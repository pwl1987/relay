// WEB-UX-03C §0/§0.1/§0.2(03B.1)单元测试:消费语义闭环。
// at-most-once(UNIQUE(message_id))/在途守卫/幂等(重启·重复 tick)/映射 append-only/上下文可见。
// 全部合成数据 + 独立 schema;零模型调用、零 egress、零门控 env。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { consumeAllPendingGoals, consumeGoalMessages, pendingConsumptionGoals } from "../../src/core/consumption.ts";
import { taskFollowUpMessagesView } from "../../src/server/views/goal.ts";
import { IN_FLIGHT_STATES } from "../../src/server/views/shared.ts";
import { buildRunPrompt } from "../../src/runtime/context.ts";

async function seedScenario(t: TestDb): Promise<void> {
  const stmts = [
    sql`INSERT INTO goals (id, raw_input, state) VALUES ('g-1','登录页不好用,自己检查并改好','ACTIVE')`,
    sql`INSERT INTO goals (id, raw_input, state) VALUES ('g-2','导出功能缺失,补上','ACTIVE')`,
    sql`INSERT INTO tasks (id, goal_id, state) VALUES ('t-1','g-1','ACCEPTED')`,
    sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES
        ('g-1','USER','USER_MESSAGE','登录页不好用,自己检查并改好'),
        ('g-1','RELAY','RELAY_MESSAGE','收到。我先检查登录流程、页面结构和相关样式。'),
        ('g-1','USER','USER_MESSAGE','按钮还是太浅,再明显一点。'),
        ('g-1','USER','USER_MESSAGE','顺便把错误提示文字也调整一下。'),
        ('g-2','USER','USER_MESSAGE','导出功能缺失,补上。')`,
  ];
  for (const s of stmts) await t.db.execute(s);
}

describe("WEB-UX-03C 03B.1:消息消费语义闭环(零模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("goal-message-consumption");
    await seedScenario(t);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("迁移已应用:UNIQUE(message_id) + 消费映射 append-only 守卫", async () => {
    // 专用占位消息(避免污染后续消费用例的消息集)
    const ph = await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('g-1','USER','USER_MESSAGE','占位消息:约束测试专用') RETURNING id
    `);
    const mid = Number(ph.rows[0]!["id"]);
    // UNIQUE(message_id) = at-most-once 的数据库级证明:同 message_id 第二条映射必拒
    await t.db.execute(sql`INSERT INTO goal_message_consumptions (message_id, goal_id, task_id) VALUES (${mid},'g-1','t-1')`);
    await expect(t.db.execute(sql`INSERT INTO goal_message_consumptions (message_id, goal_id, task_id) VALUES (${mid},'g-1','t-1')`)).rejects.toThrow();
    // append-only:UPDATE/DELETE 拒绝
    const row = await t.db.execute(sql`SELECT id FROM goal_message_consumptions WHERE message_id = ${mid}`);
    const cid = String(row.rows[0]!["id"]);
    await expect(t.db.execute(sql`UPDATE goal_message_consumptions SET task_id = 't-9' WHERE id = ${cid}`)).rejects.toThrow();
    await expect(t.db.execute(sql`DELETE FROM goal_message_consumptions WHERE id = ${cid}`)).rejects.toThrow();
  });

  it("consumeGoalMessages:不在途 ⇒ 合并派生 follow-up + 逐消息映射 + 审计 + RELAY 确认", async () => {
    const before = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    const r = await consumeGoalMessages(t.db, "g-1", { actor: "owner" });
    expect(r.consumed).toBe(true);
    expect(r.taskId).toMatch(/^task-/);
    expect(r.messageIds!.length).toBe(3); // 原始需求 + 两条补充(第一条 USER 消息也未被消费过)
    const after = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM goals`);
    expect(Number(after.rows[0]!["n"])).toBe(Number(before.rows[0]!["n"])); // 不创建新 Goal
    const task = await t.db.execute(sql`SELECT goal_id, state, allowed_scope FROM tasks WHERE id = ${r.taskId}`);
    expect(String(task.rows[0]!["goal_id"])).toBe("g-1");
    expect(String(task.rows[0]!["state"])).toBe("READY"); // 同 Goal 新受控执行动作(J5)
    const mapping = await t.db.execute(sql`
      SELECT message_id FROM goal_message_consumptions WHERE task_id = ${r.taskId} ORDER BY message_id ASC
    `);
    expect(mapping.rows.length).toBe(3);
    const auditRows = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE detail->>'goalId' = 'g-1' AND action = 'GOAL_MESSAGES_CONSUMED'
    `);
    expect(auditRows.rows.length).toBe(1);
    const ack = await t.db.execute(sql`
      SELECT content FROM goal_messages WHERE goal_id = 'g-1' AND actor = 'RELAY' ORDER BY id DESC LIMIT 1
    `);
    expect(String(ack.rows[0]!["content"])).toContain("已收到你的补充");
  });

  it("at-most-once:重启/重复 tick/重试不重复派生(再次消费 ⇒ nothing_pending)", async () => {
    const tasksBefore = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE goal_id = 'g-1'`);
    const r2 = await consumeGoalMessages(t.db, "g-1", { actor: "goal-loop" });
    expect(r2.consumed).toBe(false);
    expect(r2.reason).toBe("nothing_pending");
    const tasksAfter = await t.db.execute(sql`SELECT COUNT(*)::int AS n FROM tasks WHERE goal_id = 'g-1'`);
    expect(Number(tasksAfter.rows[0]!["n"])).toBe(Number(tasksBefore.rows[0]!["n"]));
  });

  it("在途守卫:IN_FLIGHT 状态(与 server IN_FLIGHT_STATES 逐态对齐)⇒ 不消费不派生", async () => {
    for (const state of IN_FLIGHT_STATES) {
      const tid = `t-inf-${state}`;
      await t.db.execute(sql`INSERT INTO tasks (id, goal_id, state) VALUES (${tid},'g-1',${state})`);
      const r = await consumeGoalMessages(t.db, "g-1");
      expect(r).toEqual({ consumed: false, reason: "in_flight" });
      await t.db.execute(sql`DELETE FROM tasks WHERE id = ${tid}`);
    }
  });

  it("pendingConsumptionGoals + consumeAllPendingGoals:跨 Goal 扫描消费;完成后无残留", async () => {
    const pending = await pendingConsumptionGoals(t.db);
    expect(pending.map((g) => g.goalId)).toEqual(["g-2"]); // g-1 已消费
    const out = await consumeAllPendingGoals(t.db, "goal-loop");
    expect(out.failedGoals).toEqual([]);
    const derived = out.results.filter((r) => r.consumed);
    expect(derived.length).toBe(1);
    expect(derived[0]!.taskId).toMatch(/^task-/);
    const after = await pendingConsumptionGoals(t.db);
    expect(after).toEqual([]); // 重启/下一拍重复扫描 ⇒ 空
  });

  it("§0.2 上下文可见:taskFollowUpMessagesView + buildRunPrompt 真正包含用户补充", async () => {
    // g-1 的 follow-up Task(上一用例派生)经映射可见两条补充
    const ft = await t.db.execute(sql`
      SELECT task_id FROM goal_message_consumptions c JOIN goal_messages gm ON gm.id = c.message_id
      WHERE gm.content LIKE '%按钮还是太浅%' LIMIT 1
    `);
    const taskId = String(ft.rows[0]!["task_id"]);
    const msgs = await taskFollowUpMessagesView(t.db, taskId);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m) => m.content.includes("按钮还是太浅"))).toBe(true);
    expect(await taskFollowUpMessagesView(t.db, "task-none")).toEqual([]);
    // 与 worker.ts 注入组合一致:Goal 原始需求 + follow-up 全部进入 prompt
    const goal = "登录页不好用,自己检查并改好";
    const extra = `# 用户后续补充(Goal 会话中消费绑定到本任务;按序合并)\n${msgs.map((m) => `- ${m.content}`).join("\n")}`;
    const prompt = buildRunPrompt({ taskId, attempt: 1, goal, allowedScope: ["/workspace"], workspacePath: "/workspace", extraInstructions: extra });
    expect(prompt).toContain(`goal: ${goal}`);
    expect(prompt).toContain("按钮还是太浅");
    expect(prompt).toContain("用户后续补充");
  });
});
