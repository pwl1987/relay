// WEB-UX-03C §0/§0.1 消息消费语义闭环(03B.1 硬前置)。
// 语义(P0-A 收窄;RELAY-SAFETY-CLOSE-02):
//   - 终态/暂停 Goal(COMPLETED/FAILED/EXHAUSTED/PAUSED)+ 终态后新消息 ⇒ 只记录不派生
//     (goal_closed;终态 Goal 不得静默派生可执行 Task —— AGENT_CONTROL §3/ADR-0012 #3);
//     反馈("已记录")由消息入口给出;
//   - 终态/暂停 Goal + 消息创建于终态迁移之前(在途窗口活会话补充,§0.1 冻结)⇒ 边界消费:
//     可审计重激活(GOAL_ACTIVE)后派生;aggregateGoals 恢复聚合,无孤儿执行;
//   - ACTIVE Goal:无在途工作(无 LEASED/RUNNING/SUBMITTED/VERIFYING)⇒ 未消费 USER 消息
//     合并为一轮同 Goal follow-up Task(READY,scope 继承该 Goal 最近 Task),立即进入 Relay Core;
//   - 在途 ⇒ 不消费(等待执行边界);Run 结束后的下一拍由 goalLoopTick 前置步自动消费;
//   - 消费映射 goal_message_consumptions UNIQUE(message_id) 数据库级保证 at-most-once:
//     重启/重复 tick/并发 worker 的重复派生落入 UNIQUE 冲突 ⇒ 整个事务回滚,不产生部分状态;
//   - 不修改在途 Run 的上下文(不中途强插);不创建匿名会话;不绕 Goal/Task/Core;
//   - goal_messages(会话事实)与本表(消费映射)均 append-only,不复制 Task 状态。
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
  reason?: "in_flight" | "nothing_pending" | "goal_closed";
  /** goal_closed 时携带当前 Goal 状态(供调用方/测试区分处置) */
  goalState?: string;
  taskId?: string;
  messageIds?: number[];
}

export interface PendingGoalRef {
  goalId: string;
}

/** 有待消费 USER 消息的 Goal 集合(消费前置扫描;不区分在途,在途守卫在 consumeGoalMessages 内)。 */
export async function pendingConsumptionGoals(db: RelayDb): Promise<PendingGoalRef[]> {
  const res = await db.execute(sql`
    SELECT gm.goal_id AS goal_id
    FROM goal_messages gm
    WHERE gm.actor = 'USER'
      AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
    GROUP BY gm.goal_id
    ORDER BY gm.goal_id ASC
  `);
  return res.rows.map((r) => ({ goalId: String(r["goal_id"]) }));
}

/**
 * 消费一个 Goal 的全部未处理 USER 消息(单事务;幂等)。
 * - 在途 ⇒ { consumed:false, reason:"in_flight" }(调用方在安全边界后重试);
 * - 无未消费消息 ⇒ { consumed:false, reason:"nothing_pending" };
 * - 终态/暂停 Goal + 终态后新消息 ⇒ { consumed:false, reason:"goal_closed" }(只记录,不派生);
 * - 终态/暂停 Goal + 消息全部先于终态迁移(在途窗口补充)⇒ 可审计重激活后照常派生;
 * - 消费 ⇒ 派生 follow-up Task + 逐消息映射 + GOAL_MESSAGES_CONSUMED 审计 + RELAY 确认消息。
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
    // Goal 状态守卫(P0-A;AGENT_CONTROL §3/ADR-0012 #3):终态/暂停 Goal 不得静默派生
    // 可执行 Task。两级确定性规则(时间戳基准 = goals.updated_at,唯一更新源 = setGoalState):
    //   ① 全部待消费消息创建于终态迁移之前 ⇒ 在途窗口的活会话补充(§0.1 冻结语义:
    //      intake 时 API 已承诺"消息已记录并将在会话流中呈现")⇒ 边界消费:可审计重激活
    //      (GOAL_ACTIVE)后照常派生 —— 消息属于已授权的执行会话,非终态新请求;
    //   ② 任一待消费消息创建于终态迁移之后 ⇒ 终态 Goal 上的新请求 ⇒ 只记录不派生
    //      (goal_closed;反馈"已记录"由消息入口在 intake 时给出)。
    // 重激活同时消除孤儿执行:aggregateGoals 恢复聚合,补充轮执行完重新聚合回终态。
    const goalRow = await exec.execute(sql`SELECT state, updated_at FROM goals WHERE id = ${goalId}`);
    const goalState = String(goalRow.rows[0]?.["state"] ?? "");
    if (goalState !== "ACTIVE") {
      const terminalAt = goalRow.rows[0]!["updated_at"];
      const postTerminal = await exec.execute(sql`
        SELECT count(*)::int AS n FROM goal_messages gm
        WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
          AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
          AND gm.created_at > ${terminalAt}
      `);
      if (Number(postTerminal.rows[0]!["n"]) > 0) {
        return { consumed: false, reason: "goal_closed", goalState };
      }
      await setGoalState(exec, goalId, "ACTIVE", {
        reason: "followup_supplement_boundary_consumption",
        note: "在途窗口活会话补充(消息先于终态迁移)⇒ 边界消费;重激活以恢复聚合(非终态新请求)",
      });
    }

    // 在途守卫(安全边界):任何 LEASED/RUNNING/SUBMITTED/VERIFYING 任务存在 ⇒ 不消费。
    const states = sql.join(
      IN_FLIGHT_STATES_LOCAL.map((s) => sql`${s}`),
      sql`, `,
    );
    const inflight = await exec.execute(sql`
      SELECT 1 FROM tasks WHERE goal_id = ${goalId} AND state IN (${states}) LIMIT 1
    `);
    if (inflight.rows.length > 0) return { consumed: false, reason: "in_flight" };

    // 未消费 USER 消息(append-only 事实;映射表不存在行 ⇒ 未消费)。
    const pendingRows = await exec.execute(sql`
      SELECT gm.id AS id, gm.content AS content
      FROM goal_messages gm
      WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER'
        AND NOT EXISTS (SELECT 1 FROM goal_message_consumptions c WHERE c.message_id = gm.id)
      ORDER BY gm.id ASC
    `);
    if (pendingRows.rows.length === 0) return { consumed: false, reason: "nothing_pending" };

    const messageIds = pendingRows.rows.map((r) => Number(r["id"]));
    const goalText = pendingRows.rows.map((r) => String(r["content"])).join("\n");

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

    // 派生同 Goal follow-up Task(planFollowUpTask:TASK_PLANNED + GOAL_FOLLOWUP_REQUESTED 审计)。
    const derived = await planFollowUpTask(exec, { goalId, goalText, actor, allowedScope, allowedCommands });

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
      detail: { goalId, taskId: derived.taskId, messageIds, count: messageIds.length },
    });

    // RELAY 确认(确定性系统文案,不伪装模型回复;供 Feed 呈现消费结果)。
    await exec.execute(sql`
      INSERT INTO goal_messages (goal_id, actor, kind, content)
      VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE',
        ${`已收到你的补充(共 ${messageIds.length} 条),已形成同任务流的新一轮执行。`})
    `);

    return { consumed: true, taskId: derived.taskId, messageIds };
  });
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
