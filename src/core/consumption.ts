// 消息消费语义(RELAY-CONTROL-READY-03 P0-1;设计权威=用户方案 A 裁决,CURRENT.md 本包合同
// + CONTRACTS.md §2 用户决策 + p0-mvp/safety-close-02/SEMANTICS-P0A.md §3。**撤销 WEB-UX-03C §0**
// "ACTIVE Goal 任意未消费 USER 消息自动派生"旧约定;上一包 SAFETY-CLOSE-02 终态守卫全部保留):
//   - 普通"发送"(execution_request=false;旧客户端缺省安全降级)⇒ 只交流/记录,
//     任何 Goal 状态下永不派生 Task、永不写消费映射;
//   - 显式"交给 Relay 执行"(execution_request=true,INSERT 时落库且 append-only 不可改)
//     ⇒ 服务器端校验(幂等/Goal 状态/在途/权限继承)后才派生受控 Task:
//     · ACTIVE 且无在途(无 LEASED/RUNNING/SUBMITTED/VERIFYING)⇒ 立即派生;
//     · 在途 ⇒ 排队到安全边界(Run 结束后的下一拍由 goalLoopTick 前置步自动消费),不立即执行;
//     · 终态 Goal:终态后送达 ⇒ 不派生不重开(goal_closed);**在途排队(先于终态迁移落库)的
//       显式执行 ⇒ 边界消费:可审计重激活(GOAL_ACTIVE,reason=execute_boundary)后派生**
//       (授权来源=用户显式点击,非隐式;aggregateGoals 恢复聚合,无孤儿执行);
//     · **PAUSED 绝对不因历史消息自动重激活**(合同硬规则;含显式执行消息 —— Reviewer Minor-3 收口);
//   - 消费映射 goal_message_consumptions UNIQUE(message_id) 数据库级保证 at-most-once:
//     重启/重复 tick/并发 worker 的重复派生落入 UNIQUE 冲突 ⇒ 整个事务回滚,不产生部分状态;
//   - 不修改在途 Run 的上下文(不中途强插);不创建匿名会话;不绕 Goal/Task/Core;
//   - goal_messages(会话事实)与本表(消费映射)均 append-only,不复制 Task 状态;
//   - 授权判定是确定性规则,不经模型关键词猜测(方案 A 硬约束)。
// 注:IN_FLIGHT 常量与 src/server/views/shared.ts 的 IN_FLIGHT_STATES 语义一致;
// core 不依赖 server 层(分层边界),一致性由 test/unit/goal-message-consumption.test.ts 钉住。
import { sql } from "drizzle-orm";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { planFollowUpTask, setGoalState } from "./goals.ts";

/** 与 server/views/shared.ts IN_FLIGHT_STATES 相同(见上注)。 */
const IN_FLIGHT_STATES_LOCAL = ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"] as const;

export interface ConsumptionResult {
  consumed: boolean;
  reason?: "in_flight" | "nothing_pending" | "goal_closed" | "no_execution_request";
  /** goal_closed / no_execution_request 时携带当前 Goal 状态(供调用方/测试区分处置) */
  goalState?: string;
  taskId?: string;
  messageIds?: number[];
}

export interface PendingGoalRef {
  goalId: string;
}

/** 有待消费**显式执行**消息的 Goal 集合(消费前置扫描;M-2 消化:仅含普通消息的 Goal 不入扫描
 *  —— 普通消息永不派生,扫入只会得到 no_execution_request 零副作用;在途/终态守卫仍在
 *  consumeGoalMessages 内,本扫描不区分状态)。 */
export async function pendingConsumptionGoals(db: RelayDb): Promise<PendingGoalRef[]> {
  const res = await db.execute(sql`
    SELECT gm.goal_id AS goal_id
    FROM goal_messages gm
    WHERE gm.actor = 'USER'
      AND gm.execution_request = true
      AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    GROUP BY gm.goal_id
    ORDER BY gm.goal_id ASC
  `);
  return res.rows.map((r) => ({ goalId: String(r["goal_id"]) }));
}

/**
 * 消费一个 Goal 的未处理显式执行消息(单事务;幂等;方案 A:普通消息永不消费/派生)。
 * - 在途 ⇒ { consumed:false, reason:"in_flight" }(显式执行排队到安全边界后重试);
 * - 无未消费显式执行消息 ⇒ { consumed:false, reason:"no_execution_request" } /
 *   { reason:"nothing_pending" }(纯普通消息 ⇒ 前者;零副作用);
 * - 终态/暂停 Goal ⇒ { reason:"goal_closed" }(只记录不派生;唯一例外=终态 Goal 上在途排队的
 *   显式执行(先于终态迁移落库)⇒ 可审计重激活后边界消费;PAUSED 绝对不重激活);
 * - 消费 ⇒ 派生受控 follow-up Task + 逐消息映射 + GOAL_MESSAGES_CONSUMED(origin=explicit-execute)
 *   审计 + RELAY"已创建执行任务"确认。
 * 并发重复消费:message_id UNIQUE 冲突 ⇒ 事务回滚(无 Task/无映射/无审计),调用方下拍重试只会得到 nothing_pending。
 */
export async function consumeGoalMessages(
  db: RelayDb,
  goalId: string,
  opts: { actor?: string } = {},
): Promise<ConsumptionResult> {
  const actor = opts.actor ?? "goal-loop";
  return db.transaction(async (tx) => {
    const exec = tx as unknown as Exec;
    const goalRow = await exec.execute(sql`SELECT state, updated_at FROM goals WHERE id = ${goalId}`);
    const goalState = String(goalRow.rows[0]?.["state"] ?? "");

    // 方案 A:仅"显式执行"消息可进入派生面(普通消息永不派生/永不写映射)。
    const pendingExecRows = await exec.execute(sql`
      SELECT gm.id AS id, gm.content AS content
      FROM goal_messages gm
      WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER' AND gm.execution_request = true
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
      ORDER BY gm.id ASC
    `);

    if (goalState !== "ACTIVE") {
      // 终态/暂停守卫(SAFETY-CLOSE-02 P0-A 保留 + 方案 A 精化):
      // - PAUSED:绝对不因历史消息自动重激活(含显式执行消息;合同硬规则)。
      // - 终态(COMPLETED/FAILED/EXHAUSTED):终态后送达的执行请求 ⇒ held;
      //   唯一例外 = 在途排队(先于终态迁移落库)的显式执行 ⇒ 边界消费(可审计重激活;
      //   授权来源=用户显式点击「交给 Relay 执行」,非隐式;按消息独立授权,仅消费该子集)。
      // 时间戳比较下沉到 SQL(µs 精度;严禁 String(Date) 往返 —— toString 丢毫秒,
      // 同秒窗口会把"先于终态"误判为"终态后"(CI 43429519863 实测反例)。
      if (goalState === "PAUSED") return { consumed: false, reason: "goal_closed", goalState };
      const terminalAt = goalRow.rows[0]!["updated_at"];
      const queuedRows = await exec.execute(sql`
        SELECT gm.id AS id, gm.content AS content
        FROM goal_messages gm
        WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER' AND gm.execution_request = true
          AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
          AND gm.created_at < ${terminalAt}
        ORDER BY gm.id ASC
      `);
      if (queuedRows.rows.length === 0) return { consumed: false, reason: "goal_closed", goalState };
      await setGoalState(exec, goalId, "ACTIVE", {
        reason: "execute_boundary",
        note: "在途排队的显式执行请求(先于终态迁移落库;授权来源=用户显式点击「交给 Relay 执行」)⇒ 边界消费;重激活以恢复聚合(非隐式重开;PAUSED 不适用本例外)",
      });
      return await deriveFromExecuteMessages(exec, goalId, queuedRows.rows, actor);
    }

    // 在途守卫(安全边界):任何 LEASED/RUNNING/SUBMITTED/VERIFYING 任务存在 ⇒ 不消费
    //(显式执行排队到安全边界;普通消息永远只记录)。
    const states = sql.join(
      IN_FLIGHT_STATES_LOCAL.map((s) => sql`${s}`),
      sql`, `,
    );
    const inflight = await exec.execute(sql`
      SELECT 1 FROM tasks WHERE goal_id = ${goalId} AND state IN (${states}) LIMIT 1
    `);
    if (inflight.rows.length > 0) return { consumed: false, reason: "in_flight" };

    if (pendingExecRows.rows.length === 0) {
      // 无显式执行消息:纯普通消息(no_execution_request)或完全无未处理消息(nothing_pending)。
      const anyPending = await exec.execute(sql`
        SELECT 1 FROM goal_messages gm
        WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
          AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
        LIMIT 1
      `);
      return {
        consumed: false,
        reason: anyPending.rows.length > 0 ? "no_execution_request" : "nothing_pending",
        goalState,
      };
    }
    return await deriveFromExecuteMessages(exec, goalId, pendingExecRows.rows, actor);
  });
}

/** 派生受控 follow-up Task(仅显式执行消息;scope 继承该 Goal 最近 Task;单事务内调用)。 */
async function deriveFromExecuteMessages(
  exec: Exec,
  goalId: string,
  rows: Array<Record<string, unknown>>,
  actor: string,
): Promise<ConsumptionResult> {
  const messageIds = rows.map((r) => Number(r["id"]));
  const goalText = rows.map((r) => String(r["content"])).join("\n");

  // scope 继承该 Goal 最近 Task(与 03B API 语义一致;浏览器不提交任何 scope)。
  const lastTask = await exec.execute(sql`
    SELECT allowed_scope, allowed_commands FROM tasks
    WHERE goal_id = ${goalId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const allowedScope = Array.isArray(lastTask.rows[0]?.["allowed_scope"])
    ? (lastTask.rows[0]!["allowed_scope"] as string[])
    : [];
  const allowedCommands = Array.isArray(lastTask.rows[0]?.["allowed_commands"])
    ? (lastTask.rows[0]!["allowed_commands"] as string[])
    : [];

  // 派生同 Goal 受控 Task(planFollowUpTask:TASK_PLANNED + GOAL_FOLLOWUP_REQUESTED 审计;
  // origin=explicit-execute 记录授权来源 —— 方案 A:授权只能来自用户显式动作)。
  const derived = await planFollowUpTask(exec, {
    goalId,
    goalText,
    actor,
    allowedScope,
    allowedCommands,
    origin: "explicit-execute",
  });

  // 消费映射(append-only;UNIQUE(message_id) 是 at-most-once 的数据库级证明)。
  for (const mid of messageIds) {
    await exec.execute(sql`
      INSERT INTO goal_message_consumptions (message_id, goal_id, task_id)
      VALUES (${mid}, ${goalId}, ${derived.taskId})
    `);
  }

  await appendAudit(exec, {
    actor,
    authority: "SUPERVISOR",
    action: "GOAL_MESSAGES_CONSUMED",
    taskId: derived.taskId,
    detail: {
      goalId,
      taskId: derived.taskId,
      messageIds,
      count: messageIds.length,
      origin: "explicit-execute",
      authorization: "user_explicit_execute",
    },
  });

  // RELAY 确认(确定性系统文案,不伪装模型回复;供 Feed 呈现消费结果)。
  await exec.execute(sql`
    INSERT INTO goal_messages (goal_id, actor, kind, content)
    VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE',
      ${`已创建执行任务(执行请求 ${messageIds.length} 条),即将进入受控执行。`})
  `);

  return { consumed: true, taskId: derived.taskId, messageIds };
}

/** Goal Loop 前置消费步:扫描全部待消费 Goal,逐个消费;单 Goal 失败不阻断其余与其他拍内步骤。 */
export async function consumeAllPendingGoals(
  db: RelayDb,
  actor?: string,
): Promise<{ results: ConsumptionResult[]; failedGoals: Array<{ goalId: string; error: string }> }> {
  const goals = await pendingConsumptionGoals(db);
  const results: ConsumptionResult[] = [];
  const failedGoals: Array<{ goalId: string; error: string }> = [];
  for (const g of goals) {
    try {
      results.push(await consumeGoalMessages(db, g.goalId, actor ? { actor } : {}));
    } catch (err) {
      failedGoals.push({ goalId: g.goalId, error: (err as Error).message });
    }
  }
  return { results, failedGoals };
}
