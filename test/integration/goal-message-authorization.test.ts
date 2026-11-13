// RELAY-SAFETY-CLOSE-02 P0-A:消息授权与终态 Goal(反例先行;零模型、零 egress、零门控 env)。
// 纠偏 GAP-REGISTER E-1/E-2:consumeGoalMessages 仅有 task 在途守卫(IN_FLIGHT),无 Goal 状态守卫
// —— 修复前:终态 Goal(COMPLETED/FAILED)上的未消费 USER 消息同样被 planFollowUpTask 派生
// READY Task(scope/commands 继承旧 Task);Goal 已终态 ⇒ aggregateGoals 只聚合 ACTIVE ⇒
// 派生任务执行后 Goal 状态永不更新(孤儿执行)。反例实证日志(修复前真实运行,断言失败输出
// 即漏洞证据):p0-mvp/safety-close-02/evidence/counterexample-terminal-goal-derived.log
// 修复后(本文件语义):非 ACTIVE Goal 消息只记录不派生(consumed=false, reason=goal_closed);
// planFollowUpTask 对非 ACTIVE Goal fail-closed(纵深防御,直呼亦拒绝);API 提供明确
// "已记录"反馈;ACTIVE Goal 派生语义保留(WEB-UX-03C §0 冻结,本包不改变)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { consumeGoalMessages } from "../../src/core/consumption.ts";
import { planFollowUpTask, setGoalState } from "../../src/core/goals.ts";
import { handleApi, type ApiDeps } from "../../src/server/api.ts";
import type { Auth } from "../../src/server/auth.ts";
import type { Exec } from "../../src/core/db.ts";

const TERMINAL_STATES = ["COMPLETED", "FAILED", "EXHAUSTED", "PAUSED"] as const;

describe("RELAY-SAFETY-CLOSE-02 P0-A:消息授权与终态 Goal(零模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("safety-close-02-p0a");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  /** 建非 ACTIVE Goal + 已 ACCEPTED 旧任务 + 一条未消费 USER 消息(反例场景最小面)。 */
  async function seedTerminalScenario(goalId: string, goalState: string): Promise<void> {
    await t.db.execute(sql`
      INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, '历史需求:登录页不好用,自己检查并改好', ${goalState})
    `);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${`t-old-${goalId}`}, ${goalId}, 'ACCEPTED', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '顺便把错误提示文字也调整一下。')
    `);
  }

  async function taskCount(goalId: string): Promise<number> {
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    return Number(r.rows[0]!["n"]);
  }

  for (const state of TERMINAL_STATES) {
    it(`反例(修复后 fail-closed):${state} Goal + 未消费 USER 消息 ⇒ 只记录不派生(goal_closed);planFollowUpTask 直呼拒绝`, async () => {
      const goalId = `g-t-${state.toLowerCase()}`;
      await seedTerminalScenario(goalId, state);
      const before = await taskCount(goalId);
      // 消费路径:非 ACTIVE Goal ⇒ 不消费、不派生(零副作用)
      const r = await consumeGoalMessages(t.db, goalId, { actor: "test-p0a" });
      expect(r.consumed).toBe(false);
      expect(r.reason).toBe("goal_closed");
      expect(await taskCount(goalId)).toBe(before); // 零新 Task(修复前:此处 +1,即漏洞)
      // 纵深防御:绕过消费层直呼 planner 亦被拒绝(终态 Goal 不得静默派生可执行 Task)
      await expect(
        planFollowUpTask(t.db as unknown as Exec, {
          goalId,
          goalText: "直接派生尝试",
          actor: "test-p0a",
          allowedScope: ["/workspace"],
          allowedCommands: ["echo"],
        }),
      ).rejects.toThrow(/非 ACTIVE/);
      expect(await taskCount(goalId)).toBe(before);
    });
  }

  it("API 反馈:终态 Goal 发消息 ⇒ 201 held=true followUpTaskId=null + RELAY 已记录确认 + GOAL_MESSAGE_HELD 审计 + 零新任务", {
    timeout: 60_000,
  }, async () => {
    const goalId = "g-t-api-held";
    await seedTerminalScenario(goalId, "COMPLETED");
    const deps = {
      db: t.db,
      auth: {
        resolve: () => ({ id: "s1", role: "owner", csrf: "c", expiresAt: Date.now() + 60_000 }),
        verifySameOrigin: () => {},
        verifyCsrf: () => {},
        activeSessions: () => 1,
      } as unknown as Auth,
      worker: null,
      workerMode: "external" as const,
      defaultGoalBudgetModelCalls: 8,
    } as ApiDeps;
    const before = await taskCount(goalId);
    const res = await handleApi(deps, {
      method: "POST",
      path: `/api/goals/${goalId}/messages`,
      query: new URLSearchParams(),
      body: { content: "这个是不是已经做完了?" },
      headers: { cookie: "relay_session=x", "x-relay-csrf": "c", origin: "null" },
      ip: "127.0.0.1",
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      ok: boolean;
      messageId: number;
      followUpTaskId: string | null;
      held?: boolean;
      inFlight?: boolean;
      note?: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.held).toBe(true); // 明确反馈:已记录(未创建任务)
    expect(body.followUpTaskId).toBeNull();
    expect(String(body.note)).toContain("已记录");
    // 消息事实保留 + RELAY 确认消息(确定性文案,不含"已形成新一轮执行"误导)
    const msgs = await t.db.execute(sql`
      SELECT actor, content FROM goal_messages WHERE goal_id = ${goalId} ORDER BY id ASC
    `);
    const contents = msgs.rows.map((r) => String(r["content"]));
    expect(contents.some((c) => c.includes("这个是不是已经做完了?"))).toBe(true);
    const ack = msgs.rows.filter((r) => String(r["actor"]) === "RELAY").map((r) => String(r["content"]));
    expect(ack.length).toBe(1);
    expect(ack[0]).toContain("已记录");
    expect(ack[0]).not.toContain("已形成");
    // 零新任务 + held 审计
    expect(await taskCount(goalId)).toBe(before);
    const audit = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE detail->>'goalId' = ${goalId} AND action = 'GOAL_MESSAGE_HELD'
    `);
    expect(audit.rows.length).toBe(1);
  });

  it("ACTIVE Goal 保留派生(冻结 §0 语义不变;修复不越权扩大拦截面)", { timeout: 60_000 }, async () => {
    const goalId = "g-a-active";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, '进行中的需求', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${`t-base-${goalId}`}, ${goalId}, 'ACCEPTED', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '按钮还是太浅,再明显一点。')
    `);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-p0a" });
    expect(r.consumed).toBe(true);
    expect(r.taskId).toMatch(/^task-/);
    const task = await t.db.execute(sql`SELECT state, allowed_scope FROM tasks WHERE id = ${r.taskId}`);
    expect(String(task.rows[0]!["state"])).toBe("READY");
    expect(task.rows[0]!["allowed_scope"]).toEqual(["/workspace"]); // 权限继承语义不变(不扩大)
  });

  it("在途窗口补充(消息创建先于终态迁移)⇒ 边界消费派生 + 可审计重激活(GOAL_ACTIVE)", { timeout: 60_000 }, async () => {
    // §0.1 冻结语义:消息在活会话(在途)期间发出,API 已承诺"将在会话流中呈现";
    // 终态迁移发生在消息之后 ⇒ 该消息是活会话补充,不是终态新请求 ⇒ 边界消费。
    const goalId = "g-b-boundary-supplement";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, '进行中需求', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${`t-base-${goalId}`}, ${goalId}, 'ACCEPTED', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '补充:把图标也换掉。')
    `);
    // 模拟 Run 结束后的聚合:Goal 进入终态(此时消息已存在 ⇒ 先于终态迁移)
    await setGoalState(t.db as unknown as Exec, goalId, "COMPLETED", { accepted: 1 });
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-p0a" });
    expect(r.consumed).toBe(true);
    expect(r.taskId).toMatch(/^task-/);
    // 可审计重激活:Goal 回 ACTIVE(aggregateGoals 恢复聚合,补充轮执行完重新聚合回终态)
    const g = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    expect(String(g.rows[0]!["state"])).toBe("ACTIVE");
    const react = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE detail->>'goalId' = ${goalId} AND action = 'GOAL_ACTIVE'
    `);
    expect(react.rows.length).toBe(1);
    // 消费映射 + at-most-once 保留
    const mapRow = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_message_consumptions WHERE goal_id = ${goalId}
    `);
    expect(Number(mapRow.rows[0]!["n"])).toBe(1);
  });

  it("混合批次(部分消息先于终态、部分后于终态)⇒ 整批保守 held(不部分消费)", async () => {
    const goalId = "g-b-mixed-batch";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, '进行中需求', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '在途补充:先做的这条。')
    `);
    await setGoalState(t.db as unknown as Exec, goalId, "COMPLETED", { accepted: 0 });
    // 终态迁移之后再发第二条(终态新请求)
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '终态后新请求:后发的这条。')
    `);
    const before = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-p0a" });
    expect(r.consumed).toBe(false);
    expect(r.reason).toBe("goal_closed");
    const after = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    expect(Number(after.rows[0]!["n"])).toBe(Number(before.rows[0]!["n"]));
    // 整批未消费(不部分消费;终态新请求连累整批保守停)
    const pending = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages gm WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    `);
    expect(Number(pending.rows[0]!["n"])).toBe(2);
  });

  it("消息事实保留:终态 Goal 的 held 消息保持未消费映射(append-only,不丢消息不假消费)", async () => {
    const goalId = "g-t-fact-keep";
    await seedTerminalScenario(goalId, "COMPLETED");
    await consumeGoalMessages(t.db, goalId, { actor: "test-p0a" });
    const pending = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages gm
      WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    `);
    expect(Number(pending.rows[0]!["n"])).toBe(1); // 未消费(不伪造映射;at-most-once 平凡成立)
    const msg = await t.db.execute(sql`
      SELECT content FROM goal_messages WHERE goal_id = ${goalId} AND actor = 'USER'
    `);
    expect(String(msg.rows[0]!["content"])).toContain("错误提示文字"); // 会话事实完整
  });
});
