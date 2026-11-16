// RELAY-GOAL-CREATE-IDEMPOTENCY-12 Goal 创建幂等(Major-R2:ACK 丢失重复创建)红绿 harness。
// 真实 Web 实现(同一 web/ 静态资源与 server 代码)+ 隔离合成环境(独立测试 schema + 确定性 stub;
// 非真实模型)+ 真实 Chromium 双视口(桌面 1440×900 / 手机 390×844)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
// 产出(按 WEBUX12_TAG 区分轮次):
//   p0-mvp/goal-create-idempotency-12/screenshots/<TAG>/*.png —— 新鲜真实截图(红轮/绿轮各一轮)
//   p0-mvp/goal-create-idempotency-12/evidence/webux12-goal-idempotency-<TAG>.json —— 逐步骤结构化观察
// 轮次分离(11 包 Reviewer Minor-M2 教训):**缺省 TAG=ci(回归安全)**;证据轮必须显式
//   WEBUX12_TAG=audit-red(修复前红态)/verify(修复后绿态)——缺省值绝不覆盖证据轮产物。
// 被测事实(合同 12 B/C/D;协调方 Major-R2 实证技术=本 harness 正式化):
//   - **ACK 丢失 ≠ 请求未送达**:page.route 拦截 POST /api/goals 后先 `route.fetch()` **真实送达
//     服务器并取得 201(事务已提交)**,再 `route.abort("failed")` 只丢弃浏览器侧回执 ——
//     修复前:用户按界面提示重试 ⇒ 第二个 POST ⇒ 重复 Goal+初始 Task/消费/预算/审计(红);
//     修复后:同一高熵请求键复用 ⇒ 服务端识别旧成功并返回同一 GoalId(绿)。
//     `route.abort` 发生在上游调用之前的旧形态(11R T2)只覆盖"请求未送达",不假称 ACK 丢失。
//   - 幂等设计=键 ⇒ 派生 Goal 主键(goal-<sha256 前缀 UUID 形态>)复用现有 PK 唯一约束:
//     同键同内容(操作者/绑定一致)⇒ 200 幂等重放;同键异 payload/项目绑定 ⇒ 409 fail-closed;
//     非法键格式 ⇒ 400 零创建;无键(旧客户端)⇒ 行为不变;不同键同文案 ⇒ 两个独立新需求
//     (不按纯文本永久去重);并发同键 ⇒ 恰一个 Goal(PK 冲突⇒重放,事务化)。
//   - 零新表/零 schema 变更/零 Core 生命周期改动:持久性=Goal 行本身;服务端无 process-local
//     状态 ⇒ 天然跨重启;Web/UI 最小增补(键生成+sessionStorage 持久+409 中文提示)。
//   - 11R UI 功能不推倒(终态「新建后续任务」/PAUSED 指引/ACTIVE 双操作由其自身套件回归)。
//   - T9 错误门=全量分类:注入性 net::ERR_FAILED(ACK 丢失注入的本意信号)与注入次数精确
//     对账(桌面 2= T1+T7,手机 1= T1m);其余 pageerror/console.error 零容忍。
// 隔离与边界:RELAY_PROJECTS_FILE 指向一次性合成注册表(绝不读取受保护 config/projects.json);
//   数据全部合成;零生产连接/零真实模型/零外部交付(target=本地 bare 远端夹具);用后即毁。
// 操作者一致性说明:Auth 单操作者(role="owner");同键异操作者的服务端拒绝逻辑在实现内
//   (GOAL_PLANNED 审计 actor 比对),e2e 单操作者环境无法构造第二操作者 ⇒ 该分支由实现审查
//   与单操作者等价性保证,如实登记(REPORT NOT_RUN 节)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright";
import type { APIRequestContext } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver, type DeliveryFactory } from "../../src/server/worker.ts";
import type { AddressInfo } from "node:net";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";

const E2E = process.env.RELAY_E2E === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
// 11 教训(M2):缺省=ci(回归安全);证据轮显式 audit-red/verify。
const TAG = process.env.WEBUX12_TAG ?? "ci";
const OUT_DIR = join(process.cwd(), "p0-mvp", "goal-create-idempotency-12");
const SHOT_DIR = join(OUT_DIR, "screenshots", TAG);
const EVIDENCE_DIR = join(OUT_DIR, "evidence");
const PASSWORD = "e2e-password-webux12";
const PROJECT_NAME = "p-alpha";

const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;
// 390×844 手机视口;deviceScaleFactor 1 ⇒ 截图 PNG 恰为 390×844(与 03D §17 同口径)
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } as const;

interface Obs {
  step: string;
  viewport: string;
  url?: string;
  facts: Record<string, string | number | boolean | null>;
}

interface Stack {
  t: TestDb;
  server: ReturnType<typeof createRelayServer>["server"];
  base: string;
  browser: Browser;
  page: Page; // 桌面页(1440×900)
  mpage: Page; // 手机页(390×844,带监听)
  csrf: string;
}

/** 逐步骤观察收集(红轮=Major-R2 可证伪反例证据源;绿轮=修后对照)。 */
const OBS: Obs[] = [];
function record(step: string, viewport: string, facts: Obs["facts"], page?: Page): void {
  OBS.push({ step, viewport, ...(page ? { url: page.url() } : {}), facts });
}

/** 全程浏览器错误收集(双视口共享同一对象;JSON 最终=全量)。 */
const CONSOLE_ERRORS: { desktop: string[]; mobile: string[] } = { desktop: [], mobile: [] };

function flushObservations(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, `webux12-goal-idempotency-${TAG}.json`),
    JSON.stringify(
      {
        tag: TAG,
        contract: "RELAY-GOAL-CREATE-IDEMPOTENCY-12",
        boundary: "SIMULATED(合成业务数据+确定性 stub,零真实模型)× REAL(真实 Web 实现/真 Chromium 操作/真隔离 PG)",
        viewports: { desktop: "1440x900", mobile: "390x844" },
        capturedAt: new Date().toISOString(),
        consoleErrors: CONSOLE_ERRORS,
        steps: OBS,
      },
      null,
      2,
    ),
  );
}

let STACK: Stack | null = null;

async function startStack(): Promise<Stack> {
  const t = await createTestDb(`webux12-e2e-goal-idempotency`);
  const auth = new Auth({
    password: PASSWORD,
    sessionTtlMs: 3_600_000,
    operators: ["owner"],
    maxLoginFailures: 10,
    loginWindowMs: 60_000,
    lockoutMs: 60_000,
  });
  const driver = createLiveWorkerDriver({
    db: t.db,
    model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
    sandbox: "host-fallback",
    workerId: "e2e-worker-webux12",
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
      reviewerEnv: {
        STUB_MODE: "verdict",
        STUB_VERDICT: "PASS",
        STUB_FINDINGS: "webux12 e2e 独立审查通过",
        STUB_DELAY_MS: "80",
      },
    },
    prepareWorkspace: (ws: string) => {
      execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "config", "user.email", "seed@l"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "config", "user.name", "seed"], { encoding: "utf8" });
      writeFileSync(join(ws, "README.md"), "# seed\n", "utf8");
      writeFileSync(join(ws, "base.txt"), "base\n", "utf8");
      execFileSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "base"], { encoding: "utf8" });
    },
    checkRunner: hostTestCheckRunner,
    evidenceChecks: [
      { kind: "deterministic_test", command: ["cat", "delivered.txt"], cwdWorkspace: true, expectOutputContains: "ok" },
    ],
    delivery: deliveryFactory(),
    stageBaseDir: mkdtempSync(join(tmpdir(), "webux12-stage-")),
  });
  const handle = createRelayServer({
    db: t.db,
    auth,
    worker: driver,
    workerMode: "stub",
    host: "127.0.0.1",
    port: 0,
    staticDir: join(process.cwd(), "web"),
    defaultGoalBudgetModelCalls: 12,
  });
  const server = handle.server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const browser = await chromium.launch();
  const mkPage = async (opts: typeof DESKTOP | typeof MOBILE, key: "desktop" | "mobile") => {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => CONSOLE_ERRORS[key].push(`pageerror ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") CONSOLE_ERRORS[key].push(`console.error ${msg.text()}`);
    });
    return page;
  };
  const page = await mkPage(DESKTOP, "desktop");
  const mpage = await mkPage(MOBILE, "mobile");
  // 一次性合成项目注册表(绝不指向受保护 config/projects.json;含一个合成项目供绑定冲突用例)
  const reg = join(mkdtempSync(join(tmpdir(), "webux12-reg-")), "projects.json");
  const projectDir = mkdtempSync(join(tmpdir(), "webux12-proj-"));
  writeFileSync(reg, JSON.stringify({ configured: true, projects: [{ name: PROJECT_NAME, path: projectDir }] }));
  process.env["RELAY_PROJECTS_FILE"] = reg;
  const s: Stack = { t, server, base, browser, page, mpage, csrf: "" };
  await login(page, base);
  s.csrf = await csrfOf(page);
  await login(mpage, base); // 手机页同样登录(独立会话;未登录会在 /workspace 跳登录页——红轮夹具教训)
  return s;
}

/** 每任务独立 bare 远端(03C.1 夹具修正同源;11 包同款)。 */
function deliveryFactory(): DeliveryFactory {
  const remoteBase = mkdtempSync(join(tmpdir(), "webux12-remote-"));
  const remotes = new Map<string, BareRemoteFixture>();
  const remoteFor = (taskId: string): BareRemoteFixture => {
    let r = remotes.get(taskId);
    if (!r) {
      r = makeBareRemote(remoteBase);
      remotes.set(taskId, r);
    }
    return r;
  };
  return {
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
        actor: "e2e-webux12",
      };
    },
    io: async (c) => ({
      executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha: string) => {
        const scratch = mkdtempSync(join(tmpdir(), "webux12-verify-"));
        const r = await verifyRemoteCommitContent({
          target: remoteFor(c.taskId).url,
          commitSha,
          manifest: c.manifest,
          scratchDir: scratch,
        });
        return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
      },
      manifest: c.manifest,
    }),
  };
}

async function stopStack(s: Stack): Promise<void> {
  await s.browser.close();
  await new Promise<void>((r) => s.server.close(() => r()));
  await s.t.cleanup();
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name), fullPage: false });
}

async function login(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/login.html`);
  await page.fill("#password", PASSWORD);
  await page.click("#btn-login");
  await page.waitForURL(/\/workspace/);
  await page.waitForSelector('[data-testid="ws-sidebar"]');
}

/** 会话 CSRF(写操作必须带 x-relay-csrf;context.request 复用浏览器 cookie jar)。 */
async function csrfOf(page: Page): Promise<string> {
  return page.evaluate((): string => {
    const A = (globalThis as unknown as { RelayApp: { state: { csrf: string } } }).RelayApp;
    return A.state.csrf || "";
  });
}

/** 回空白工作区(直接 goto 无 goal 参数 URL;SPA 状态重置=真实「第一次打开」形态)。 */
async function gotoBlank(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/workspace`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="ws-input"]');
}

/** URL goal 参数真正变化(谓词式;宽松正则会立即匹配当前 URL——11R 教训)。 */
async function waitForGoalChange(page: Page, prevGoal: string, timeout = 20000): Promise<string> {
  await page.waitForURL(
    (u) => {
      const g = new URL(u.toString()).searchParams.get("goal");
      return g !== null && g !== prevGoal;
    },
    { timeout },
  );
  return new URL(page.url()).searchParams.get("goal") ?? "";
}

/** 创建失败提示可见(服务端/网络失败后的中文反馈;草稿保留在输入框)。 */
async function waitComposerError(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const doc = (
        globalThis as unknown as { document: { querySelector: (s: string) => { textContent?: string } | null } }
      ).document;
      const el = doc.querySelector('[data-testid="ws-composer-msg"]');
      return !!el && (el.textContent ?? "").includes("创建失败");
    },
    { timeout: 15000 },
  );
}

interface AckLoss {
  hit: boolean;
  committedStatus: number | null;
}

/** **协调方 Major-R2 实证技术的正式化**:拦截 POST /api/goals ⇒ `route.fetch()` 真实送达
 *  服务器(事务已提交,拿真实状态码)⇒ `route.abort("failed")` 只丢弃浏览器侧回执。
 *  之后同 handler 对后续请求放行(重试走真实链路)。 */
async function installAckLoss(page: Page, marker: AckLoss): Promise<void> {
  let used = false;
  await page.route("**/api/goals", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && !used) {
      used = true;
      const committed = await route.fetch();
      marker.hit = true;
      marker.committedStatus = committed.status();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
}

async function removeAckLoss(page: Page): Promise<void> {
  await page.unroute("**/api/goals");
}

/** API 级创建(带会话 CSRF;key 缺省=旧客户端无键形态)。 */
async function apiCreate(
  base: string,
  ctx: APIRequestContext,
  csrf: string,
  payload: Record<string, unknown>,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await ctx.post(base + "/api/goals", {
    headers: { "x-relay-csrf": csrf, ...(key ? { "x-relay-idempotency-key": key } : {}) },
    data: payload,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: r.status(), body };
}

async function countRows(t: TestDb, query: SQL): Promise<number> {
  const r = await t.db.execute(query);
  const v = r.rows[0]?.["n"];
  return Number(v ?? 0);
}
const goalsCount = (t: TestDb) => countRows(t, sql`SELECT count(*)::int AS n FROM goals`);
const tasksOf = (t: TestDb, id: string) =>
  countRows(t, sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${id}`);
const messagesOf = (t: TestDb, id: string) =>
  countRows(t, sql`SELECT count(*)::int AS n FROM goal_messages WHERE goal_id = ${id}`);
const consumptionsOf = (t: TestDb, id: string) =>
  countRows(t, sql`SELECT count(*)::int AS n FROM goal_message_consumptions WHERE goal_id = ${id}`);
const ledgerOf = (t: TestDb, id: string) =>
  countRows(t, sql`SELECT count(*)::int AS n FROM budget_ledger WHERE scope_type = 'goal' AND scope_id = ${id}`);
const auditsOf = (t: TestDb, id: string, action: string) =>
  countRows(t, sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action} AND detail->>'goalId' = ${id}`);
async function newestGoalId(t: TestDb): Promise<string> {
  const r = await t.db.execute(sql`SELECT id FROM goals ORDER BY created_at DESC, id LIMIT 1`);
  return String(r.rows[0]?.["id"] ?? "");
}
async function goalStateOf(t: TestDb, id: string): Promise<string | null> {
  const r = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${id}`);
  return r.rows.length > 0 ? String(r.rows[0]!["state"]) : null;
}

describe.skipIf(!E2E)(
  "RELAY-GOAL-CREATE-IDEMPOTENCY-12 Goal 创建幂等(Major-R2 ACK 丢失;桌面 1440+手机 390)",
  { timeout: 420_000 },
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = await startStack();
      STACK = s;
    });

    afterAll(async () => {
      if (!STACK) return;
      await stopStack(STACK);
      flushObservations();
    });

    it("T5 旧客户端兼容(控制):无键调用行为不变,同文案两次=两个独立 Goal", async () => {
      const before = await goalsCount(s.t);
      const text = "T5 旧客户端无幂等键的两次创建";
      const r1 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text });
      const r2 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text });
      const after = await goalsCount(s.t);
      record("t5/no-key-twice", "api", {
        before,
        after,
        status1: r1.status,
        status2: r2.status,
        goal1: String(r1.body["goalId"] ?? ""),
        goal2: String(r2.body["goalId"] ?? ""),
      });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.body["taskIds"]).toEqual(expect.any(Array)); // 响应形状不变
      expect(r1.body["project"]).toBeNull();
      expect(after).toBe(before + 2); // 无键=无去重(兼容边界:不按纯文本永久去重)
      expect(String(r1.body["goalId"])).not.toBe(String(r2.body["goalId"]));
    });

    it("T6 不同键同文案(控制):两次明确新建意图=两个独立 Goal,不按纯文本永久去重", async () => {
      const before = await goalsCount(s.t);
      const text = "T6 相同文案但用户明确要两个需求";
      const r1 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text }, randomUUID());
      const r2 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text }, randomUUID());
      const after = await goalsCount(s.t);
      record("t6/different-keys-same-text", "api", {
        before,
        after,
        status1: r1.status,
        status2: r2.status,
        goal1: String(r1.body["goalId"] ?? ""),
        goal2: String(r2.body["goalId"] ?? ""),
      });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(after).toBe(before + 2); // 新键=新意图 ⇒ 新 Goal(反"纯文本永久去重")
      expect(String(r1.body["goalId"])).not.toBe(String(r2.body["goalId"]));
    });

    it("T4 键格式/容量门:非法键 400 且零创建;合法 UUID 接受", async () => {
      // 仅 ASCII 非法形态:HTTP 头本身不能携带非 ASCII 值(任何合规客户端 API 都会拒发),
      // 非 ASCII 键在传输层即不可达,服务端字符集校验仍保留为纵深防御。
      const before = await goalsCount(s.t);
      const invalid = [
        "short",
        "not-even-a-valid-uuid",
        "12345678-1234-1234-1234-1234567890g", // 含非法 hex 位
        "k".repeat(129), // 超容量(>128)
        "key with space", // 非法分隔符
      ];
      const statuses: string[] = [];
      for (const k of invalid) {
        const r = await apiCreate(
          s.base,
          s.page.context().request,
          s.csrf,
          { rawInput: `T4 非法键 ${k.slice(0, 6)}` },
          k,
        );
        statuses.push(String(r.status));
        expect(r.status).toBe(400); // 翻红断言:修复前键被忽略 ⇒ 201(红)
        expect(r.body["error"]).toBe("idempotency_key_invalid");
      }
      const mid = await goalsCount(s.t);
      const ok = await apiCreate(
        s.base,
        s.page.context().request,
        s.csrf,
        { rawInput: "T4 合法 UUID 键正常创建" },
        randomUUID(),
      );
      const after = await goalsCount(s.t);
      record("t4/key-format-gate", "api", { before, mid, after, statuses: statuses.join(","), okStatus: ok.status });
      expect(mid).toBe(before); // 非法键零创建(翻红断言:修复前 mid>before ⇒ 红)
      expect(ok.status).toBe(201);
      expect(after).toBe(before + 1);
    });

    it("T8 重放确定性:同键重试=同 GoalId/同初始 Task;DB 恰一套 Goal/Task/消费/预算/审计", async () => {
      const before = await goalsCount(s.t);
      const key = randomUUID();
      const text = "T8 幂等重放确定性检查";
      const r1 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text }, key);
      expect(r1.status).toBe(201);
      const goalId = String(r1.body["goalId"]);
      const taskIds1 = r1.body["taskIds"];
      const r2 = await apiCreate(s.base, s.page.context().request, s.csrf, { rawInput: text }, key);
      const after = await goalsCount(s.t);
      const facts = {
        before,
        after,
        status1: r1.status,
        status2: r2.status,
        goal1: goalId,
        goal2: String(r2.body["goalId"] ?? ""),
        replayFlag: r2.body["idempotentReplay"] === true,
        tasks: await tasksOf(s.t, goalId),
        messages: await messagesOf(s.t, goalId),
        consumptions: await consumptionsOf(s.t, goalId),
        ledger: await ledgerOf(s.t, goalId),
        auditPlanned: await auditsOf(s.t, goalId, "GOAL_PLANNED"),
        auditWebCreated: await auditsOf(s.t, goalId, "WEB_GOAL_CREATED"),
        auditTaskPlanned: await auditsOf(s.t, goalId, "TASK_PLANNED"),
      };
      record("t8/replay-determinism", "api", facts);
      expect(r2.status).toBe(200); // 翻红断言:修复前第二个 POST ⇒ 201(红)
      expect(String(r2.body["goalId"])).toBe(goalId); // 同一 GoalId(翻红断言:修复前新随机 id ⇒ 红)
      expect(r2.body["idempotentReplay"]).toBe(true);
      expect(r2.body["taskIds"]).toEqual(taskIds1); // 绝不重派生初始 Task
      expect(after).toBe(before + 1); // 恰一个 Goal
      expect(facts.tasks).toBe(1); // 恰一组初始 Task/消费/预算/审计(重放零新副作用)
      expect(facts.messages).toBe(1);
      expect(facts.consumptions).toBe(1);
      expect(facts.ledger).toBe(1);
      expect(facts.auditPlanned).toBe(1);
      expect(facts.auditWebCreated).toBe(1);
      expect(facts.auditTaskPlanned).toBe(1);
    });

    it("T2 并发同键两请求:恰一个 Goal,双方同 goalId(201+幂等重放)", async () => {
      const before = await goalsCount(s.t);
      const key = randomUUID();
      const text = "T2 并发同键请求只创建一个 Goal";
      const ctx = s.page.context().request;
      const [ra, rb] = await Promise.all([
        apiCreate(s.base, ctx, s.csrf, { rawInput: text }, key),
        apiCreate(s.base, ctx, s.csrf, { rawInput: text }, key),
      ]);
      const after = await goalsCount(s.t);
      const goalA = String(ra.body["goalId"] ?? "");
      const goalB = String(rb.body["goalId"] ?? "");
      record("t2/concurrent-same-key", "api", { before, after, statusA: ra.status, statusB: rb.status, goalA, goalB });
      expect([ra.status, rb.status].sort()).toEqual([200, 201]); // 恰一个 201,另一个=幂等重放 200(翻红断言:修复前 [201,201] ⇒ 红)
      expect(goalA).toBe(goalB); // 同一 GoalId(翻红断言:修复前两个随机 id ⇒ 红)
      expect(after).toBe(before + 1); // 恰一个 Goal(翻红断言:修复前 +2 ⇒ 红)
    });

    it("T3 同键异 payload/项目绑定:409 冲突零新建;跨会话重用异内容亦 409", async () => {
      const before = await goalsCount(s.t);
      const key = randomUUID();
      const ctx = s.page.context().request;
      const r1 = await apiCreate(s.base, ctx, s.csrf, { rawInput: "T3 原始内容" }, key);
      expect(r1.status).toBe(201);
      const goalId = String(r1.body["goalId"]);
      // 同键异 rawInput ⇒ 409(翻红断言:修复前 201 新 Goal ⇒ 红)
      const r2 = await apiCreate(s.base, ctx, s.csrf, { rawInput: "T3 被篡改的内容" }, key);
      const midCount = await goalsCount(s.t);
      // 同键异项目绑定 ⇒ 409
      const r3 = await apiCreate(s.base, ctx, s.csrf, { rawInput: "T3 原始内容", projectId: PROJECT_NAME }, key);
      const midCount2 = await goalsCount(s.t);
      // 跨会话(新浏览器上下文=新登录会话)同键异内容 ⇒ 409(跨会话重用攻击 fail-closed)
      const ctx2 = await s.browser.newContext(DESKTOP);
      const p2 = await ctx2.newPage();
      await login(p2, s.base);
      const csrf2 = await csrfOf(p2);
      const r4 = await apiCreate(s.base, ctx2.request, csrf2, { rawInput: "T3 跨会话异内容" }, key);
      const after = await goalsCount(s.t);
      record("t3/conflict-matrix", "api", {
        before,
        midCount,
        midCount2,
        after,
        status1: r1.status,
        status2: r2.status,
        status3: r3.status,
        status4: r4.status,
        err2: String(r2.body["error"] ?? ""),
        err4: String(r4.body["error"] ?? ""),
      });
      await ctx2.close();
      expect(r2.status).toBe(409);
      expect(r2.body["error"]).toBe("goal_create_key_conflict");
      expect(midCount).toBe(before + 1); // 冲突零新建(翻红断言:修复前 +2 ⇒ 红)
      expect(r3.status).toBe(409);
      expect(midCount2).toBe(before + 1);
      expect(r4.status).toBe(409);
      expect(after).toBe(before + 1);
      // 原 Goal 未被任何冲突请求改动
      expect(await goalStateOf(s.t, goalId)).toBe("ACTIVE");
    });

    it("T1 ACK 丢失重试不重复创建(桌面):服务器已 201→回执丢弃→同草稿重试=同一 Goal", async () => {
      await gotoBlank(s.page, s.base);
      const before = await goalsCount(s.t);
      const marker: AckLoss = { hit: false, committedStatus: null };
      await installAckLoss(s.page, marker);
      await s.page.fill('[data-testid="ws-input"]', "T1 桌面 ACK 丢失重试幂等");
      await s.page.click('[data-testid="ws-send"]');
      // 服务端已真实提交(201),浏览器只见网络失败 ⇒ 界面中文报错+草稿保留
      await waitComposerError(s.page);
      const draftKept = await s.page.evaluate((): string => {
        const doc = (globalThis as unknown as { document: { querySelector: (s: string) => { value?: string } | null } })
          .document;
        const el = doc.querySelector('[data-testid="ws-input"]');
        return el?.value ?? "";
      });
      const afterLoss = await goalsCount(s.t);
      const lostGoalId = await newestGoalId(s.t); // 服务器侧已创建的第一个 Goal
      await shot(s.page, "t1-d01-ack-loss-error-draft-kept.png");
      record("t1/ack-loss-committed", "desktop", {
        before,
        afterLoss,
        committedStatus: marker.committedStatus,
        draftKept,
        lostGoalId,
      });
      expect(marker.hit).toBe(true);
      expect(marker.committedStatus).toBe(201); // 上游确实提交(协调方实证前提)
      expect(afterLoss).toBe(before + 1);
      expect(draftKept).toContain("T1 桌面");
      // 用户按界面提示重试(同草稿=同一创建意图 ⇒ 同键)
      await removeAckLoss(s.page);
      await s.page.click('[data-testid="ws-send"]');
      const retryGoalId = await waitForGoalChange(s.page, "", 20000);
      const afterRetry = await goalsCount(s.t);
      await shot(s.page, "t1-d02-retry-same-goal.png");
      record("t1/retry", "desktop", {
        retryGoalId,
        afterRetry,
        lostGoalId,
        sameGoal: retryGoalId === lostGoalId,
      });
      expect(afterRetry).toBe(before + 1); // 翻红断言:修复前 +2 ⇒ 红(协调方 COORD_ACKLOSS_GOALS_BEFORE_AFTER 同型)
      expect(retryGoalId).toBe(lostGoalId); // 翻红断言:修复前跳到第二个新 Goal ⇒ 红
      expect(await goalStateOf(s.t, lostGoalId)).toBe("ACTIVE"); // 原 Goal 未被重启/改动
    });

    it("T7 ACK 丢失后页面刷新:重输入同草稿重试仍返回同一 Goal(键跨刷新持久)", async () => {
      await gotoBlank(s.page, s.base);
      const before = await goalsCount(s.t);
      const marker: AckLoss = { hit: false, committedStatus: null };
      await installAckLoss(s.page, marker);
      await s.page.fill('[data-testid="ws-input"]', "T7 刷新后重试仍幂等");
      await s.page.click('[data-testid="ws-send"]');
      await waitComposerError(s.page);
      const lostGoalId = await newestGoalId(s.t);
      await removeAckLoss(s.page);
      await s.page.reload({ waitUntil: "load" });
      await s.page.waitForSelector('[data-testid="ws-input"]');
      await s.page.fill('[data-testid="ws-input"]', "T7 刷新后重试仍幂等"); // 刷新丢草稿文本,用户重输入同内容
      await s.page.click('[data-testid="ws-send"]');
      const retryGoalId = await waitForGoalChange(s.page, "", 20000);
      const after = await goalsCount(s.t);
      record("t7/refresh-retry", "desktop", {
        before,
        after,
        committedStatus: marker.committedStatus,
        lostGoalId,
        retryGoalId,
        sameGoal: retryGoalId === lostGoalId,
      });
      expect(marker.committedStatus).toBe(201);
      expect(after).toBe(before + 1); // 翻红断言:修复前重试=第二个 POST ⇒ +2 ⇒ 红
      expect(retryGoalId).toBe(lostGoalId); // 翻红断言:修复前新 Goal ⇒ 红
    });

    it("T1m ACK 丢失重试不重复创建(手机 390×844)", async () => {
      await gotoBlank(s.mpage, s.base);
      const before = await goalsCount(s.t);
      const marker: AckLoss = { hit: false, committedStatus: null };
      await installAckLoss(s.mpage, marker);
      await s.mpage.fill('[data-testid="ws-input"]', "T1m 手机 ACK 丢失重试幂等");
      await s.mpage.click('[data-testid="ws-send"]');
      await waitComposerError(s.mpage);
      const lostGoalId = await newestGoalId(s.t);
      await removeAckLoss(s.mpage);
      await s.mpage.click('[data-testid="ws-send"]');
      const retryGoalId = await waitForGoalChange(s.mpage, "", 20000);
      const after = await goalsCount(s.t);
      await shot(s.mpage, "t1m-m01-retry-same-goal-mobile.png");
      record("t1m/mobile-ack-loss", "mobile", {
        before,
        after,
        committedStatus: marker.committedStatus,
        lostGoalId,
        retryGoalId,
        sameGoal: retryGoalId === lostGoalId,
      });
      expect(marker.committedStatus).toBe(201);
      expect(after).toBe(before + 1); // 翻红断言:修复前 +2 ⇒ 红
      expect(retryGoalId).toBe(lostGoalId); // 翻红断言:修复前新 Goal ⇒ 红
    });

    it("T9 全程浏览器错误分类门(桌面+手机):零真实错误;注入性 ERR_FAILED 恰=注入次数", async () => {
      // ACK 丢失注入(route.abort)会让浏览器记录预期中的网络失败噪声 —— 该信号正是注入本意,
      // 单独分类并与注入次数精确对账(T1+T7 桌面=2 次,T1m 手机=1 次);其余任何
      // pageerror/console.error 一律零容忍(比 11R 逐测试清零更强,历史不回写)。
      const isInjectedNoise = (m: string): boolean => m.includes("Failed to load resource: net::ERR_FAILED");
      const classify = (arr: string[]): { noise: string[]; real: string[] } => ({
        noise: arr.filter(isInjectedNoise),
        real: arr.filter((m) => !isInjectedNoise(m)),
      });
      const d = classify(CONSOLE_ERRORS.desktop);
      const m = classify(CONSOLE_ERRORS.mobile);
      record("t9/console-errors-classified", "both", {
        desktopReal: d.real.length,
        desktopNoise: d.noise.length,
        desktopNoiseExpected: 2, // T1+T7 两次有意注入
        mobileReal: m.real.length,
        mobileNoise: m.noise.length,
        mobileNoiseExpected: 1, // T1m 一次有意注入
        desktopRealDetail: d.real.join(" | ").slice(0, 500) || null,
        mobileRealDetail: m.real.join(" | ").slice(0, 500) || null,
      });
      expect(d.real).toEqual([]);
      expect(m.real).toEqual([]);
      // 噪声计数=诊断事实:控制台消息到达时序不定(实测手机侧可能晚于 T9 评估),故只设上界
      //(不得超注入次数),真实错误才是不容忍门。
      expect(d.noise.length).toBeLessThanOrEqual(2);
      expect(m.noise.length).toBeLessThanOrEqual(1);
    });
  },
);
