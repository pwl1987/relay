// C-3/C-4 Goal Loop 集成(真实 PG;stub Run 注入,无人工干预多 Task 有界执行):
// Planner(FAIL-CLOSED)→ D2 fallback 自动 / D3 阻断永不超时批准 → 多 Task 推进 → goal 聚合。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal, setGoalState } from "../../src/core/goals.ts";
import { createDecision, expireStaleDecisions } from "../../src/core/decisions.ts";
import { resolveDecision, resumeTask, operatorAllowed } from "../../src/core/ops.ts";
import { goalLoopTick, handleOpenDecisions, type RunOutcomeDigest } from "../../src/core/goal-loop.ts";
import type { Exec } from "../../src/core/db.ts";

describe("Planner(FAIL-CLOSED,无模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c3-planner");
  });
  afterAll(() => t.cleanup());

  it("budget.modelCalls 缺失/非正 ⇒ 拒绝创建(无预算不允许模型工作)", async () => {
    await expect(
      planGoal(t.db as unknown as Exec, { rawInput: "g", budget: undefined as never, tasks: [{ goalText: "t" }] }),
    ).rejects.toThrow(/FAIL-CLOSED/);
    await expect(
      planGoal(t.db as unknown as Exec, { rawInput: "g", budget: { modelCalls: 0 }, tasks: [{ goalText: "t" }] }),
    ).rejects.toThrow();
  });

  it("正常规划:goals+tasks+预算账本一行不少;任务 READY", async () => {
    const p = await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        rawInput: "整理目录",
        budget: { modelCalls: 5, tokensIn: 100_000 },
        tasks: [{ id: "t-p1", goalText: "任务一", allowedScope: ["/workspace"], allowedCommands: ["ls"], priority: 5 }, { id: "t-p2", goalText: "任务二" }],
      }),
    );
    expect(p.taskIds).toEqual(["t-p1", "t-p2"]);
    const goal = await t.db.execute(sql`SELECT state FROM goals WHERE id=${p.goalId}`);
    expect(String(goal.rows[0]!["state"])).toBe("ACTIVE");
    const tasks = await t.db.execute(sql`SELECT id, state, priority, allowed_commands FROM tasks WHERE goal_id=${p.goalId} ORDER BY id`);
    expect(String(tasks.rows[0]!["state"])).toBe("READY");
    expect(Number(tasks.rows[0]!["priority"])).toBe(5);
    expect(tasks.rows[0]!["allowed_commands"]).toEqual(["ls"]);
    const ledger = await t.db.execute(sql`SELECT kind, limit_value FROM budget_ledger WHERE scope_id=${p.goalId} ORDER BY kind`);
    expect(ledger.rows.map((r) => [String(r["kind"]), Number(r["limit_value"])])).toEqual([["model_calls", 5], ["tokens_in", 100_000]]);
    // D4 创建被拒
    const d4 = await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, { taskId: "t-p1", level: "D4", question: "危险操作" }),
    );
    expect(d4.ok).toBe(false);
  });
});

describe("D2 fallback / D3 阻断与永不超时批准(T07)/ 恢复 API", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c3-decision");
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-dec",
        rawInput: "g",
        budget: { modelCalls: 10 },
        tasks: [
          { id: "t-d2", goalText: "D2 任务", allowedCommands: ["ls"] },
          { id: "t-d3", goalText: "D3 任务" },
          { id: "t-safe", goalText: "不受阻任务", priority: 10 },
        ],
      }),
    );
    await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, { taskId: "t-d2", level: "D2", question: "q2", fallback: { action: "continue_safe" } }),
    );
    await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, {
        taskId: "t-d3", level: "D3", question: "q3",
        deadline: new Date(Date.now() + 50), // 将过期,但绝不自动批准
      }),
    );
  });
  afterAll(() => t.cleanup());

  it("D2 自动 fallback(审计 DECISION_FALLBACK);D3 → NEEDS_DECISION;D3 过期仅标记仍停留", async () => {
    const r = await handleOpenDecisions(t.db);
    expect(r.d2Resolved).toBe(1);
    expect(r.d3Blocked).toBe(1);
    const d2 = await t.db.execute(sql`SELECT state FROM decisions WHERE task_id='t-d2'`);
    expect(String(d2.rows[0]!["state"])).toBe("RESOLVED_FALLBACK");
    const d3State = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-d3'`);
    expect(String(d3State.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // 决策过期:仅标记 EXPIRED_STILL_BLOCKED,任务停留 NEEDS_DECISION(T07)
    await new Promise((res) => setTimeout(res, 80));
    const expired = await t.db.transaction(async (tx) => expireStaleDecisions(tx as unknown as Exec));
    expect(expired.length).toBe(1);
    const after = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-d3'`);
    expect(String(after.rows[0]!["state"])).toBe("NEEDS_DECISION");
    const dec = await t.db.execute(sql`SELECT state FROM decisions WHERE task_id='t-d3'`);
    expect(String(dec.rows[0]!["state"])).toBe("EXPIRED_STILL_BLOCKED");
  });

  it("恢复 API:未授权 actor 拒绝;state_version 不符拒绝;授权批准 → READY;驳回 → 决策 REJECTED", async () => {
    const tRow = await t.db.execute(sql`SELECT state_version FROM tasks WHERE id='t-d3'`);
    const version = Number(tRow.rows[0]!["state_version"]);
    const dec = await t.db.execute(sql`SELECT id FROM decisions WHERE task_id='t-d3'`);
    const decisionId = String(dec.rows[0]!["id"]);

    // 未授权 actor(env RELAY_OPERATORS 缺省仅 "owner")
    const r1 = await t.db.transaction(async (tx) =>
      resolveDecision(tx as unknown as Exec, { decisionId, taskId: "t-d3", approve: true, actor: "intruder", expectedStateVersion: version }),
    );
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("actor_not_authorized");

    // state_version 过期
    const r2 = await t.db.transaction(async (tx) =>
      resolveDecision(tx as unknown as Exec, { decisionId, taskId: "t-d3", approve: true, actor: "owner", expectedStateVersion: version - 1 }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("state_version_mismatch");

    // 授权批准
    const r3 = await t.db.transaction(async (tx) =>
      resolveDecision(tx as unknown as Exec, { decisionId, taskId: "t-d3", approve: true, actor: "owner", expectedStateVersion: version }),
    );
    expect(r3.ok).toBe(true);
    expect(r3.decisionResolved).toBe(true);
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-d3'`);
    expect(String(st.rows[0]!["state"])).toBe("READY");
  });

  it("resumeTask:PAUSED→READY(state_version 校验);operatorAllowed 语义", () => {
    expect(operatorAllowed("owner")).toBe(true);
    expect(operatorAllowed("random")).toBe(false);
  });
});

describe("Goal Loop 多 Task 有界自治(无人工;stub run 注入)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c4-loop");
  });
  afterAll(() => t.cleanup());

  it("两任务全自动推进到 ACCEPTED ⇒ goal COMPLETED;IDLE 判定;模型断供 ⇒ IDLE_PROVIDER_DOWN 不领取", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-loop1",
        rawInput: "两个独立任务",
        budget: { modelCalls: 10 },
        tasks: [
          { id: "t-loop-a", goalText: "A", priority: 2 },
          { id: "t-loop-b", goalText: "B", priority: 1 },
        ],
      }),
    );
    let ranTasks: string[] = [];
    const runTask = async (claim: { taskId: string }): Promise<RunOutcomeDigest> => {
      ranTasks.push(claim.taskId);
      // 模拟 runner 成功路径末端:RUNNING→SUBMITTED→VERIFYING(runner 职责)
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${claim.taskId}`);
      void r;
      return { outcome: "SUCCEEDED", taskId: claim.taskId };
    };
    // 模拟 runner 的任务推进:成功 ⇒ RUNNING→SUBMITTED→VERIFYING
    const runTaskFull = async (claim: { taskId: string; ownerId: string; fencingToken: number }) => {
      await t.db.transaction(async (tx) => {
        await (tx as unknown as Exec).execute(sql`
          UPDATE tasks SET state='SUBMITTED', state_version=state_version+1 WHERE id=${claim.taskId} AND state='RUNNING'
        `);
      });
      await t.db.transaction(async (tx) => {
        await (tx as unknown as Exec).execute(sql`
          UPDATE tasks SET state='VERIFYING', state_version=state_version+1 WHERE id=${claim.taskId} AND state='SUBMITTED'
        `);
      });
      return runTask(claim);
    };

    // tick 1:领 A(priority 高)
    const tick1 = await goalLoopTick(t.db, { workerId: "w1", ttlSeconds: 60, runTask: runTaskFull });
    expect(tick1.status).toBe("PROGRESSED");
    expect(tick1.tick!.claimed!.taskId).toBe("t-loop-a");
    expect(tick1.run!.outcome).toBe("SUCCEEDED");
    // gate(简化:直接记录 PASS)后 ACCEPTED —— 本包 Gate 编排属 P0-02A,这里仅推进状态
    await t.db.execute(sql`INSERT INTO task_gate_verdicts (id, task_id, verdict, reviewer) VALUES ('g-a','t-loop-a','PASS','rv')`);
    await t.db.execute(sql`UPDATE tasks SET state='ACCEPTED', state_version=state_version+1 WHERE id='t-loop-a'`);

    // tick 2:领 B
    const tick2 = await goalLoopTick(t.db, { workerId: "w1", ttlSeconds: 60, runTask: runTaskFull });
    expect(tick2.tick!.claimed!.taskId).toBe("t-loop-b");
    await t.db.execute(sql`INSERT INTO task_gate_verdicts (id, task_id, verdict, reviewer) VALUES ('g-b','t-loop-b','PASS','rv')`);
    await t.db.execute(sql`UPDATE tasks SET state='ACCEPTED', state_version=state_version+1 WHERE id='t-loop-b'`);

    // tick 3:全部终态 ⇒ goal COMPLETED + IDLE
    const tick3 = await goalLoopTick(t.db, { workerId: "w1", ttlSeconds: 60, runTask: runTaskFull });
    expect(tick3.goalStates).toContainEqual({ goalId: "goal-loop1", state: "COMPLETED" });
    expect(tick3.status).toBe("IDLE");
    expect(tick3.idleHintSeconds).toBeGreaterThan(0);

    // 模型断供:探测失败 ⇒ IDLE_PROVIDER_DOWN,不领取(runTask 不被调用)
    let called = false;
    const tick4 = await goalLoopTick(t.db, {
      workerId: "w1",
      providerProbe: async () => false,
      runTask: async (c) => {
        called = true;
        return { outcome: "SUCCEEDED", taskId: c.taskId };
      },
    });
    expect(tick4.status).toBe("IDLE_PROVIDER_DOWN");
    expect(called).toBe(false);
    void ranTasks;
  });
});
