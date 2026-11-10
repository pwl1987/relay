// Decision D0–D4(P0-01C C-3;架构 §6;SECURITY_MODEL T07)。
// - D0/D1:作用域内自动执行,不产生决策行;
// - D2:仅当创建时声明了 fallback(fallback 必须存在)→ 循环可自动执行 fallback;
// - D3:需人批准 —— **永不超时自动批准**(T07:级别不可由超时降低);
//   deadline 仅由 expireStaleDecisions 标记 EXPIRED_STILL_BLOCKED,任务停留 NEEDS_DECISION;
// - D4:禁止 —— 创建即拒绝(planner 层)。
// 恢复动作(resolveDecision 等)在 ops.ts:actor 授权 + expected state_version + 合法转移 + 审计。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";

export type DecisionLevel = "D0" | "D1" | "D2" | "D3" | "D4";
export type DecisionState =
  | "OPEN"
  | "RESOLVED_AUTO"
  | "RESOLVED_FALLBACK"
  | "RESOLVED_MANUAL"
  | "REJECTED"
  | "EXPIRED_STILL_BLOCKED";

export interface DecisionRow {
  id: string;
  task_id: string | null;
  goal_id: string | null;
  level: DecisionLevel;
  question: string;
  fallback: Record<string, unknown> | null;
  deadline: string | Date | null;
  state: DecisionState;
  verdict: Record<string, unknown> | null;
  decided_by: string | null;
}

/** 创建决策行(D4 拒绝;D2 必须带 fallback;D3 建议带 deadline 仅作提示标记)。 */
export async function createDecision(
  exec: Exec,
  spec: {
    taskId?: string | null;
    goalId?: string | null;
    level: DecisionLevel;
    question: string;
    fallback?: Record<string, unknown> | null;
    deadline?: Date | null;
    actor?: string;
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (spec.level === "D4") {
    await appendAudit(exec, {
      actor: spec.actor ?? "planner",
      authority: "SUPERVISOR",
      action: "DECISION_REJECTED_D4",
      taskId: spec.taskId ?? undefined,
      detail: { level: spec.level, question: spec.question },
    });
    return { ok: false, reason: "level_D4_forbidden" };
  }
  if (spec.level === "D2" && !spec.fallback) {
    return { ok: false, reason: "D2_requires_preauthorized_fallback" };
  }
  const id = `dec-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, deadline)
    VALUES (${id}, ${spec.taskId ?? null}, ${spec.goalId ?? null}, ${spec.level}, ${spec.question},
      ${spec.fallback ? JSON.stringify(spec.fallback) : null}::jsonb, ${spec.deadline ?? null})
  `);
  await appendAudit(exec, {
    actor: spec.actor ?? "planner",
    authority: "SUPERVISOR",
    action: "DECISION_CREATED",
    taskId: spec.taskId ?? undefined,
    detail: { decisionId: id, level: spec.level, question: spec.question, hasFallback: Boolean(spec.fallback) },
  });
  return { ok: true, id };
}

/** 查询任务未决决策(OPEN 状态;D3 停滞面)。 */
export async function openDecisions(
  exec: Exec,
  taskId: string,
): Promise<Array<DecisionRow>> {
  const res = await exec.execute(sql`
    SELECT id, task_id, goal_id, level, question, fallback, deadline, state, verdict, decided_by
    FROM decisions WHERE task_id = ${taskId} AND state = 'OPEN' ORDER BY created_at
  `);
  return res.rows as unknown as Array<DecisionRow>;
}

/**
 * 超时标记(仅 EXPIRED_STILL_BLOCKED;**不改变任务状态、不自动批准**,T07)。
 * 返回被标记的决策 id。
 */
export async function expireStaleDecisions(exec: Exec, actor = "supervisor"): Promise<string[]> {
  const res = await exec.execute(sql`
    UPDATE decisions SET state = 'EXPIRED_STILL_BLOCKED'
    WHERE state = 'OPEN' AND level = 'D3' AND deadline IS NOT NULL AND deadline <= now()
    RETURNING id
  `);
  const ids = res.rows.map((r) => String(r["id"]));
  for (const id of ids) {
    await appendAudit(exec, {
      actor,
      authority: "SUPERVISOR",
      action: "DECISION_EXPIRED_STILL_BLOCKED",
      detail: { decisionId: id, note: "D3 永不超时自动批准;任务停留 NEEDS_DECISION 等待人(T07)" },
    });
  }
  return ids;
}

/** 决策裁决写入(供 ops.resolveDecision / fallback 自动执行路径复用)。 */
export async function resolveDecisionRow(
  exec: Exec,
  decisionId: string,
  newState: Extract<DecisionState, "RESOLVED_MANUAL" | "RESOLVED_FALLBACK" | "REJECTED">,
  verdict: Record<string, unknown>,
  decidedBy: string,
): Promise<{ ok: boolean; reason?: string; taskId?: string | null }> {
  const res = await exec.execute(sql`
    UPDATE decisions SET state = ${newState}, verdict = ${JSON.stringify(verdict)}::jsonb,
      decided_by = ${decidedBy}, decided_at = now()
    WHERE id = ${decisionId} AND state IN ('OPEN','EXPIRED_STILL_BLOCKED')
    RETURNING task_id
  `);
  const row = res.rows[0];
  if (!row) return { ok: false, reason: "decision_not_open" };
  return { ok: true, taskId: row["task_id"] === null ? null : String(row["task_id"]) };
}
