// RELAY-WEB-UX-ACCEPTANCE-11 首次使用全链审计/验证 harness。
// 真实 Web 实现(同一 web/ 静态资源与 server 代码)+ 隔离合成环境(独立测试 schema + 确定性 stub;
// 非真实模型)+ 真实 Chromium 双视口(桌面 1440×900 / 手机 390×844)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
// 产出(按 WEBUX11_TAG 区分轮次,缺省 ci=回归安全):
//   p0-mvp/web-ux-acceptance-11/screenshots/<TAG>/*.png —— 新鲜真实截图(首轮审计+修后复核各一轮)
//   p0-mvp/web-ux-acceptance-11/evidence/firstuse-audit-<TAG>.json —— 逐步骤结构化观察(文案/状态/几何/零错误)
// 隔离与边界:RELAY_PROJECTS_FILE 指向一次性空注册表(首次使用=零项目;绝不读取受保护 config/projects.json);
//   数据全部合成;零生产连接/零真实模型/零外部交付(target=本地 bare 远端夹具)。
// 轮次分离(Reviewer Minor-M2,必守):证据轮(显式 TAG=audit 红/verify 绿)与回归轮必须分开——
//   缺省 TAG=ci(11 包曾发生缺省 audit 覆盖红态证据事故;11R 起把安全缺省反应用,证据轮必须显式指定)。
// 首次使用旅程(合同 B 全链):登录首屏 → 空状态(无项目/无任务)→ 一句话建需求 → Feed/进度 →
//   Decision(内联)→ 失败/停止态 → Result → 追问(held)/刷新;桌面与手机各自完整走一遍。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const TAG = process.env.WEBUX11_TAG ?? "ci";
const OUT_DIR = join(process.cwd(), "p0-mvp", "web-ux-acceptance-11");
const SHOT_DIR = join(OUT_DIR, "screenshots", TAG);
const EVIDENCE_DIR = join(OUT_DIR, "evidence");
const PASSWORD = "e2e-password-webux11";

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
  errors: { desktop: string[]; mobile: string[] }; // = CONSOLE_ERRORS(共享引用;零错误断言口径不变)
}

/** 逐步骤观察收集(audit 轮=阻断/混淆点证据源;verify 轮=修后对照)。 */
const OBS: Obs[] = [];
function record(step: string, viewport: string, facts: Obs["facts"], page?: Page): void {
  OBS.push({ step, viewport, ...(page ? { url: page.url() } : {}), facts });
}

/** 全程浏览器错误收集(双栈共享同一对象;JSON 最终=全量;Reviewer Minor-M1) */
const CONSOLE_ERRORS: { desktop: string[]; mobile: string[] } = { desktop: [], mobile: [] };

/** M1(Reviewer):两个 describe 的 afterAll 统一落盘——最终 JSON=全量 OBS(含失败态 d9/d10 facts)。 */
function flushObservations(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, `firstuse-audit-${TAG}.json`),
    JSON.stringify(
      {
        tag: TAG,
        contract: "RELAY-WEB-UX-ACCEPTANCE-11",
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

async function startStack(label: string, opts: { stubMode?: string } = {}): Promise<Stack> {
  const t = await createTestDb(`webux11-e2e-${label}`);
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
    workerId: `e2e-worker-webux11-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    // stubMode="exit-mid" ⇒ coder 桩进程 prompt 后立即退出(web-journey J3 同款确定性失败链)
    // ⇒ Run FAILED(rpc_disconnect)→ REWORK 退避 → attempt 预算耗尽 ⇒ 任务 FAILED(失败态 UI 面)
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: opts.stubMode ?? "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
      reviewerEnv: {
        STUB_MODE: "verdict",
        STUB_VERDICT: "PASS",
        STUB_FINDINGS: "webux11 e2e 独立审查通过",
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
    stageBaseDir: mkdtempSync(join(tmpdir(), "webux11-stage-")),
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
  return s;
}

/** 每任务独立 bare 远端(03C.1 夹具修正同源):共享远端+每 Run 全新种子提交 ⇒ 第二笔交付 push 非快进被拒。 */
function deliveryFactory(): DeliveryFactory {
  const remoteBase = mkdtempSync(join(tmpdir(), "webux11-remote-"));
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
        actor: "e2e-webux11",
      };
    },
    io: async (c) => ({
      executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha: string) => {
        const scratch = mkdtempSync(join(tmpdir(), "webux11-verify-"));
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

/** 工作区新建任务(单 Composer:空白态=项目+一句话+「开始」)。等待 URL goal 参数真正变化。 */
async function createGoalViaWorkspace(page: Page, rawInput: string): Promise<string> {
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) {
    await page.click('[data-testid="ws-new-task"]');
    await page.waitForURL(/\/workspace$/);
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

/** 推进到目标态:轮询 DB;状态停滞 >10s 时补发一拍(stub 单拍=完整链路;并发 tick 有租约守卫,幂等)。 */
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

/** 逐步骤关键事实采集(文案/控件状态/几何;audit 证据源)。 */
async function captureFacts(page: Page): Promise<Obs["facts"]> {
  const get = async (sel: string, attr = "textContent"): Promise<string | null> => {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return null;
    return attr === "textContent" ? ((await loc.textContent()) ?? null) : ((await loc.getAttribute(attr)) ?? null);
  };
  const projectSel = page.locator('[data-testid="ws-project"]');
  // 注:goal 态 populateProjectSelect 不执行 ⇒ select 可能为空(选项数=0 是真实观察,不得挂起等待)
  const projectOptionCount = (await projectSel.count()) > 0 ? await projectSel.locator("option").count() : 0;
  const projectOption = projectOptionCount > 0 ? await projectSel.locator("option").first().textContent() : null;
  const composerBox = await page.locator('[data-testid="ws-composer"]').boundingBox();
  const vp = page.viewportSize();
  return {
    heroTitle: await get('[data-testid="ws-feed"] .ws-hero-title'),
    heroSub: await get('[data-testid="ws-feed"] .ws-hero-sub'),
    sidebarText: (await get('[data-testid="ws-sidebar"]'))?.slice(0, 400) ?? null,
    title: await get("#ws-title"),
    inputPlaceholder: await get('[data-testid="ws-input"]', "placeholder"),
    sendLabel: await get('[data-testid="ws-send"]'),
    executeVisible:
      (await page
        .locator('[data-testid="ws-execute"]')
        .isVisible()
        .catch(() => false)) || false,
    projectSelectVisible:
      (await page
        .locator('[data-testid="ws-composer-project"]')
        .isVisible()
        .catch(() => false)) || false,
    projectFirstOption: projectOption,
    projectOptionCount,
    projectSelected: (await projectSel.count()) > 0 ? await projectSel.inputValue() : null,
    feedText: (await get('[data-testid="ws-feed"]'))?.slice(0, 1500) ?? null,
    workBlockText: await get('[data-testid="ws-work-block"]'),
    resultCardText: await get('[data-testid="ws-result-card"]'),
    decisionCardText: await get('[data-testid^="ws-decision-card-"]'),
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
  "WEB-UX-11 首次使用全链(桌面 1440 + 手机 390;真实 Web 实现×隔离合成栈)",
  { timeout: 300_000 },
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = await startStack("firstuse");
      // 首次使用=零项目:一次性空注册表(绝不指向受保护 config/projects.json;readProjectRegistry 按请求读取)
      const reg = join(mkdtempSync(join(tmpdir(), "webux11-reg-")), "projects.json");
      writeFileSync(reg, JSON.stringify({ projects: [] }));
      process.env["RELAY_PROJECTS_FILE"] = reg;
    });
    afterAll(async () => {
      await stopStack(s);
      flushObservations(); // M1:统一落盘(失败态 describe 完成后二次调用=全量覆盖写)
    });

    it("D1 登录首屏+空状态(无项目/无任务):首次用户第一眼看到什么", async () => {
      const { page, base } = s;
      // 未登录访问业务页 ⇒ 302 login(app.ts PAGE_ROUTES 既有语义)
      const res = await page.context().request.get(`${base}/`, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      expect(res.headers()["location"]).toBe("/login.html");
      await page.goto(`${base}/login.html`);
      await shot(page, "d01-login-desktop.png");
      record(
        "d1-login-first-screen",
        "desktop",
        { title: await page.title(), bodyText: (await page.textContent("body"))?.slice(0, 300) ?? null },
        page,
      );
      await login(page, base);
      await page.waitForSelector('[data-testid="ws-composer"]');
      await page.waitForTimeout(600); // 空注册表 option 异步填充落定
      const facts = await captureFacts(page);
      record("d2-workspace-empty-no-project-no-goal", "desktop", facts, page);
      await shot(page, "d02-workspace-empty-desktop.png");
      // 03C 既有钉住语义:空白态引导+唯一输入
      expect(facts.heroTitle).toBe("今天想让 Relay 做什么?");
      expect(facts.inputPlaceholder).toBe("告诉 Relay 你想做什么……");
      expect(facts.sendLabel).toBe("开始");
      expect(facts.sidebarText).toContain("还没有任务");
      // 首次使用关键观察:零项目时项目选择的如实文案(不再断言具体文案——本轮审计观察点,修后按定稿钉住)
      expect(facts.projectFirstOption).toBeTruthy();
      // WEB-UX-11 修复钉住(先红后绿;审计 2026-11-15 三项阻断):
      // B1 空白态唯一主操作=「开始」;「交给 Relay 执行」必须不可见(旧:CSS .btn display 压过 [hidden]
      //    ⇒ 双主按钮在场且点击静默无反应,截图 d02 为证)
      expect(facts.executeVisible).toBe(false);
      // B3 零项目时引导语必须给出可执行的中文下一步(直接开始+如何添加项目),
      //    不得要求「选择项目」却无可选项(旧 hero 副标与「尚未配置项目—直接开始」自相矛盾)
      expect(facts.heroSub).toContain("直接");
      expect(facts.heroSub).not.toContain("选择项目");
      s.errors.desktop.length = 0;
    });

    it("D2 一句话建需求 → Conversation;推进 → Result;追问(held)→ 刷新保持", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, "感觉登录页不好用,想让登录更快更清楚");
      expect(goalId).toBeTruthy();
      await page.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
      record("d3-goal-created", "desktop", await captureFacts(page), page);
      await shot(page, "d03-goal-created-desktop.png");
      // 推进一拍(走 system 页;stub 单拍=完整链路)
      await page.goto(`${base}/system.html`, { waitUntil: "load" });
      await page.click('[data-testid="btn-tick"]');
      await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      await driveUntil(page, t, String(taskRow.rows[0]!["id"]), "ACCEPTED");
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      record("d4-result", "desktop", await captureFacts(page), page);
      await shot(page, "d04-result-desktop.png");
      expect(await page.textContent('[data-testid="ws-result-card"]')).toContain("已完成本轮工作");
      // 追问(终态 held 语义):只记录不派生 + 明确中文下一步
      await page.fill('[data-testid="ws-input"]', "按钮还是太浅,再明显一点。");
      await page.click('[data-testid="ws-send"]');
      const ack = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已记录" }).first();
      await ack.waitFor({ timeout: 15000 });
      record(
        "d5-followup-held",
        "desktop",
        { ...(await captureFacts(page)), heldAck: (await ack.textContent()) ?? null },
        page,
      );
      await shot(page, "d05-followup-held-desktop.png");
      expect((await ack.textContent()) ?? "").toContain("已记录");
      // 刷新:会话保持
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector('[data-testid^="ws-msg-user"]');
      const feedAfterReload = (await page.textContent('[data-testid="ws-feed"]')) ?? "";
      expect(feedAfterReload).toContain("按钮还是太浅");
      record("d6-refresh-kept", "desktop", await captureFacts(page), page);
      await shot(page, "d06-refresh-desktop.png");
      s.errors.desktop.length = 0;
    });

    it("D3 Decision 内联(等待用户决定):卡文案+三按钮+批准后继续", async () => {
      const { page, base, t } = s;
      const goalId = await createGoalViaWorkspace(page, "目标:被 D3 卡住的扩大作用域工作");
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      const taskId = String(taskRow.rows[0]!["id"]);
      await t.db.execute(sql`
        INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
        VALUES ('dec-webux11-desktop', ${taskId}, ${goalId}, 'D3', '需要扩大到 src/styles/,是否允许?',
          '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
      `);
      await driveUntil(page, t, taskId, "NEEDS_DECISION");
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-decision-card-dec-webux11-desktop"]');
      record("d7-decision-inline", "desktop", await captureFacts(page), page);
      await shot(page, "d07-decision-desktop.png");
      expect(await page.textContent('[data-testid="ws-decision-question"]')).toContain("src/styles/");
      await page.click('[data-testid="ws-decision-approve-dec-webux11-desktop"]');
      const notice = page.locator('[data-testid="ws-notice"]').first();
      await notice.waitFor({ timeout: 15000 });
      record("d8-decision-approved", "desktop", { approvedNotice: (await notice.textContent()) ?? null }, page);
      await shot(page, "d08-decision-approved-desktop.png");
      expect(await notice.textContent()).toContain("已批准");
      const backRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
      expect(String(backRow.rows[0]!["state"])).toBe("READY");
      await driveUntil(page, t, taskId, "ACCEPTED");
      s.errors.desktop.length = 0;
    });

    it("M1 手机 390×844:登录→空状态→抽屉→建需求→Result→追问→Decision(≥44px 触控)", async () => {
      const { base, t } = s;
      const mpage = await s.mobile.newPage();
      mpage.on("pageerror", (err) => s.errors.mobile.push(`pageerror ${err.message}`));
      mpage.on("console", (msg) => {
        if (msg.type() === "error") s.errors.mobile.push(`console.error ${msg.text()}`);
      });
      await mpage.goto(`${base}/login.html`);
      await shot(mpage, "m01-login-mobile.png");
      record("m1-login-first-screen", "mobile", { title: await mpage.title() }, mpage);
      await login(mpage, base);
      await mpage.waitForSelector('[data-testid="ws-composer"]');
      await mpage.waitForTimeout(600);
      const emptyFacts = await captureFacts(mpage);
      record("m2-workspace-empty", "mobile", emptyFacts, mpage);
      await shot(mpage, "m02-workspace-empty-mobile.png");
      expect(emptyFacts.horizontalOverflow ?? 0).toBeLessThanOrEqual(1);
      expect(emptyFacts.composerBottomGap).not.toBeNull();
      // B1(手机):空白态唯一主操作=「开始」;执行按钮不可见 ⇒ 输入框不再被双按钮挤压(截图 m02 为证)
      expect(emptyFacts.executeVisible).toBe(false);
      expect(Math.abs(Number(emptyFacts.composerBottomGap ?? 999))).toBeLessThanOrEqual(24);
      // 抽屉:开 → 遮罩关(遮挡面=抽屉滑入视口内;遮罩覆盖余下区域——观察不判定美学)
      await mpage.click('[data-testid="ws-menu-btn"]');
      expect(await mpage.getAttribute("#ws-layout", "class")).toContain("ws-drawer-open");
      await mpage.waitForTimeout(300);
      await shot(mpage, "m03-drawer-mobile.png");
      const drawerFacts = await captureFacts(mpage);
      record("m3-drawer-open", "mobile", drawerFacts, mpage);
      await mpage.click('[data-testid="ws-backdrop"]', { position: { x: 370, y: 400 } });
      expect(await mpage.getAttribute("#ws-layout", "class")).not.toContain("ws-drawer-open");
      // 建需求 → 进入会话
      const goalId = await createGoalViaWorkspaceMobile(mpage, base, "手机上让 Relay 优化登录页的提示文字");
      expect(goalId).toBeTruthy();
      await mpage.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
      record("m4-goal-created", "mobile", await captureFacts(mpage), mpage);
      await shot(mpage, "m04-goal-created-mobile.png");
      // 推进 → Result
      const taskRow = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`,
      );
      await mpage.goto(`${base}/system.html`, { waitUntil: "load" });
      await mpage.click('[data-testid="btn-tick"]');
      await mpage.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      await driveUntil(mpage, t, String(taskRow.rows[0]!["id"]), "ACCEPTED");
      await mpage.goto(`${base}/workspace?goal=${goalId}`);
      await mpage.waitForSelector('[data-testid="ws-result-card"]');
      const resultFacts = await captureFacts(mpage);
      record("m5-result", "mobile", resultFacts, mpage);
      await shot(mpage, "m05-result-mobile.png");
      expect(resultFacts.resultCardText ?? "").toContain("已完成本轮工作");
      // 追问(held)
      await mpage.fill('[data-testid="ws-input"]', "手机上继续说:按钮再明显一点。");
      await mpage.click('[data-testid="ws-send"]');
      const ack = mpage.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已记录" }).first();
      await ack.waitFor({ timeout: 15000 });
      record("m6-followup-held", "mobile", { heldAck: (await ack.textContent()) ?? null }, mpage);
      await shot(mpage, "m06-followup-held-mobile.png");
      // Decision(内联;主按钮 ≥44px 触控)
      const goalId2 = await createGoalViaWorkspaceMobile(mpage, base, "目标:被 D3 卡住的样式范围扩展(手机)");
      const taskRow2 = await t.db.execute(
        sql`SELECT id FROM tasks WHERE goal_id = ${goalId2} ORDER BY created_at ASC LIMIT 1`,
      );
      const taskId2 = String(taskRow2.rows[0]!["id"]);
      await t.db.execute(sql`
        INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
        VALUES ('dec-webux11-mobile', ${taskId2}, ${goalId2}, 'D3', '需要修改 src/styles/,这个目录超出了当前授权。',
          '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
      `);
      await driveUntil(mpage, t, taskId2, "NEEDS_DECISION");
      await mpage.goto(`${base}/workspace?goal=${goalId2}`);
      await mpage.waitForSelector('[data-testid="ws-decision-card-dec-webux11-mobile"]');
      const decFacts = await captureFacts(mpage);
      const approve = mpage.locator('[data-testid="ws-decision-approve-dec-webux11-mobile"]');
      const bb = await approve.boundingBox();
      record(
        "m7-decision-inline",
        "mobile",
        { ...decFacts, approveButtonHeight: bb ? Math.round(bb.height) : null },
        mpage,
      );
      await shot(mpage, "m07-decision-mobile.png");
      expect(bb && bb.height >= 44).toBe(true);
      await approve.click();
      const notice = mpage.locator('[data-testid="ws-notice"]').first();
      await notice.waitFor({ timeout: 15000 });
      record("m8-decision-approved", "mobile", { approvedNotice: (await notice.textContent()) ?? null }, mpage);
      await shot(mpage, "m08-decision-approved-mobile.png");
      expect(await notice.textContent()).toContain("已批准");
      expect(new URL(mpage.url()).searchParams.get("goal")).toBe(goalId2); // 原地更新不跳页
      mpage.close();
      s.errors.mobile.length = 0;
    });

    it("全程零浏览器错误(desktop+mobile pageerror/console.error)", async () => {
      expect(s.errors.desktop).toEqual([]);
      expect(s.errors.mobile).toEqual([]);
    });
  },
);

describe.skipIf(!E2E)(
  "WEB-UX-11 失败/停止态(模型不可用确定性链;无桩注入=连真实 runtime 到不可达地址)",
  { timeout: 300_000 },
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = await startStack("firstuse-fail", { stubMode: "exit-mid" });
    });
    afterAll(async () => {
      await stopStack(s);
      flushObservations(); // M1(Reviewer Minor-1):d9/d10 facts 也落盘(JSON=全量 OBS 覆盖写)
    });

    it("D4 失败态:任务终败后工作块如实呈现+查看原因入口(模型不可用首用场景)", async () => {
      const { page, base, t } = s;
      await login(page, base);
      await page.waitForSelector('[data-testid="ws-input"]');
      const prev = new URL(page.url()).searchParams.get("goal");
      await page.fill('[data-testid="ws-input"]', "目标:模型不可用时的一次失败执行观察");
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
      // 失败链:run 连接被拒 → REWORK 退避 → attempt 预算耗尽/熔断 ⇒ FAILED(确定性;零模型请求)
      await driveUntil(page, t, taskId, "FAILED", 180_000);
      await page.goto(`${base}/workspace?goal=${goalId}`);
      await page.waitForSelector('[data-testid="ws-work-block"]');
      const facts = await captureFacts(page);
      record("d9-failed-terminal", "desktop", facts, page);
      await shot(page, "d09-failed-desktop.png");
      expect(facts.workBlockText).toContain("本轮工作未完成");
      // B2(先红后绿):失败态必须给明确中文下一步(合同 B:「失败或停止」状态)——
      // 旧实现只有「查看原因」工程入口,无下一步指引(截图 d09 为证);修后=提示重试路径(新建需求)
      expect(facts.workBlockText).toContain("下一步");
      expect(facts.workBlockText).toContain("新建一个需求");
      // 「查看原因」入口在失败态在场(点开=技术详情层)
      const reasonBtn = page.locator('[data-testid="ws-fail-reason"]');
      expect(await reasonBtn.count()).toBe(1);
      await reasonBtn.click();
      await page.waitForSelector('[data-testid="ws-detail-tech"]');
      await shot(page, "d10-failed-reason-desktop.png");
      record("d10-failed-reason-opened", "desktop", await captureFacts(page), page);
      s.errors.desktop.length = 0;
    });
  },
);
