// WEB-UX-02 视觉验收截图旅程(Playwright + 真 Chromium + 真 PG;模型用确定性桩)。
// 门:RELAY_E2E=1 才跑。与 web-journey 互为补充:本文件按 WEB-UX-02 §13/§14 的
// Mac 桌面三尺寸(1440×900 / 1512×982 / 1728×1117)与手机 390×844 产出整套页面截图,
// 供独立 Reviewer 视觉审查(主操作一眼可见/无中英混杂/无信息过载/无大面积空白/无表格堆砌)。
// 证据输出:p0-mvp/webux-02/screenshots/(Evidence 提交与实现分离)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver } from "../../src/server/worker.ts";
import type { AddressInfo } from "node:net";

const E2E = process.env.RELAY_E2E === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const OUT_DIR = join(process.cwd(), "p0-mvp", "webux-02");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const PASSWORD = "e2e-password-51ab";
const BASE_VIEWPORT = { width: 1440, height: 900 };

interface Stack {
  t: TestDb;
  base: string;
  page: Page;
  context: BrowserContext;
  browser: Browser;
  projDir: string;
  registryFile: string;
}

async function startStack(label: string): Promise<Stack> {
  const t = await createTestDb(`webux02-${label}`);
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
    workerId: `webux02-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
      reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "视觉旅程独立审查通过", STUB_DELAY_MS: "80" },
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
  const context = await browser.newContext({ viewport: BASE_VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  // 项目注册表(临时目录;截出项目卡片)
  const projDir = mkdtempSync(join(tmpdir(), "webux02-proj-"));
  execFileSync("git", ["-C", projDir, "init", "--initial-branch=main"], { encoding: "utf8" });
  execFileSync("git", ["-C", projDir, "config", "user.email", "seed@l"], { encoding: "utf8" });
  execFileSync("git", ["-C", projDir, "config", "user.name", "seed"], { encoding: "utf8" });
  writeFileSync(join(projDir, "README.md"), "# 试点项目\n", "utf8");
  execFileSync("git", ["-C", projDir, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", projDir, "commit", "--quiet", "-m", "init"], { encoding: "utf8" });
  const registryFile = join(mkdtempSync(join(tmpdir(), "webux02-reg-")), "projects.json");
  writeFileSync(registryFile, JSON.stringify({ projects: [{ name: "试点项目", path: projDir, repo: "local/pilot-demo", branch: "main" }] }), "utf8");
  process.env["RELAY_PROJECTS_FILE"] = registryFile;
  return { t, base, page, context, browser, projDir, registryFile };
}

async function stopStack(s: Stack | undefined, savedReg: string | undefined): Promise<void> {
  if (!s) {
    if (savedReg !== undefined) process.env["RELAY_PROJECTS_FILE"] = savedReg;
    else delete process.env["RELAY_PROJECTS_FILE"];
    return;
  }
  await s.browser.close();
  rmSync(s.projDir, { recursive: true, force: true });
  rmSync(join(s.registryFile, ".."), { recursive: true, force: true });
  if (savedReg !== undefined) process.env["RELAY_PROJECTS_FILE"] = savedReg;
  else delete process.env["RELAY_PROJECTS_FILE"];
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
  await page.waitForURL(`${base}/`);
}

async function createGoal(page: Page, base: string, raw: string, projectId?: string): Promise<string> {
  await page.goto(`${base}/`);
  if (projectId) {
    await page.waitForSelector('[data-testid="goal-project"] option[value="' + projectId + '"]', { state: "attached" });
    await page.selectOption('[data-testid="goal-project"]', projectId);
  }
  await page.fill('[data-testid="goal-input"]', raw);
  await page.click('[data-testid="btn-create-goal"]');
  await page.waitForURL(/\/goal\.html\?id=/);
  return new URL(page.url()).searchParams.get("id") ?? "";
}

async function openTech(page: Page, id: string): Promise<void> {
  await page.evaluate((elId: string) => {
    const g = globalThis as unknown as { document: { getElementById: (i: string) => { open: boolean } | null } };
    const d = g.document.getElementById(elId);
    if (d) d.open = true;
  }, id);
}

describe.skipIf(!E2E)("WEB-UX-02 视觉验收截图旅程(Mac 三尺寸 + 手机 390×844)", { timeout: 240_000 }, () => {
  let s: Stack;
  let savedReg: string | undefined;
  let goalBlocked = "";
  let goalDone = "";
  let changesetId = "";

  beforeAll(async () => {
    savedReg = process.env["RELAY_PROJECTS_FILE"] ?? undefined;
    s = await startStack("shots");
    const { page, base, t } = s;
    await login(page, base);
    // 目标 A:被 D3 卡住(决策卡有真实内容可截)
    goalBlocked = await createGoal(page, base, "登录页 loading 提示不清晰,帮我优化一下");
    const aRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalBlocked} LIMIT 1`);
    const taskA = String(aRow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, state, deadline, fallback)
      VALUES ('dec-visual-d3', ${taskA}, ${goalBlocked}, 'D3', '是否扩大作用域到 src/styles/?(影响范围超出原始授权)',
              'OPEN', now() + interval '30 days',
              '{"recommended":"批准扩大作用域","alternatives":["保持原作用域,手动复制样式"],"risk":"低:样式文件可回滚"}'::jsonb)
    `);
    // 目标 B:推进到已通过 + 生成变更集(结果摘要页有真实数据)
    goalDone = await createGoal(page, base, "生成 delivered.txt 内容为 ok(视觉旅程)");
    const bRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalDone} LIMIT 1`);
    const taskB = String(bRow.rows[0]!["id"]);
    await page.goto(`${base}/system.html`);
    await page.waitForSelector('[data-testid="btn-tick"]');
    await page.click('[data-testid="btn-tick"]');
    await page.locator("#tick-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
    const csRow = await t.db.execute(sql`
      SELECT id FROM candidate_changesets WHERE task_id = ${taskB} ORDER BY created_at DESC LIMIT 1
    `);
    if (csRow.rows.length) changesetId = String(csRow.rows[0]!["id"]);
  });

  afterAll(async () => {
    await stopStack(s, savedReg);
  });

  it("桌面 1440×900:七个页面整套截图", async () => {
    const { page, base } = s;
    // 1 工作台(Hero + 四区)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-testid="goal-input"]');
    await shot(page, "d1-1440-workbench.png");
    // 2 任务列表
    await page.goto(`${base}/goal.html`);
    await page.waitForSelector('[data-testid="goals-list"]');
    await shot(page, "d2-1440-tasks.png");
    // 3 任务详情(时间线主视图;技术详情关闭态)
    await page.goto(`${base}/goal.html?id=${goalBlocked}`);
    await page.waitForSelector('[data-testid="goal-timeline-steps"]');
    await shot(page, "d3-1440-goal-timeline.png");
    // 3b 任务详情(技术详情展开)
    await openTech(page, "goal-tech");
    await page.waitForSelector('[data-testid="goal-tasks"]');
    await shot(page, "d3b-1440-goal-tech.png");
    // 4 待我决定(四问卡)
    await page.goto(`${base}/decisions.html`);
    await page.waitForSelector('[data-testid="decision-card-dec-visual-d3"]');
    await shot(page, "d4-1440-decisions.png");
    // 5 验收结果(摘要;无变更集时截列表态)
    await page.goto(changesetId ? `${base}/changeset.html?id=${encodeURIComponent(changesetId)}` : `${base}/changeset.html`);
    await page.waitForSelector('[data-testid="result-summary"], [data-testid="cs-picker"]');
    await shot(page, "d5-1440-result.png");
    // 5b 验收结果(技术证据展开)
    if (changesetId) {
      await openTech(page, "cs-tech");
      await page.waitForSelector('[data-testid="sha-commit"]');
      await shot(page, "d5b-1440-result-tech.png");
    }
    // 6 项目(卡片 + 内嵌需求表单展开)
    await page.goto(`${base}/projects.html`);
    await page.waitForSelector('[data-testid="projects-body"]');
    await shot(page, "d6-1440-projects.png");
    await page.click('[data-testid="project-ask-试点项目"]');
    await page.waitForSelector('[data-testid="goal-input"]');
    // m10:等待项目被预选(而非停留在"请选择一个项目")
    await page.waitForFunction(() => {
      const g = globalThis as unknown as { document: { querySelector: (s: string) => { value: string } | null } };
      const sel = g.document.querySelector('[data-testid="goal-project"]');
      return !!sel && sel.value === "试点项目";
    }, undefined, { timeout: 15000 });
    await shot(page, "d6b-1440-project-form.png");
    // 7 AI 资源 / 系统状态
    await page.goto(`${base}/models.html`);
    await page.waitForSelector('[data-testid="provider-body"]');
    await shot(page, "d7-1440-models.png");
    await page.goto(`${base}/system.html`);
    await page.waitForSelector('[data-testid="relay-body"]');
    await shot(page, "d8-1440-system.png");
  });

  it("桌面 1512×982 与 1728×1117:关键页复查", async () => {
    const { page, base } = s;
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-testid="goal-input"]');
    await shot(page, "m1-1512-workbench.png");
    await page.goto(`${base}/goal.html?id=${goalBlocked}`);
    await page.waitForSelector('[data-testid="goal-timeline-steps"]');
    await shot(page, "m2-1512-goal-timeline.png");
    await page.setViewportSize({ width: 1728, height: 1117 });
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-testid="goal-input"]');
    await shot(page, "m3-1728-workbench.png");
    await page.goto(`${base}/decisions.html`);
    await page.waitForSelector('[data-testid="decision-card-dec-visual-d3"]');
    await shot(page, "m4-1728-decisions.png");
  });

  it("手机 390×844:工作台/任务/待决定/结果 + 抽屉导航", async () => {
    const { page, base } = s;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-testid="mobile-topbar"]');
    await page.waitForSelector('[data-testid="goal-input"]');
    await shot(page, "p1-390-workbench.png");
    // 抽屉打开(m1:等滑入动画结束再截,截图须能证明抽屉完整可用)
    await page.click("#btn-burger");
    await page.waitForSelector("#app-sidebar.open");
    await page.waitForTimeout(350);
    await shot(page, "p2-390-drawer.png");
    await page.click("#btn-burger");
    // 任务详情(时间线 + 需要你决定提示)
    await page.goto(`${base}/goal.html?id=${goalBlocked}`);
    await page.waitForSelector('[data-testid="goal-timeline-steps"]');
    await shot(page, "p3-390-goal-timeline.png");
    // 待我决定(单手按钮)
    await page.goto(`${base}/decisions.html`);
    await page.waitForSelector('[data-testid="decision-card-dec-visual-d3"]');
    await shot(page, "p4-390-decisions.png");
    // 验收结果
    await page.goto(changesetId ? `${base}/changeset.html?id=${encodeURIComponent(changesetId)}` : `${base}/changeset.html`);
    await page.waitForSelector('[data-testid="result-summary"], [data-testid="cs-picker"]');
    await shot(page, "p5-390-result.png");
    // 横向溢出兜底断言(§14)
    for (const p of ["/", "/goal.html", "/decisions.html", "/changeset.html", "/projects.html", "/models.html", "/system.html"]) {
      await page.goto(`${base}${p}`);
      await page.waitForSelector('[data-testid="data-stamp"]');
      const overflow = await page.evaluate((): number => {
        const g = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
        return g.document.documentElement.scrollWidth - g.innerWidth;
      });
      expect(overflow, p + " 手机视口不应横向溢出").toBeLessThanOrEqual(1);
    }
  });
});
