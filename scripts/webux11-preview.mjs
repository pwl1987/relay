// RELAY-WEB-UX-ACCEPTANCE-11 隔离预览启动器(最新 main Web 实现×隔离合成环境;零生产触碰)。
//
// 用途:在 VM80 本机运行,把「最新 main 的工作区 UI」以安全方式呈现给用户 Mac 实机体验——
//   Mac 经 SSH 端口转发访问,全程不公开网络、不改任何生产面。
//
//   VM80:  node scripts/webux11-preview.mjs            (默认 127.0.0.1:8790;--port 可改)
//   Mac:   ssh -L 8790:127.0.0.1:8790 <你的VM80账号@10.30.5.80>
//          然后浏览器打开 http://localhost:8790/workspace  (用脚本打印的一次性口令登录)
//
// 隔离与边界(逐条):
//   - 数据库=共享测试实例上的一次性独立 schema(p01a_ 前缀;testdb 授权守卫 fail-closed,
//     任何非 127.0.0.1:55433/relayp000 目标在连接前即拒绝)⇒ 生产 relay_console 零读写;退出即删 schema。
//   - Web 绑定=127.0.0.1(server 层 G-1:非回环绑定默认拒绝;不开放公网,Mac 只经 SSH 转发)。
//   - 登录口令=每次运行随机生成,仅启动时打印一次,不写盘、不进日志文件。
//   - 项目注册表=一次性空文件(真实「首次使用:零项目」状态)。想带项目体验:自行导出
//     RELAY_PROJECTS_FILE=<你的注册表文件> 后再运行(仍只读该文件,不写回)。
//   - 执行链=确定性 stub(test/helpers/stub-pi.mjs;非真实模型、零付费请求);交付=一次性本地
//     bare 远端(零外部 GitHub 写入)+ 真实快进推送与真实内容核验(与 e2e 夹具同语义);
//     自动推进(每 2.5s 一拍)以便观察「正在处理→结果」全过程。
//   - 本脚本只读 web/ 静态资源与 src/ 代码,不写仓库任何文件;退出时清理一次性 schema。
//
// 与现役生产 Web 的差异:生产=旧代码进程(2026-11-13 启动);本预览=最新 main 代码
// (含「发送=只交流/记录;交给 Relay 执行=显式执行」方案 A 语义)。详见
// p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md。
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../test/setup/testdb.ts";
import { makeBareRemote } from "../test/helpers/git-fixture.ts";
import { Auth } from "../src/server/auth.ts";
import { createRelayServer } from "../src/server/app.ts";
import { createLiveWorkerDriver } from "../src/server/worker.ts";
import { DEFAULT_DELIVERY_POLICY } from "../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../src/runtime/git-candidate.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stubPath = join(repoRoot, "test", "helpers", "stub-pi.mjs");
const argPort = (() => {
  const i = process.argv.indexOf("--port");
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : 8790;
})();

const password = randomBytes(9).toString("base64url");
const t = await createTestDb("webux11-preview");
const auth = new Auth({
  password,
  sessionTtlMs: 3_600_000,
  operators: ["owner"],
  maxLoginFailures: 10,
  loginWindowMs: 60_000,
  lockoutMs: 60_000,
});
// 首次使用空状态:一次性空项目注册表(绝不指向受保护 config/projects.json)
const reg = join(mkdtempSync(join(tmpdir(), "webux11-preview-reg-")), "projects.json");
writeFileSync(reg, JSON.stringify({ projects: [] }));
process.env["RELAY_PROJECTS_FILE"] = reg;

/** 每任务独立 bare 远端(与 e2e 夹具同语义:propose 先推 base=远端 HEAD 基线,交付按快进推进;零外部 GitHub 写入)。 */
const remoteBase = mkdtempSync(join(tmpdir(), "webux11-preview-remote-base-"));
const remotes = new Map();
function remoteFor(taskId) {
  let r = remotes.get(taskId);
  if (!r) {
    r = makeBareRemote(remoteBase);
    remotes.set(taskId, r);
  }
  return r;
}

const driver = createLiveWorkerDriver({
  db: t.db,
  model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
  sandbox: "host-fallback",
  workerId: "webux11-preview",
  wallSeconds: 30,
  heartbeatSeconds: 2,
  reserveCallsPerRun: 4,
  reviewerReserveCallsPerRun: 2,
  reviewAttempts: 1,
  stubInjection: {
    argv: [process.execPath, stubPath],
    coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "200" },
    reviewerEnv: {
      STUB_MODE: "verdict",
      STUB_VERDICT: "PASS",
      STUB_FINDINGS: "预览 stub 独立审查通过",
      STUB_DELAY_MS: "200",
    },
  },
  prepareWorkspace: (ws) => {
    execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { encoding: "utf8" });
    execFileSync("git", ["-C", ws, "config", "user.email", "preview@l"], { encoding: "utf8" });
    execFileSync("git", ["-C", ws, "config", "user.name", "preview"], { encoding: "utf8" });
    writeFileSync(`${ws}/README.md`, "# preview\n", "utf8");
    writeFileSync(`${ws}/base.txt`, "base\n", "utf8");
    execFileSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "base"], { encoding: "utf8" });
  },
  checkRunner: (spec, ws) =>
    new Promise((resolve) => {
      let raw = "";
      let passed = true;
      try {
        raw = execFileSync(spec.command[0], spec.command.slice(1), {
          cwd: spec.cwdWorkspace === false ? repoRoot : ws,
          timeout: spec.timeoutMs ?? 60000,
          encoding: "utf8",
        });
      } catch (e) {
        passed = false;
        raw = `$ ${spec.command.join(" ")}\n[exit=${e?.code ?? "error"}] ${e?.stderr ?? ""}`.trimEnd();
      }
      resolve({
        passed,
        rawOutput: `$ ${spec.command.join(" ")}\n${raw}`.trimEnd(),
        env: { mode: "preview-stub", host: "preview" },
      });
    }),
  delivery: {
    propose: async (c) => {
      const remote = remoteFor(c.taskId);
      remote.pushHead(c.stageRepoDir, c.baseCommitSha);
      return {
        taskId: c.taskId,
        attempt: c.attempt,
        target: remote.url,
        branch: "main",
        expectedRemoteSha: c.baseCommitSha,
        policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [remote.url.toLowerCase()] },
        credentialPresent: true,
        verifyCommitBinding: makeCommitBindingVerifier(() => c.stageRepoDir),
        actor: "webux11-preview",
      };
    },
    io: async (c) => ({
      executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha) => {
        const scratch = mkdtempSync(join(tmpdir(), "webux11-preview-verify-"));
        const r = await verifyRemoteCommitContent({
          target: remoteFor(c.taskId).url,
          commitSha,
          manifest: c.manifest,
          scratchDir: scratch,
        });
        return r.ok ? { ok: true } : { ok: false, mismatches: r.mismatches };
      },
      manifest: c.manifest,
    }),
  },
  stageBaseDir: mkdtempSync(join(tmpdir(), "webux11-preview-stage-")),
});

const handle = createRelayServer({
  db: t.db,
  auth,
  worker: driver,
  workerMode: "stub",
  host: "127.0.0.1",
  port: argPort,
  staticDir: join(repoRoot, "web"),
  defaultGoalBudgetModelCalls: 12,
});
await new Promise((resolve) => handle.server.listen(argPort, "127.0.0.1", () => resolve(null)));

// 自动推进(每 2.5s 一拍;异常不终止预览——如实打印后继续)
const timer = setInterval(() => {
  driver.tick().catch((e) => console.error("[preview] tick:", e?.message ?? String(e)));
}, 2500);

console.log("Relay 隔离预览(最新 main × 合成数据)已启动:");
console.log(`  本机访问   http://127.0.0.1:${argPort}/workspace`);
console.log(
  `  Mac 经 SSH:ssh -L ${argPort}:127.0.0.1:${argPort} <你的VM80账号@10.30.5.80>  →  http://localhost:${argPort}/workspace`,
);
console.log(`  本次登录口令(仅打印一次):${password}`);
console.log("  说明:执行链为确定性 stub(非真实模型);Ctrl+C 退出并清理一次性数据。");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await new Promise((r) => handle.server.close(() => r()));
  try {
    await t.cleanup();
  } catch (e) {
    console.error("[preview] cleanup:", e?.message ?? String(e));
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
