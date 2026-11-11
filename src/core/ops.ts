// 恢复动作 API(P0-01C C-3;P0-01A F-2 遗留的落地):
// NEEDS_DECISION / PAUSED / BLOCKED → READY 等恢复转移,统一要求:
//   actor 授权(env RELAY_OPERATORS 逗号分隔,缺省仅 "owner")+ expected state_version
//   + 合法转移表 + 审计(append-only)。权限不符/版本过期 ⇒ 拒绝,不修改任何状态。
// 决策行本身仍由 decisions.ts 管理;本文件只做"任务状态恢复"这一层。
import { sql } from "drizzle-orm";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { isLegalTransition, isTerminal } from "./lifecycle.ts";
import { resolveDecisionRow } from "./decisions.ts";

export function operatorAllowed(actor: string): boolean {
  const list = (process.env.RELAY_OPERATORS ?? "owner").split(",").map((s) => s.trim());
  return list.includes(actor);
}

export interface RecoveryResult {
  ok: boolean;
  reason?: string;
  fromState?: string;
  toState?: string;
}

async function lockTaskRow(exec: Exec, taskId: string): Promise<Record<string, unknown> | null> {
  const res = await exec.execute(sql`SELECT * FROM tasks WHERE id = ${taskId} FOR UPDATE`);
  return res.rows[0] ?? null;
}

/** 通用恢复转移:授权 + expected state_version + 合法转移 + 审计,单事务。 */
async function recoverTransition(
  exec: Exec,
  taskId: string,
  toState: string,
  opts: { actor: string; expectedStateVersion: number; action: string; detail?: Record<string, unknown> },
): Promise<RecoveryResult> {
  if (!operatorAllowed(opts.actor)) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: `${opts.action}_REJECTED`,
      taskId,
      detail: { reason: "actor_not_authorized" },
    });
    return { ok: false, reason: "actor_not_authorized" };
  }
  const task = await lockTaskRow(exec, taskId);
  if (!task) return { ok: false, reason: "task_not_found" };
  const fromState = String(task["state"]);
  const version = Number(task["state_version"]);
  if (isTerminal(fromState)) return { ok: false, reason: `state_terminal:${fromState}`, fromState };
  if (version !== opts.expectedStateVersion) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: `${opts.action}_REJECTED`,
      taskId,
      detail: { reason: "state_version_mismatch", expected: opts.expectedStateVersion, actual: version },
    });
    return { ok: false, reason: "state_version_mismatch", fromState };
  }
  if (!isLegalTransition(fromState, toState)) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: `${opts.action}_REJECTED`,
      taskId,
      detail: { reason: `illegal_transition:${fromState}->${toState}` },
    });
    return { ok: false, reason: `illegal_transition:${fromState}->${toState}`, fromState };
  }
  await exec.execute(sql`
    UPDATE tasks SET state = ${toState}, state_version = state_version + 1,
      blocked_reason = NULL, updated_at = now()
    WHERE id = ${taskId}
  `);
  await appendAudit(exec, {
    actor: opts.actor,
    authority: "OPERATOR",
    action: opts.action,
    taskId,
    beforeState: fromState,
    afterState: toState,
    detail: opts.detail ?? {},
  });
  return { ok: true, fromState, toState };
}

/** D3 裁决:批准 → 任务 NEEDS_DECISION→READY(带决策行 RESOLVED_MANUAL);驳回 → 决策 REJECTED + 任务 FAILED。 */
export async function resolveDecision(
  exec: Exec,
  spec: {
    decisionId: string;
    taskId: string;
    approve: boolean;
    actor: string;
    expectedStateVersion: number;
    verdict?: Record<string, unknown>;
  },
): Promise<RecoveryResult & { decisionResolved?: boolean }> {
  if (!operatorAllowed(spec.actor)) {
    await appendAudit(exec, {
      actor: spec.actor,
      authority: "OPERATOR",
      action: "DECISION_RESOLVE_REJECTED",
      taskId: spec.taskId,
      detail: { reason: "actor_not_authorized", decisionId: spec.decisionId },
    });
    return { ok: false, reason: "actor_not_authorized" };
  }
  const rec = await recoverTransition(exec, spec.taskId, spec.approve ? "READY" : "FAILED", {
    actor: spec.actor,
    expectedStateVersion: spec.expectedStateVersion,
    action: spec.approve ? "DECISION_APPROVED" : "DECISION_DECLINED",
    detail: { decisionId: spec.decisionId },
  });
  if (!rec.ok) return rec;
  const dr = await resolveDecisionRow(
    exec,
    spec.decisionId,
    spec.approve ? "RESOLVED_MANUAL" : "REJECTED",
    spec.verdict ?? { approved: spec.approve },
    spec.actor,
  );
  return { ...rec, decisionResolved: dr.ok };
}

/** PAUSED/NEEDS_DECISION/BLOCKED → READY(无决策行的通用恢复)。 */
export async function resumeTask(
  exec: Exec,
  taskId: string,
  opts: { actor: string; expectedStateVersion: number; action?: string },
): Promise<RecoveryResult> {
  return recoverTransition(exec, taskId, "READY", {
    actor: opts.actor,
    expectedStateVersion: opts.expectedStateVersion,
    action: opts.action ?? "TASK_RESUMED",
  });
}

/**
 * READY → PAUSED(P0-REWORK-2:暂停置入入口;此前 PAUSED 无任何置入途径)。
 * 语义边界(总执行包 A2 + REVIEW Major-1 修复):**仅 READY 可置入**。
 * 暂停 = 阻止 claimNextReady 再领取(领取只查 state='READY');已在租约链
 * (LEASED/RUNNING/SUBMITTED/VERIFYING)上的执行**不打断**——外部副作用由既有
 * 租约/Intent/Reconcile 管理,故 RUNNING→PAUSED 虽在转移表内合法,本入口显式拒绝
 * (避免与 fencing 竞争打断在飞执行)。同口径:actor 授权 + expected state_version
 * + 合法转移 + 审计(复用 recoverTransition)。
 */
export async function pauseTask(
  exec: Exec,
  taskId: string,
  opts: { actor: string; expectedStateVersion: number; reason?: string },
): Promise<RecoveryResult> {
  const row = await exec.execute(sql`SELECT state FROM tasks WHERE id = ${taskId} FOR UPDATE`);
  const cur = row.rows[0];
  if (!cur) return { ok: false, reason: "task_not_found" };
  const fromState = String(cur["state"]);
  if (fromState !== "READY") {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: "TASK_PAUSED_REJECTED",
      taskId,
      detail: { reason: `pause_requires_ready:${fromState}`, note: "仅 READY 可置入 PAUSED;租约链上的执行不打断(归租约/Intent/Reconcile)" },
    });
    return { ok: false, reason: `pause_requires_ready:${fromState}`, fromState };
  }
  return recoverTransition(exec, taskId, "PAUSED", {
    actor: opts.actor,
    expectedStateVersion: opts.expectedStateVersion,
    action: "TASK_PAUSED",
    detail: opts.reason ? { reason: opts.reason } : {},
  });
}
