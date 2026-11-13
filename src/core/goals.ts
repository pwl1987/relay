// Goal Planner(P0-01C C-3;确定性规则,无模型参与 —— 不引入第二决策源)。
// 简单 Goal → tasks(CREATED→READY);WorkPackage 裁剪为 task.goal_id 直挂(架构 §2 允许 P0 轻量)。
// FAIL-CLOSED:goal.budget.modelCalls 缺失/<=0 ⇒ 拒绝创建(无预算不允许模型工作)。
// 同时创建预算账本行(model_calls 带 limit;tokens/wall 仅在声明时建记账行)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { ensureLedgerRow } from "./budget.ts";

export interface GoalTaskSpec {
  id?: string;
  goalText: string;
  allowedScope?: string[];
  allowedCommands?: string[];
  priority?: number;
  maxAttempts?: number;
}

export interface GoalSpec {
  id?: string;
  rawInput: string;
  budget: { modelCalls: number; tokensIn?: number; tokensOut?: number; wallSeconds?: number };
  tasks: GoalTaskSpec[];
  actor?: string;
}

export interface PlannedGoal {
  goalId: string;
  taskIds: string[];
}

export async function planGoal(exec: Exec, spec: GoalSpec): Promise<PlannedGoal> {
  if (!spec.budget || !Number.isFinite(spec.budget.modelCalls) || spec.budget.modelCalls <= 0) {
    throw new Error("budget.modelCalls 必须为正数(FAIL-CLOSED:无预算不允许模型 Run)");
  }
  if (!spec.tasks || spec.tasks.length === 0) throw new Error("goal 必须至少含一个 task");
  const goalId = spec.id ?? `goal-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO goals (id, raw_input, state, budget)
    VALUES (${goalId}, ${spec.rawInput}, 'ACTIVE', ${JSON.stringify(spec.budget)}::jsonb)
  `);
  await ensureLedgerRow(exec, {
    scopeType: "goal",
    scopeId: goalId,
    kind: "model_calls",
    limit: Math.floor(spec.budget.modelCalls),
  });
  if (spec.budget.tokensIn)
    await ensureLedgerRow(exec, {
      scopeType: "goal",
      scopeId: goalId,
      kind: "tokens_in",
      limit: Math.floor(spec.budget.tokensIn),
    });
  if (spec.budget.tokensOut)
    await ensureLedgerRow(exec, {
      scopeType: "goal",
      scopeId: goalId,
      kind: "tokens_out",
      limit: Math.floor(spec.budget.tokensOut),
    });
  if (spec.budget.wallSeconds)
    await ensureLedgerRow(exec, {
      scopeType: "goal",
      scopeId: goalId,
      kind: "wall_seconds",
      limit: Math.floor(spec.budget.wallSeconds),
    });

  const taskIds: string[] = [];
  for (const t of spec.tasks) {
    const taskId = t.id ?? `task-${randomUUID()}`;
    await exec.execute(sql`
      INSERT INTO tasks (id, goal_id, state, priority, max_attempts, allowed_scope, allowed_commands)
      VALUES (${taskId}, ${goalId}, 'READY', ${t.priority ?? 0}, ${t.maxAttempts ?? 3},
        ${JSON.stringify(t.allowedScope ?? [])}::jsonb, ${JSON.stringify(t.allowedCommands ?? [])}::jsonb)
    `);
    await appendAudit(exec, {
      actor: spec.actor ?? "planner",
      authority: "SUPERVISOR",
      action: "TASK_PLANNED",
      taskId,
      beforeState: null,
      afterState: "READY",
      detail: { goalId, goalText: t.goalText },
    });
    taskIds.push(taskId);
  }
  await appendAudit(exec, {
    actor: spec.actor ?? "planner",
    authority: "SUPERVISOR",
    action: "GOAL_PLANNED",
    detail: { goalId, tasks: taskIds, budget: spec.budget },
  });
  return { goalId, taskIds };
}

export interface FollowUpTaskSpec {
  goalId: string;
  goalText: string;
  actor?: string;
  priority?: number;
  maxAttempts?: number;
  allowedScope?: string[];
  allowedCommands?: string[];
}

/**
 * WEB-UX-03 §9-J5:follow-up = 同 Goal 下的新受控执行动作(READY 复用;零生命周期变更)。
 * 不创建脱离当前 Goal 的匿名会话,不绕 Relay Core;Task 形状与 planGoal 完全一致。
 * 调用方(API 层)负责先做在途检查(RUNNING/VERIFYING 在途 ⇒ 只记录不派生)。
 */
export async function planFollowUpTask(exec: Exec, spec: FollowUpTaskSpec): Promise<{ taskId: string }> {
  if (!spec.goalText || !spec.goalText.trim()) throw new Error("goalText 必须为非空描述");
  const goalRows = await exec.execute(sql`SELECT id, state FROM goals WHERE id = ${spec.goalId}`);
  if (goalRows.rows.length === 0) throw new Error(`goal 不存在:${spec.goalId}`);
  // P0-A 纵深防御(RELAY-SAFETY-CLOSE-02):非 ACTIVE Goal 不得派生可执行 Task
  // (AGENT_CONTROL §3"终态 Goal 上的新要求不得静默派生可执行 Task"/ADR-0012 #3)。
  // 消费层已守卫;此处保证任何直接调用方也无法绕过(终态 Goal 派生 = 孤儿执行)。
  const goalState = String(goalRows.rows[0]!["state"] ?? "");
  if (goalState !== "ACTIVE") {
    throw new Error(
      `goal 非 ACTIVE(${goalState}):终态/暂停 Goal 不得静默派生可执行 Task;请创建新 Goal(AGENT_CONTROL §3/ADR-0012 #3)`,
    );
  }
  const taskId = `task-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO tasks (id, goal_id, state, priority, max_attempts, allowed_scope, allowed_commands)
    VALUES (${taskId}, ${spec.goalId}, 'READY', ${spec.priority ?? 0}, ${spec.maxAttempts ?? 3},
      ${JSON.stringify(spec.allowedScope ?? [])}::jsonb, ${JSON.stringify(spec.allowedCommands ?? [])}::jsonb)
  `);
  await appendAudit(exec, {
    actor: spec.actor ?? "planner",
    authority: "SUPERVISOR",
    action: "TASK_PLANNED",
    taskId,
    beforeState: null,
    afterState: "READY",
    detail: { goalId: spec.goalId, goalText: spec.goalText.trim(), origin: "follow-up" },
  });
  await appendAudit(exec, {
    actor: spec.actor ?? "planner",
    authority: "SUPERVISOR",
    action: "GOAL_FOLLOWUP_REQUESTED",
    detail: { goalId: spec.goalId, taskId, goalText: spec.goalText.trim() },
  });
  return { taskId };
}

/** Goal 状态推进(loop 用;确定性,无人工语义)。 */
export async function setGoalState(
  exec: Exec,
  goalId: string,
  state: "ACTIVE" | "PAUSED" | "EXHAUSTED" | "COMPLETED" | "FAILED",
  detail?: Record<string, unknown>,
): Promise<void> {
  await exec.execute(sql`
    UPDATE goals SET state = ${state}, updated_at = now() WHERE id = ${goalId}
  `);
  await appendAudit(exec, {
    actor: "goal-loop",
    authority: "SUPERVISOR",
    action: `GOAL_${state}`,
    detail: { goalId, ...(detail ?? {}) },
  });
}
