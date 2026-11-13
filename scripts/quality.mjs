#!/usr/bin/env node
// RELAY-QUALITY-LOCAL-01:统一本地质量流水线(唯一实现;本地与 GitHub Actions 复用同一配置)。
// RELAY-SAFETY-CLOSE-02 增补(P1-D/P0-C):必需项 NOT_RUN 不产生发布就绪 PASS(release INCOMPLETE);
//   release 禁继承 RELAY_QUALITY_SKIP_BROWSER(fail-closed);运行前置校验 RELAY_DB_URL 授权三元组;
//   RELAY_GITHUB_REAL_E2E 显式授权门(默认不写远端,剥离继承)。
// 语义(C7):每步记录 status=PASS|FAILED|NOT_RUN、命令、退出码、时长、日志文件;
//           证据 JSON 落 test-evidence/(gitignore,不入库),CI 以 Actions 日志为权威证据面。
// 模式:
//   quick   = lint(全仓 error 阻断) + format(仅变更文件,只读) + typecheck + 单测
//   full    = quick 全部 + 真 PG 集成(不可达则拉起测试库;失败即 FAILED,不静默跳过) + 浏览器旅程
//   release = full 全部 + 备份恢复专项 + 显式 NOT_RUN 登记(性能无基线/模型门禁需授权,不伪装通过)
// 边界(C8/C9):测试库为隔离容器 127.0.0.1:55433;模型消耗测试门禁(RELAY_A4_E2E 等)本脚本永不打开。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const mode = process.argv[2] ?? "";
if (!["quick", "full", "release"].includes(mode)) {
  console.error("用法: node scripts/quality.mjs quick|full|release");
  process.exit(2);
}

// ---- P1-D 前置校验(在任何测试执行之前) ----
// ① release 必须真跑浏览器:禁继承 RELAY_QUALITY_SKIP_BROWSER(继承=静默降低验收面 ⇒ fail-closed)
if (mode === "release" && process.env.RELAY_QUALITY_SKIP_BROWSER === "1") {
  console.error(
    "quality:release 拒绝执行:RELAY_QUALITY_SKIP_BROWSER=1 被继承 —— release 模式必需浏览器检查,不得跳过后仍报告发布就绪(P1-D fail-closed);请清除该变量后重试",
  );
  process.exit(2);
}
// ② 测试目标必须是授权的独立测试库(P0-C;与 test/setup/testdb.ts 守卫同一三元组,两层防线)。
//    错误生产 RELAY_DB_URL 在任何写操作前拒绝;未设置(默认)不拦截。
if (process.env.RELAY_DB_URL) {
  let u;
  try {
    u = new URL(process.env.RELAY_DB_URL);
  } catch {
    u = null;
  }
  const authorized =
    u !== null &&
    ["127.0.0.1", "localhost", "::1"].includes(u.hostname) &&
    (u.port || "5432") === "55433" &&
    u.pathname.replace(/^\//, "") === "relayp000";
  if (!authorized) {
    console.error(
      "quality 拒绝执行:RELAY_DB_URL 不在授权测试三元组(loopback:55433/relayp000)内 —— 测试不得指向生产或未授权数据库(P0-C fail-closed);未执行任何测试或写操作。" +
        "如需让 quality 使用其它测试库,请清除 RELAY_DB_URL(默认 127.0.0.1:55433/relayp000)。",
    );
    process.exit(2);
  }
}

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
const evDir = join("test-evidence", `quality-${mode}-${stamp}`);
mkdirSync(evDir, { recursive: true });

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** 变更文件集(C5:格式只读检查仅作用于本次新增/修改代码,历史基线不重排):
 *  CI 传 RELAY_QUALITY_BASE_SHA(push 事件 before)⇒ 检查推送区间;本地 ⇒ 工作区+暂存+未跟踪。
 *  范围与 biome.jsonc files.includes 对齐(src/web/test/scripts/bin + biome.jsonc);
 *  显式排除受保护未跟踪产物(config 目录与 p0 前缀目录)——独立 Reviewer M-1:越界文件会使
 *  Biome 报 "No files were processed" 且 exit 1,干净树上假 FAILED。 */
function changedFiles() {
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json", ".jsonc"];
  const inScope = (f) =>
    f === "biome.jsonc" ||
    ((f.startsWith("src/") ||
      f.startsWith("web/") ||
      f.startsWith("test/") ||
      f.startsWith("scripts/") ||
      f.startsWith("bin/")) &&
      exts.some((e) => f.endsWith(e)));
  const files = new Set();
  const add = (out) => {
    for (const f of out.split("\n")) {
      const t = f.trim();
      if (t && inScope(t)) files.add(t);
    }
  };
  const base = process.env.RELAY_QUALITY_BASE_SHA;
  if (base && /^[0-9a-f]{40}$/.test(base) && base !== "0000000000000000000000000000000000000000") {
    add(execFileSync("git", ["diff", "--name-only", `${base}..HEAD`], { encoding: "utf8" }));
  } else {
    add(execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" }));
    add(execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }));
    add(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }));
  }
  return [...files];
}

function pgReachable(port = 55433, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

/** 外部副作用门禁变量(C9/P1-D):quality 运行器显式剥离,防止操作者 shell 残留变量隐式启用
 *  模型消耗或真实远端写入。release 的 backup 步骤所需 RELAY_BACKUP_E2E 由步骤参数显式传入,
 *  不受剥离影响;真实 GitHub 远端写入须由操作者在调用 quality 之外、经独立授权流程显式设置。 */
const MODEL_GATE_ENV = [
  "RELAY_A4_E2E",
  "RELAY_GATE_E2E",
  "RELAY_EGRESS_E2E",
  "RELAY_E2E",
  "RELAY_BACKUP_E2E",
  "RELAY_DISCOVERY_E2E",
  "RELAY_F1_E2E",
  "RELAY_F2_E2E",
  "RELAY_F3_E2E",
  "RELAY_GITHUB_REAL_E2E",
];
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of MODEL_GATE_ENV) delete env[k];
  return { ...env, ...extra };
}

/** 顺序执行步骤:输出实时透传并落日志;返回结构化结果。 */
async function runStep(name, command, args, env = {}) {
  const logFile = join(evDir, `${name}.log`);
  const t0 = Date.now();
  console.log(`\n===== [${name}] ${command} ${args.join(" ")} =====`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const append = (chunk) => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text);
      writeFileSync(logFile, out);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => resolve({ code: -1, note: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1 }));
  });
  const durationMs = Date.now() - t0;
  const status = result.code === 0 ? "PASS" : "FAILED";
  console.log(`===== [${name}] ${status} (exit=${result.code}, ${durationMs}ms) =====`);
  return {
    name,
    command: [command, ...args].join(" "),
    status,
    exitCode: result.code,
    durationMs,
    logFile,
    ...(result.note ? { note: result.note } : {}),
  };
}

const steps = [];
const sha = gitSha();

// ---------- 公共步骤定义 ----------
const stepLint = async () =>
  runStep("lint", "npx", ["biome", "lint", "--reporter=summary", "src", "web", "test", "scripts", "bin"]);
const stepFormat = async () => {
  const files = changedFiles();
  if (files.length === 0) {
    console.log("===== [format] NOT_RUN(无变更文件;基线见 biome.jsonc 注释与质量报告) =====");
    return {
      name: "format",
      command: "biome format <changed>",
      status: "NOT_RUN",
      exitCode: null,
      reason: "no_changed_files",
    };
  }
  return runStep("format", "npx", ["biome", "format", ...files]);
};
const stepTypecheck = async () => runStep("typecheck", "npx", ["tsc", "--noEmit"]);
const stepUnit = async () => runStep("unit", "npx", ["vitest", "run", "test/unit"]);
const stepPg = async () => {
  if (await pgReachable()) {
    console.log("===== [pg] 测试库 127.0.0.1:55433 已可达(复用,不重建) =====");
    return {
      name: "pg",
      command: "tcp-check 127.0.0.1:55433",
      status: "PASS",
      exitCode: 0,
      reason: "already_reachable",
    };
  }
  return runStep("pg", "bash", ["scripts/test-db-up.sh"]);
};
const stepTests = async () => runStep("tests", "npx", ["vitest", "run"]);
const stepBrowser = async () => {
  // CI 双 job 分工:test job 设 RELAY_QUALITY_SKIP_BROWSER=1(浏览器由独立 e2e job 覆盖);
  // 跳过必须显式落 NOT_RUN 与原因,不静默(C2)。
  if (process.env.RELAY_QUALITY_SKIP_BROWSER === "1") {
    console.log("===== [browser] NOT_RUN(RELAY_QUALITY_SKIP_BROWSER=1;由 CI 独立 e2e job 覆盖) =====");
    return {
      name: "browser",
      command: "skipped-by-env",
      status: "NOT_RUN",
      exitCode: null,
      reason: "RELAY_QUALITY_SKIP_BROWSER=1",
    };
  }
  // Chromium 预检:缺失则安装一次(记录于日志);仍缺失 ⇒ FAILED,不静默跳过
  try {
    const exePath = execFileSync(
      "node",
      ["-e", "import('playwright').then(m=>console.log(m.chromium.executablePath()))"],
      { encoding: "utf8" },
    ).trim();
    if (!existsSync(exePath)) {
      const inst = await runStep("browser-install", "npx", ["playwright", "install", "chromium"]);
      steps.push(inst);
      if (inst.status !== "PASS")
        return { ...inst, name: "browser", status: "FAILED", reason: "chromium_install_failed" };
    }
  } catch (err) {
    return {
      name: "browser",
      command: "preflight",
      status: "FAILED",
      exitCode: -1,
      reason: `chromium_probe_failed:${String(err)}`,
    };
  }
  return runStep("browser", "npx", ["vitest", "run", "test/e2e"], { RELAY_E2E: "1" });
};
const stepBackup = async () =>
  runStep("backup-restore", "npx", ["vitest", "run", "test/integration/backup-restore.test.ts"], {
    RELAY_BACKUP_E2E: "1",
  });

// ---------- 模式编排 ----------
async function main() {
  const quickSteps = [stepLint, stepFormat, stepTypecheck, stepUnit];
  const fullSteps = [...quickSteps, stepPg, stepTests, stepBrowser];
  const releaseSteps = [...fullSteps, stepBackup];

  for (const s of { quick: quickSteps, full: fullSteps, release: releaseSteps }[mode]) {
    const r = await s();
    steps.push(r);
    if (r.status === "FAILED") break; // fail-fast:失败不掩盖后续(如实中断,不偷偷跳过)
  }

  // 显式 NOT_RUN 登记(C3:不虚构、不伪装)
  const notRun = [];
  const executed = new Set(steps.map((s) => s.name));
  const plan = {
    quick: ["lint", "format", "typecheck", "unit"],
    full: [...["lint", "format", "typecheck", "unit", "pg", "tests", "browser"]],
    release: ["lint", "format", "typecheck", "unit", "pg", "tests", "browser", "backup-restore"],
  };
  for (const n of plan[mode]) if (!executed.has(n)) notRun.push({ name: n, reason: "前置步骤失败,未执行" });
  if (mode === "release") {
    notRun.push({ name: "performance", reason: "无实测基线与冻结阈值(ADR-0012 §10:阈值须实测后校准;本包不虚构)" });
    notRun.push({
      name: "model-gated-e2e",
      reason: "RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E/pi-e2e 需独立模型授权,本脚本永不打开(C9)",
    });
    notRun.push({ name: "real-deploy-verify", reason: "生产 VM80 验证属部署包范围,本包未授权触碰生产" });
  }

  const failed = steps.some((s) => s.status === "FAILED");
  // P1-D 发布就绪语义:必需项 NOT_RUN 不产生整体发布就绪 PASS。
  // - release:计划步骤(除 format —— 变更集作用域检查,无变更文件时 NOT_RUN 属语义正确)必须
  //   全部 PASS 才算 PASS;任一必需项 NOT_RUN ⇒ INCOMPLETE(检查可完成 ≠ 可发布),exit 1。
  // - full:CI test job 场景下 browser NOT_RUN 属分工设计 ⇒ 判定仍 PASS,但证据强制携带
  //   releaseReadiness 警示(浏览器结论必须由独立 e2e job 的真实结果补足)。
  const notRunRequired =
    mode === "release"
      ? plan[mode]
          .filter((n) => n !== "format")
          .filter((n) => steps.some((s) => s.name === n && s.status === "NOT_RUN"))
      : [];
  const releaseReadiness =
    mode === "release"
      ? failed
        ? "NOT_READY(存在 FAILED 步骤;不得宣称发布就绪,修复后重跑)"
        : notRunRequired.length === 0
          ? "READY(全部必需检查 PASS;性能/模型门禁/真实部署仍按 NOT_RUN 登记为未验证,不虚构)"
          : `NOT_READY(必需项未执行:${notRunRequired.join(", ")})`
      : mode === "full" && steps.some((s) => s.name === "browser" && s.status === "NOT_RUN")
        ? "质量检查完成 ≠ 发布就绪:本 job 浏览器 NOT_RUN;必须由独立 e2e job 的真实结果补足(P1-D)"
        : null;
  const verdict = failed ? "FAILED" : mode === "release" && notRunRequired.length > 0 ? "INCOMPLETE" : "PASS";
  const gitDirty = (() => {
    try {
      return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    } catch {
      return null;
    }
  })();
  // P1-D:github-real 真实远端写入 —— quality 管线零外部副作用(RELAY_GITHUB_REAL_E2E 已剥离);
  // 真实写入验证属独立授权步骤(在 quality 之外显式运行该测试文件),此处如实登记未验证。
  if (mode === "full" || mode === "release") {
    notRun.push({
      name: "github-real-write",
      reason:
        "quality 管线零外部副作用:RELAY_GITHUB_REAL_E2E 被剥离,真实远端写入用例跳过(P1-D;仅凭本地凭据存在不得隐式写入);需独立授权时在 quality 之外显式运行 test/integration/github-real.test.ts",
    });
  }
  const evidence = {
    mode,
    sha,
    // 脏树标志(Reviewer m-2):sha 为 HEAD 提交,脏树时被测代码面≠该提交,须结合本标志读证据
    gitDirty,
    baseSha: process.env.RELAY_QUALITY_BASE_SHA ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    cwd: process.cwd(),
    steps,
    notRun,
    ...(releaseReadiness ? { releaseReadiness } : {}),
    verdict,
  };
  const evFile = join(evDir, "evidence.json");
  writeFileSync(evFile, JSON.stringify(evidence, null, 2));
  console.log(`\n===== 质量证据: ${evFile} =====`);
  if (releaseReadiness) console.log(`===== 发布就绪: ${releaseReadiness} =====`);
  console.log(`===== ${mode} 总裁决: ${verdict} =====`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("quality runner 异常:", err);
  process.exit(2);
});
