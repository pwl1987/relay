// RELAY-RESULT-TRUTH-16 真实浏览器 E2E:交付事实 → 结果页 → 用户接受/拒绝 → 刷新后仍保持事实。
// 合同 §六:至少一条真实 PG + Web API + 浏览器 E2E 覆盖全链;§五-1~10 反例面。
// 全链走生产同款内建路径:真实 Web/API 入口(POST /api/goals 绑定项目)→ live driver(**不注入**
// prepareWorkspace/delivery ⇒ 内建绑定 seed + 内建交付装配)→ stub 大脑 → 真实候选 commit →
// 真实交付到本地 bare 远端(DELIVERED)→ 浏览器验收闭环。
// 断言面:
//   V1 结果页事实推导:来源行显式 stub 演示;DELIVERED ⇒ 已提交到仓库;无过期能力声明
//      ("尚未接入 GitHub 推送交付"零命中);验收区 = "内部复核已通过 / 用户尚未验收"。
//   V2 「查看修改详情」真实可达:点击 ⇒ 技术证据区展开且文件清单可见(dead-control 防回归)。
//   V3 用户接受:按钮 ⇒ 审计事实(USER_RESULT_ACCEPTED)+ 刷新后仍在;零 Run 触发。
//   V4 用户拒绝:原因落审计(USER_RESULT_REJECTED);刷新后仍在;task 仍 ACCEPTED(内部 Gate
//      语义不动);拒绝后仍提供明确「新建后续任务」指引文案(不自动改代码/不自动 FAILED)。
//   V5 工作区结果卡:来源行 + 用户验收事实行(最新事实),与验收结果页同源。
//   V6 Goal 时间线 = 最新轮口径:旧轮 DELIVERED + 最新轮 FAILED ⇒ 不得出现旧轮成功文案
//      (路由拦截改写明细快照注入两轮变更集;纯投影逻辑测试,后端事实面由集成测试承担)。
// 隔离:一次性合成注册表 + 一次性 bare 远端(绝不读受保护 config/projects.json);
//   零生产连接/零真实模型/零外部交付;用后即毁。
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

const PASSWORD = "result-truth-e2e-pw";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const PROJ_ENV = "RELAY_PROJECTS_FILE";
const PROJECT_NAME = "truth-demo";
const DESKTOP = { viewport: { width: 1440, height: 900 } };

describe.skipIf(process.env.RELAY_E2E !== "1")(
  "RELAY-RESULT-TRUTH-16:交付事实→结果页→用户验收→刷新保持(真实浏览器)",
  () => {
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
    let changesetId = "";

    beforeAll(async () => {
      t = await createTestDb("result-truth-e2e");
      const projBase = mkdtempSync(join(tmpdir(), "truth-proj-"));
      tmpRoots.push(projBase);
      const project = makeWorkspaceRepo(projBase);
      const projectDir = project.dir;
      const remoteBase = mkdtempSync(join(tmpdir(), "truth-remote-"));
      tmpRoots.push(remoteBase);
      const remoteUrl = makeBareRemote(remoteBase).url;
      const regDir = mkdtempSync(join(tmpdir(), "truth-reg-"));
      tmpRoots.push(regDir);
      const reg = join(regDir, "projects.json");
      writeFileSync(
        reg,
        JSON.stringify({ projects: [{ name: PROJECT_NAME, path: projectDir, repo: remoteUrl, branch: "main" }] }),
        "utf8",
      );
      envSaved.push([PROJ_ENV, process.env[PROJ_ENV]]);
      process.env[PROJ_ENV] = reg;

      const stageBase = mkdtempSync(join(tmpdir(), "truth-stage-"));
      tmpRoots.push(stageBase);
      // driver:**不注入** prepareWorkspace / delivery ⇒ 生产同款内建装配
      driver = createLiveWorkerDriver({
        db: t.db,
        model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
        sandbox: "host-fallback",
        workerId: "e2e-worker-result-truth",
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
        body: JSON.stringify({ rawInput: "在 truth-demo 项目里加一个结果校验脚本", projectId: PROJECT_NAME }),
      });
      const body = (await created.json()) as { goalId?: string; taskIds?: string[] };
      expect(created.status).toBe(201);
      goalId = body.goalId ?? "";
      taskId = body.taskIds?.[0] ?? "";
      expect(taskId).not.toBe("");

      // 真实执行链直到 DELIVERED(与 three-dirs 同款:单 tick 全链)
      const report = await driver.tick();
      expect(report.status).toBe("PROGRESSED");
      const cs = await t.db.execute(sql`SELECT id, delivery_state FROM candidate_changesets WHERE task_id = ${taskId}`);
      expect(cs.rows.length).toBe(1);
      expect(String(cs.rows[0]!["delivery_state"])).toBe("DELIVERED");
      changesetId = String(cs.rows[0]!["id"]);

      browser = await chromium.launch();
      ctx = await browser.newContext(DESKTOP);
      page = await ctx.newPage();
      await page.goto(`${base}/login.html`);
      await page.fill("#password", PASSWORD);
      await page.click("#btn-login");
      await page.waitForURL(/\/workspace/);
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

    it("V1 结果页事实推导:来源行 stub 演示显式;无过期能力声明;验收区=内部通过/用户未验收", async () => {
      await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
      await page.waitForSelector('[data-testid="result-provenance"]');
      const prov = (await page.textContent('[data-testid="result-provenance"]')) ?? "";
      expect(prov).toContain("演示");
      expect(prov).toContain("stub");
      // 过期能力声明必须消失(15 包后内建交付已接入绑定远端)
      const content = await page.content();
      expect(content).not.toContain("尚未接入 GitHub 推送交付");
      // 交付事实:DELIVERED ⇒ 已提交到仓库(既有事实推导保持)
      expect(content).toContain("已提交到仓库");
      // 语义分离:内部复核已通过 + 用户尚未验收(独立两句话,不混谈)
      const acc = await page.waitForSelector('[data-testid="result-user-acceptance"]');
      const accText = (await acc.textContent()) ?? "";
      expect(accText).toContain("内部复核已通过");
      expect(accText).toContain("用户尚未验收");
      // 首屏成功标题仅因 DELIVERED 事实(非"有候选即完成")
      expect(((await page.textContent('[data-testid="result-title"]')) ?? "").trim()).toBe("已完成");
    });

    it("V2 「查看修改详情」真实可达:点击 ⇒ 技术区展开且文件清单可见(dead-control 防回归)", async () => {
      await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
      await page.waitForSelector('[data-testid="result-summary"]');
      // 收起态:目标区不可见(Playwright isVisible 含祖先折叠面 —— closed details ⇒ false)
      expect(await page.isVisible('[data-testid="cs-diff"]')).toBe(false);
      await page.getByRole("button", { name: "查看修改详情" }).click();
      await page.locator('[data-testid="cs-diff"]').scrollIntoViewIfNeeded();
      expect(await page.isVisible('[data-testid="cs-diff"]')).toBe(true);
    });

    it("V3 用户接受结果 ⇒ append-only 审计 + 刷新后仍在;零 Run 触发", async () => {
      await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
      await page.waitForSelector('[data-testid="user-accept-btn"]');
      const runsBefore = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskId}`);
      await page.click('[data-testid="user-accept-btn"]');
      await page.locator('[data-testid="user-result-state"]', { hasText: "已接受" }).waitFor();
      // 审计事实(独立持久,非客户端会话态)
      const rows = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'USER_RESULT_ACCEPTED' AND detail->>'goalId' = ${goalId}
    `);
      expect(Number(rows.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
      // 刷新(全新加载)后仍显示已接受
      await page.reload();
      await page.locator('[data-testid="user-result-state"]', { hasText: "已接受" }).waitFor();
      // 接受不触发新 Run
      const runsAfter = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskId}`);
      expect(Number(runsAfter.rows[0]!["n"])).toBe(Number(runsBefore.rows[0]!["n"]));
    });

    it("V4 用户拒绝结果(带原因)⇒ 原因落审计;刷新后仍在;task 仍 ACCEPTED;给后续指引", async () => {
      await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
      await page.waitForSelector('[data-testid="user-reject-reason"]');
      const runsBefore = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskId}`);
      await page.fill('[data-testid="user-reject-reason"]', "脚本内容不符合预期,需要重做");
      await page.click('[data-testid="user-reject-btn"]');
      await page.locator('[data-testid="user-result-state"]', { hasText: "已拒绝" }).waitFor();
      const rows = await t.db.execute(sql`
      SELECT detail FROM audit_events
      WHERE action = 'USER_RESULT_REJECTED' AND detail->>'goalId' = ${goalId}
      ORDER BY seq DESC LIMIT 1
    `);
      expect(rows.rows.length).toBe(1);
      const detail = rows.rows[0]!["detail"] as Record<string, unknown>;
      expect(detail["reason"]).toBe("脚本内容不符合预期,需要重做");
      // 刷新(全新加载)后仍显示已拒绝 + 原因可见
      await page.reload();
      await page.locator('[data-testid="user-result-state"]', { hasText: "已拒绝" }).waitFor();
      expect((await page.textContent('[data-testid="user-result-reason"]')) ?? "").toContain("不符合预期");
      // 拒绝不改内部 Gate 语义:task 仍 ACCEPTED
      const task = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
      expect(String(task.rows[0]!["state"])).toBe("ACCEPTED");
      // 拒绝不触发新 Run;给出明确下一步指引(不自动改代码/不自动 FAILED)
      const runsAfter = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskId}`);
      expect(Number(runsAfter.rows[0]!["n"])).toBe(Number(runsBefore.rows[0]!["n"]));
      expect((await page.textContent('[data-testid="result-user-acceptance"]')) ?? "").toContain("新建后续任务");
    });

    it("V5 工作区结果卡:来源行 stub 演示 + 用户验收最新事实,与验收结果页同源", async () => {
      await page.goto(`${base}/workspace?goal=${encodeURIComponent(goalId)}`);
      await page.waitForSelector('[data-testid="ws-result-card"]');
      const prov = (await page.textContent('[data-testid="ws-result-provenance"]')) ?? "";
      expect(prov).toContain("演示");
      const acc = (await page.textContent('[data-testid="ws-result-user-acceptance"]')) ?? "";
      expect(acc).toContain("已拒绝"); // 最新用户验收事实(V4 之后)
      // 语义分离在工作区同样成立:内部复核通过 stage 仍在
      expect((await page.textContent('[data-testid="ws-result-card"]')) ?? "").toContain("独立复核通过");
    });

    it("V6 Goal 时间线=最新轮口径:旧轮 DELIVERED + 最新轮 FAILED ⇒ 零旧轮成功文案", async () => {
      // 纯投影测试:拦截明细快照,注入「旧轮 DELIVERED + 最新轮 FAILED」两轮变更集;
      // 旧实现 cs.some(DELIVERED) ⇒ 时间线第 7/8 步显示旧轮成功(红);修复后按最新轮事实。
      await page.route(`**/api/goals/${goalId}`, async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as { goal: Record<string, unknown> };
        const detail = json["goal"] as {
          changesets: Array<Record<string, unknown>>;
        };
        const stale = {
          ...detail.changesets[0]!,
          id: "cs-old-round-delivered",
          deliveryState: "DELIVERED",
          gitCommitSha: "a".repeat(40),
        };
        const newest = { ...detail.changesets[0]!, deliveryState: "FAILED" };
        detail.changesets = [newest, stale]; // API 序=新在前(csList[0] 最新)
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
      });
      await page.goto(`${base}/goal.html?id=${encodeURIComponent(goalId)}`);
      await page.waitForSelector('[data-testid="goal-timeline-steps"]');
      const steps = await page.locator('[data-testid="goal-timeline-steps"] .tl-step').allTextContents();
      const deliverStep = steps.find((s) => s.includes("正在交付")) ?? "";
      const doneStep = steps.find((s) => s.includes("完成")) ?? "";
      expect(deliverStep).toContain("交付遇到问题"); // 最新轮 FAILED 事实
      expect(deliverStep).not.toContain("修改已交付到仓库"); // 旧轮 DELIVERED 不得冒充本轮
      expect(doneStep).not.toContain("全部完成"); // 旧轮成功不得冒充本轮完成
    });
  },
);
