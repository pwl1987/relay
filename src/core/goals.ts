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
  await ensureLedgerRow(exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: Math.floor(spec.budget.modelCalls) });
  if (spec.budget.tokensIn) await ensureLedgerRow(exec, { scopeType: "goal", scopeId: goalId, kind: "tokens_in", limit: Math.floor(spec.budget.tokensIn) });
  if (spec.budget.tokensOut) await ensureLedgerRow(exec, { scopeType: "goal", scopeId: goalId, kind: "tokens_out", limit: Math.floor(spec.budget.tokensOut) });
  if (spec.budget.wallSeconds) await ensureLedgerRow(exec, { scopeType: "goal", scopeId: goalId, kind: "wall_seconds", limit: Math.floor(spec.budget.wallSeconds) });

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
