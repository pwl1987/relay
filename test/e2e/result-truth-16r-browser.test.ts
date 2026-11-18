// RELAY-RESULT-TRUTH-16R 真实浏览器 E2E:A 验收后出现 B ⇒ B 不继承 A 的验收;标签中性化。
// 合同 §四:至少一条真实 PG + Web API + Browser E2E 覆盖"A 验收后出现 B,B 不继承 A"。
// 全链:真实 Web/API 创建 Goal(绑定项目)→ live driver 内建 seed/交付(stub 大脑)→
// 真实候选 commit → 真实交付本地 bare 远端(changeset A=DELIVERED)→ 真实浏览器接受 A →
// DB 夹具注入后续 changeset B(NONE,同 Goal 最新轮;场景构造面,验证全部走真实 UI/API)→
// 断言:B 页"用户尚未验收该结果"、workspace"用户尚未验收当前结果"、回看 A 仍"已接受"。
// 另:结果摘要字段标签不得硬编码"GitHub"(合同 §三 ⇒ 中性"仓库交付")。
// 隔离:一次性合成注册表 + 一次性 bare 远端;零生产连接/零真实模型/零外部交付;用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver } from "../../src/server/worker.ts";
import { makeWorkspaceRepo, makeBareRemote } from "../helpers/git-fixture.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";

const PASSWORD = "result-truth-16r-e2e-pw";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const PROJ_ENV = "RELAY_PROJECTS_FILE";
const PROJECT_NAME = "truth16r-demo";
const DESKTOP = { viewport: { width: 1440, height: 900 } };

describe.skipIf(process.env.RELAY_E2E !== "1")("RELAY-RESULT-TRUTH-16R:A 验收后出现 B ⇒ B 不继承 A(真实浏览器)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  let driver: ReturnType<typeof createLiveWorkerDriver>;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const tmpRoots: string[] = [];
  const envSaved: Array<[string, string | undefined]> = [];
  let goalId = "";
  let taskId = "";
  let csA = "";
  let csB = "";

  beforeAll(async () => {
    t = await createTestDb("result-truth-16r-e2e");
    const projBase = mkdtempSync(join(tmpdir(), "truth16r-proj-"));
    tmpRoots.push(projBase);
    const projectDir = makeWorkspaceRepo(projBase).dir;
    const remoteBase = mkdtempSync(join(tmpdir(), "truth16r-remote-"));
    tmpRoots.push(remoteBase);
    const remoteUrl = makeBareRemote(remoteBase).url;
    const regDir = mkdtempSync(join(tmpdir(), "truth16r-reg-"));
    tmpRoots.push(regDir);
    const reg = join(regDir, "projects.json");
    writeFileSync(
      reg,
      JSON.stringify({ projects: [{ name: PROJECT_NAME, path: projectDir, repo: remoteUrl, branch: "main" }] }),
      "utf8",
    );
    envSaved.push([PROJ_ENV, process.env[PROJ_ENV]]);
    process.env[PROJ_ENV] = reg;

    const stageBase = mkdtempSync(join(tmpdir(), "truth16r-stage-"));
    tmpRoots.push(stageBase);
    driver = createLiveWorkerDriver({
      db: t.db,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      workerId: "e2e-worker-result-truth-16r",
      wallSeconds: 30,
      heartbeatSeconds: 2,
      reserveCallsPerRun: 4,
      reviewerReserveCallsPerRun: 2,
      reviewAttempts: 1,
      stubInjection: {
        argv: [process.execPath, STUB],
        coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
        reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "x", STUB_DELAY_MS: "80" },
      },
      checkRunner: hostTestCheckRunner,
      evidenceChecks: [
        {
          kind: "deterministic_test",
          command: ["cat", "delivered.txt"],
          cwdWorkspace: true,
          expectOutputContains: "ok",
        },
      ],
      stageBaseDir: stageBase,
    });

    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 10,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
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
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    csrf = ((await login.json()) as { csrfToken?: string }).csrfToken ?? "";

    const created = await fetch(base + "/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify({ rawInput: "在 truth16r-demo 项目里加一个版本化验收校验脚本", projectId: PROJECT_NAME }),
    });
    const body = (await created.json()) as { goalId?: string; taskIds?: string[] };
    expect(created.status).toBe(201);
    goalId = body.goalId ?? "";
    taskId = body.taskIds?.[0] ?? "";
    expect(taskId).not.toBe("");

    // 真实执行链直到 changeset A=DELIVERED(单 tick 全链,与 three-dirs 同款)
    const report = await driver.tick();
    expect(report.status).toBe("PROGRESSED");
    const cs = await t.db.execute(sql`SELECT id FROM candidate_changesets WHERE task_id = ${taskId}`);
    expect(cs.rows.length).toBe(1);
    csA = String(cs.rows[0]!["id"]);

    browser = await chromium.launch();
    ctx = await browser.newContext(DESKTOP);
    page = await ctx.newPage();
    await page.goto(`${base}/login.html`);
    await page.fill("#password", PASSWORD);
    await page.click("#btn-login");
    await page.waitForURL(/\/workspace/);

    // 真实浏览器接受 A(验收事实写入 append-only 审计)
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(csA)}`);
    await page.waitForSelector('[data-testid="user-accept-btn"]');
    await page.click('[data-testid="user-accept-btn"]');
    await page.locator('[data-testid="user-result-state"]', { hasText: "已接受" }).waitFor();

    // 场景构造:同一 Goal 注入后续 changeset B(NONE;最新轮)。FK 链 = 新 run + 同 task。
    const runB = `run-16r-b-${taskId.slice(5, 13)}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome, detail)
      VALUES (${runB}, ${taskId}, 2, 'pi-rpc', 'stub/stub/gm', 'host-fallback', 'SUCCEEDED', '{"role":"coder"}'::jsonb)
    `);
    csB = `cs-16r-b-${taskId.slice(5, 13)}`;
    await t.db.execute(sql`
      INSERT INTO candidate_changesets
        (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
         git_commit_sha, delivery_state)
      VALUES (${csB}, ${taskId}, ${runB}, 2, ${"e".repeat(64)}, ${"f".repeat(64)}, ${"1".repeat(64)},
              '{"added":["y.txt"],"modified":[],"removed":[]}'::jsonb,
              '{"inScope":["/workspace/y.txt"],"violations":[]}'::jsonb,
              ${"2".repeat(40)}, 'NONE')
    `);
  });

  afterAll(async () => {
    for (const [key, val] of envSaved) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const r of tmpRoots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
    }
    try {
      await ctx?.close();
      await browser?.close();
    } catch {
      /* 已关 */
    }
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    await t.cleanup();
  });

  it("T1 A 已接受 → 出现 B:B 页/工作区不继承 A 的验收;回看 A 仍已接受", async () => {
    // B 当前页:用户尚未验收该结果;交付状态 NONE ⇒ "尚未交付"(零成功语气)
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(csB)}`);
    await page.waitForSelector('[data-testid="result-user-acceptance"]');
    const bState = (await page.textContent('[data-testid="user-result-state"]')) ?? "";
    expect(bState).toContain("尚未验收"); // 修复前:此处显示 A 的"已接受结果"
    expect(bState).not.toContain("已接受结果");
    const content = await page.content();
    expect(content).not.toContain("已提交到仓库"); // NONE ⇒ 零交付成功文案
    // workspace 当前结果:按最新 B ⇒ "用户尚未验收当前结果"
    await page.goto(`${base}/workspace?goal=${encodeURIComponent(goalId)}`);
    await page.waitForSelector('[data-testid="ws-result-card"]');
    const wsAcc = (await page.textContent('[data-testid="ws-result-user-acceptance"]')) ?? "";
    expect(wsAcc).toContain("尚未验收当前结果");
    expect(wsAcc).not.toContain("已接受结果");
    // 回看 A:A 历史页仍显示已接受(A 自己的验收事实永久保留)
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(csA)}`);
    await page.waitForSelector('[data-testid="result-user-acceptance"]');
    const aState = (await page.textContent('[data-testid="user-result-state"]')) ?? "";
    expect(aState).toContain("已接受结果");
  });

  it("T2 结果摘要字段标签中性化:仓库交付(不得硬编码 GitHub)", async () => {
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(csA)}`);
    await page.waitForSelector('[data-testid="result-delivery"]');
    const label = (await page.textContent('[data-testid="result-delivery"]')) ?? "";
    expect(label).toContain("仓库交付");
    expect(label).not.toContain("GitHub");
    const summary = (await page.textContent('[data-testid="result-summary"]')) ?? "";
    expect(summary).not.toContain("GitHub");
  });
});
