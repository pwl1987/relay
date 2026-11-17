// RELAY-MAC-UX-HANDOFF-13 预览生命周期 focused harness(合同 B/C:安全起停与临时目录清理)。
// 真实子进程 = node scripts/webux11-preview.mjs(最新 main 预览脚本本体)+ 真实隔离测试 PG + 真实 HTTP。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
// 产出:p0-mvp/mac-ux-handoff-13/evidence/preview-lifecycle-<TAG>.json(缺省 TAG=ci 回归安全;
//   证据轮显式 TAG=verify,与 webux11 harness M2 教训同口径——证据轮与回归轮分离)。
// 只清自有口径(硬边界):测试只做 /tmp/webux11-preview-* 前后差分断言「零新增」,
//   绝不删除/清算历史遗留目录(历史泄漏归历史,不归咎本轮);schema 残留断言同样只看本轮自建 label。
// 边界:SIMULATED(零真实模型/零外部 GitHub/预览执行链为确定性 stub)× REAL(真实进程起停/真实
//   HTTP/CSRF 登录/真实 PG catalog 只读计数);零生产连接(测试库守卫 fail-closed 钉死 55433/relayp000)。
// 生命周期契约:
//   T1 就绪后 SIGTERM(优雅)⇒ exit 0+端口释放+一次性 schema 删除+/tmp 零新增(修复前=泄漏一套目录)。
//   T2 启动窗口 SIGTERM(reg 目录已现=信号处理器已装)⇒ exit 0+零泄漏+零 schema 残留
//     (修复前处理器在 listen 之后才注册 ⇒ 默认终止,进程被信号杀死且目录全漏)。
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

const E2E = process.env.RELAY_E2E === "1";
const TAG = process.env.WEBUX13_TAG ?? "ci";
const OUT_DIR = join(process.cwd(), "p0-mvp", "mac-ux-handoff-13", "evidence");
const PASSWORD_LINE = /本次登录口令\(仅打印一次\):(\S+)/; // 字面括号必须转义(未转义=捕获组语义,永不匹配)
const TMP_PREFIXES = [
  join(tmpdir(), "webux11-preview-reg-"),
  join(tmpdir(), "webux11-preview-remote-base-"),
  join(tmpdir(), "webux11-preview-stage-"),
  join(tmpdir(), "webux11-preview-verify-"),
];

interface Step {
  step: string;
  facts: Record<string, string | number | boolean | null>;
}
const STEPS: Step[] = [];
function record(step: string, facts: Step["facts"]): void {
  STEPS.push({ step, facts });
}

function listPreviewTmp(): string[] {
  const names = new Set(readdirSync(tmpdir()));
  const out: string[] = [];
  for (const prefix of TMP_PREFIXES) {
    const base = prefix.split("/").pop()!;
    for (const name of names) if (name.startsWith(base)) out.push(join(tmpdir(), name));
  }
  return out.sort();
}

/** 只读 catalog 计数:本轮预览脚本一次性 schema(p01a_webux11_preview_*)是否残留。 */
async function previewSchemaCount(): Promise<number> {
  const url = process.env.RELAY_DB_URL ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name LIKE 'p01a\\_webux11\\_preview%' ESCAPE '\\'",
    );
    return r.rows[0]!.n;
  } finally {
    await pool.end().catch(() => {});
  }
}

/** 从内核取一个当前空闲的 TCP 端口(绑 0 后读 AddressInfo 再关闭;127.0.0.1 单接口)。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface ProbeResult {
  unauth: [number, number]; // [/workspace, /api/health]
  authed: [number, number];
  loginStatus: number;
  hasCookie: boolean;
}

interface Preview {
  child: ChildProcess;
  base: string;
  password: string;
}

async function startPreview(port: number): Promise<Preview> {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "webux11-preview.mjs"), "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  let stdout = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const base = `http://127.0.0.1:${port}`;
  // 就绪判据:健康端点响应 401(未授权)=服务器已监听
  await waitFor(
    async () => {
      try {
        const r = await fetch(`${base}/api/health`);
        return r.status === 401;
      } catch {
        return false;
      }
    },
    30_000,
    "preview /api/health 401",
  );
  const m = PASSWORD_LINE.exec(stdout);
  if (!m) throw new Error(`preview stdout 未打印口令:\n${stdout}\n${stderr}`);
  // 恰一个捕获组 ⇒ 口令=m[1](曾误取 m[2]=undefined ⇒ 登录 401 假失败,教训=非空断言不能替代组号核对)
  return { child, base, password: m[1]! };
}

/** 未授权面+登录+授权面(与协调方 B 项冒烟同口径:302/401 → 200/200/200)。 */
async function loginAndProbe(base: string, password: string): Promise<ProbeResult> {
  const unauthWs = await fetch(`${base}/workspace`, { redirect: "manual" });
  record("unauth-workspace", { status: unauthWs.status, redirect: unauthWs.headers.get("location") });
  const unauthHealth = await fetch(`${base}/api/health`);
  record("unauth-health", { status: unauthHealth.status });
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, operator: "owner" }),
  });
  const loginBody = await login.text().catch(() => "");
  const setCookie = login.headers.get("set-cookie") ?? "";
  record("login-session", {
    status: login.status,
    hasCookie: setCookie.length > 0,
    // 诊断字段(红态定位用):仅口令长度,不落任何口令前缀/全文(13 硬禁令:口令禁止入库)
    pwLen: password.length,
    bodyHead: loginBody.slice(0, 120),
  });
  const authedWs = await fetch(`${base}/workspace`, { headers: { cookie: setCookie }, redirect: "manual" });
  record("authed-workspace", { status: authedWs.status });
  const authedHealth = await fetch(`${base}/api/health`, { headers: { cookie: setCookie } });
  record("authed-health", { status: authedHealth.status });
  return {
    unauth: [unauthWs.status, unauthHealth.status],
    authed: [authedWs.status, authedHealth.status],
    loginStatus: login.status,
    hasCookie: setCookie.length > 0,
  };
}

function terminate(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  child.kill("SIGTERM");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview 未在 30s 内退出")), 30_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function writeEvidence(extra: Record<string, unknown>): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, `preview-lifecycle-${TAG}.json`),
    JSON.stringify(
      {
        tag: TAG,
        contract: "RELAY-MAC-UX-HANDOFF-13",
        capturedAt: new Date().toISOString(),
        boundary:
          "REAL(真实预览进程起停/真实 HTTP+Cookie 登录/真实隔离 PG catalog 只读计数)× SIMULATED(预览执行链=确定性 stub,零真实模型/零外部 GitHub)",
        steps: STEPS,
        ...extra,
      },
      null,
      2,
    ),
  );
}

let evidenceExtra: Record<string, unknown> = {};

afterAll(() => {
  if (E2E) writeEvidence(evidenceExtra);
});

describe("webux13 preview lifecycle(RELAY_E2E 门)", () => {
  if (!E2E) {
    it("RELAY_E2E 未开启,显式 skip(不假装)", () => expect(E2E).toBe(false));
    return;
  }

  it("T1 就绪后 SIGTERM:登录面 302/401→200,退出后端口释放+schema 删除+/tmp 零新增", async () => {
    const before = listPreviewTmp();
    record("tmp-before", { count: before.length });
    const beforeSchemas = await previewSchemaCount();
    const port = await pickFreePort();
    const preview = await startPreview(port);
    record("started", { pid: preview.child.pid ?? null, port });
    // 断言失败也必须终止子进程(防孤儿:曾有失败路径遗留孤儿预览进程+schema,教训固化)
    let probe: ProbeResult;
    try {
      probe = await loginAndProbe(preview.base, preview.password);
    } catch (err) {
      preview.child.kill("SIGTERM");
      throw err;
    }
    record("probe", {
      unauthWs: probe.unauth[0],
      unauthHealth: probe.unauth[1],
      login: probe.loginStatus,
      authedWs: probe.authed[0],
      authedHealth: probe.authed[1],
    });
    try {
      expect(probe.unauth, "未授权 /workspace 必须 302 且 /api/health 401").toEqual([302, 401]);
      expect(probe.loginStatus, "随机口令登录必须 200 且有会话 Cookie").toBe(200);
      expect(probe.hasCookie).toBe(true);
      expect(probe.authed, "登录后 /workspace 与 /api/health 必须 200").toEqual([200, 200]);
    } catch (err) {
      preview.child.kill("SIGTERM");
      throw err;
    }
    const { code, signal } = await terminate(preview.child);
    record("terminated", { code, signal: signal ?? null });
    expect(code, "SIGTERM 应走优雅清理路径 exit 0(而非被信号杀死)").toBe(0);
    await waitFor(() => portClosed(port), 10_000, "port release");
    const after = listPreviewTmp();
    const newDirs = after.filter((d) => !before.includes(d));
    record("tmp-after", { count: after.length, newDirs: newDirs.length });
    const schemaAfter = await previewSchemaCount();
    record("schema", { before: beforeSchemas, after: schemaAfter });
    evidenceExtra = { ...evidenceExtra, t1: { port, exit: { code, signal } } };
    expect(newDirs, "预览自身新建临时目录必须在退出后零残留(历史目录不计)").toEqual([]);
    expect(schemaAfter - beforeSchemas, "一次性 schema 必须删除(零残留)").toBe(0);
  }, 90_000);

  it("T2 启动窗口 SIGTERM(reg 目录已现=处理器已装):exit 0+零泄漏+零 schema 残留", async () => {
    const before = listPreviewTmp();
    const beforeSchemas = await previewSchemaCount();
    const port = await pickFreePort();
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "scripts", "webux11-preview.mjs"), "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stdout = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    // 同步点:首个自有 reg 目录出现 ⇒ 信号处理器已安装(修复后注册先于任何临时目录创建);
    // 10ms 轮询尽量把 TERM 打进启动窗口(listen 之前);TERM 实际落点如实记录(banner 是否已打印)
    await waitFor(async () => listPreviewTmp().some((d) => !before.includes(d)), 30_000, "首个 reg 目录出现", 10);
    const termBeforeBanner = !stdout.includes("已启动");
    const { code, signal } = await terminate(child);
    record("t2-terminated", {
      code,
      signal: signal ?? null,
      termBeforeBanner,
      stdoutTail: stdout.slice(-200).replace(PASSWORD_LINE, "本次登录口令(仅打印一次):***REDACTED***"), // 口令零落盘
    });
    const after = listPreviewTmp();
    const newDirs = after.filter((d) => !before.includes(d));
    const schemaAfter = await previewSchemaCount();
    record("t2-facts", { newDirs: newDirs.length, schemaBefore: beforeSchemas, schemaAfter });
    evidenceExtra = { ...evidenceExtra, t2: { exit: { code, signal } } };
    expect(code, "启动窗口 SIGTERM 也必须优雅清理 exit 0").toBe(0);
    expect(newDirs, "启动窗口终止同样零临时目录泄漏").toEqual([]);
    expect(schemaAfter - beforeSchemas, "启动窗口终止零 schema 残留(createTestDb 半途也必须收尾)").toBe(0);
  }, 90_000);
});
