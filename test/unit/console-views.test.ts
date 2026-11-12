// OPERATOR-CONSOLE-00 单元测试:控制台扩展视图(全部合成数据 + 独立 schema;零模型调用、零 egress、零门控 env)。
// 覆盖:dashboardExtrasView(P0-UI-1)/projectsView(P0-UI-2)/goalDetailView.progress(P0-UI-3)
//       /decisionListView.guidance(P0-UI-4)/modelsUsageView(P0-UI-5)/systemView(P0-UI-6)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import {
  dashboardExtrasView,
  goalDetailView,
  decisionListView,
  projectsView,
  modelsUsageView,
  systemView,
  groupTaskCounts,
} from "../../src/server/views.ts";

const PROJ_ENV = "RELAY_PROJECTS_FILE";

async function seedCoreScenario(t: TestDb): Promise<void> {
  // Goal A:执行中(一条 RUN);Goal B:等待人工决策(D3 OPEN);Goal C:已交付。
  const stmts = [
    sql`INSERT INTO goals (id, raw_input, state) VALUES ('g-run','给系统加 Excel 导出','ACTIVE'), ('g-dec','调查接口偶发出错','ACTIVE'), ('g-done','修好登录页','ACTIVE')`,
    sql`INSERT INTO tasks (id, goal_id, state) VALUES ('t-run','g-run','RUNNING'), ('t-dec','g-dec','NEEDS_DECISION'), ('t-done','g-done','ACCEPTED')`,
    sql`INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, outcome, detail) VALUES
        ('r-1','t-run',1,'group/gm','docker','RUNNING','{"role":"coder"}'::jsonb),
        ('r-0','t-done',1,'group/gm','docker','SUCCEEDED','{"role":"coder"}'::jsonb)`,
    sql`INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, deadline)
        VALUES ('d-1','t-dec','g-dec','D3','是否批准对真实仓库执行 force-with-lease 推送?',
        '{"recommended":"暂缓推送,先人工核对远端 HEAD","alternatives":["放弃本次候选","改走新分支"],"risk":"覆盖远端历史且不可逆","action":"等待人工批准"}'::jsonb, now() + interval '2 hours')`,
    sql`INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope, git_tree_sha, git_commit_sha, delivery_state, delivered_at)
        VALUES ('cs-1','t-done','r-0',1,'b','c','q','{"added":["a.ts"],"modified":[],"removed":[]}'::jsonb,'{"inScope":["a.ts"],"violations":[]}'::jsonb,'tree','commit','DELIVERED', now())`,
    sql`INSERT INTO budget_ledger (id, scope_type, scope_id, kind, limit_value, reserved, used) VALUES
        ('bl-1','goal','g-run','model_calls',8,2,3),
        ('bl-2','run','r-1','tokens_in',NULL,0,1200),
        ('bl-3','run','r-1','tokens_out',NULL,0,340)`,
    sql`INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
        VALUES ('ev-1','t-done',1,'c','deterministic_test',true,'ok','{}'::jsonb,'sha','worker')`,
    sql`INSERT INTO leases (task_id, owner_id, fencing_token, lease_expires_at, heartbeat_at)
        VALUES ('t-run','w1',7, now() + interval '30 minutes', now())`,
  ];
  for (const s of stmts) await t.db.execute(s);
}

describe("OPERATOR-CONSOLE-00:控制台扩展视图(合成数据;零模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("console-views");
    await seedCoreScenario(t);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("groupTaskCounts:状态分组计数正确", () => {
    const g = groupTaskCounts({ RUNNING: 1, VERIFYING: 2, READY: 3, REWORK: 1, NEEDS_DECISION: 4, BLOCKED: 1, FAILED: 2, ACCEPTED: 5, CANCELLED: 1 });
    expect(g).toEqual({ inFlight: 3, ready: 4, waiting: 5, failed: 2, done: 6 });
  });

  it("P0-UI-1 dashboardExtrasView:当前 Goal/任务分组/Delivery 汇总/最近模型/心跳/最近完成", async () => {
    const x = await dashboardExtrasView(t.db);
    // 执行中任务在 t-run ⇒ currentGoal 指向 g-run
    expect(x.currentGoal?.id).toBe("g-run");
    expect(x.currentGoal?.inFlightTaskId).toBe("t-run");
    expect(x.currentGoal?.inFlightState).toBe("RUNNING");
    expect(x.taskGroups.inFlight).toBeGreaterThanOrEqual(1);
    expect(x.taskGroups.waiting).toBeGreaterThanOrEqual(1);
    expect(x.taskGroups.done).toBeGreaterThanOrEqual(1);
    expect(x.deliverySummary.byState["DELIVERED"]).toBe(1);
    expect(x.deliverySummary.deliveredTotal).toBe(1);
    expect(x.deliverySummary.lastDeliveredAt).toBeTruthy();
    expect(x.lastModel.modelRef).toBe("group/gm");
    expect(["run", "discovery"]).toContain(x.lastModel.source);
    expect(x.lastWorkerHeartbeat).toBeTruthy();
    const delivered = x.recentCompleted.find((r) => r.taskId === "t-done");
    expect(delivered?.commitSha).toBe("commit");
    expect(delivered?.changedFiles).toBe(1);
    expect(delivered?.deliveredAt).toBeTruthy();
  });

  it("P0-UI-3 goalDetailView.progress:执行中/已交付/等待决策三态阶段推导正确", async () => {
    const running = await goalDetailView(t.db, "g-run");
    expect(running?.progress.phase).toBe("执行中");
    expect(running?.progress.currentTaskId).toBe("t-run");
    expect(running?.progress.currentModelRef).toBe("group/gm");
    expect(running?.progress.delivered).toBe(false);
    expect(running?.progress.counts.runs).toBe(1);

    const done = await goalDetailView(t.db, "g-done");
    expect(done?.progress.phase).toBe("已交付");
    expect(done?.progress.delivered).toBe(true);

    const dec = await goalDetailView(t.db, "g-dec");
    expect(dec?.progress.phase).toBe("等待人工决策");
    expect(dec?.progress.counts.openDecisions).toBe(1);
    expect(dec?.progress.elapsedSeconds).toBeNull();
    expect(running?.progress.elapsedSeconds).toBeTypeOf("number");
  });

  it("P0-UI-4 decisionListView.guidance:五要素(为何/推荐/备选/风险/不处理影响)从既有列推导", async () => {
    const list = await decisionListView(t.db);
    const d = list.find((x) => x.id === "d-1");
    expect(d).toBeTruthy();
    // WEB-UX-02:guidance 改用户语言 —— 不再把内部级别/枚举(D3/NEEDS_DECISION)直显给普通用户
    expect(d!.guidance.why).toContain("需要你亲自决定");
    expect(d!.guidance.why).not.toContain("D3");
    expect(d!.guidance.why).not.toContain("NEEDS_DECISION");
    expect(d!.guidance.recommended).toBe("暂缓推送,先人工核对远端 HEAD");
    expect(d!.guidance.alternatives).toEqual(["放弃本次候选", "改走新分支"]);
    expect(d!.guidance.risk).toBe("覆盖远端历史且不可逆");
    expect(d!.guidance.impactOfNoAction).toContain("不会自动批准");
  });

  it("P0-UI-5 modelsUsageView:聚合预算/最近调用/失败原因;凭据零出现;probed 恒 false", async () => {
    const saved = ["RELAY_PI_PROVIDER", "RELAY_PI_MODEL", "RELAY_PI_API_KEY", "RELAY_PI_BASE_URL"].map((k) => [k, process.env[k]] as const);
    for (const [k] of saved) delete process.env[k];
    try {
      const u = await modelsUsageView(t.db);
      expect(u.provider.configured).toBe(false);
      expect(u.provider.probed).toBe(false);
      expect(u.classification.status).toBe("UNREGISTERED");
      expect(u.budgetTotals.modelCalls).toEqual({ limit: 8, reserved: 2, used: 3 });
      expect(u.budgetTotals.tokensInUsed).toBe(1200);
      expect(u.budgetTotals.tokensOutUsed).toBe(340);
      expect(u.outcomes.byOutcome["SUCCEEDED"]).toBe(1);
      expect(u.outcomes.byOutcome["RUNNING"]).toBe(1);
      expect(u.recentRuns.length).toBeGreaterThanOrEqual(2);
      expect(u.recentRuns.every((r) => typeof r.modelRef === "string")).toBe(true);
      expect(u.perGoal.some((p) => p.goalId === "g-run" && p.used === 3)).toBe(true);
      const raw = JSON.stringify(u);
      expect(raw).not.toContain("API_KEY");
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });

  it("P0-UI-2 projectsView:注册文件健康事实 + allowed_scope 前缀关联 Goal;坏目录如实 unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-proj-"));
    try {
      const good = join(dir, "proj-a");
      mkdirSync(good, { recursive: true });
      execFileSync("git", ["-C", good, "init", "--initial-branch=main"], { stdio: "ignore" });
      execFileSync("git", ["-C", good, "config", "user.email", "t@local"], { stdio: "ignore" });
      execFileSync("git", ["-C", good, "config", "user.name", "t"], { stdio: "ignore" });
      writeFileSync(join(good, "f.txt"), "x\n");
      execFileSync("git", ["-C", good, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", good, "commit", "-m", "init"], { stdio: "ignore" });
      // 项目路径作为 allowed_scope 前缀写入 t-run
      await t.db.execute(sql`UPDATE tasks SET allowed_scope = ${JSON.stringify([good])}::jsonb WHERE id = 't-run'`);
      const cfg = join(dir, "projects.json");
      writeFileSync(cfg, JSON.stringify({ projects: [{ name: "项目A", path: good, repo: "https://example.invalid/a", branch: "main" }, { name: "坏项目", path: join(dir, "missing") }] }));
      const saved = process.env[PROJ_ENV];
      process.env[PROJ_ENV] = cfg;
      try {
        const v = await projectsView(t.db);
        expect(v.configured).toBe(true);
        expect(v.projects).toHaveLength(2);
        const okProj = v.projects.find((p) => p.name === "项目A")!;
        expect(okProj.health).toBe("ok");
        expect(okProj.gitBranch).toBe("main");
        expect(okProj.gitHead).toMatch(/^[0-9a-f]{40}$/);
        expect(okProj.repo).toBe("https://example.invalid/a");
        expect(okProj.recentGoals.map((g) => g.id)).toContain("g-run");
        const bad = v.projects.find((p) => p.name === "坏项目")!;
        expect(bad.health).toBe("unreachable");
        expect(bad.healthDetail).toBeTruthy();
      } finally {
        if (saved === undefined) delete process.env[PROJ_ENV];
        else process.env[PROJ_ENV] = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P0-UI-6 systemView:HEAD/DB/Worker/GitHub/uptime/最近错误(全只读)", async () => {
    const v = await systemView(t.db, { mode: "external", active: false, lastTick: null });
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: join(import.meta.dirname, "../..") }).trim();
    expect(v.relay.head).toBe(expectedHead);
    expect(v.relay.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(v.db.ok).toBe(true);
    expect(v.db.serverVersion).toContain("PostgreSQL");
    expect(v.github.deliveryByState["DELIVERED"]).toBe(1);
    expect(v.worker.mode).toBe("external");
    expect(v.worker.activeLeases).toBe(1);
    expect(v.provider.probed).toBe(false);
    expect(v.recentErrors.some((e) => e.kind.startsWith("run_")) || v.recentErrors.length === 0).toBe(true);
  });
});
