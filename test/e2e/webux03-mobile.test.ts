// WEB-UX-03D §16 Mobile Journey(M1-M10):真实浏览器 + 真 PG + stub worker(确定性桩;非真实模型)。
// 视口 = iPhone 390×844(isMobile + hasTouch;coarse pointer ⇒ §9 Enter=换行/发送走按钮)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
//   M1 新建任务:空白态唯一输入+无横向溢出+Composer 贴视觉底部+抽屉冒烟 → 开始 → 进入 Conversation
//   M2 运行状态:慢桩执行中 → 工作块(正在修改代码)+ 顶栏状态点;同页可见不跳转
//   M3 Decision:内联卡+主按钮 ≥44px 触控 → 允许 → 原地更新(不跳页)+ 执行继续
//   M4 Result:完成卡+查看修改;技术详情经 sheet(§11 主界面零工程术语)
//   M5 完成后继续输入:同 Goal follow-up;新结果仍在同一 Conversation
//   M6 运行中补充消息(硬门):不丢/在途不派生/不建匿名会话;安全边界消费 → 上下文可见
//   M7 Drawer:项目/会话切换 → 遮罩关闭回原会话(上下文不变,§4)
//   M8 长会话 20+:贴底自动滚;向上查看不强制拉回;「回到最新」(§10)
//   M9 断网恢复:横幅「连接暂时中断」+会话不清空;恢复自动轮询;写失败不假成功(§13)
//   M10 桌面回归(1440×900):三层布局/顶栏/Enter 发送/右栏折叠 —— 03C.1 行为不回退(§15)
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

const E2E = process.env.RELAY_E2E === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const SHOT_DIR = join(process.cwd(), "p0-webux-03d", "screenshots");
const PASSWORD = "e2e-password-03d";
// 390×844 手机视口;deviceScaleFactor 1 ⇒ 截图 PNG 恰为 390×844(§17)
const MOBILE_OPTS = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } as const;

interface Stack {
  t: TestDb;
  server: ReturnType<typeof createRelayServer>["server"];
  base: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

async function startStack(label: string, opts: { delivery?: DeliveryFactory; stubDelayMs?: string } = {}): Promise<Stack> {
  const t = await createTestDb(`webux03d-e2e-${label}`);
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
    workerId: `e2e-worker-03d-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: opts.stubDelayMs ?? "80" },
      reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "webux03d e2e 独立审查通过", STUB_DELAY_MS: "80" },
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
    evidenceChecks: [
      { kind: "deterministic_test", command: ["cat", "delivered.txt"], cwdWorkspace: true, expectOutputContains: "ok" },
    ],
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
    ...(opts.delivery ? { stageBaseDir: mkdtempSync(join(tmpdir(), "webux03d-stage-")) } : {}),
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
  const context = await browser.newContext(MOBILE_OPTS);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error ${msg.text()}`);
  });
  return { t, server, base, browser, context, page, errors };
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
  await page.waitForSelector('[data-testid="ws-topbar"]');
}

/** 工作区新建任务(单 Composer:空白态=项目+一句话+「开始」)。等待 URL goal 参数真正变化。
 *  已在会话中时直接回空白工作区(手机新建入口在抽屉内;URL 等价,§5 轻量页面)。 */
async function createGoalViaWorkspace(page: Page, base: string, rawInput: string): Promise<string> {
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
async function driveUntil(page: Page, t: TestDb, taskId: string, target: string, maxMs = 90_000): Promise<void> {
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

/** Feed 气泡计数(移动端长会话/断网断言用)。 */
function countBubbles(page: Page): Promise<number> {
  return page.evaluate((): number => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(sel: string): { length: number } } }).document;
    return doc.querySelectorAll('[data-testid^="ws-msg-"]').length;
  });
}

/** Feed 滚动几何(JSON 字符串;CI tsconfig 无 DOM lib ⇒ 经 globalThis 结构化类型,073589d 教训)。 */
function feedMetrics(page: Page): Promise<{ top: number; height: number; client: number }> {
  return page.evaluate((): string => {
    const doc = (globalThis as unknown as {
      document: { getElementById(id: string): { scrollTop: number; scrollHeight: number; clientHeight: number } | null };
    }).document;
    const f = doc.getElementById("ws-feed");
    return JSON.stringify(f ? { top: f.scrollTop, height: f.scrollHeight, client: f.clientHeight } : { top: 0, height: 0, client: 0 });
  }).then((s) => JSON.parse(s) as { top: number; height: number; client: number });
}

describe.skipIf(!E2E)("WEB-UX-03D Mobile Journey M1/M3/M4/M5/M7/M8/M9/M10(390×844;交付栈)", { timeout: 240_000 }, () => {
  let s: Stack;
  let goalA = ""; // M1 创建的主 Goal(M4/M5/M8/M9 沿用)
  let goalB = ""; // M3 的 D3 Goal(M7 切换会话用)
  let goalC = ""; // M7 绑定 LAMICE 的 Goal(侧栏分组)

  beforeAll(async () => {
    // 每任务独立 bare 远端(03C.1 夹具修正同源):共享远端+每 Run 全新种子提交 ⇒ 第二笔交付 push 非快进被拒
    const remoteBase = mkdtempSync(join(tmpdir(), "webux03d-remote-"));
    const remotes = new Map<string, BareRemoteFixture>();
    const remoteFor = (taskId: string): BareRemoteFixture => {
      let r = remotes.get(taskId);
      if (!r) {
        r = makeBareRemote(remoteBase);
        remotes.set(taskId, r);
      }
      return r;
    };
    const delivery: DeliveryFactory = {
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
          actor: "e2e-03d",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = mkdtempSync(join(tmpdir(), "webux03d-verify-"));
          const r = await verifyRemoteCommitContent({ target: remoteFor(c.taskId).url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    s = await startStack("journey-mobile", { delivery });
    // 注册表(M7 侧栏 LAMICE 分组;P0-2 同一归组规则)
    const reg = join(mkdtempSync(join(tmpdir(), "webux03d-reg-")), "projects.json");
    writeFileSync(reg, JSON.stringify({ projects: [{ name: "LAMICE", path: "/tmp/proj-lamice" }] }));
    process.env["RELAY_PROJECTS_FILE"] = reg;
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("M1 390×844 新建任务:无横向溢出+移动顶栏+唯一输入+Composer 贴底+抽屉冒烟 → 开始 → 进入 Conversation", async () => {
    const { page, base, t } = s;
    await login(page, base);
    // §2:390 视口零横向溢出
    await page.waitForSelector('[data-testid="ws-composer"]');
    const overflow = await page.evaluate((): number => {
      const doc = (globalThis as unknown as { document: { documentElement: { scrollWidth: number }; body: { scrollWidth: number } } }).document;
      return Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth);
    });
    expect(overflow).toBeLessThanOrEqual(391);
    // §3:移动顶栏=☰;刷新时间/右栏开关不入顶栏(secondary)
    expect(await page.locator('[data-testid="ws-menu-btn"]').isVisible()).toBe(true);
    expect(await page.locator('[data-testid="ws-stamp"]').isVisible()).toBe(false);
    expect(await page.locator('[data-testid="ws-pane-toggle"]').isVisible()).toBe(false);
    // §5:手机禁两输入框 ⇒ 整页唯一 textarea;项目选择可见(空白态)
    expect(await page.locator("#ws-layout textarea").count()).toBe(1);
    expect(await page.locator('[data-testid="ws-composer-project"]:not([hidden])').count()).toBe(1);
    // §9:Composer 固定视觉底部(bounding box 贴视口底;safe-area=0 时 bottom≈844)
    const box = await page.locator('[data-testid="ws-composer"]').boundingBox();
    expect(box).toBeTruthy();
    expect(Math.abs(box!.y + box!.height - 844)).toBeLessThanOrEqual(24);
    // §4:抽屉开/关冒烟(遮罩关闭)
    await page.click('[data-testid="ws-menu-btn"]');
    expect(await page.getAttribute("#ws-layout", "class")).toContain("ws-drawer-open");
    await page.waitForTimeout(300); // 滑入动画 0.2s 落定后再读几何
    const sb = await page.locator('[data-testid="ws-sidebar"]').boundingBox();
    expect(sb && sb.x >= 0).toBe(true); // 抽屉滑入视口
    await page.click('[data-testid="ws-backdrop"]', { position: { x: 370, y: 400 } }); // 抽屉右侧可见遮罩区
    expect(await page.getAttribute("#ws-layout", "class")).not.toContain("ws-drawer-open");
    // 一句话 → 开始 → 直接进入该 Conversation(§5)
    const goalId = await createGoalViaWorkspace(page, base, "手机上让 Relay 优化登录页的提示文字");
    expect(goalId).toBeTruthy();
    goalA = goalId;
    await page.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
    const bubble = await page.textContent('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
    expect(bubble).toContain("登录页的提示文字");
    const msgRow = await t.db.execute(sql`SELECT id FROM goal_messages WHERE goal_id = ${goalId} AND actor = 'USER' LIMIT 1`);
    expect(msgRow.rows.length).toBe(1);
    await shot(page, "mj1-new-task.png");
    s.errors.length = 0;
  });

  it("M3 Decision 内联单手处理:主按钮 ≥44px 触控 → 允许 → 原地更新(不跳页)+ 执行继续", async () => {
    const { page, base, t } = s;
    const goalId = await createGoalViaWorkspace(page, base, "目标:被 D3 卡住的样式范围扩展(手机)");
    goalB = goalId;
    const taskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const taskId = String(taskRow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
      VALUES ('dec-03d-inline', ${taskId}, ${goalId}, 'D3', '需要修改 src/styles/,这个目录超出了当前授权。',
        '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
    `);
    await driveUntil(page, t, taskId, "NEEDS_DECISION");
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-decision-card-dec-03d-inline"]');
    const q = await page.textContent('[data-testid="ws-decision-question"]');
    expect(q).toContain("src/styles/");
    // §7:主按钮触摸区域足够大(单手可完成)
    const approve = page.locator('[data-testid="ws-decision-approve-dec-03d-inline"]');
    const bb = await approve.boundingBox();
    expect(bb && bb.height >= 44).toBe(true);
    await shot(page, "mj3-decision.png");
    await approve.click();
    const notice = page.locator('[data-testid="ws-notice"]').first();
    await notice.waitFor({ timeout: 15000 });
    expect(await notice.textContent()).toContain("已批准");
    // 原地更新:卡从未决列表消失;URL 仍在工作区(不跳后台页)
    await page.waitForSelector('[data-testid="ws-decision-card-dec-03d-inline"]', { state: "detached", timeout: 20000 });
    expect(new URL(page.url()).searchParams.get("goal")).toBe(goalId);
    const decRow = await t.db.execute(sql`SELECT state FROM decisions WHERE id = 'dec-03d-inline'`);
    expect(String(decRow.rows[0]!["state"])).toBe("RESOLVED_MANUAL");
    // 自动继续:任务回 READY,下一拍照常领取并完成
    const backRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(backRow.rows[0]!["state"])).toBe("READY");
    await driveUntil(page, t, taskId, "ACCEPTED");
    s.errors.length = 0;
  });

  it("M4 Result:完成卡+查看修改;技术详情经 sheet(§11 主界面零工程术语)", async () => {
    const { page, base, t } = s;
    const goalId = goalA;
    const taskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const taskId = String(taskRow.rows[0]!["id"]);
    await driveUntil(page, t, taskId, "ACCEPTED");
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const card = await page.textContent('[data-testid="ws-result-card"]');
    expect(card).toContain("已完成本轮工作");
    expect(card).toContain("已提交 GitHub");
    expect(card).toContain("独立复核通过");
    expect(card).not.toContain("propose_failed"); // §12:主界面禁内部码
    expect(card).not.toContain("/tmp/");
    await page.waitForSelector('[data-testid="ws-result-view"]'); // 查看修改 → 简化详情(changeset 页)
    // §11:技术详情默认完全隐藏(sheet 关闭;右栏在手机隐藏)
    expect(await page.locator('[data-testid="ws-sheet"]').isVisible()).toBe(false);
    expect(await page.locator('[data-testid="ws-detail-tech"]').count()).toBe(0);
    // Result 卡「技术详情」→ 移动端打开 sheet(secondary view;Model/Budget/Run/Scope 只在此层)
    await page.click('[data-testid="ws-result-tech"]');
    await page.waitForSelector('[data-testid="ws-sheet-tech"]');
    const tech = await page.textContent('[data-testid="ws-sheet-tech"]');
    expect(tech).toContain("预算");
    expect(tech).toContain("作用域");
    expect(tech).toContain("Goal ID");
    await shot(page, "mj4-result-sheet.png");
    await page.click('[data-testid="ws-sheet-close"]');
    await page.waitForSelector('[data-testid="ws-sheet"]', { state: "hidden" });
    s.errors.length = 0;
  });

  it("M5 完成后继续输入:同 Goal follow-up;新结果仍在同一 Conversation;Composer 常驻", async () => {
    const { page, base, t } = s;
    const goalId = goalA;
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    await page.fill('[data-testid="ws-input"]', "手机上继续说:按钮再明显一点。");
    await page.click('[data-testid="ws-send"]');
    const ack = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已收到你的补充" }).first();
    await ack.waitFor({ timeout: 15000 });
    const tasks = await t.db.execute(sql`SELECT id, state FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC`);
    expect(tasks.rows.length).toBe(2);
    const followUp = String(tasks.rows[1]!["id"]);
    expect(String(tasks.rows[1]!["state"])).toBe("READY");
    await driveUntil(page, t, followUp, "ACCEPTED");
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const feed = await page.textContent('[data-testid="ws-feed"]');
    expect(feed).toContain("按钮再明显一点");
    expect(feed).toContain("已完成本轮工作");
    await shot(page, "mj5-followup.png");
    s.errors.length = 0;
  });

  it("M7 Drawer:项目分组可见 → 切换会话 → 遮罩关闭回原会话(上下文不变,§4)", async () => {
    const { page, base } = s;
    // 绑定项目的 Goal(经 API 携带 projectId;侧栏 LAMICE 分组=与注册表同规则)
    const csrf = await page.evaluate((): string => (globalThis as unknown as { RelayApp: { state: { csrf: string } } }).RelayApp.state.csrf || "");
    const created = await page.evaluate(async ({ raw, csrf }: { raw: string; csrf: string }) => {
      const r = await fetch("/api/goals", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-relay-csrf": csrf },
        body: JSON.stringify({ rawInput: raw, projectId: "LAMICE" }),
      });
      const b = (await r.json()) as { goalId?: string };
      return b.goalId ?? "";
    }, { raw: "M7 绑定 LAMICE 的字幕修复任务", csrf });
    expect(created).toBeTruthy();
    goalC = created;
    await page.goto(`${base}/workspace?goal=${goalB}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    // 打开抽屉:项目分组(LAMICE)+ 会话行可见
    await page.click('[data-testid="ws-menu-btn"]');
    expect(await page.getAttribute("#ws-layout", "class")).toContain("ws-drawer-open");
    await page.waitForSelector(`[data-testid="ws-goal-row-${goalC}"]`, { timeout: 10000 });
    const sideText = await page.textContent('[data-testid="ws-sidebar"]');
    expect(sideText).toContain("LAMICE");
    expect(sideText).toContain("待我决定");
    await page.waitForTimeout(350); // 滑入动画落定后再截图(证据完整性)
    await shot(page, "mj7-drawer.png");
    // 点另一会话 → 切换(抽屉经页面导航自然关闭)
    await page.click(`[data-testid="ws-goal-row-${goalA}"]`);
    await page.waitForURL(new RegExp("goal=" + goalA));
    await page.waitForSelector('[data-testid="ws-input"]');
    expect(new URL(page.url()).searchParams.get("goal")).toBe(goalA);
    // 再开抽屉 → 遮罩关闭 → 原会话不变(§4:抽屉关闭后回到原会话,不改变上下文)
    await page.click('[data-testid="ws-menu-btn"]');
    expect(await page.getAttribute("#ws-layout", "class")).toContain("ws-drawer-open");
    await page.click('[data-testid="ws-backdrop"]', { position: { x: 370, y: 400 } }); // 抽屉右侧可见遮罩区
    expect(await page.getAttribute("#ws-layout", "class")).not.toContain("ws-drawer-open");
    expect(new URL(page.url()).searchParams.get("goal")).toBe(goalA);
    await page.waitForSelector(`[data-testid="ws-goal-row-${goalA}"].active`, { timeout: 10000 });
    s.errors.length = 0;
  });

  it("M8 长会话 20+ 条:贴底自动滚;向上查看不强制拉回;「回到最新」(§10)", async () => {
    const { page, base, t } = s;
    const goalId = goalA;
    // 造历史(RELAY 消息不进入消费链 ⇒ 零 Task 派生;append-only INSERT)
    for (let i = 1; i <= 24; i++) {
      await t.db.execute(sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE', ${"进度播报第 " + i + " 条:阶段性验证进行中。"})`);
    }
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    await page.waitForFunction(
      (): boolean => {
        const doc = (globalThis as unknown as { document: { querySelectorAll(sel: string): { length: number } } }).document;
        return doc.querySelectorAll('[data-testid^="ws-msg-"]').length >= 25;
      },
      undefined,
      { timeout: 15000 },
    );
    // 贴底(进入会话自动滚到最新)
    let m = await feedMetrics(page);
    expect(m.height - m.top - m.client).toBeLessThanOrEqual(60);
    // 向上翻历史:一个轮询周期后不强制拉回
    await page.evaluate((): void => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { scrollTop: number } | null } }).document;
      const f = doc.getElementById("ws-feed");
      if (f) f.scrollTop = 0;
    });
    await page.waitForTimeout(5000); // ≥1 个前台轮询周期(4s)
    m = await feedMetrics(page);
    expect(m.top).toBeLessThan(120);
    // 「回到最新」出现;点击平滑回底
    expect(await page.locator('[data-testid="ws-jump-latest"]').isVisible()).toBe(true);
    await shot(page, "mj8-long-session.png");
    await page.click('[data-testid="ws-jump-latest"]');
    await page.waitForFunction(
      (): boolean => {
        const doc = (globalThis as unknown as { document: { getElementById(id: string): { scrollTop: number; scrollHeight: number; clientHeight: number } | null } }).document;
        const f = doc.getElementById("ws-feed");
        return !!f && f.scrollHeight - f.scrollTop - f.clientHeight <= 60;
      },
      undefined,
      { timeout: 5000 },
    );
    s.errors.length = 0;
  });

  it("M9 断网恢复:横幅文案+会话不清空;恢复自动轮询;写失败不假成功(§13)", async () => {
    const { page, base } = s;
    await page.goto(`${base}/workspace?goal=${goalA}`);
    await page.waitForSelector('[data-testid^="ws-msg-user"]');
    const before = await countBubbles(page);
    expect(before).toBeGreaterThanOrEqual(25);
    // 临时断网:拦断 feed 轮询
    await page.route(/\/api\/goals\/[a-z0-9-]+\/feed/, (route) => route.abort());
    await page.waitForSelector('[data-testid="ws-conn"]:not([hidden])', { timeout: 15000 });
    const banner = await page.textContent('[data-testid="ws-conn"]');
    expect(banner).toContain("与 Relay 的连接暂时中断");
    expect(banner).toContain("正在重新连接");
    // 会话不清空
    const during = await countBubbles(page);
    expect(during).toBe(before);
    await shot(page, "mj9-offline.png");
    // 恢复:自动重新 polling,横幅消失,消息完好
    await page.unroute(/\/api\/goals\/[a-z0-9-]+\/feed/);
    await page.waitForSelector('[data-testid="ws-conn"][hidden]', { state: "attached", timeout: 15000 });
    expect(await countBubbles(page)).toBe(before);
    // 写操作失败:显式报错+还原文稿,不得显示为已成功(§13)
    await page.route(/\/api\/goals\/[a-z0-9-]+\/messages/, (route) => route.abort());
    await page.fill('[data-testid="ws-input"]', "断网期间发送的补充");
    await page.click('[data-testid="ws-send"]');
    const failNotice = page.locator('[data-testid="ws-notice"]').filter({ hasText: "发送失败" }).first();
    await failNotice.waitFor({ timeout: 10000 });
    expect(await page.inputValue('[data-testid="ws-input"]')).toContain("断网期间发送的补充");
    await page.unroute(/\/api\/goals\/[a-z0-9-]+\/messages/);
    s.errors.length = 0;
  });

  it("M10 桌面回归(1440×900):三层布局/顶栏/Enter 发送/右栏折叠 —— 03C.1 行为不回退(§15)", async () => {
    const { base } = s;
    const dctx = await s.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dpage = await dctx.newPage();
    const derrors: string[] = [];
    dpage.on("pageerror", (err) => derrors.push(`pageerror ${err.message}`));
    dpage.on("console", (msg) => {
      if (msg.type() === "error") derrors.push(`console.error ${msg.text()}`);
    });
    await login(dpage, base);
    // 桌面三层:侧栏内联/中央会话/右栏详情;移动专属控件不出现
    expect(await dpage.locator('[data-testid="ws-sidebar"]').isVisible()).toBe(true);
    expect(await dpage.locator('[data-testid="ws-detail"]').isVisible()).toBe(true);
    expect(await dpage.locator('[data-testid="ws-menu-btn"]').isVisible()).toBe(false);
    expect(await dpage.locator('[data-testid="ws-pane-toggle"]').isVisible()).toBe(true);
    expect(await dpage.locator("#ws-layout textarea").count()).toBe(1);
    // 右栏折叠往返(03C.1 P0-6)
    await dpage.click('[data-testid="ws-pane-toggle"]');
    await dpage.waitForSelector('[data-testid="ws-detail"]', { state: "hidden" });
    await dpage.click('[data-testid="ws-pane-toggle"]');
    await dpage.waitForSelector('[data-testid="ws-detail"]', { state: "visible" });
    // Enter 发送(桌面语义):空白态 Enter 创建 Goal 并进入 Conversation
    const prevGoal = new URL(dpage.url()).searchParams.get("goal");
    await dpage.fill('[data-testid="ws-input"]', "桌面回归:Enter 应当发送创建");
    await dpage.press('[data-testid="ws-input"]', "Enter");
    await dpage.waitForFunction(
      (p: string | null) => {
        const doc = (globalThis as unknown as { document: { location: { search: string } } }).document;
        const g = new URLSearchParams(doc.location.search).get("goal");
        return g !== null && g !== p;
      },
      prevGoal,
      { timeout: 20000 },
    );
    await dpage.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
    // 03C.1 桌面顶栏:数据读取时间(有选中 Goal 时渲染文本)仍在顶栏(§3 只约束手机顶栏)
    expect(await dpage.locator('[data-testid="ws-stamp"]').isVisible()).toBe(true);
    mkdirSync(SHOT_DIR, { recursive: true });
    await dpage.screenshot({ path: join(SHOT_DIR, "mj10-desktop-1440.png"), fullPage: false });
    expect(derrors).toEqual([]);
    await dctx.close();
    s.errors.length = 0;
  });

  it("Journey 全程零浏览器错误(pageerror/console.error)", async () => {
    expect(s.errors).toEqual([]);
  });
});

describe.skipIf(!E2E)("WEB-UX-03D Mobile Journey M2/M6(慢桩运行态栈)", { timeout: 240_000 }, () => {
  let s: Stack;

  beforeAll(async () => {
    // 慢桩 6s:RUNNING 窗口 ≥1.5 个轮询周期 ⇒ M2 稳定截到「正在处理」;M6 稳定在运行中发送
    s = await startStack("journey-mobile-slow", { stubDelayMs: "6000" });
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("M2 Conversation 运行状态:工作块(正在修改…)+ 顶栏状态点;同页可见不跳转", async () => {
    const { page, base, t } = s;
    await login(page, base);
    const goalId = await createGoalViaWorkspace(page, base, "手机看运行状态:慢任务进行中");
    const taskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const taskId = String(taskRow.rows[0]!["id"]);
    tickInBackground(page);
    // 等 RUNNING(慢桩 6s 窗口)
    let running = false;
    for (let i = 0; i < 40; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
      if (String(r.rows[0]!["state"]) === "RUNNING") { running = true; break; }
      await page.waitForTimeout(200);
    }
    expect(running).toBe(true);
    // §2:Feed 4s 轮询刷出工作块(运行阶段文案);不跳页(URL 不变)
    await page.waitForSelector('[data-testid="ws-work-block"]', { timeout: 12000 });
    await page.waitForFunction(
      (): boolean => {
        const doc = (globalThis as unknown as { document: { querySelector(sel: string): { textContent: string | null } | null } }).document;
        const el = doc.querySelector('[data-testid="ws-work-block"]');
        return el !== null && el.textContent !== null && el.textContent.indexOf("正在") >= 0;
      },
      undefined,
      { timeout: 12000 },
    );
    // §3:顶栏必要状态点(蓝=执行中)
    await page.waitForSelector('[data-testid="ws-title-dot"]:not([hidden])', { timeout: 12000 });
    const dotClass = await page.getAttribute('[data-testid="ws-title-dot"]', "class");
    expect(dotClass).toContain("ws-dot-blue");
    await shot(page, "mj2-running.png");
    // 等该拍完成(不阻塞后续)
    for (let i = 0; i < 40; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
      if (String(r.rows[0]!["state"]) !== "RUNNING") break;
      await page.waitForTimeout(400);
    }
    s.errors.length = 0;
  });

  it("M6 运行中补充消息(硬门):本地回显即时/不丢/在途不派生/不建匿名会话;安全边界消费 → 上下文可见", async () => {
    const { page, base, t } = s;
    const goalId = await createGoalViaWorkspace(page, base, "手机运行中追加需求的验证");
    const firstTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const task1 = String(firstTaskRow.rows[0]!["id"]);
    const goalsBefore = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    tickInBackground(page);
    let running = false;
    for (let i = 0; i < 40; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${task1}`);
      if (String(r.rows[0]!["state"]) === "RUNNING") { running = true; break; }
      await page.waitForTimeout(200);
    }
    expect(running).toBe(true);
    // 运行中发送:§9 点击发送后立即显示用户消息(本地回显)
    await page.fill('[data-testid="ws-input"]', "顺便把空状态文案也调整一下。");
    await page.click('[data-testid="ws-send"]');
    await page.waitForSelector('[data-testid^="ws-msg-user"]', { timeout: 10000 });
    // 在途 ⇒ 只记录:消息持久化;此刻不派生 follow-up(单 Task)
    await page.waitForTimeout(400);
    const msgRow = await t.db.execute(sql`SELECT id FROM goal_messages WHERE goal_id = ${goalId} AND content LIKE '%空状态文案%'`);
    expect(msgRow.rows.length).toBe(1);
    const midTasks = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    expect(Number(midTasks.rows[0]!["n"])).toBe(1);
    // 等第一拍完成 → 下一拍安全边界消费 → 派生同 Goal follow-up
    await driveUntil(page, t, task1, "ACCEPTED");
    for (let i = 0; i < 20; i++) {
      const c = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
      if (Number(c.rows[0]!["n"]) >= 2) break;
      tickInBackground(page);
      await page.waitForTimeout(1000);
    }
    const tasks = await t.db.execute(sql`SELECT id, state FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC`);
    expect(tasks.rows.length).toBe(2);
    const mapRow = await t.db.execute(sql`
      SELECT c.task_id FROM goal_message_consumptions c
      JOIN goal_messages gm ON gm.id = c.message_id WHERE gm.content LIKE '%空状态文案%'
    `);
    expect(mapRow.rows.length).toBe(1); // at-most-once:恰好一条消费映射
    expect(String(mapRow.rows[0]!["task_id"])).toBe(String(tasks.rows[1]!["id"]));
    // 不建匿名会话:Goal 数不变
    const goalsAfter = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    expect(Number(goalsAfter.rows[0]!["n"])).toBe(Number(goalsBefore.rows[0]!["n"]));
    // 会话内可见:消息未丢 + RELAY 消费确认(等 Feed 4s 轮询刷出)
    await page.waitForSelector('[data-testid^="ws-msg-user"]');
    const ack2 = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已收到你的补充" }).first();
    await ack2.waitFor({ timeout: 15000 });
    const feed = await page.textContent('[data-testid="ws-feed"]');
    expect(feed).toContain("空状态文案");
    s.errors.length = 0;
  });

  it("Journey 全程零浏览器错误(pageerror/console.error)", async () => {
    expect(s.errors).toEqual([]);
  });
});
