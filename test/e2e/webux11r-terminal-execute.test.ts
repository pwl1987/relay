// RELAY-WEB-UX-ACCEPTANCE-11R 终态/暂停态「交给 Relay 执行」误导(Major-U1)红绿 harness。
// 真实 Web 实现(同一 web/ 静态资源与 server 代码)+ 隔离合成环境(独立测试 schema + 确定性 stub;
// 非真实模型)+ 真实 Chromium 双视口(桌面 1440×900 / 手机 390×844)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
// 产出(按 WEBUX11R_TAG 区分轮次):
//   p0-mvp/web-ux-acceptance-11/11R/screenshots/<TAG>/*.png —— 新鲜真实截图(红轮/绿轮各一轮)
//   p0-mvp/web-ux-acceptance-11/11R/evidence/webux11r-terminal-execute-<TAG>.json —— 逐步骤结构化观察
// 轮次分离(11 包 Reviewer Minor-M2 教训反向应用):**缺省 TAG=ci(回归安全)**;证据轮必须显式
//   WEBUX11R_TAG=audit-red(修复前红态)/verify(修复后绿态)——缺省值绝不覆盖证据轮产物。
//   内含本 harness 的全量 e2e 回归复跑缺省即落 ci/,历史证据零覆盖。
// 被测事实(合同 11R B/C;协调方 Major-U1):
//   - 修复前:任何有 goalId 的页面(含 COMPLETED/FAILED/PAUSED)都显示可点击「交给 Relay 执行」;
//     点击仅 POST /api/goals/:id/messages{executionRequest:true},服务端对非 ACTIVE Goal 一律
//     held:true/followUpTaskId:null(只记录不派生)——按钮承诺"执行"却静默不执行=误导。
//   - 修复后(ACTIVE 不变;PAUSED=恢复指引;终态=显式「新建后续任务」):
//     ACTIVE 仍双操作(发送=只记录/交给 Relay 执行=显式授权,派生受控 Task);
//     终态(COMPLETED/FAILED/EXHAUSTED 等非活动态)执行按钮替换为「新建后续任务」
//     (复用既有 POST /api/goals 创建入口:项目归属由用户在行内项目选择器显式选定/沿用预选,
//     服务端按注册表校验;旧 Goal 历史不重启、消息不丢);
//     PAUSED 不显示任何执行/新建入口,给中文恢复指引,不自动恢复。
//   - 后端 fail-closed/终态禁止静默重开是正确安全边界,绝不改:本 harness 同断言
//     非活动 Goal 上显式执行请求 ⇒ held:true + 零 Task 派生 + Goal 状态不变(红绿轮均通过)。
// 隔离与边界:RELAY_PROJECTS_FILE 指向一次性合成注册表(绝不读取受保护 config/projects.json);
//   数据全部合成;零生产连接/零真实模型/零外部交付(target=本地 bare 远端夹具)。
// PAUSED 夹具说明:当前代码无 goal 级 PAUSED 置入路径(goals.state 枚举 ACTIVE|PAUSED|EXHAUSTED|
//   COMPLETED|FAILED,现役聚合只产出 COMPLETED/FAILED;PAUSED 的服务端 held 分支真实存在,
//   api.ts goalState==="PAUSED" ⇒ stateLabel"该需求会话已暂停")——故 PAUSED Goal 由本 harness
//   在隔离 schema 内直接构造(任务同步 READY→PAUSED,ops 合法转移,防误领取),如实登记。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// 11 教训(M2)反向应用:缺省=ci(回归安全);证据轮显式 audit-red/verify。
const TAG = process.env.WEBUX11R_TAG ?? "ci";
const OUT_DIR = join(process.cwd(), "p0-mvp", "web-ux-acceptance-11", "11R");
const SHOT_DIR = join(OUT_DIR, "screenshots", TAG);
const EVIDENCE_DIR = join(OUT_DIR, "evidence");
const PASSWORD = "e2e-password-webux11r";
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
  mobile: BrowserContext; // 手机上下文(390×844)
  errors: { desktop: string[]; mobile: string[] };
}

/** 逐步骤观察收集(红轮=Major-U1 可证伪反例证据源;绿轮=修后对照)。 */
const OBS: Obs[] = [];
function record(step: string, viewport: string, facts: Obs["facts"], page?: Page): void {
  OBS.push({ step, viewport, ...(page ? { url: page.url() } : {}), facts });
}

/** 全程浏览器错误收集(双栈共享同一对象;JSON 最终=全量)。 */
const CONSOLE_ERRORS: { desktop: string[]; mobile: string[] } = { desktop: [], mobile: [] };

/** 两个 describe 的 afterAll 统一落盘(最终 JSON=全量 OBS 覆盖写;11 包 M1 同款)。 */
function flushObservations(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, `webux11r-terminal-execute-${TAG}.json`),
    JSON.stringify(
      {
        tag: TAG,
        contract: "RELAY-WEB-UX-ACCEPTANCE-11R",
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

async function startStack(label: string, opts: { stubMode?: string; withProject?: boolean } = {}): Promise<Stack> {
  const t = await createTestDb(`webux11r-e2e-${label}`);
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
    workerId: `e2e-worker-webux11r-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    // stubMode="exit-mid" ⇒ coder 桩进程 prompt 后立即退出(web-journey J3/11 包 D4 同款确定性失败链)
    // ⇒ Run FAILED(rpc_disconnect)→ REWORK 退避 → attempt 预算耗尽 ⇒ 任务 FAILED(失败终态 UI 面)
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: opts.stubMode ?? "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
      reviewerEnv: {
        STUB_MODE: "verdict",
        STUB_VERDICT: "PASS",
        STUB_FINDINGS: "webux11r e2e 独立审查通过",
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
    stageBaseDir: mkdtempSync(join(tmpdir(), "webux11r-stage-")),
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
    return { ctx, page };
  };
  const s: Stack = {
    t,
    server,
    base,
    browser,
    page: null as unknown as Page,
    mobile: null as unknown as BrowserContext,
    errors: CONSOLE_ERRORS,
  };
  s.page = (await mkPage(DESKTOP, "desktop")).page;
  s.mobile = (await mkPage(MOBILE, "mobile")).ctx;
  // 一次性合成项目注册表(绝不指向受保护 config/projects.json;withProject=true 时含一个合成项目,
  // 供终态后续任务的项目选择/服务端注册表校验负例使用;path=一次性 tmp 目录)
  const reg = join(mkdtempSync(join(tmpdir(), "webux11r-reg-")), "projects.json");
  const projectDir = mkdtempSync(join(tmpdir(), "webux11r-proj-"));
  writeFileSync(
    reg,
    JSON.stringify(
      opts.withProject ? { configured: true, projects: [{ name: PROJECT_NAME, path: projectDir }] } : { projects: [] },
    ),
  );
  process.env["RELAY_PROJECTS_FILE"] = reg;
  (s as Stack & { registryPath: string }).registryPath = reg;
  return s;
}

/** 每任务独立 bare 远端(03C.1 夹具修正同源;11 包同款)。 */
function deliveryFactory(): DeliveryFactory {
  const remoteBase = mkdtempSync(join(tmpdir(), "webux11r-remote-"));
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
        actor: "e2e-webux11r",
      };
    },
    io: async (c) => ({
      executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha: string) => {
        const scratch = mkdtempSync(join(tmpdir(), "webux11r-verify-"));
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

/** 工作区新建任务(单 Composer:空白态=项目+一句话+「开始」)。等待 URL goal 参数真正变化。
 *  页面归一化:前一测试可能停在 system.html 等非工作区页(失败级联防护),先归位再建。 */
async function createGoalViaWorkspace(page: Page, base: string, rawInput: string, project?: string): Promise<string> {
  const u = new URL(page.url());
  if (!u.pathname.startsWith("/workspace")) {
    await page.goto(`${base}/workspace`, { waitUntil: "load" });
  }
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) {
    await page.click('[data-testid="ws-new-task"]');
    await page.waitForURL(/\/workspace$/);
  }
  await page.waitForSelector('[data-testid="ws-input"]');
  if (project) {
    // 项目选项为异步填充(populateProjectSelect):先等目标选项在场再选
    await page.waitForFunction(
      (want: string) => {
        const doc = (
          globalThis as unknown as {
            document: { querySelector: (s: string) => { options?: Array<{ value: string }> } | null };
          }
        ).document;
        const sel = doc.querySelector('[data-testid="ws-project"]');
        return !!sel && Array.from(sel.options ?? []).some((o) => o.value === want);
      },
      project,
      { timeout: 15000 },
    );
    await page.selectOption('[data-testid="ws-project"]', project);
  }
  await page.fill('[data-testid="ws-input"]', rawInput);
  await page.click('[data-testid="ws-send"]');
  await page.waitForFunction(
    (p: string | null) => {
      const doc = (globalThis as unknown as { document: { location: { search: string } } }).document;
      const g = new URLSearchParams(doc.location.search).get("goal");
      return g !== null && g !== p;
    },
    prev,
    { timeout: 20000 },
  );
  return new URL(page.url()).searchParams.get("goal") ?? "";
}

/** 手机新建任务(03D §5 同款):回空白工作区走 URL 导航——「＋新建任务」在抽屉内,
 *  手机空白态该按钮不在视口(点击会挂起),直接 goto 等价。 */
async function createGoalViaWorkspaceMobile(page: Page, base: string, rawInput: string): Promise<string> {
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) {
    await page.goto(`${base}/workspace`, { waitUntil: "load" });
  }
  await page.waitForSelector('[data-testid="ws-input"]');
  await page.fill('[data-testid="ws-input"]', rawInput);
  await page.click('[data-testid="ws-send"]');
  await page.waitForFunction(
    (p: string | null) => {
      const doc = (globalThis as unknown as { document: { location: { search: string } } }).document;
      const g = new URLSearchParams(doc.location.search).get("goal");
      return g !== null && g !== p;
    },
    prev,
    { timeout: 20000 },
  );
  return new URL(page.url()).searchParams.get("goal") ?? "";
}

/** 页面内后台推进一拍(fire-and-forget;csrf 经 RelayApp.state)。 */
function tickInBackground(page: Page): void {
  void page.evaluate((): string => {
    const A = (globalThis as unknown as { RelayApp: { state: { csrf: string } } }).RelayApp;
    void fetch("/api/worker/tick", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-relay-csrf": A.state.csrf || "" },
      body: "{}",
    });
    return "fired";
  });
}

/** 推进任务到目标态:轮询 DB;状态停滞 >10s 时补发一拍(stub 单拍=完整链路;并发 tick 有租约守卫,幂等)。 */
async function driveUntil(page: Page, t: TestDb, taskId: string, target: string, maxMs = 120_000): Promise<void> {
  const start = Date.now();
  let lastChange = Date.now();
  let last = "";
  while (Date.now() - start < maxMs) {
    const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    const st = String(r.rows[0]!["state"]);
    if (st === target) return;
    if (st !== last) {
      last = st;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 10_000) {
      tickInBackground(page);
      lastChange = Date.now();
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`task ${taskId} 未到达 ${target}(最后状态 ${last})`);
}

/** 推进 Goal 到目标态(聚合状态;停滞补拍同上)。 */
async function driveGoalUntil(page: Page, t: TestDb, goalId: string, target: string, maxMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastChange = Date.now();
  let last = "";
  while (Date.now() - start < maxMs) {
    const r = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    const st = String(r.rows[0]?.["state"] ?? "");
    if (st === target) return;
    if (st !== last) {
      last = st;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 10_000) {
      tickInBackground(page);
      lastChange = Date.now();
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`goal ${goalId} 未到达 ${target}(最后状态 ${last})`);
}

/** Goal 任务数(隔离 schema 直查)。 */
async function taskCountOf(t: TestDb, goalId: string): Promise<number> {
  const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
  return Number(r.rows[0]!["n"]);
}

/** 全库 Goal 数(API 面;鉴权经浏览器 cookie jar)。 */
async function goalsCount(page: Page, base: string): Promise<number> {
  const res = await page.context().request.get(`${base}/api/goals`);
  const j = (await res.json()) as { goals?: unknown[] };
  return (j.goals ?? []).length;
}

/** Goal feed 消息条数(旧 Goal「消息不丢」断言面)。 */
async function feedCount(page: Page, base: string, goalId: string): Promise<number> {
  const res = await page.context().request.get(`${base}/api/goals/${goalId}/feed`);
  const j = (await res.json()) as { feed?: { items?: unknown[] } };
  return (j.feed?.items ?? []).length;
}

/** 逐步骤关键事实采集(文案/控件状态/几何/goalState)。 */
async function captureFacts(page: Page): Promise<Obs["facts"]> {
  const get = async (sel: string, attr = "textContent"): Promise<string | null> => {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return null;
    return attr === "textContent" ? ((await loc.textContent()) ?? null) : ((await loc.getAttribute(attr)) ?? null);
  };
  const projectSel = page.locator('[data-testid="ws-project"]');
  const projectOptionCount = (await projectSel.count()) > 0 ? await projectSel.locator("option").count() : 0;
  const composerBox = await page.locator('[data-testid="ws-composer"]').boundingBox();
  const vp = page.viewportSize();
  const followBtn = page.locator('[data-testid="ws-followup"]');
  return {
    goalState: await page.evaluate(async (): Promise<string | null> => {
      // 注:workspace.js 的 state 是模块内本地对象(不经 window.RelayApp 暴露),无法从页面直读;
      // 此处以同源服务端真值 /api/goals/:id/status 为准(与 UI renderComposer 所用 state.status 同源)。
      try {
        const doc = (globalThis as unknown as { document: { location: { search: string } } }).document;
        const gid = new URLSearchParams(doc.location.search).get("goal");
        if (!gid) return null;
        const r = await fetch("/api/goals/" + gid + "/status", { credentials: "same-origin" });
        const j = (await r.json()) as { status?: { goalState?: string } | null };
        return j && j.status && j.status.goalState ? String(j.status.goalState) : null;
      } catch {
        return null;
      }
    }),
    heroTitle: await get('[data-testid="ws-feed"] .ws-hero-title'),
    sidebarText: (await get('[data-testid="ws-sidebar"]'))?.slice(0, 300) ?? null,
    title: await get("#ws-title"),
    inputPlaceholder: await get('[data-testid="ws-input"]', "placeholder"),
    inputValue:
      (await page.locator('[data-testid="ws-input"]').count()) > 0
        ? await page.locator('[data-testid="ws-input"]').inputValue()
        : null,
    sendLabel: await get('[data-testid="ws-send"]'),
    executeVisible:
      (await page
        .locator('[data-testid="ws-execute"]')
        .isVisible()
        .catch(() => false)) || false,
    executeLabel: await get('[data-testid="ws-execute"]'),
    followupVisible: (await followBtn.isVisible().catch(() => false)) || false,
    followupLabel: (await followBtn.count()) > 0 ? ((await followBtn.textContent()) ?? null) : null,
    followupHeight:
      (await followBtn.count()) > 0 ? await followBtn.evaluate((el) => el.getBoundingClientRect().height) : null,
    stateHintVisible:
      (await page
        .locator('[data-testid="ws-state-hint"]')
        .isVisible()
        .catch(() => false)) || false,
    stateHintText: await get('[data-testid="ws-state-hint"]'),
    composerMsgText: await get('[data-testid="ws-composer-msg"]'),
    projectSelectVisible:
      (await page
        .locator('[data-testid="ws-composer-project"]')
        .isVisible()
        .catch(() => false)) || false,
    projectOptionCount,
    projectSelected: (await projectSel.count()) > 0 ? await projectSel.inputValue() : null,
    feedText: (await get('[data-testid="ws-feed"]'))?.slice(0, 1200) ?? null,
    workBlockText: await get('[data-testid="ws-work-block"]'),
    resultCardText: await get('[data-testid="ws-result-card"]'),
    composerBottomGap: composerBox && vp ? Math.round(vp.height - (composerBox.y + composerBox.height)) : null,
    horizontalOverflow:
      (vp &&
        (await page.evaluate((maxWidth: number): number => {
          const doc = (
            globalThis as unknown as {
              document: { documentElement: { scrollWidth: number }; body: { scrollWidth: number } };
            }
          ).document;
          return Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth) - maxWidth;
        }, vp.width))) ||
      null,
  };
}

describe.skipIf(!E2E)(
  "WEB-UX-11R 终态/暂停态执行按钮(Major-U1;ok 栈=COMPLETED/PAUSED/ACTIVE 正例;桌面 1440+手机 390)",
  { timeout: 420_000 },
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = await startStack("terminal-ok", { withProject: true });
    });
    afterAll(async () => {
      await stopStack(s);
      flushObservations();
    });

    it("T1 COMPLETED 桌面:可证伪反例(点击执行=静默 held)+修后钉住(执行按钮退场/新建后续任务在场)", async () => {
      const { page, base, t } = s;
      await login(page, base);
      const goalId = await createGoalViaWorkspace(page, base, "11R-T1:正常完成的登录页优化需求");
      expect(goalId).toBeTruthy();
      await page.goto(`${base}/system.html`, { waitUntil: "load" });
      await page.click('[data-testid="btn-tick"]');
      await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      await driveUntil(page, t, String(taskRow.rows[0]!["id"]), "ACCEPTED");
      await driveGoalUntil(page, t, goalId, "COMPLETED");
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      const facts = await captureFacts(page);
      record("t1-completed-terminal-facts", "desktop", facts, page);
      await shot(page, "r01-completed-terminal.png");
      expect(facts.goalState).toBe("COMPLETED");
      expect(facts.resultCardText ?? "").toContain("已完成本轮工作");

      // ===== 修复前形态(Major-U1 可证伪反例;红轮证据源) =====
      // 终态仍有「交给 Relay 执行」蓝按钮;点击仅得 held:true(零 Task 派生、零新 Goal、旧 Goal 不变)。
      if (facts.executeVisible) {
        const goalsBefore = await goalsCount(page, base);
        const feedBefore = await feedCount(page, base, goalId);
        const respPromise = page.waitForResponse(
          (r) => r.url().includes(`/api/goals/${goalId}/messages`) && r.request().method() === "POST",
        );
        await page.fill('[data-testid="ws-input"]', "先点一下执行看看会发生什么");
        await page.click('[data-testid="ws-execute"]');
        const resp = await respPromise;
        const body = (await resp.json()) as { held?: boolean; followUpTaskId?: string | null; note?: string };
        record(
          "t1-executed-but-held",
          "desktop",
          {
            httpStatus: resp.status(),
            held: body.held ?? null,
            followUpTaskId: body.followUpTaskId ?? null,
            note: body.note ?? null,
            buttonLabel: facts.executeLabel ?? null,
            goalsBefore,
            goalsAfter: await goalsCount(page, base),
            feedAfter: await feedCount(page, base, goalId),
          },
          page,
        );
        await shot(page, "r02-completed-executed-but-held.png");
        // 后端 fail-closed 负例(红绿轮均须通过——后端边界不变,问题纯在前端误导):
        expect(body.held).toBe(true);
        expect(body.followUpTaskId ?? null).toBeNull();
        expect(await goalsCount(page, base)).toBe(goalsBefore); // 零新 Goal
        expect(await feedCount(page, base, goalId)).toBeGreaterThan(feedBefore); // 只追加消息
        await driveGoalUntil(page, t, goalId, "COMPLETED"); // Goal 未被静默重启
      } else {
        record("t1-terminal-execute-hidden", "desktop", { note: "修后:终态无执行按钮(绿轮形态)" }, page);
      }

      // ===== 修复钉住(先红后绿;红轮恰在此失败) =====
      expect(facts.executeVisible).toBe(false); // 终态不得再承诺「执行」(红=true ⇒ FAIL)
      expect(facts.followupVisible).toBe(true); // 显式后续任务入口在场(红=false ⇒ FAIL)
      expect(facts.followupLabel).toBe("新建后续任务");
      expect(facts.stateHintVisible).toBe(false); // 终态无「暂停」暗示
      s.errors.desktop.length = 0;
    });

    it("T2 终态新建后续任务全流程(未绑定 Goal):显式创建新 Goal、旧 Goal 历史不重启、重复点击/空文本/服务端报错 fail-closed", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, base, "11R-T2A:结果卡片文案优化需求");
      await page.goto(`${base}/system.html`, { waitUntil: "load" });
      await page.click('[data-testid="btn-tick"]');
      await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      await driveUntil(page, t, String(taskRow.rows[0]!["id"]), "ACCEPTED");
      await driveGoalUntil(page, t, goalId, "COMPLETED");
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      const facts = await captureFacts(page);
      record("t2-terminal-before-followup", "desktop", facts, page);
      await shot(page, "r03-terminal-followup-ready.png");
      expect(facts.followupVisible).toBe(true); // 红=false ⇒ FAIL(红轮在此中止)

      // 旧 Goal 消息基线(历史不丢)
      const feedBefore = await feedCount(page, base, goalId);
      const goalsBefore = await goalsCount(page, base);
      const draft = "请把结果卡片里的技术详情折叠起来,默认只看结论";
      const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/goals") && r.method() === "POST");
      const respPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/goals") && r.request().method() === "POST",
      );
      await page.fill('[data-testid="ws-input"]', draft);
      await page.click('[data-testid="ws-followup"]');
      const req = await reqPromise;
      // 注:201 创建成功即整页跳转,响应体读取与导航竞态(CDP getResponseBody 失效)——
      // 只读状态码(元数据安全);新 Goal ID 以跳转目标 URL 为准(与服务端 201 语义互证)。
      const httpStatus = (await respPromise).status();
      const payload = req.postDataJSON() as { rawInput?: string; projectId?: string };
      const newGoalId = await waitForGoalChange(page, goalId);
      record(
        "t2-followup-created",
        "desktop",
        {
          httpStatus,
          rawInput: payload.rawInput ?? null,
          projectId: payload.projectId ?? null,
          newGoalId,
        },
        page,
      );
      expect(httpStatus).toBe(201);
      expect(payload.rawInput).toBe(draft);
      // 未绑定 Goal 的后续任务不伪造项目关联(用户未选择 ⇒ 不携带 projectId)
      expect(payload.projectId).toBeUndefined();
      expect(newGoalId).toBeTruthy();
      await page.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
      record("t2-new-goal-view", "desktop", await captureFacts(page), page);
      await shot(page, "r04-followup-new-goal.png");
      // 新 Goal=真实可执行需求(首条 USER 消息=草稿)
      expect(newGoalId).not.toBe(goalId);
      expect((await page.textContent('[data-testid="ws-feed"]')) ?? "").toContain("技术详情");
      // 旧 Goal:状态/交付/消息历史全部未变
      await driveGoalUntil(page, t, goalId, "COMPLETED");
      expect(await feedCount(page, base, goalId)).toBe(feedBefore);
      expect(await goalsCount(page, base)).toBe(goalsBefore + 1);
      const oldState = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      expect(String(oldState.rows[0]!["state"])).toBe("COMPLETED");
      await shot(page, "r05-old-goal-unchanged.png");

      // 回到旧 Goal:重复点击 fail-closed(仅一次 POST)
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      let postCount = 0;
      const onReq = (r: { url(): string; method(): string }): void => {
        if (r.url().endsWith("/api/goals") && r.method() === "POST") postCount += 1;
      };
      page.on("request", onReq);
      await page.fill('[data-testid="ws-input"]', "重复点击防护验证");
      await page.dblclick('[data-testid="ws-followup"]');
      await waitForGoalChange(page, goalId);
      await page.waitForTimeout(800);
      expect(postCount).toBe(1);
      page.removeListener("request", onReq);
      record("t2-double-click-guard", "desktop", { postCount }, page);

      // 空文本 fail-closed:零请求 + 中文提示
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      postCount = 0;
      page.on("request", onReq);
      await page.click('[data-testid="ws-followup"]');
      await page.waitForTimeout(800);
      expect(postCount).toBe(0);
      page.removeListener("request", onReq);
      const emptyFacts = await captureFacts(page);
      record("t2-empty-text-guard", "desktop", emptyFacts, page);
      expect(emptyFacts.composerMsgText ?? "").toContain("先写一句");

      // 服务端报错 fail-closed:草稿保留 + 显式报错;恢复后重试成功(网络重试)
      await page.route("**/api/goals", async (route) => {
        if (route.request().method() === "POST") {
          await route.abort("failed");
          return;
        }
        await route.fallback();
      });
      const draft2 = "服务端报错时的草稿保留验证";
      await page.fill('[data-testid="ws-input"]', draft2);
      await page.click('[data-testid="ws-followup"]');
      await page.waitForFunction(
        () => {
          const doc = (
            globalThis as unknown as {
              document: { querySelector: (s: string) => { textContent?: string | null } | null };
            }
          ).document;
          const el = doc.querySelector('[data-testid="ws-composer-msg"]');
          return (el?.textContent ?? "").includes("创建失败");
        },
        undefined,
        { timeout: 15000 },
      );
      page.unroute("**/api/goals");
      const errFacts = await captureFacts(page);
      record("t2-server-error-draft-kept", "desktop", errFacts, page);
      await shot(page, "r06-server-error-draft-kept.png");
      expect(errFacts.inputValue).toBe(draft2);
      expect(errFacts.composerMsgText ?? "").toContain("创建失败");
      // 恢复后重试成功
      const respOk = page.waitForResponse((r) => r.url().endsWith("/api/goals") && r.request().method() === "POST");
      await page.click('[data-testid="ws-followup"]');
      const resp2 = await respOk;
      expect(resp2.status()).toBe(201);
      await waitForGoalChange(page, goalId);
      record("t2-retry-after-error-ok", "desktop", { url: page.url() }, page);
      s.errors.desktop.length = 0;
    });

    it("T2b 绑定 Goal 后续任务:项目选择器在场并预选现绑定(用户可改选),服务端按注册表校验、不扩权", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, base, "11R-T2B:带项目绑定的暗色模式需求", PROJECT_NAME);
      // 夹具说明(如实登记):绑定 Goal 的**执行语义**不在本合同 UI 范围——红轮实证:stub 写盘于任务
      // 工作区,recordChangeset 对 allowedScope=[项目目录] 判 violations ⇒ 任务 NEEDS_RECONCILE。
      // **2026-11-18 更正**:该现象不是"越界写被授权边界正确拦截",而是**作用域口径漂移**(任务落库
      // 的是宿主项目路径,影响面核验却按容器挂载根解释 ⇒ 相对路径全被判越界)。现已统一为
      // allowed_scope 恒为工作区挂载根,项目身份改由冻结绑定承载。T2b 只测 UI 后续任务流程与
      // 项目绑定校验 ⇒ 终态仍由夹具直接构造(任务 ACCEPTED+Goal COMPLETED)。
      await t.db.execute(sql`UPDATE tasks SET state = 'ACCEPTED' WHERE goal_id = ${goalId}`);
      await t.db.execute(sql`UPDATE goals SET state = 'COMPLETED', updated_at = now() WHERE id = ${goalId}`);
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-composer"]');
      await page.waitForTimeout(800);
      let facts = await captureFacts(page);
      record("t2b-terminal-bound-facts", "desktop", facts, page);
      await shot(page, "r07-bound-terminal-project-select.png");
      if (!facts.projectSelectVisible) {
        // 修复前形态登记(红轮):终态无项目选择器/无预选
        record("t2b-pre-fix-no-project-select", "desktop", { note: "红轮:终态无项目选择器" }, page);
      } else {
        // 修后:预选落定(异步 populate)后再采集
        await page.waitForFunction(
          (want: string) => {
            const doc = (
              globalThis as unknown as {
                document: { querySelector: (s: string) => { value?: string } | null };
              }
            ).document;
            const sel = doc.querySelector('[data-testid="ws-project"]');
            return (sel?.value ?? "") === want;
          },
          PROJECT_NAME,
          { timeout: 15000 },
        );
        facts = await captureFacts(page);
        record("t2b-terminal-bound-facts-settled", "desktop", facts, page);
      }
      // 红=false ⇒ FAIL(红轮在此失败:终态无项目选择器/预选)
      expect(facts.projectSelectVisible).toBe(true);
      expect(facts.projectSelected).toBe(PROJECT_NAME); // 预选现 Goal 绑定项目(仅当注册表仍含该项目)
      const draft = "继续为同一项目补一个浅色模式开关";
      const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/goals") && r.method() === "POST");
      const respPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/goals") && r.request().method() === "POST",
      );
      await page.fill('[data-testid="ws-input"]', draft);
      await page.click('[data-testid="ws-followup"]');
      const req = await reqPromise;
      // 响应体读取与导航竞态(T2 同款处置):只读状态码;新 Goal ID 取自跳转 URL
      const httpStatus = (await respPromise).status();
      const payload = req.postDataJSON() as { rawInput?: string; projectId?: string };
      const newGoalId = await waitForGoalChange(page, goalId);
      record("t2b-followup-created", "desktop", { httpStatus, projectId: payload.projectId ?? null, newGoalId }, page);
      expect(httpStatus).toBe(201);
      expect(payload.projectId).toBe(PROJECT_NAME); // 同项目随迁=用户显式选定,零 allowed_scope 扩权
      expect(newGoalId).toBeTruthy();
      // 新 Goal 任务作用域=工作区挂载根(统一口径);项目路径由冻结绑定承载(服务端权威解析;零伪造)
      const scopeRow = await t.db.execute(
        sql`SELECT allowed_scope FROM tasks WHERE goal_id = ${newGoalId} ORDER BY created_at ASC LIMIT 1`,
      );
      const scope = (scopeRow.rows[0]?.["allowed_scope"] as string[] | null) ?? [];
      expect(scope).toEqual(["/workspace"]);
      const regParsed = JSON.parse(readFileSync((s as Stack & { registryPath: string }).registryPath, "utf8")) as {
        projects: Array<{ name: string; path: string }>;
      };
      const frozenRow = await t.db.execute(
        sql`SELECT detail->'project' AS project FROM audit_events WHERE action='GOAL_PLANNED' AND detail->>'goalId' = ${newGoalId} ORDER BY seq LIMIT 1`,
      );
      const frozen = (frozenRow.rows[0]?.["project"] ?? null) as { name?: string; path?: string } | null;
      expect(frozen?.name).toBe(PROJECT_NAME);
      expect(frozen?.path).toBe(regParsed.projects.find((p) => p.name === PROJECT_NAME)!.path);
      // 旧 Goal 不变
      await driveGoalUntil(page, t, goalId, "COMPLETED");
      const oldState = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      expect(String(oldState.rows[0]!["state"])).toBe("COMPLETED");
      s.errors.desktop.length = 0;
    });

    it("T3 PAUSED 桌面:不暗示可执行、中文恢复指引、不自动恢复;后端 held 负例(零 Task 派生)", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, base, "11R-T3:被暂停的需求会话(夹具构造)");
      // PAUSED 夹具(见文件头说明):当前代码无 goal 级置入路径;任务同步 READY→PAUSED(ops 合法转移,防误领取)
      await t.db.execute(sql`UPDATE goals SET state = 'PAUSED', updated_at = now() WHERE id = ${goalId}`);
      await t.db.execute(sql`UPDATE tasks SET state = 'PAUSED' WHERE goal_id = ${goalId}`);
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-composer"]');
      await page.waitForTimeout(600); // status/feed 落定
      const facts = await captureFacts(page);
      record("t3-paused-facts", "desktop", facts, page);
      await shot(page, "r08-paused-hint.png");
      expect(facts.goalState).toBe("PAUSED");
      expect(facts.executeVisible).toBe(false); // 红=true ⇒ FAIL(红轮在此失败)
      expect(facts.followupVisible).toBe(false); // 暂停态无「新建后续任务」暗示(不暗示可继续执行)
      expect(facts.stateHintVisible).toBe(true); // 红=false ⇒ FAIL
      expect(facts.stateHintText ?? "").toContain("暂停");
      expect(facts.stateHintText ?? "").toContain("恢复");
      expect(facts.stateHintText ?? "").toContain("不会自动恢复");
      // 发送=只记录(聊天存档保留;服务端 held ack 明确「已暂停」)
      await page.fill('[data-testid="ws-input"]', "暂停期间说句话,不应触发执行");
      await page.click('[data-testid="ws-send"]');
      const ack = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已暂停" }).first();
      await ack.waitFor({ timeout: 15000 });
      record("t3-paused-send-held-ack", "desktop", { heldAck: (await ack.textContent()) ?? null }, page);
      expect((await ack.textContent()) ?? "").toContain("不会自动创建新执行任务");
      // 后端负例:显式执行请求 ⇒ held:true、零 Task 派生、Goal 不重激活
      const csrf = await csrfOf(page);
      const tasksBefore = await taskCountOf(t, goalId);
      const res = await page.context().request.post(`${base}/api/goals/${goalId}/messages`, {
        data: { content: "恢复执行吧", executionRequest: true },
        headers: { "content-type": "application/json", "x-relay-csrf": csrf },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { held?: boolean; followUpTaskId?: string | null };
      record(
        "t3-backend-held-negative",
        "desktop",
        { httpStatus: res.status(), held: body.held ?? null, followUpTaskId: body.followUpTaskId ?? null, tasksBefore },
        page,
      );
      expect(body.held).toBe(true);
      expect(body.followUpTaskId ?? null).toBeNull();
      expect(await taskCountOf(t, goalId)).toBe(tasksBefore);
      const st = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      expect(String(st.rows[0]!["state"])).toBe("PAUSED"); // 不自动恢复
      s.errors.desktop.length = 0;
    });

    it("T5 ACTIVE 正例:发送=只记录;交给 Relay 执行=显式授权 ⇒ 安全边界内派生受控 Task(方案 A 不回归)", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, base, "11R-T5:ACTIVE 态会话中追加显式执行");
      await page.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
      await page.waitForTimeout(600);
      const facts = await captureFacts(page);
      record("t5-active-facts", "desktop", facts, page);
      await shot(page, "r09-active-execute-present.png");
      // ACTIVE 态现状保持(红绿轮均通过=正例控制组)
      expect(facts.goalState).toBe("ACTIVE");
      expect(facts.executeVisible).toBe(true);
      expect(facts.executeLabel).toBe("交给 Relay 执行");
      expect(facts.followupVisible).toBe(false);
      expect(facts.projectSelectVisible).toBe(false);
      // 普通「发送」=只记录,零派生(方案 A 核心)
      await page.fill('[data-testid="ws-input"]', "这句只是交流,不应创建任务");
      await page.click('[data-testid="ws-send"]');
      const ack = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已记录" }).first();
      await ack.waitFor({ timeout: 15000 });
      expect((await ack.textContent()) ?? "").toContain("交给 Relay 执行");
      expect(await taskCountOf(t, goalId)).toBe(1);
      // 显式执行 ⇒ 立即派生受控 Task(空闲 ACTIVE;方案 A 语义不回归)
      const respPromise = page.waitForResponse(
        (r) => r.url().includes(`/api/goals/${goalId}/messages`) && r.request().method() === "POST",
      );
      await page.fill('[data-testid="ws-input"]', "同时把错误提示文案也改清楚");
      await page.click('[data-testid="ws-execute"]');
      const resp = await respPromise;
      const body = (await resp.json()) as { followUpTaskId?: string | null; queuedExecute?: boolean; held?: boolean };
      record(
        "t5-executive-request-derived",
        "desktop",
        {
          httpStatus: resp.status(),
          followUpTaskId: body.followUpTaskId ?? null,
          queuedExecute: body.queuedExecute ?? null,
          held: body.held ?? null,
          tasksAfter: await taskCountOf(t, goalId),
        },
        page,
      );
      expect(body.held ?? false).toBe(false);
      expect(body.followUpTaskId != null || body.queuedExecute === true).toBe(true);
      expect(await taskCountOf(t, goalId)).toBe(2);
      if (body.followUpTaskId) {
        await driveUntil(page, t, body.followUpTaskId, "ACCEPTED");
      }
      await driveGoalUntil(page, t, goalId, "COMPLETED");
      const rows = await t.db.execute(sql`SELECT state FROM tasks WHERE goal_id = ${goalId}`);
      expect(rows.rows.every((r) => String(r["state"]) === "ACCEPTED")).toBe(true);
      s.errors.desktop.length = 0;
    });

    it("T6 手机 390×844:终态执行按钮退场/新建后续任务(≥44px)全流程 + PAUSED 指引;零横向溢出", async () => {
      const { base, t } = s;
      const mpage = await s.mobile.newPage();
      mpage.on("pageerror", (err) => s.errors.mobile.push(`pageerror ${err.message}`));
      mpage.on("console", (msg) => {
        if (msg.type() === "error") s.errors.mobile.push(`console.error ${msg.text()}`);
      });
      await login(mpage, base);
      const goalId = await createGoalViaWorkspaceMobile(mpage, base, "手机端:完成卡片信息层级优化需求");
      expect(goalId).toBeTruthy();
      await mpage.goto(`${base}/system.html`, { waitUntil: "load" });
      await mpage.click('[data-testid="btn-tick"]');
      await mpage.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      await driveUntil(mpage, t, String(taskRow.rows[0]!["id"]), "ACCEPTED");
      await driveGoalUntil(mpage, t, goalId, "COMPLETED");
      await mpage.goto(`${base}/workspace?goal=${goalId}`);
      await mpage.waitForSelector('[data-testid="ws-result-card"]');
      const facts = await captureFacts(mpage);
      record("t6-mobile-terminal-facts", "mobile", facts, mpage);
      await shot(mpage, "m01-completed-terminal-mobile.png");
      expect(facts.goalState).toBe("COMPLETED");
      expect(facts.executeVisible).toBe(false); // 红=true ⇒ FAIL(红轮在此失败)
      expect(facts.followupVisible).toBe(true); // 红=false ⇒ FAIL
      expect(facts.followupLabel).toBe("新建后续任务");
      expect(facts.horizontalOverflow ?? 0).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(facts.composerBottomGap ?? 999))).toBeLessThanOrEqual(24);
      const hh = Number(facts.followupHeight ?? 0);
      expect(hh >= 44).toBe(true); // 03D 触控高度不回归
      // 后续任务全流程(手机):显式创建新 Goal、旧 Goal 不变
      const draft = "手机端继续:把完成卡片的技术细节默认折叠";
      const respPromise = mpage.waitForResponse(
        (r) => r.url().endsWith("/api/goals") && r.request().method() === "POST",
      );
      await mpage.fill('[data-testid="ws-input"]', draft);
      await mpage.click('[data-testid="ws-followup"]');
      // 响应体读取与导航竞态(T2 同款处置):只读状态码;新 Goal ID 取自跳转 URL
      const httpStatus = (await respPromise).status();
      await waitForGoalChange(mpage, goalId);
      const newGoalId = new URL(mpage.url()).searchParams.get("goal") ?? "";
      expect(httpStatus).toBe(201);
      expect(newGoalId).toBeTruthy();
      await mpage.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
      record("t6-mobile-followup-created", "mobile", { newGoalId }, mpage);
      await shot(mpage, "m02-followup-new-goal-mobile.png");
      expect((await mpage.textContent('[data-testid="ws-feed"]')) ?? "").toContain("技术细节");
      const oldState = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      expect(String(oldState.rows[0]!["state"])).toBe("COMPLETED");

      // 手机 PAUSED:恢复指引在场、无执行/新建暗示
      const goalId3 = await createGoalViaWorkspaceMobile(mpage, base, "手机端:被暂停的需求(夹具构造)");
      await t.db.execute(sql`UPDATE goals SET state = 'PAUSED', updated_at = now() WHERE id = ${goalId3}`);
      await t.db.execute(sql`UPDATE tasks SET state = 'PAUSED' WHERE goal_id = ${goalId3}`);
      await mpage.goto(`${base}/workspace?goal=${goalId3}`);
      await mpage.waitForSelector('[data-testid="ws-composer"]');
      await mpage.waitForTimeout(600);
      const pausedFacts = await captureFacts(mpage);
      record("t6-mobile-paused-facts", "mobile", pausedFacts, mpage);
      await shot(mpage, "m03-paused-hint-mobile.png");
      expect(pausedFacts.goalState).toBe("PAUSED");
      expect(pausedFacts.executeVisible).toBe(false);
      expect(pausedFacts.followupVisible).toBe(false);
      expect(pausedFacts.stateHintVisible).toBe(true);
      expect(pausedFacts.stateHintText ?? "").toContain("不会自动恢复");
      expect(pausedFacts.horizontalOverflow ?? 0).toBeLessThanOrEqual(1);
      mpage.close();
      s.errors.mobile.length = 0;
    });

    it("T7 后端负例矩阵(不重开/不越权/fail-closed 创建面):终态与暂停显式执行=held;未登记项目拒绝;空/超长拒绝", async () => {
      const { page, base, t } = s;
      const csrf = await csrfOf(page);
      const headers = { "content-type": "application/json", "x-relay-csrf": csrf };
      // 前置:复用 T2 的 COMPLETED Goal 与 T3 的 PAUSED Goal(同一栈内确定性存在)
      const goalsRes = await page.context().request.get(`${base}/api/goals`);
      const goals = ((await goalsRes.json()) as { goals?: Array<{ id?: string; rawInput?: string }> }).goals ?? [];
      expect(goals.length).toBeGreaterThan(0);
      // COMPLETED Goal:显式执行请求 ⇒ held + 状态不变 + 任务数不变
      const completedId = goals.find((g) => (g.rawInput ?? "").includes("11R-T2A"))!.id!;
      const cTasks = await taskCountOf(t, completedId);
      const res1 = await page.context().request.post(`${base}/api/goals/${completedId}/messages`, {
        data: { content: "再执行一轮", executionRequest: true },
        headers,
      });
      expect(res1.status()).toBe(201);
      const b1 = (await res1.json()) as { held?: boolean; followUpTaskId?: string | null };
      expect(b1.held).toBe(true);
      expect(b1.followUpTaskId ?? null).toBeNull();
      expect(await taskCountOf(t, completedId)).toBe(cTasks);
      const st1 = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${completedId}`);
      expect(String(st1.rows[0]!["state"])).toBe("COMPLETED");
      record("t7-completed-held", "desktop", { held: b1.held ?? null, tasks: cTasks }, page);
      // PAUSED Goal:同上(绝不自动重激活)
      const pausedId = goals.find((g) => (g.rawInput ?? "").includes("11R-T3"))!.id!;
      const pTasks = await taskCountOf(t, pausedId);
      const res2 = await page.context().request.post(`${base}/api/goals/${pausedId}/messages`, {
        data: { content: "给我恢复", executionRequest: true },
        headers,
      });
      expect(res2.status()).toBe(201);
      const b2 = (await res2.json()) as { held?: boolean; followUpTaskId?: string | null };
      expect(b2.held).toBe(true);
      expect(b2.followUpTaskId ?? null).toBeNull();
      expect(await taskCountOf(t, pausedId)).toBe(pTasks);
      const st2 = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${pausedId}`);
      expect(String(st2.rows[0]!["state"])).toBe("PAUSED");
      record("t7-paused-held", "desktop", { held: b2.held ?? null, tasks: pTasks }, page);
      // 创建面 fail-closed:未登记 projectId ⇒ 400 且零 Goal 创建(不伪造关联/不扩权)
      const before = await goalsCount(page, base);
      const res3 = await page.context().request.post(`${base}/api/goals`, {
        data: { rawInput: "未登记项目的越权尝试", projectId: "no-such-project" },
        headers,
      });
      expect(res3.status()).toBe(400);
      const b3 = (await res3.json()) as { error?: string };
      expect(b3.error ?? "").toBe("unknown_project");
      expect(await goalsCount(page, base)).toBe(before);
      record("t7-unknown-project-rejected", "desktop", { httpStatus: res3.status(), error: b3.error ?? null }, page);
      // 空/超长 rawInput ⇒ 400
      const res4 = await page.context().request.post(`${base}/api/goals`, { data: { rawInput: "   " }, headers });
      expect(res4.status()).toBe(400);
      const res5 = await page.context().request.post(`${base}/api/goals`, {
        data: { rawInput: "长".repeat(2001) },
        headers,
      });
      expect(res5.status()).toBe(400);
      expect(await goalsCount(page, base)).toBe(before);
      record("t7-empty-and-too-long-rejected", "desktop", { empty: res4.status(), tooLong: res5.status() }, page);
      s.errors.desktop.length = 0;
    });

    it("全程零浏览器错误(desktop+mobile pageerror/console.error)", async () => {
      expect(s.errors.desktop).toEqual([]);
      expect(s.errors.mobile).toEqual([]);
    });
  },
);

describe.skipIf(!E2E)(
  "WEB-UX-11R 失败终态(exit-mid 确定性链):执行按钮退场/显式后续任务/后端 held 负例",
  { timeout: 420_000 },
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = await startStack("terminal-fail", { stubMode: "exit-mid" });
    });
    afterAll(async () => {
      await stopStack(s);
      flushObservations(); // M1 同款:两 describe 共用落盘,最终 JSON=全量 OBS
    });

    it("T4 FAILED 桌面:失败终态执行按钮退场/新建后续任务全流程;旧 Goal 交付记录不变;后端 held 负例", async () => {
      const { page, base, t } = s;
      await login(page, base);
      await page.waitForSelector('[data-testid="ws-input"]');
      const prev = new URL(page.url()).searchParams.get("goal");
      await page.fill('[data-testid="ws-input"]', "11R-T4:模型不可用时的一次失败执行");
      await page.click('[data-testid="ws-send"]');
      await page.waitForFunction(
        (p: string | null) => {
          const doc = (globalThis as unknown as { document: { location: { search: string } } }).document;
          const g = new URLSearchParams(doc.location.search).get("goal");
          return g !== null && g !== p;
        },
        prev,
        { timeout: 20000 },
      );
      const goalId = new URL(page.url()).searchParams.get("goal") ?? "";
      expect(goalId).toBeTruthy();
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      const taskId = String(taskRow.rows[0]!["id"]);
      await driveUntil(page, t, taskId, "FAILED", 180_000);
      await driveGoalUntil(page, t, goalId, "FAILED");
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-work-block"]');
      const facts = await captureFacts(page);
      record("t4-failed-terminal-facts", "desktop", facts, page);
      await shot(page, "f01-failed-terminal.png");
      expect(facts.goalState).toBe("FAILED");
      // 11 B2 回归(不退化):失败块仍有中文下一步
      expect(facts.workBlockText ?? "").toContain("本轮工作未完成");
      expect(facts.workBlockText ?? "").toContain("下一步");
      expect(facts.executeVisible).toBe(false); // 红=true ⇒ FAIL(红轮在此失败)
      expect(facts.followupVisible).toBe(true); // 红=false ⇒ FAIL
      expect(facts.followupLabel).toBe("新建后续任务");
      // 后续任务全流程:失败终态上显式创建新 Goal,旧 Goal FAILED 不变
      const feedBefore = await feedCount(page, base, goalId);
      const draft = "换个角度重试:把提示文案改短一点(新需求)";
      const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/goals") && r.method() === "POST");
      const respPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/goals") && r.request().method() === "POST",
      );
      await page.fill('[data-testid="ws-input"]', draft);
      await page.click('[data-testid="ws-followup"]');
      const req = await reqPromise;
      // 响应体读取与导航竞态(T2 同款处置):只读状态码;新 Goal ID 取自跳转 URL
      const httpStatus = (await respPromise).status();
      const payload = req.postDataJSON() as { rawInput?: string };
      const newGoalId = await waitForGoalChange(page, goalId);
      expect(httpStatus).toBe(201);
      expect(payload.rawInput).toBe(draft);
      expect(newGoalId).toBeTruthy();
      record("t4-followup-created-on-failed", "desktop", { httpStatus, newGoalId }, page);
      await shot(page, "f02-followup-new-goal-on-failed.png");
      const oldState = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      expect(String(oldState.rows[0]!["state"])).toBe("FAILED");
      expect(await feedCount(page, base, goalId)).toBe(feedBefore); // 旧 Goal 消息不丢
      // 后端负例:FAILED Goal 显式执行 ⇒ held(不自动重试/不重开)
      const csrf = await csrfOf(page);
      const tasksBefore = await taskCountOf(t, goalId);
      const res = await page.context().request.post(`${base}/api/goals/${goalId}/messages`, {
        data: { content: "自动重试一次", executionRequest: true },
        headers: { "content-type": "application/json", "x-relay-csrf": csrf },
      });
      expect(res.status()).toBe(201);
      const b = (await res.json()) as { held?: boolean; followUpTaskId?: string | null };
      expect(b.held).toBe(true);
      expect(b.followUpTaskId ?? null).toBeNull();
      expect(await taskCountOf(t, goalId)).toBe(tasksBefore);
      await driveGoalUntil(page, t, goalId, "FAILED"); // 仍为 FAILED
      record("t4-backend-held-negative", "desktop", { held: b.held ?? null, tasksBefore }, page);
      s.errors.desktop.length = 0;
    });

    it("全程零浏览器错误(desktop pageerror/console.error)", async () => {
      expect(s.errors.desktop).toEqual([]);
    });
  },
);

/** 等待导航到一个**新的** goal(谓词等待:旧 URL 的 goal 参数不会命中,消除宽松正则即判竞态)。 */
async function waitForGoalChange(page: Page, prevGoal: string, timeout = 15000): Promise<string> {
  await page.waitForURL(
    (u) => {
      const g = new URL(u.toString()).searchParams.get("goal");
      return g !== null && g !== prevGoal;
    },
    { timeout },
  );
  return new URL(page.url()).searchParams.get("goal") ?? "";
}
