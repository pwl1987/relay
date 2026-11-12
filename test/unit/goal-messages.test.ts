// WEB-UX-03 03B 单元测试:goal_messages 迁移约束 + planFollowUpTask + Goal Feed/Status 视图。
// 全部合成数据 + 独立 schema;零模型调用、零 egress、零门控 env(沿 console-views 模式)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planFollowUpTask } from "../../src/core/goals.ts";
import type { Exec } from "../../src/core/db.ts";
import { goalFeedView, goalHasInFlightRun, goalStatusView } from "../../src/server/views/goal.ts";

async function seedScenario(t: TestDb): Promise<void> {
  const stmts = [
    sql`INSERT INTO goals (id, raw_input, state) VALUES ('g-1','登录页不好用,自己检查并改好','ACTIVE')`,
    sql`INSERT INTO tasks (id, goal_id, state) VALUES ('t-1','g-1','ACCEPTED')`,
    sql`INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, deadline)
        VALUES ('d-1','t-1','g-1','D3','是否批准对真实仓库执行 force-with-lease 推送?',
        '{"recommended":"暂缓推送,先人工核对远端 HEAD","alternatives":["放弃本次候选"],"risk":"覆盖远端历史且不可逆","action":"等待人工批准"}'::jsonb, now() + interval '2 hours')`,
    sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES
        ('g-1','USER','USER_MESSAGE','登录页不好用,自己检查并改好'),
        ('g-1','RELAY','RELAY_MESSAGE','收到。我先检查登录流程、页面结构和相关样式。')`,
  ];
  for (const s of stmts) await t.db.execute(s);
}

describe("WEB-UX-03 03B:goal_messages(零模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("goal-messages");
    await seedScenario(t);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("迁移已应用:表存在且 append-only 守卫拦截 UPDATE/DELETE", async () => {
    const rows = await t.db.execute(sql`SELECT id, goal_id, actor, kind FROM goal_messages ORDER BY id ASC`);
    expect(rows.rows.length).toBe(2);
    // actor/kind CHECK 约束
    await expect(t.db.execute(sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('g-1','SYSTEM','USER_MESSAGE','x')`)).rejects.toThrow();
    await expect(t.db.execute(sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('g-1','USER','STATUS','x')`)).rejects.toThrow();
    // append-only 触发器
    const first = String(rows.rows[0]!["id"]);
    await expect(t.db.execute(sql`UPDATE goal_messages SET content = 'tampered' WHERE id = ${first}`)).rejects.toThrow();
    await expect(t.db.execute(sql`DELETE FROM goal_messages WHERE id = ${first}`)).rejects.toThrow();
    // FK:不存在的 goal 拒绝
    await expect(t.db.execute(sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('g-missing','USER','USER_MESSAGE','x')`)).rejects.toThrow();
  });

  it("planFollowUpTask:同 Goal 派生 READY Task + 审计;不创建新 Goal", async () => {
    const before = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    const derived = await planFollowUpTask(t.db as unknown as Exec, {
      goalId: "g-1",
      goalText: "再把按钮颜色调明显一点",
      actor: "owner",
    });
    expect(derived.taskId).toMatch(/^task-/);
    const after = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    expect(Number(after.rows[0]!["n"])).toBe(Number(before.rows[0]!["n"]));
    const task = await t.db.execute(sql`SELECT goal_id, state FROM tasks WHERE id = ${derived.taskId}`);
    expect(String(task.rows[0]!["goal_id"])).toBe("g-1");
    expect(String(task.rows[0]!["state"])).toBe("READY");
    const auditRows = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE detail->>'goalId' = 'g-1' AND action IN ('TASK_PLANNED','GOAL_FOLLOWUP_REQUESTED')
      ORDER BY seq DESC LIMIT 2
    `);
    const actions = auditRows.rows.map((r) => String(r["action"])).sort();
    expect(actions).toEqual(["GOAL_FOLLOWUP_REQUESTED", "TASK_PLANNED"]);
  });

  it("planFollowUpTask:不存在的 goal / 空文本拒绝", async () => {
    await expect(planFollowUpTask(t.db as unknown as Exec, { goalId: "g-missing", goalText: "x" })).rejects.toThrow();
    await expect(planFollowUpTask(t.db as unknown as Exec, { goalId: "g-1", goalText: "  " })).rejects.toThrow();
  });

  it("goalHasInFlightRun:RUNNING 在途 ⇒ true;全终态 ⇒ false", async () => {
    expect(await goalHasInFlightRun(t.db, "g-1")).toBe(false);
    await t.db.execute(sql`INSERT INTO tasks (id, goal_id, state) VALUES ('t-2','g-1','RUNNING')`);
    expect(await goalHasInFlightRun(t.db, "g-1")).toBe(true);
  });

  it("goalStatusView:不存在 ⇒ null;存在 ⇒ 任务与未决计数", async () => {
    expect(await goalStatusView(t.db, "g-missing")).toBeNull();
    const s = await goalStatusView(t.db, "g-1");
    expect(s).toBeTruthy();
    expect(s!.goalId).toBe("g-1");
    expect(s!.pendingDecisions).toBe(1);
    expect(s!.tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("goalFeedView:消息游标分页 + 未决决策卡 + 状态快照", async () => {
    const feed1 = await goalFeedView(t.db, "g-1", 0);
    expect(feed1).toBeTruthy();
    expect(feed1!.items.length).toBe(2);
    expect(feed1!.items[0]!.kind).toBe("USER_MESSAGE");
    expect(feed1!.items[1]!.kind).toBe("RELAY_MESSAGE");
    expect(feed1!.hasMore).toBe(false);
    expect(feed1!.decisions.length).toBe(1);
    expect(feed1!.decisions[0]!.question).toContain("force-with-lease");
    // 游标增量:after=首条 id ⇒ 只返回后续
    const firstId = feed1!.items[0]!.id;
    const feed2 = await goalFeedView(t.db, "g-1", firstId);
    expect(feed2!.items.length).toBe(1);
    expect(feed2!.items[0]!.kind).toBe("RELAY_MESSAGE");
    // 不存在的 goal ⇒ null
    expect(await goalFeedView(t.db, "g-missing", null)).toBeNull();
  });
});
