// WEB-UX-03C §16 正式截图生成(真实浏览器+真 PG+stub worker;非测试夹具后台页)。
// 门:RELAY_E2E=1 且 RELAY_03C_SHOTS=1 才跑(显式证据生成;常规 vitest/CI 自动 skip)。
// 产出 p0-webux-03c/screenshots/ws16-*.{1440x900,1512x982}.png:
//   01 空白工作区/新建任务  02 多项目侧栏·执行中会话  03 内联 Decision  04 完成 Result
//   05 完成后继续输入(follow-up 预填)  06 右侧技术详情展开
// (与 webux03-workspace journey 的 c1-c6 截图互补,共同覆盖 §16 七场景。)
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
const SHOTS = process.env.RELAY_03C_SHOTS === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const OUT_DIR = join(process.cwd(), "p0-webux-03c", "screenshots");
const PASSWORD = "shots-password-03c";

let s: {
  t: TestDb;
  server: ReturnType<typeof createRelayServer>["server"];
  base: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

async function startStack(delivery: DeliveryFactory): Promise<void> {
  const t = await createTestDb("webux03c-shots");
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
    workerId: "shots-worker-03c",
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "2500" },
      reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "截图栈独立审查通过", STUB_DELAY_MS: "80" },
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
    delivery,
    stageBaseDir: mkdtempSync(join(tmpdir(), "webux03c-shots-stage-")),
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
  s = { t, server, base, browser, context, page };
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
}

async function login(page: Page): Promise<void> {
  await page.goto(`${s.base}/login.html`);
  await page.fill("#password", PASSWORD);
  await page.click("#btn-login");
  await page.waitForURL(/\/workspace/);
  await page.waitForSelector('[data-testid="ws-sidebar"]');
}

/** 页面内后台推进一拍(不导航离开工作区)。 */
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

async function createGoal(page: Page, raw: string): Promise<string> {
  // 可能刚从 system 页推进一拍回来:先回工作区(空白态 Composer 所在页)
  if (!page.url().includes("/workspace")) await page.goto(`${s.base}/workspace`, { waitUntil: "load" });
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) {
    await page.click('[data-testid="ws-new-task"]');
    await page.waitForURL(/\/workspace$/);
  }
  // 03C.1 P0-1 单 Composer:空白态输入一句话 → 「开始」
  await page.waitForSelector('[data-testid="ws-input"]');
  await page.fill('[data-testid="ws-input"]', raw);
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

async function tickOnce(page: Page): Promise<void> {
  await page.goto(`${s.base}/system.html`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="btn-tick"]', { timeout: 20000 });
  await page.click('[data-testid="btn-tick"]');
  await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
}

const VIEWPORTS: Array<{ w: number; h: number }> = [
  { w: 1440, h: 900 },
  { w: 1512, h: 982 },
];

describe.skipIf(!E2E || !SHOTS)("WEB-UX-03C §16 正式截图(双视口)", { timeout: 300_000 }, () => {
beforeAll(async () => {
  // 每任务独立 bare 远端(03C.1 夹具修正,同 webux03-workspace):共享远端 + 每 Run 全新种子提交
  // ⇒ 后续交付 push 非快进被拒 → D3 delivery_propose_failed(工作状态块如实呈现,夹具须修复)。
  const remoteBase = mkdtempSync(join(tmpdir(), "webux03c-shots-remote-"));
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
        actor: "shots",
      };
    },
    io: async (c) => ({
      executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha: string) => {
        const scratch = mkdtempSync(join(tmpdir(), "webux03c-shots-verify-"));
        const r = await verifyRemoteCommitContent({ target: remoteFor(c.taskId).url, commitSha, manifest: c.manifest, scratchDir: scratch });
        return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
      },
      manifest: c.manifest,
    }),
  };
  await startStack(delivery);
    // 项目注册表(LAMICE/WPS 插件):侧栏项目分组需要;路径仅用于归组匹配,不要求目录存在
    const reg = join(mkdtempSync(join(tmpdir(), "webux03c-shots-reg-")), "projects.json");
    writeFileSync(reg, JSON.stringify({ projects: [{ name: "LAMICE", path: "/tmp/proj-lamice" }, { name: "WPS 插件", path: "/tmp/proj-wps" }] }));
    process.env["RELAY_PROJECTS_FILE"] = reg;
  });
  afterAll(async () => {
    await s.browser.close();
    await new Promise<void>((r) => s.server.close(() => r()));
    await s.t.cleanup();
  });

  it("生成七场景截图(1440×900 与 1512×982)", async () => {
    const { page, t } = s;
    await login(page);

    // --- 数据准备(全部经真实 API/worker;零模型,stub) ---
    // ① 已完成 Goal(全链 DELIVERED,Result 卡最丰富)
    const doneGoal = await createGoal(page, "优化登录页的状态提示与错误反馈");
    await tickOnce(page);
    // ② 执行中 Goal(慢桩;截图时处于 RUNNING)
    // ③ 等待决定 Goal(D3 未决)
    const decGoal = await createGoal(page, "需要扩大到 src/styles/ 的样式统一调整");
    const decTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${decGoal} ORDER BY created_at ASC LIMIT 1`);
    const decTaskId = String(decTaskRow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
      VALUES ('dec-shots-inline', ${decTaskId}, ${decGoal}, 'D3', '我需要修改 src/styles/,这个目录超出了当前授权范围。',
        '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
    `);
    await tickOnce(page); // READY+OPEN D3 ⇒ NEEDS_DECISION(不领取)
    // ④ 侧栏多样性:再建两个不同项目的 Goal(注册表路径经 API?项目绑定只接受注册表内 name;
    //    createGoal UI 未选项目 ⇒ 默认工作区;为让侧栏分组真实,用 API 携带 projectId 建两条)
    const cookie = await page.context().cookies();
    const csrf = await page.evaluate((): string => (globalThis as unknown as { RelayApp: { state: { csrf: string } } }).RelayApp.state.csrf || "");
    void cookie;
    const mkGoal = async (projectId: string, raw: string): Promise<string> => {
      const res = await page.evaluate(async ({ projectId, raw, csrf }: { projectId: string; raw: string; csrf: string }) => {
        const r = await fetch("/api/goals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-relay-csrf": csrf },
          body: JSON.stringify({ rawInput: raw, projectId }),
        });
        const b = (await r.json()) as { goalId?: string };
        return `${r.status}:${b.goalId ?? ""}`;
      }, { projectId, raw, csrf });
      console.log("shots diag: mkGoal", projectId, raw.slice(0, 12), "=>", res);
      const gid = res.split(":")[1] ?? "";
      const feed = await page.evaluate(async (g: string) => {
        const r = await fetch(`/api/goals/${g}/feed`, { credentials: "same-origin" });
        const b = (await r.json()) as { feed?: { items?: unknown[] } };
        return JSON.stringify(b.feed?.items?.length ?? "null");
      }, gid);
      console.log("shots diag: feed items for", gid.slice(0, 10), "=", feed);
      return gid;
    };
    await mkGoal("LAMICE", "字幕修复:时间轴偏移两帧");
    await mkGoal("WPS 插件", "Ribbon 兼容:高 DPI 图标模糊");

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const tag = `${vp.w}x${vp.h}`;
      // 01 空白工作区/新建任务(03C.1:空白态 = 居中引导语 + 底部唯一 Composer(项目+开始))
      await page.goto(`${s.base}/workspace`);
      await page.waitForSelector('[data-testid="ws-composer"]');
      await page.waitForSelector(".ws-empty-hero");
      await page.waitForTimeout(600);
      await shot(page, `ws16-01-blank-newtask-${tag}.png`);
      // 02 执行中会话(后台一拍进行时;侧栏多项目;每视口新建一个执行中 Goal)
      const execGoal = await mkGoal("LAMICE", "登录页优化:按钮状态与错误反馈");
      const execTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${execGoal} ORDER BY created_at ASC LIMIT 1`);
      const execTaskId = String(execTaskRow.rows[0]!["id"]);
      // 确定性领取:提高本 Goal 任务优先级(后台一拍必领本任务,而非更早创建的其他 READY 任务)
      await t.db.execute(sql`UPDATE tasks SET priority = 50 WHERE goal_id = ${execGoal}`);
      tickInBackground(page);
      await page.goto(`${s.base}/workspace?goal=${execGoal}`);
      await page.waitForSelector('[data-testid="ws-input"]');
      // 等 RUNNING(慢桩 2.5s 窗口)→ 再等 Feed 刷出"正在修改代码"
      let running = false;
      for (let i = 0; i < 25; i++) {
        const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${execTaskId}`);
        if (String(r.rows[0]!["state"]) === "RUNNING") { running = true; break; }
        await page.waitForTimeout(200);
      }
      if (running) {
        // 等 Feed(4s 轮询)刷出工作状态块(03C.1 P0-4:运行中 = 单一聚合块)
        await page.waitForSelector('[data-testid="ws-work-block"]', { timeout: 10000 });
        await page.waitForFunction(
          () => {
            const doc = (globalThis as unknown as { document: { querySelector(sel: string): { textContent: string | null } | null } }).document;
            const el = doc.querySelector('[data-testid="ws-work-block"]');
            return el !== null && el.textContent !== null && el.textContent.indexOf("正在修改代码") >= 0;
          },
          undefined,
          { timeout: 10000 },
        );
      }
      await page.waitForTimeout(400); // 版式稳定
      const dump = await page.evaluate((): string => {
        type Rect = { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
        const doc = globalThis as unknown as {
          document: {
            querySelector(sel: string): { getBoundingClientRect(): Rect } | null;
            getElementById(id: string): { getBoundingClientRect(): Rect; scrollTop: number; scrollHeight: number; clientHeight: number } | null;
          };
        };
        const el = doc.document.querySelector('[data-testid^="ws-msg-user"]');
        const feed = doc.document.getElementById("ws-feed");
        const r = el ? el.getBoundingClientRect() : null;
        const f = feed ? { top: feed.getBoundingClientRect().top, scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight } : null;
        return JSON.stringify({ bubbleRect: r, feed: f });
      });
      console.log("shots diag: 02 bubble geom =", dump);
      await shot(page, `ws16-02-executing-multi-sidebar-${tag}.png`);
      // 等 RUN 结束(不阻塞后续)
      for (let i = 0; i < 40; i++) {
        const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${execTaskId}`);
        if (String(r.rows[0]!["state"]) !== "RUNNING") break;
        await page.waitForTimeout(300);
      }
      // 03 内联 Decision
      await page.goto(`${s.base}/workspace?goal=${decGoal}`);
      await page.waitForSelector('[data-testid="ws-decision-card-dec-shots-inline"]');
      await page.waitForTimeout(400);
      await shot(page, `ws16-03-decision-inline-${tag}.png`);
      // 04 完成 Result
      await page.goto(`${s.base}/workspace?goal=${doneGoal}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      await page.waitForTimeout(400);
      await shot(page, `ws16-04-result-${tag}.png`);
      // 05 完成后继续输入(follow-up 预填)
      await page.fill('[data-testid="ws-input"]', "按钮还是太浅,再明显一点。");
      await page.waitForTimeout(300);
      await shot(page, `ws16-05-followup-input-${tag}.png`);
      // 06 技术详情展开
      await page.click('[data-testid="ws-detail-toggle"]');
      await page.waitForSelector('[data-testid="ws-detail-tech"]');
      await page.waitForTimeout(300);
      await shot(page, `ws16-06-tech-detail-${tag}.png`);
    }
    expect(true).toBe(true);
  });
});
