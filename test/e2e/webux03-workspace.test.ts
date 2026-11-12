// WEB-UX-03C §15 桌面 Journey(C1-C6):真实浏览器 + 真 PG + stub worker(确定性桩;非真实模型)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
//   C1 新任务:空白态唯一 Composer(P0-1/UX1/UX2)→ 一句话 → 开始 → 自动进入 Conversation → 首条 USER_MESSAGE 可见
//   C2 执行状态:完成后工作状态块聚合展示 需求→修改→测试→复核→交付(不跳页;同阶段不重复渲染 UX4/UX5)
//   C3 Decision:Decision Card 内联于当前 Conversation;批准 → 状态更新 + 执行继续(复用现有 resolve 语义)
//   C4 Result:Result 卡出现在同一 Feed(阶段汇总:修改文件/验证/复核/交付;可展开技术详情)
//   C5 Follow-up:完成后继续说 → USER_MESSAGE 持久化 + 派生同 Goal follow-up Task(消费映射绑定;新结果仍在同一 Conversation)
//   C6 运行中 Follow-up(硬门):执行中发送 ⇒ 消息不丢/不重复派生/不建匿名会话;到安全边界(下一拍)消费 → 上下文含该消息
//   UX3 项目上下文一致:绑定项目 Sidebar/Header/右栏同源一致;未绑定如实"项目未绑定",全页无"默认工作区"(P0-2)
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
import type { Exec } from "../../src/core/db.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";

const E2E = process.env.RELAY_E2E === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const OUT_DIR = join(process.cwd(), "p0-webux-03c");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const PASSWORD = "e2e-password-03c";

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
  const t = await createTestDb(`webux03c-e2e-${label}`);
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
    workerId: `e2e-worker-03c-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: opts.stubDelayMs ?? "80" },
      reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "webux03c e2e 独立审查通过", STUB_DELAY_MS: "80" },
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
    ...(opts.delivery ? { stageBaseDir: mkdtempSync(join(tmpdir(), "webux03c-stage-")) } : {}),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
  await page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });
}

async function login(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/login.html`);
  await page.fill("#password", PASSWORD);
  await page.click("#btn-login");
  // WEB-UX-03C §2:登录后 / 302 → /workspace(默认进入工作区)
  await page.waitForURL(/\/workspace/);
  await page.waitForSelector('[data-testid="ws-sidebar"]');
}

/** 工作区新建任务(03C.1 P0-1 单 Composer:空白态=项目选择+一句话+「开始」;已选中任务时点 ＋新建任务 回空白态)。
 *  等待 URL 中 goal 参数真正"变化"(页面可能已处于某个 ?goal= 上,waitForURL 会立即命中旧 URL)。 */
async function createGoalViaWorkspace(page: Page, rawInput: string): Promise<string> {
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) {
    // 已在任务页:回空白工作区(唯一 Composer 承载创建)
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

/** 推进一拍(system 页 btn-tick;workerMode=stub;显式等待按钮出现——若会话被重定向到登录页会清晰失败)。 */
async function tickOnce(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/system.html`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="btn-tick"]', { timeout: 20000 });
  await page.click('[data-testid="btn-tick"]');
  await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
}

/** 页面内后台推进一拍(不导航离开工作区;fire-and-forget,csrf 经 RelayApp.state)。 */
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

describe.skipIf(!E2E)("WEB-UX-03C 桌面 Journey C1/C2/C4/C3/C5(会话式工作区;交付栈)", { timeout: 240_000 }, () => {
  let s: Stack;
  let desktopGoal = ""; // C1 创建的主 Goal(C2/C4/C5 沿用)

  beforeAll(async () => {
    // 每任务独立 bare 远端(03C.1 夹具修正):run 工作区每 Run 全新种子提交,若共享同一远端,
    // 后续交付(任意 Goal 的第二轮/其他 Goal)push 必非快进被拒 → D3 delivery_propose_failed
    // (旧 UI 不在主 Feed 显示未决决策而掩盖;03C.1 工作状态块如实呈现后必须在夹具层修复)。
    // 每任务远端保留「远端 HEAD 基线」语义:propose 先推 base,交付推进 payloadSha(快进)。
    const remoteBase = mkdtempSync(join(tmpdir(), "webux03c-remote-"));
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
          actor: "e2e",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = mkdtempSync(join(tmpdir(), "webux03c-verify-"));
          const r = await verifyRemoteCommitContent({ target: remoteFor(c.taskId).url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    s = await startStack("journey-desktop", { delivery });
    // UX3 项目上下文:注册表(LAMICE)——绑定 Goal 经 API 携带 projectId;readProjectRegistry 按请求读取,启动后设置即生效
    const reg = join(mkdtempSync(join(tmpdir(), "webux03c-reg-")), "projects.json");
    writeFileSync(reg, JSON.stringify({ projects: [{ name: "LAMICE", path: "/tmp/proj-lamice" }] }));
    process.env["RELAY_PROJECTS_FILE"] = reg;
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("C1 新任务:登录默认进工作区;空白态唯一 Composer(UX1/UX2)→ 开始 → 自动进入 Conversation → 首条 USER_MESSAGE 可见", async () => {
    const { page, base, t } = s;
    await login(page, base);
    // / 默认进工作区(302)
    const res = await page.context().request.get(`${base}/`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/workspace");
    // UX1 空白态:唯一主要文本输入控件(旧第二表单已删除)
    await page.waitForSelector('[data-testid="ws-composer"]');
    expect(await page.locator("#ws-layout textarea").count()).toBe(1);
    expect(await page.locator('[data-testid="ws-goal-input"]').count()).toBe(0);
    expect(await page.locator('[data-testid="ws-newtask-panel"]').count()).toBe(0);
    // UX2 创建前:占位与按钮 =「告诉 Relay 你想做什么……」/「开始」;项目选择可见
    expect(await page.getAttribute('[data-testid="ws-input"]', "placeholder")).toBe("告诉 Relay 你想做什么……");
    expect(await page.textContent('[data-testid="ws-send"]')).toBe("开始");
    expect(await page.locator('[data-testid="ws-composer-project"]:not([hidden])').count()).toBe(1);
    // 一句话 + 开始(单 Composer 创建)
    const goalId = await createGoalViaWorkspace(page, "感觉登录页不好用,想让登录更快更清楚");
    expect(goalId).toBeTruthy();
    desktopGoal = goalId;
    // UX2 创建后:同一 Composer 切换 =「继续告诉 Relay……」/「发送」;项目选择隐藏
    expect(await page.getAttribute('[data-testid="ws-input"]', "placeholder")).toBe("继续告诉 Relay……");
    expect(await page.textContent('[data-testid="ws-send"]')).toBe("发送");
    expect(await page.locator('[data-testid="ws-composer-project"][hidden]').count()).toBe(1);
    // 首条 USER_MESSAGE 在 Feed 可见(会话事实落库:POST /api/goals 追加 + 消费映射绑定首 Task)
    await page.waitForSelector('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
    const bubble = await page.textContent('[data-testid="ws-feed"] [data-testid^="ws-msg-user"]');
    expect(bubble).toContain("登录页不好用");
    const msgRow = await t.db.execute(sql`SELECT id, content FROM goal_messages WHERE goal_id = ${goalId} AND actor = 'USER' ORDER BY id ASC LIMIT 1`);
    expect(String(msgRow.rows[0]!["content"])).toContain("登录页不好用");
    const mapRow = await t.db.execute(sql`SELECT task_id FROM goal_message_consumptions WHERE goal_id = ${goalId}`);
    expect(mapRow.rows.length).toBe(1); // 首条消息已绑定首 Task(防首拍重复派生)
    await shot(page, "c1-new-task-conversation.png");
    s.errors.length = 0;
  });

  it("C2 执行状态:完成后工作状态块聚合(需求→修改→测试→复核→交付;同阶段不重复 UX4/UX5;P1-1 无内部码)", async () => {
    const { page, base, t } = s;
    const goalId = desktopGoal;
    const taskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const taskId = String(taskRow.rows[0]!["id"]);
    await tickOnce(page, base); // 一拍内:领取→Run(桩)→验证→Gate→交付
    const final = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(final.rows[0]!["state"])).toBe("ACCEPTED");
    // 回到工作区(不跳详情页):工作状态块聚合展示本轮各阶段;用户消息仍在同一 Feed
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const feed = await page.textContent('[data-testid="ws-feed"]');
    expect(feed).toContain("登录页不好用"); // 会话连续性:首条需求仍在
    expect(feed).toContain("代码修改"); // 修改阶段(完成后聚合块;原始逐条事件只在技术详情)
    expect(feed).toContain("独立复核通过");
    expect(feed).toContain("已提交 GitHub");
    // UX4 同阶段不重复渲染:聚合块内每阶段文本唯一
    expect((feed!.match(/代码修改/g) || []).length).toBe(1);
    expect((feed!.match(/独立复核通过/g) || []).length).toBe(1);
    expect(feed).not.toContain("正在修改代码"); // 完成态不再显示进行时文案
    // UX5 完成后 = 单一 Result 块原位更新(不再追加重复日志)
    expect(await page.locator('[data-testid="ws-work-block"]').count()).toBe(0);
    expect(await page.locator('[data-testid="ws-result-card"]').count()).toBe(1);
    // P1-1 主 Feed 无内部错误码/路径
    expect(feed).not.toContain("propose_failed");
    expect(feed).not.toContain("/tmp/");
    // 原始事件保留在技术详情(审计事实不删)
    await page.click('[data-testid="ws-detail-toggle"]');
    await page.waitForSelector('[data-testid="ws-tech-events"]');
    const raw = await page.textContent('[data-testid="ws-tech-events"]');
    expect(raw).toContain("代码修改完成"); // 原始事件层保留
    await shot(page, "c2-execution-events.png");
    s.errors.length = 0;
  });

  it("C4 Result:Result 卡出现在同一 Feed(阶段汇总:文件数/验证/复核/交付;技术详情默认关闭可展开)", async () => {
    const { page, base } = s;
    const goalId = desktopGoal;
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const card = await page.textContent('[data-testid="ws-result-card"]');
    expect(card).toContain("已完成本轮工作");
    expect(card).toContain("已提交 GitHub");
    expect(card).toContain("独立复核通过");
    const files = await page.textContent('[data-testid="ws-result-files"]');
    expect(files).toContain("个文件");
    // P0-6:技术详情默认关闭(右栏默认只显示摘要四项);elapsed 有实际运行时长 ⇒ 显示
    expect(await page.locator('[data-testid="ws-detail-tech"]').count()).toBe(0);
    expect(await page.locator('[data-testid="ws-detail-elapsed"]').count()).toBe(1);
    // P0-6:右栏整栏可折叠(收起 ⇄ 展开)
    await page.click('[data-testid="ws-pane-toggle"]');
    await page.waitForSelector('[data-testid="ws-detail"]', { state: "hidden" });
    expect(await page.textContent('[data-testid="ws-pane-toggle"]')).toBe("查看详情");
    await page.click('[data-testid="ws-pane-toggle"]');
    await page.waitForSelector('[data-testid="ws-detail"]', { state: "visible" });
    // 技术详情展开(右栏;默认弱化)
    await page.click('[data-testid="ws-detail-toggle"]');
    await page.waitForSelector('[data-testid="ws-detail-tech"]');
    const tech = await page.textContent('[data-testid="ws-detail-tech"]');
    expect(tech).toContain("预算");
    await shot(page, "c4-result-card.png");
    void base;
  });

  it("C3 Decision:Decision Card 内联于当前 Conversation;批准 → 状态更新 + 执行继续", async () => {
    const { page, base, t } = s;
    // 新 Goal + D3 未决(先建 Goal,再插决策;下一拍 handleOpenDecisions 置 NEEDS_DECISION)
    const goalId = await createGoalViaWorkspace(page, "目标:被 D3 卡住的扩大作用域工作");
    const taskRow = await t.db.execute(sql`SELECT id, state_version FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const taskId = String(taskRow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
      VALUES ('dec-03c-inline', ${taskId}, ${goalId}, 'D3', '需要扩大到 src/styles/,是否允许?',
        '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
    `);
    await tickOnce(page, base); // READY + OPEN D3 ⇒ NEEDS_DECISION(不领取;单测 diag-d3-block 已钉语义)
    const midState = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(midState.rows[0]!["state"])).toBe("NEEDS_DECISION");
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-decision-card-dec-03c-inline"]');
    const q = await page.textContent('[data-testid="ws-decision-question"]');
    expect(q).toContain("src/styles/");
    // 内联批准(复用现有 resolve 语义;不向用户暴露版本号)
    await page.click('[data-testid="ws-decision-approve-dec-03c-inline"]');
    const notice = page.locator('[data-testid="ws-notice"]').first();
    await notice.waitFor({ timeout: 15000 });
    expect(await notice.textContent()).toContain("已批准");
    // 卡状态更新:决策已裁决 ⇒ 从未决列表消失(Feed 内联更新,不跳页)
    await page.waitForSelector('[data-testid="ws-decision-card-dec-03c-inline"]', { state: "detached", timeout: 20000 });
    const decRow = await t.db.execute(sql`SELECT state FROM decisions WHERE id = 'dec-03c-inline'`);
    // 现有 resolve 语义(ops.resolveDecision):人工批准 ⇒ RESOLVED_MANUAL;拒绝 ⇒ REJECTED
    expect(String(decRow.rows[0]!["state"])).toBe("RESOLVED_MANUAL");
    // 执行继续:任务回 READY,下一拍照常领取并完成
    const backRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(backRow.rows[0]!["state"])).toBe("READY");
    await shot(page, "c3-decision-inline.png"); // 此时仍在工作区(下一拍会导航去 system 页)
    await tickOnce(page, base);
    const doneRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(doneRow.rows[0]!["state"])).toBe("ACCEPTED");
    s.errors.length = 0;
  });

  it("C5 Follow-up:完成后继续说 → 消息持久化 + 同 Goal 新受控 Task(消费映射绑定)→ 新结果仍在同一 Conversation", async () => {
    const { page, base, t } = s;
    const goalId = desktopGoal;
    expect(goalId).toBeTruthy();
    const goalsBefore = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    await page.fill('[data-testid="ws-input"]', "按钮还是太浅,再明显一点。");
    await page.click('[data-testid="ws-send"]');
    // USER_MESSAGE 持久化 + RELAY 确认出现在 Feed(同一会话)
    const ack = page.locator('[data-testid^="ws-msg-relay"]').filter({ hasText: "已收到你的补充" }).first();
    await ack.waitFor({ timeout: 15000 });
    expect(await ack.textContent()).toContain("已收到你的补充");
    // 派生同 Goal follow-up Task;不创建新 Goal
    await page.waitForTimeout(600); // 等刷新落定后核对 DB
    const tasks = await t.db.execute(sql`SELECT id, state FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC`);
    expect(tasks.rows.length).toBe(2);
    const followUp = String(tasks.rows[1]!["id"]);
    expect(String(tasks.rows[1]!["state"])).toBe("READY");
    const mapRow = await t.db.execute(sql`
      SELECT c.task_id, gm.content FROM goal_message_consumptions c
      JOIN goal_messages gm ON gm.id = c.message_id
      WHERE c.goal_id = ${goalId} AND gm.content LIKE '%按钮还是太浅%'
    `);
    expect(String(mapRow.rows[0]!["task_id"])).toBe(followUp);
    const goalsAfter = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    expect(Number(goalsAfter.rows[0]!["n"])).toBe(Number(goalsBefore.rows[0]!["n"]));
    // 新执行完成仍在同一 Conversation(Feed 同页;含 follow-up 消息与新事件)。
    // 每拍只领一个任务:循环推进直到 follow-up 到终态(兼容 FIFO 先领取其他 READY 任务)。
    let done = false;
    for (let i = 0; i < 3 && !done; i++) {
      await tickOnce(page, base);
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${followUp}`);
      if (String(r.rows[0]!["state"]) === "ACCEPTED") done = true;
    }
    expect(done).toBe(true);
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const feed = await page.textContent('[data-testid="ws-feed"]');
    expect(feed).toContain("按钮还是太浅");
    expect(feed).toContain("已完成本轮工作");
    await shot(page, "c5-follow-up-same-conversation.png");
    s.errors.length = 0;
  });

  it("UX3 项目上下文一致:绑定项目 Sidebar/Header/右栏同源;未绑定如实显示(全页无「默认工作区」)", async () => {
    const { page, base } = s;
    // 第四处:空白态 Composer Project Selector 选项=同一注册表(P0-2)
    await page.goto(`${base}/workspace`);
    await page.waitForSelector('[data-testid="ws-composer-project"]:not([hidden])');
    const selText = await page.textContent('[data-testid="ws-project"]');
    expect(selText).toContain("LAMICE");
    expect(selText).not.toContain("默认工作区");
    // 绑定项目 Goal(经 API 携带 projectId=LAMICE;与侧栏归组同一注册表规则)
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
    }, { raw: "UX3 绑定项目的上下文一致性检查", csrf });
    expect(created).toBeTruthy();
    await page.goto(`${base}/workspace?goal=${created}`);
    await page.waitForSelector('[data-testid="ws-detail-project"]');
    // 三处同源一致(同一 status.projectName / 同一归组规则):
    // (CI tsconfig 无 DOM lib:evaluate/waitForFunction 回调内经 globalThis 结构化类型访问 DOM——073589d 教训)
    await page.waitForFunction(
      () => {
        const doc = (globalThis as unknown as { document: { querySelector(sel: string): { textContent: string | null } | null } }).document;
        const el = doc.querySelector('[data-testid="ws-detail-project"]');
        return el !== null && el.textContent === "LAMICE";
      },
      undefined,
      { timeout: 10000 },
    );
    expect(await page.textContent('[data-testid="ws-detail-project"]')).toBe("LAMICE");
    expect((await page.textContent("#ws-title"))!.startsWith("LAMICE ·")).toBe(true); // Header
    const sidebarRow = page.locator(`[data-testid="ws-goal-row-${created}"]`);
    await sidebarRow.waitFor({ timeout: 10000 });
    // 侧栏行位于 LAMICE 分组下(向前找最近的分组名)
    const groupName = await page.evaluate((gid: string): string | null => {
      type WsNode = { classList: { contains(c: string): boolean }; previousElementSibling: WsNode | null; textContent: string | null };
      const doc = (globalThis as unknown as { document: { querySelector(sel: string): WsNode | null } }).document;
      let p: WsNode | null = doc.querySelector('[data-testid="ws-goal-row-' + gid + '"]');
      if (!p) return null;
      p = p.previousElementSibling;
      while (p && !p.classList.contains("ws-group-name")) p = p.previousElementSibling;
      return p ? p.textContent : null;
    }, created);
    expect(groupName).toBe("LAMICE");
    // 未绑定 Goal(desktopGoal 无 projectId)⇒ 三处如实「项目未绑定」
    await page.goto(`${base}/workspace?goal=${desktopGoal}`);
    await page.waitForSelector('[data-testid="ws-detail-project"]');
    await page.waitForFunction(
      () => {
        const doc = (globalThis as unknown as { document: { querySelector(sel: string): { textContent: string | null } | null } }).document;
        const el = doc.querySelector('[data-testid="ws-detail-project"]');
        return el !== null && el.textContent === "项目未绑定";
      },
      undefined,
      { timeout: 10000 },
    );
    expect((await page.textContent("#ws-title"))!.startsWith("项目未绑定 ·")).toBe(true);
    const body = await page.textContent("body");
    expect(body).not.toContain("默认工作区"); // 禁模糊兜底掩盖未知状态
    s.errors.length = 0;
  });

  it("Journey 全程零浏览器错误(pageerror/console.error)", async () => {
    expect(s.errors).toEqual([]);
  });
});

describe.skipIf(!E2E)("WEB-UX-03C 桌面 Journey C6(运行中 Follow-up;硬门)", { timeout: 240_000 }, () => {
  let s: Stack;

  beforeAll(async () => {
    s = await startStack("journey-c6", { stubDelayMs: "2500" });
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("C6 运行中发送:消息不丢/不重复派生/不建匿名会话;安全边界(下一拍)消费 → 上下文含该消息", async () => {
    const { page, base, t } = s;
    await login(page, base);
    const goalId = await createGoalViaWorkspace(page, "目标:执行中追加需求也不丢消息");
    const firstTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC LIMIT 1`);
    const task1 = String(firstTaskRow.rows[0]!["id"]);
    const goalsBefore = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);

    // 后台推进一拍(慢桩 2.5s);趁任务 RUNNING 时在工作区继续发消息
    tickInBackground(page);
    await page.waitForSelector('[data-testid="ws-input"]');
    // 等 RUNNING 窗口(慢桩 2.5s;轮询避免启动抖动)
    let running = false;
    for (let i = 0; i < 20; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${task1}`);
      const st = String(r.rows[0]!["state"]);
      if (st === "RUNNING") { running = true; break; }
      if (["ACCEPTED", "FAILED", "CANCELLED"].includes(st)) break;
      await page.waitForTimeout(200);
    }
    expect(running).toBe(true);
    await page.fill('[data-testid="ws-input"]', "顺便把错误提示文字也调整一下。");
    await page.click('[data-testid="ws-send"]');
    await page.waitForSelector('[data-testid^="ws-msg-user"]');
    // C2 精神:执行中的 Feed 显示工作状态块(同页可见,不跳转)
    await page.waitForSelector('[data-testid="ws-work-block"]');
    // UX4:运行中同阶段不得重复渲染(旧实现 LEASED/RUNNING/Run 三源叠加出现两条「正在修改代码」)
    const runningFeed = await page.textContent('[data-testid="ws-feed"]');
    expect((runningFeed!.match(/正在修改代码/g) || []).length).toBeLessThanOrEqual(1);
    expect(await page.locator('[data-testid="ws-work-block"]').count()).toBeLessThanOrEqual(1);

    // 在途 ⇒ 只记录:消息持久化;此刻不得派生 follow-up(无新 Task)
    await page.waitForTimeout(400);
    const msgRow = await t.db.execute(sql`SELECT id FROM goal_messages WHERE goal_id = ${goalId} AND content LIKE '%错误提示文字%'`);
    expect(msgRow.rows.length).toBe(1);
    const midTasks = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    expect(Number(midTasks.rows[0]!["n"])).toBe(1); // 在途不派生
    // 等待该拍完成(task1 ACCEPTED)
    let accepted = false;
    for (let i = 0; i < 40; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${task1}`);
      if (String(r.rows[0]!["state"]) === "ACCEPTED") { accepted = true; break; }
      await page.waitForTimeout(300);
    }
    expect(accepted).toBe(true);

    // 安全边界后:下一拍自动消费 → 派生同 Goal follow-up → 本拍领取执行并完成
    await tickOnce(page, base);
    const tasks = await t.db.execute(sql`SELECT id, state FROM tasks WHERE goal_id = ${goalId} ORDER BY created_at ASC`);
    expect(tasks.rows.length).toBe(2);
    const task2 = String(tasks.rows[1]!["id"]);
    const mapRow = await t.db.execute(sql`
      SELECT c.task_id FROM goal_message_consumptions c
      JOIN goal_messages gm ON gm.id = c.message_id WHERE gm.content LIKE '%错误提示文字%'
    `);
    expect(mapRow.rows.length).toBe(1); // at-most-once:恰好一条消费映射
    expect(String(mapRow.rows[0]!["task_id"])).toBe(task2);
    const auditRow = await t.db.execute(sql`SELECT action FROM audit_events WHERE action = 'GOAL_MESSAGES_CONSUMED' AND detail->>'goalId' = ${goalId}`);
    expect(auditRow.rows.length).toBe(1);
    // 不建匿名会话:Goal 数不变;新任务同 Goal
    const goalsAfter = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    expect(Number(goalsAfter.rows[0]!["n"])).toBe(Number(goalsBefore.rows[0]!["n"]));
    const goalOfTask2 = await t.db.execute(sql`SELECT goal_id FROM tasks WHERE id = ${task2}`);
    expect(String(goalOfTask2.rows[0]!["goal_id"])).toBe(goalId);
    // 上下文可见性(端到端事实):消费审计 + 映射;buildRunPrompt 注入由单元测试钉住(§0.2)。
    // task2 本拍领取并执行;循环守卫避免领取顺序抖动。
    let task2Done = false;
    for (let i = 0; i < 3 && !task2Done; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${task2}`);
      if (String(r.rows[0]!["state"]) === "ACCEPTED") { task2Done = true; break; }
      await tickOnce(page, base);
    }
    expect(task2Done).toBe(true);
    await page.goto(`${base}/workspace?goal=${goalId}`);
    await page.waitForSelector('[data-testid^="ws-msg-user"]');
    const feed = await page.textContent('[data-testid="ws-feed"]');
    expect(feed).toContain("顺便把错误提示文字也调整一下。"); // 消息未丢,仍在会话
    expect(feed).toContain("已收到你的补充"); // RELAY 消费确认
    await shot(page, "c6-inflight-followup.png");
    expect(s.errors).toEqual([]);
  });
});
