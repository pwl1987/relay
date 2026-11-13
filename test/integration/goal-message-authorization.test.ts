// RELAY-CONTROL-READY-03 P0-1:消息授权方案 A(用户 2026-11-13 已裁决;反例先行;零模型)。
// 语义(设计权威=CURRENT.md 本包合同 + CONTRACTS.md §2 用户决策 + SEMANTICS-P0A §3 方案 A;
// 撤销 WEB-UX-03C §0 "ACTIVE Goal 任意未消费消息自动派生"旧约定):
//   - 普通"发送"(execution_request=false,旧客户端缺省安全降级)⇒ 只交流/记录,
//     任何 Goal 状态下永不派生 Task(ACTIVE 亦不派生 —— 修复前旧代码会派生=反例);
//   - 显式"交给 Relay 执行"(execution_request=true)⇒ 服务器端校验(幂等/Goal 状态/在途/
//     权限/预算继承)后才派生受控 Task;在途 ⇒ 排队到安全边界(不丢不立即执行);
//   - 终态 Goal:终态后送达的执行请求 ⇒ 不派生不重开(goal_closed);
//     在途排队(先于终态迁移)的显式执行 ⇒ 边界消费派生(可审计重激活,授权来源=用户显式点击);
//   - PAUSED:绝对不因历史消息自动重激活(含显式执行消息;合同硬规则,Reviewer Minor-3 收口)。
// 反例实证日志(修复前旧代码真实运行):p0-mvp/control-ready-03/evidence/counterexample-plan-a-old-derive.log
// 上一包 P0-A 终态守卫语义(SAFETY-CLOSE-02)全部保留;幂等防重/在途排队为本包新增。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { consumeGoalMessages } from "../../src/core/consumption.ts";
import { planFollowUpTask, setGoalState } from "../../src/core/goals.ts";
import { handleApi, type ApiDeps } from "../../src/server/api.ts";
import type { Auth } from "../../src/server/auth.ts";
import type { Exec } from "../../src/core/db.ts";

const TERMINAL_STATES = ["COMPLETED", "FAILED", "EXHAUSTED"] as const;
const PAUSED_STATE = "PAUSED";

describe("RELAY-CONTROL-READY-03 P0-1:消息授权方案 A(零模型)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("control-ready-03-p01");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  async function seedGoalWithTask(goalId: string, goalState: string): Promise<void> {
    await t.db.execute(sql`
      INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, '历史需求:登录页不好用,自己检查并改好', ${goalState})
    `);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${`t-old-${goalId}`}, ${goalId}, 'ACCEPTED', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
  }

  /** 建 Goal + 已 ACCEPTED 旧任务 + 一条未消费 USER 消息(executionRequest 缺省=false)。 */
  async function seedTerminalScenario(goalId: string, goalState: string): Promise<void> {
    await seedGoalWithTask(goalId, goalState);
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '顺便把错误提示文字也调整一下。')
    `);
  }

  async function seedMessage(goalId: string, content: string, executionRequest: boolean): Promise<void> {
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', ${content}, ${executionRequest})
    `);
  }

  async function taskCount(goalId: string): Promise<number> {
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    return Number(r.rows[0]!["n"]);
  }

  function apiDeps() {
    return {
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
  }

  function postMessage(goalId: string, body: Record<string, unknown>) {
    return handleApi(apiDeps(), {
      method: "POST",
      path: `/api/goals/${goalId}/messages`,
      query: new URLSearchParams(),
      body,
      headers: { cookie: "relay_session=x", "x-relay-csrf": "c", origin: "null" },
      ip: "127.0.0.1",
    });
  }

  // ---------- 方案 A 核心:普通发送永不派生;显式执行才派生 ----------

  it("方案 A 反例(修复前旧代码会派生):ACTIVE Goal + 普通 USER 消息(无执行意图)⇒ 只记录不派生(no_execution_request)", async () => {
    const goalId = "g-a-plain-no-derive";
    await seedGoalWithTask(goalId, "ACTIVE");
    await seedMessage(goalId, "按钮还是太浅,再明显一点。", false);
    const before = await taskCount(goalId);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(false);
    expect(r.reason).toBe("no_execution_request");
    expect(await taskCount(goalId)).toBe(before); // 修复前:此处 +1(旧 §0 自动派生,已被方案 A 撤销)
    // 消息保持未消费(会话事实;不伪造映射)
    const pending = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages gm WHERE gm.goal_id=${goalId} AND gm.actor='USER'
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    `);
    expect(Number(pending.rows[0]!["n"])).toBe(1);
  });

  it("旧客户端缺省安全降级:INSERT 不带 execution_request(迁移默认 false)⇒ 永不派生", async () => {
    const goalId = "g-a-default-false";
    await seedGoalWithTask(goalId, "ACTIVE");
    // 不指定 execution_request(模拟旧客户端/旧数据行)
    await t.db.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'USER', 'USER_MESSAGE', '默认路径:没有执行意图。')
    `);
    const col = await t.db.execute(sql`
      SELECT execution_request FROM goal_messages WHERE goal_id=${goalId} AND actor='USER'
    `);
    expect(col.rows[0]!["execution_request"]).toBe(false); // 迁移默认 = 安全降级
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(false);
    expect(r.reason).toBe("no_execution_request");
    expect(await taskCount(goalId)).toBe(1);
  });

  it("方案 A:显式执行消息(执行意图)⇒ 派生受控 Task + 消费映射 + 审计(origin=explicit-execute)+ RELAY 已创建执行任务确认", async () => {
    const goalId = "g-a-explicit-derive";
    await seedGoalWithTask(goalId, "ACTIVE");
    await seedMessage(goalId, "按钮还是太浅,再明显一点。", true);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(true);
    expect(r.taskId).toMatch(/^task-/);
    const task = await t.db.execute(sql`SELECT state, allowed_scope FROM tasks WHERE id = ${r.taskId}`);
    expect(String(task.rows[0]!["state"])).toBe("READY");
    expect(task.rows[0]!["allowed_scope"]).toEqual(["/workspace"]); // 权限继承语义不变(不扩大)
    // 消费映射(at-most-once)+ 审计
    const mapRow = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_message_consumptions WHERE goal_id=${goalId}
    `);
    expect(Number(mapRow.rows[0]!["n"])).toBe(1);
    const audit = await t.db.execute(sql`
      SELECT detail->>'origin' AS origin FROM audit_events WHERE task_id = ${r.taskId} AND action = 'GOAL_MESSAGES_CONSUMED'
    `);
    expect(String(audit.rows[0]!["origin"])).toBe("explicit-execute");
    // RELAY 确认:明确"已创建执行任务"(非"已形成补充轮")
    const ack = await t.db.execute(sql`
      SELECT content FROM goal_messages WHERE goal_id=${goalId} AND actor='RELAY' ORDER BY id DESC LIMIT 1
    `);
    expect(String(ack.rows[0]!["content"])).toContain("已创建执行任务");
  });

  it("混合意图批次:普通消息与执行消息并存 ⇒ 仅执行消息被消费派生;普通消息保持未消费", async () => {
    const goalId = "g-a-mixed-intent";
    await seedGoalWithTask(goalId, "ACTIVE");
    await seedMessage(goalId, "普通交流:这里文档写得如何?", false);
    await seedMessage(goalId, "执行请求:修复登录页。", true);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(true);
    expect(r.messageIds!.length).toBe(1); // 仅执行消息
    const pendingPlain = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages gm WHERE gm.goal_id=${goalId} AND gm.actor='USER'
        AND gm.execution_request = false
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    `);
    expect(Number(pendingPlain.rows[0]!["n"])).toBe(1); // 普通消息未被消费(记录性事实)
    expect(await taskCount(goalId)).toBe(2);
  });

  // ---------- 在途与终态竞争(合同要求的确定性竞争用例) ----------

  it("在途与终态竞争:在途排队的显式执行(先于终态迁移)⇒ 边界消费派生 + 可审计重激活(GOAL_ACTIVE;授权来源=显式点击)", {
    timeout: 60_000,
  }, async () => {
    const goalId = "g-r-queued-execute";
    await seedGoalWithTask(goalId, "ACTIVE");
    await seedMessage(goalId, "执行请求:把图标也换掉。", true); // 在途期间排队
    await setGoalState(t.db as unknown as Exec, goalId, "COMPLETED", { accepted: 1 }); // 本轮完成后 Goal 终态
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(true); // 排队的显式执行在边界生效(非隐式;授权来源=用户显式点击)
    expect(r.taskId).toMatch(/^task-/);
    const g = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    expect(String(g.rows[0]!["state"])).toBe("ACTIVE"); // 可审计重激活(恢复聚合,无孤儿执行)
    const react = await t.db.execute(sql`
      SELECT detail->>'reason' AS reason FROM audit_events WHERE detail->>'goalId' = ${goalId} AND action = 'GOAL_ACTIVE'
    `);
    expect(String(react.rows[0]!["reason"])).toBe("execute_boundary");
  });

  it("终态后送达的显式执行 ⇒ 不派生不重开(goal_closed;终态竞争的另一半)", async () => {
    const goalId = "g-r-post-terminal-execute";
    await seedGoalWithTask(goalId, "ACTIVE");
    await setGoalState(t.db as unknown as Exec, goalId, "COMPLETED", { accepted: 1 });
    await seedMessage(goalId, "执行请求:再改一轮。", true); // 终态之后才送达
    const before = await taskCount(goalId);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(false);
    expect(r.reason).toBe("goal_closed");
    expect(await taskCount(goalId)).toBe(before);
    const g = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    expect(String(g.rows[0]!["state"])).toBe("COMPLETED"); // 不重开
  });

  // ---------- PAUSED 绝对不自动重激活(合同硬规则;Reviewer Minor-3 收口) ----------

  it(`PAUSED 绝对不重激活:暂停前遗留的显式执行消息 ⇒ 不派生不重激活(goal_closed)`, async () => {
    const goalId = "g-p-paused-absolute";
    await seedGoalWithTask(goalId, "ACTIVE");
    await seedMessage(goalId, "执行请求:暂停前提交。", true); // 暂停前遗留
    await setGoalState(t.db as unknown as Exec, goalId, "PAUSED", { note: "用户暂停" });
    const before = await taskCount(goalId);
    const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    expect(r.consumed).toBe(false);
    expect(r.reason).toBe("goal_closed");
    expect(await taskCount(goalId)).toBe(before);
    const g = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    expect(String(g.rows[0]!["state"])).toBe(PAUSED_STATE); // 绝对不重激活
    // 无重激活审计
    const react = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events WHERE detail->>'goalId' = ${goalId} AND action = 'GOAL_ACTIVE'
    `);
    expect(Number(react.rows[0]!["n"])).toBe(0);
  });

  // ---------- 终态守卫回归(P0-A 语义全部保留;普通消息) ----------

  for (const state of [...TERMINAL_STATES, PAUSED_STATE]) {
    it(`终态/暂停守卫回归:${state} Goal + 普通消息 ⇒ 只记录不派生(goal_closed);planFollowUpTask 直呼拒绝`, async () => {
      const goalId = `g-t-${state.toLowerCase()}`;
      await seedTerminalScenario(goalId, state);
      const before = await taskCount(goalId);
      const r = await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
      expect(r.consumed).toBe(false);
      expect(r.reason).toBe("goal_closed");
      expect(await taskCount(goalId)).toBe(before);
      await expect(
        planFollowUpTask(t.db as unknown as Exec, {
          goalId,
          goalText: "直接派生尝试",
          actor: "test-c03",
          allowedScope: ["/workspace"],
          allowedCommands: ["echo"],
        }),
      ).rejects.toThrow(/非 ACTIVE/);
    });
  }

  // ---------- API 层:intent 字段/反馈三态/幂等 ----------

  it("API:ACTIVE 空闲 Goal 普通发送 ⇒ recorded=true 零新任务 + 指引反馈;旧客户端无 intent 字段同语义", {
    timeout: 60_000,
  }, async () => {
    const goalId = "g-api-plain";
    await seedGoalWithTask(goalId, "ACTIVE");
    const res = await postMessage(goalId, { content: "这里文档写得如何?" }); // 无 executionRequest 字段
    expect(res.status).toBe(201);
    const body = res.body as { recorded?: boolean; followUpTaskId: string | null; note?: string | null };
    expect(body.recorded).toBe(true);
    expect(body.followUpTaskId).toBeNull();
    expect(String(body.note)).toContain("已记录");
    expect(String(body.note)).toContain("交给 Relay 执行");
    expect(await taskCount(goalId)).toBe(1);
  });

  it("API:显式执行(executionRequest=true)⇒ 立即派生 + followUpTaskId + 已创建任务反馈", {
    timeout: 60_000,
  }, async () => {
    const goalId = "g-api-execute";
    await seedGoalWithTask(goalId, "ACTIVE");
    const res = await postMessage(goalId, { content: "修复登录页。", executionRequest: true });
    expect(res.status).toBe(201);
    const body = res.body as { followUpTaskId: string | null; note?: string | null };
    expect(body.followUpTaskId).toMatch(/^task-/);
    expect(String(body.note)).toContain("已创建执行任务");
    expect(await taskCount(goalId)).toBe(2);
    const audit = await t.db.execute(sql`
      SELECT detail->>'executionRequest' AS er FROM audit_events WHERE action = 'WEB_GOAL_MESSAGE' AND detail->>'goalId' = ${goalId}
    `);
    expect(String(audit.rows[0]!["er"])).toBe("true");
  });

  it("幂等防重:相同内容执行请求重复提交 ⇒ 单条消息单任务,第二次返回 duplicate(原子防重;非模型判断)", {
    timeout: 60_000,
  }, async () => {
    const goalId = "g-api-idempotent";
    await seedGoalWithTask(goalId, "ACTIVE");
    const first = await postMessage(goalId, { content: "修复登录页。", executionRequest: true });
    expect(first.status).toBe(201);
    const firstBody = first.body as { followUpTaskId: string | null; messageId: number };
    expect(firstBody.followUpTaskId).toMatch(/^task-/);
    const second = await postMessage(goalId, { content: "修复登录页。", executionRequest: true });
    expect(second.status).toBe(201);
    const secondBody = second.body as { duplicate?: boolean; followUpTaskId: string | null; messageId: number };
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.followUpTaskId).toBe(firstBody.followUpTaskId); // 同一任务,未重复创建
    expect(secondBody.messageId).toBe(firstBody.messageId); // 未插入第二条消息
    expect(await taskCount(goalId)).toBe(2); // 旧任务 + 恰好一个新受控任务
    const msgs = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages WHERE goal_id=${goalId} AND actor='USER' AND execution_request = true
    `);
    expect(Number(msgs.rows[0]!["n"])).toBe(1);
  });

  it("API:终态 Goal 显式执行 ⇒ held(执行请求已记录但不重开不派生)+ 明确反馈", { timeout: 60_000 }, async () => {
    const goalId = "g-api-execute-terminal";
    await seedTerminalScenario(goalId, "COMPLETED");
    const before = await taskCount(goalId);
    const res = await postMessage(goalId, { content: "再改一轮。", executionRequest: true });
    expect(res.status).toBe(201);
    const body = res.body as { held?: boolean; followUpTaskId: string | null; note?: string | null };
    expect(body.held).toBe(true);
    expect(body.followUpTaskId).toBeNull();
    expect(String(body.note)).toContain("已记录");
    expect(String(body.note)).toContain("不会自动创建新执行任务");
    expect(await taskCount(goalId)).toBe(before);
  });

  it("消息事实保留:held 消息保持未消费(append-only;不丢消息不假消费)", async () => {
    const goalId = "g-t-fact-keep";
    await seedTerminalScenario(goalId, "COMPLETED");
    await consumeGoalMessages(t.db, goalId, { actor: "test-c03" });
    const pending = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM goal_messages gm
      WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    `);
    expect(Number(pending.rows[0]!["n"])).toBe(1);
    const msg = await t.db.execute(sql`
      SELECT content FROM goal_messages WHERE goal_id = ${goalId} AND actor = 'USER'
    `);
    expect(String(msg.rows[0]!["content"])).toContain("错误提示文字");
  });
});
