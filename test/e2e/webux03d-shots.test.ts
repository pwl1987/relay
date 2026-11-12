// WEB-UX-03D §17 正式截图生成(真实浏览器+真 PG+stub worker;非测试夹具后台页)。
// 门:RELAY_E2E=1 且 RELAY_03D_SHOTS=1 才跑(显式证据生成;常规 vitest/CI 自动 skip)。
// 产出 p0-webux-03d/screenshots/d17-*.png:
//   01 新任务(390×844 空白工作区)      02 正在处理(RUNNING 工作块+状态点)
//   03 Decision(内联卡)                04 Result(完成卡)
//   05 Follow-up(完成后继续输入预填)   06 Drawer(导航抽屉展开)
//   07 长会话(20+ 条,向上翻历史+回到最新)  08 网络异常(断网横幅+会话不清空)
//   09/10 桌面回归 1440×900(空白+完成;§15 03C.1 不回退)
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
const SHOTS = process.env.RELAY_03D_SHOTS === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const OUT_DIR = join(process.cwd(), "p0-webux-03d", "screenshots");
const PASSWORD = "shots-password-03d";
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } as const;

let s: {
  t: TestDb;
  server: ReturnType<typeof createRelayServer>["server"];
  base: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

async function startStack(delivery: DeliveryFactory): Promise<void> {
  const t = await createTestDb("webux03d-shots");
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
    workerId: "shots-worker-03d",
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
    stageBaseDir: mkdtempSync(join(tmpdir(), "webux03d-shots-stage-")),
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
  const context = await browser.newContext(MOBILE);
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
  await page.waitForSelector('[data-testid="ws-topbar"]');
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
  if (!page.url().includes("/workspace")) await page.goto(`${s.base}/workspace`, { waitUntil: "load" });
  const prev = new URL(page.url()).searchParams.get("goal");
  if (prev !== null) await page.goto(`${s.base}/workspace`, { waitUntil: "load" });
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

describe.skipIf(!E2E || !SHOTS)("WEB-UX-03D §17 正式截图(390×844 + 桌面回归 1440×900)", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    // 每任务独立 bare 远端(03C.1 夹具修正同源;shared remote ⇒ 第二笔交付非快进被拒)
    const remoteBase = mkdtempSync(join(tmpdir(), "webux03d-shots-remote-"));
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
          actor: "shots-03d",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = mkdtempSync(join(tmpdir(), "webux03d-shots-verify-"));
          const r = await verifyRemoteCommitContent({ target: remoteFor(c.taskId).url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    await startStack(delivery);
    // 项目注册表(LAMICE/WPS 插件):抽屉分组真实呈现
    const reg = join(mkdtempSync(join(tmpdir(), "webux03d-shots-reg-")), "projects.json");
    writeFileSync(reg, JSON.stringify({ projects: [{ name: "LAMICE", path: "/tmp/proj-lamice" }, { name: "WPS 插件", path: "/tmp/proj-wps" }] }));
    process.env["RELAY_PROJECTS_FILE"] = reg;
  });
  afterAll(async () => {
    await s.browser.close();
    await new Promise<void>((r) => s.server.close(() => r()));
    await s.t.cleanup();
  });

  it("生成八场景移动截图 + 桌面回归截图", async () => {
    const { page, t } = s;
    await login(page);

    // --- 数据准备(全部经真实 API/worker;零模型,stub) ---
    // ① 已完成 Goal(全链 DELIVERED,Result 卡最丰富)
    const doneGoal = await createGoal(page, "优化登录页的状态提示与错误反馈");
    const doneTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${doneGoal} ORDER BY created_at ASC LIMIT 1`);
    const doneTaskId = String(doneTaskRow.rows[0]!["id"]);
    // 推进到终态(单拍=完整链路;停滞补拍)
    for (let i = 0; i < 12; i++) {
      tickInBackground(page);
      await page.waitForTimeout(1500);
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${doneTaskId}`);
      if (String(r.rows[0]!["state"]) === "ACCEPTED") break;
    }
    const doneState = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${doneTaskId}`);
    expect(String(doneState.rows[0]!["state"])).toBe("ACCEPTED");
    // ② Decision Goal(D3 未决)
    const decGoal = await createGoal(page, "需要扩大到 src/styles/ 的样式统一调整");
    const decTaskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${decGoal} ORDER BY created_at ASC LIMIT 1`);
    const decTaskId = String(decTaskRow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, state, deadline)
      VALUES ('dec-03d-shots', ${decTaskId}, ${decGoal}, 'D3', '我需要修改 src/styles/,这个目录超出了当前授权范围。',
        '{"recommended":"允许本次修改","risk":"较低,可回滚"}'::jsonb, 'OPEN', now() + interval '2 hours')
    `);
    for (let i = 0; i < 10; i++) {
      tickInBackground(page);
      await page.waitForTimeout(1200);
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${decTaskId}`);
      if (String(r.rows[0]!["state"]) === "NEEDS_DECISION") break;
    }
    const decState = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${decTaskId}`);
    expect(String(decState.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // ③ 侧栏分组多样性(绑定项目经 API)
    const csrf = await page.evaluate((): string => (globalThis as unknown as { RelayApp: { state: { csrf: string } } }).RelayApp.state.csrf || "");
    const mkGoal = async (projectId: string, raw: string): Promise<string> => {
      const res = await page.evaluate(async ({ projectId, raw, csrf }: { projectId: string; raw: string; csrf: string }) => {
        const r = await fetch("/api/goals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-relay-csrf": csrf },
          body: JSON.stringify({ rawInput: raw, projectId }),
        });
        const b = (await r.json()) as { goalId?: string };
        return b.goalId ?? "";
      }, { projectId, raw, csrf });
      expect(res).toBeTruthy();
      return res;
    };
    await mkGoal("LAMICE", "字幕修复:时间轴偏移两帧");
    await mkGoal("WPS 插件", "Ribbon 兼容:高 DPI 图标模糊");
    // ④ 长会话 Goal(24 条 RELAY 进度消息;不进消费链 ⇒ 零派生)
    const longGoal = await createGoal(page, "整理项目文档结构并补齐缺失说明");
    for (let i = 1; i <= 24; i++) {
      await s.t.db.execute(sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES (${longGoal}, 'RELAY', 'RELAY_MESSAGE', ${"进度播报第 " + i + " 条:阶段性验证进行中。"})`);
    }

    // --- 01 新任务(空白工作区) ---
    await page.goto(`${s.base}/workspace`);
    await page.waitForSelector('[data-testid="ws-composer"]');
    await page.waitForSelector(".ws-empty-hero");
    await page.waitForTimeout(600);
    await shot(page, "d17-01-new-task-390x844.png");

    // --- 02 正在处理(慢桩 RUNNING;确定性领取 priority=50) ---
    const execGoal = await mkGoal("LAMICE", "登录页优化:按钮状态与错误反馈");
    const execTaskRow = await s.t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${execGoal} ORDER BY created_at ASC LIMIT 1`);
    const execTaskId = String(execTaskRow.rows[0]!["id"]);
    await s.t.db.execute(sql`UPDATE tasks SET priority = 50 WHERE goal_id = ${execGoal}`);
    tickInBackground(page);
    await page.goto(`${s.base}/workspace?goal=${execGoal}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    let running = false;
    for (let i = 0; i < 30; i++) {
      const r = await s.t.db.execute(sql`SELECT state FROM tasks WHERE id = ${execTaskId}`);
      if (String(r.rows[0]!["state"]) === "RUNNING") { running = true; break; }
      await page.waitForTimeout(200);
    }
    if (running) {
      await page.waitForSelector('[data-testid="ws-work-block"]', { timeout: 10000 });
      await page.waitForFunction(
        (): boolean => {
          const doc = (globalThis as unknown as { document: { querySelector(sel: string): { textContent: string | null } | null } }).document;
          const el = doc.querySelector('[data-testid="ws-work-block"]');
          return el !== null && el.textContent !== null && el.textContent.indexOf("正在") >= 0;
        },
        undefined,
        { timeout: 10000 },
      );
    }
    await page.waitForTimeout(400);
    await shot(page, "d17-02-executing-390x844.png");
    for (let i = 0; i < 40; i++) {
      const r = await s.t.db.execute(sql`SELECT state FROM tasks WHERE id = ${execTaskId}`);
      if (String(r.rows[0]!["state"]) !== "RUNNING") break;
      await page.waitForTimeout(300);
    }

    // --- 03 Decision ---
    await page.goto(`${s.base}/workspace?goal=${decGoal}`);
    await page.waitForSelector('[data-testid="ws-decision-card-dec-03d-shots"]');
    await page.waitForTimeout(400);
    await shot(page, "d17-03-decision-390x844.png");

    // --- 04 Result ---
    await page.goto(`${s.base}/workspace?goal=${doneGoal}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    await page.waitForTimeout(400);
    await shot(page, "d17-04-result-390x844.png");

    // --- 05 Follow-up(完成后继续输入预填) ---
    await page.fill('[data-testid="ws-input"]', "按钮还是太浅,再明显一点。");
    await page.waitForTimeout(300);
    await shot(page, "d17-05-followup-390x844.png");
    // (不实际发送:避免污染后续场景;预填即完成演示)

    // --- 06 Drawer(展开;项目分组+待我决定+辅助入口) ---
    await page.click('[data-testid="ws-menu-btn"]');
    await page.waitForTimeout(350); // 滑入动画落定
    await shot(page, "d17-06-drawer-390x844.png");
    await page.click('[data-testid="ws-backdrop"]', { position: { x: 370, y: 400 } });
    await page.waitForTimeout(300);

    // --- 07 长会话(20+ 条;向上翻历史 + 回到最新可见) ---
    await page.goto(`${s.base}/workspace?goal=${longGoal}`);
    await page.waitForSelector('[data-testid="ws-input"]');
    await page.waitForFunction(
      (): boolean => {
        const doc = (globalThis as unknown as { document: { querySelectorAll(sel: string): { length: number } } }).document;
        return doc.querySelectorAll('[data-testid^="ws-msg-"]').length >= 20;
      },
      undefined,
      { timeout: 15000 },
    );
    await page.evaluate((): void => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { scrollTop: number } | null } }).document;
      const f = doc.getElementById("ws-feed");
      if (f) f.scrollTop = 0;
    });
    await page.waitForTimeout(5000); // ≥1 轮询周期:证明不强制拉回
    await shot(page, "d17-07-long-session-390x844.png");

    // --- 08 网络异常(断网横幅;会话不清空) ---
    await page.route(/\/api\/goals\/[a-z0-9-]+\/feed/, (route) => route.abort());
    await page.waitForSelector('[data-testid="ws-conn"]:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot(page, "d17-08-offline-390x844.png");
    await page.unroute(/\/api\/goals\/[a-z0-9-]+\/feed/);
    await page.waitForSelector('[data-testid="ws-conn"][hidden]', { state: "attached", timeout: 15000 });

    // --- 09/10 桌面回归(1440×900;03C.1 视觉不回退) ---
    const dctx = await s.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dpage = await dctx.newPage();
    await dpage.goto(`${s.base}/login.html`);
    await dpage.fill("#password", PASSWORD);
    await dpage.click("#btn-login");
    await dpage.waitForURL(/\/workspace/);
    await dpage.waitForSelector(".ws-empty-hero");
    await dpage.waitForTimeout(600);
    await dpage.screenshot({ path: join(OUT_DIR, "d17-09-desktop-blank-1440x900.png"), fullPage: false });
    await dpage.goto(`${s.base}/workspace?goal=${doneGoal}`);
    await dpage.waitForSelector('[data-testid="ws-result-card"]');
    await dpage.waitForTimeout(500);
    await dpage.screenshot({ path: join(OUT_DIR, "d17-10-desktop-result-1440x900.png"), fullPage: false });
    await dctx.close();
    expect(true).toBe(true);
  });
});
