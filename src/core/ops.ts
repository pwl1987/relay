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
      detail: {
        reason: `pause_requires_ready:${fromState}`,
        note: "仅 READY 可置入 PAUSED;租约链上的执行不打断(归租约/Intent/Reconcile)",
      },
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

// RELAY-CONTROL-READY-03 P1-3:紧急停止与人工接管最小切片。
// RELAY-CONTROL-SAFETY-04 P0-B 扩展:ACCEPTED(已验收)且交付未完成(PROPOSED/DELIVERING)
// ⇒ 允许"交付阶段停止"(同一 abort 旗标,不引入第二生命周期):
//   - 交付未开始 ⇒ 边界检查(executeDelivery 入口 + perform 前)阻止外部写入;
//   - 交付外部动作已在进行 ⇒ 回执如实 external_in_progress,**不声称 STOP_CONFIRMED**,
//     结果以远端核对为准(NEEDS_RECONCILE);已发生的外部提交不可撤销(合同 B2,如实陈述);
//   - 已 DELIVERED/无交付 ⇒ 拒绝(无停止对象,不混语义)。
// ControlCommand 审计最小字段(P1-C C3):actor/task/runId/expectedVersion/幂等键/请求时间/
// 实际结果/控制权状态。
// 语义(AGENT_CONTROL §4;回执三分:REQUESTED=RECEIVED / 旗标生效=APPLIED /
// run=CANCELLED+任务终态=STOP_CONFIRMED —— 三者不混淆,均落审计):
//   - abort 旗标跨进程安全(无需触碰 worker 进程):worker 在 Run 期间心跳轮询
//     tasks.abort_requested_at,命中 ⇒ 翻转 runner cancelSignal ⇒ SIGTERM→SIGKILL,
//     run=CANCELLED,任务按合法转移 RUNNING→CANCELLED(租约权威不变);
//   - 幂等:set-if-null,重复请求返回 alreadyRequested(重复点击不重复生效);
//   - 仅在飞状态可 abort(READY/PAUSED 等无在飞执行 ⇒ 走既有 pause/decision 路径,不混语义);
//   - takeover = 请求停止在飞 Run + 撤销其后续写入资格(旗标)+ 审计;STOP_CONFIRMED 由
//     ABORT_CONFIRMED 审计承载;旧 Run 的 advance 在其自身租约下合法完成 CANCELLED,
//     终态后任何旧 fencing 推进均被拒(lifecycle/isTerminal);
//   - handback = 停止后由用户重新显式授权(方案 A 执行请求)或既有 resume(PAUSED),不新增第二恢复通道。

const ABORTABLE_STATES = new Set(["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"]);

export interface AbortResult {
  ok: boolean;
  reason?: string;
  alreadyRequested?: boolean;
  fromState?: string;
  /** 停止相位:P1-C C1 —— run=在飞 Run 停止;delivery=验收后交付阶段停止 */
  phase?: "run" | "delivery";
  /** 控制权状态(C1/C2:停止确认前不构成"获得人工控制权";交付相位=真实交付态) */
  controlState?: string;
}

/**
 * 交付阶段相位查询(P0-B B1 五态判别;基于既有 changeset.delivery_state + proposal +
 * intent 状态,不复制状态机):
 *   not_started(未开始)/ external_in_progress(外部动作已在进行)/
 *   external_write_done(外部提交已发生、交付回执未落 —— perform 完成至 markDelivered 之间
 *   的真实窗口,含两次远端核对;停止请求不可撤销已发生的提交)/
 *   external_outcome_unknown(执行失败/冲突:副作用是否发生不确定 ⇒ Reconcile 语义)/
 *   already_delivered(已交付)/ none(无可停止交付)。
 * 注意:proposeDelivery 只建 action_proposals 行,changeset.delivery_state 在 executeDelivery
 * 才推进 —— "已批准未执行"的相位必须同时查 proposal 面(P0-B B7 竞争测试实证)。
 * Reviewer Major-1 修复:DELIVERING + intent COMPLETED 绝不判 not_started —— 外部提交已落
 * 远端,回执/审计不得声称"尚未发生外部写入"。
 */
export async function deliveryStopPhase(exec: Exec, taskId: string): Promise<string> {
  const res = await exec.execute(sql`
    SELECT cc.delivery_state AS delivery_state, cc.delivery_intent_id AS intent_id, ai.state AS intent_state
    FROM candidate_changesets cc
    LEFT JOIN action_intents ai ON ai.id = cc.delivery_intent_id
    WHERE cc.task_id = ${taskId}
    ORDER BY cc.created_at DESC, cc.id DESC
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return "none";
  const ds = String(row["delivery_state"] ?? "NONE");
  if (ds === "DELIVERED") return "already_delivered";
  if (ds === "DELIVERING") {
    const intentState = String(row["intent_state"] ?? "");
    if (intentState === "EXECUTING") return "external_in_progress";
    if (intentState === "COMPLETED") return "external_write_done";
    if (intentState === "FAILED" || intentState === "CONFLICT") return "external_outcome_unknown";
    return "not_started"; // RESERVED/无 intent 行:perform 未开始 ⇒ 真实"未开始"
  }
  if (ds === "PROPOSED") return "not_started";
  if (ds === "NONE") {
    // changeset 交付态未推进:已批准未执行的 proposal ⇒ not_started(可停止);否则无可停止对象
    const p = await exec.execute(sql`
      SELECT 1 FROM action_proposals
      WHERE task_id = ${taskId} AND state = 'POLICY_APPROVED'
      ORDER BY updated_at DESC LIMIT 1
    `);
    return p.rows.length > 0 ? "not_started" : "none";
  }
  return "none"; // changeset CONFLICT/FAILED:无在飞外部写入,不混停止语义(D3 人工处置既有路径)
}

/** 最新 run id(ControlCommand 审计字段 C3;无 run 为 null)。 */
async function latestRunId(exec: Exec, taskId: string): Promise<string | null> {
  const r = await exec.execute(sql`
    SELECT id FROM runs WHERE task_id = ${taskId} ORDER BY started_at DESC, id DESC LIMIT 1`);
  return r.rows[0] ? String(r.rows[0]!["id"]) : null;
}

/** 请求紧急停止(abort 旗标;幂等;仅在飞状态或交付阶段;OPERATOR 授权 + 可选 state_version 校验)。 */
export async function requestTaskAbort(
  exec: Exec,
  taskId: string,
  opts: { actor: string; expectedStateVersion?: number },
): Promise<AbortResult> {
  if (!operatorAllowed(opts.actor)) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: "TASK_ABORT_REJECTED",
      taskId,
      detail: { reason: "actor_not_authorized" },
    });
    return { ok: false, reason: "actor_not_authorized" };
  }
  const task = await lockTaskRow(exec, taskId);
  if (!task) return { ok: false, reason: "task_not_found" };
  const fromState = String(task["state"]);
  const expectedVersionActual = Number(task["state_version"]);
  if (opts.expectedStateVersion !== undefined && expectedVersionActual !== opts.expectedStateVersion) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: "TASK_ABORT_REJECTED",
      taskId,
      detail: {
        reason: "state_version_mismatch",
        expected: opts.expectedStateVersion,
        actual: expectedVersionActual,
      },
    });
    return { ok: false, reason: "state_version_mismatch", fromState };
  }
  // C3 幂等键:abort 命令面=set-if-null 旗标;键绑定 (taskId),审计如实记录
  const idempotencyKey = `abort:${taskId}`;

  // P0-B:交付阶段停止(ACCEPTED 终态上唯一被授权的停止语义;B1 五态/ B3/B4 诚实回执)
  if (fromState === "ACCEPTED") {
    const phase = await deliveryStopPhase(exec, taskId);
    if (phase === "none") {
      await appendAudit(exec, {
        actor: opts.actor,
        authority: "OPERATOR",
        action: "TASK_ABORT_REJECTED",
        taskId,
        detail: { reason: "state_terminal:ACCEPTED", note: "已验收且无可停止交付(无 PROPOSED/DELIVERING 变更集)" },
      });
      return { ok: false, reason: "state_terminal:ACCEPTED", fromState };
    }
    // B2/B4(Reviewer Major-1 分档):外部提交已发生(含"已交付"与"perform 完成回执未落"窗口)
    // ⇒ 停止请求不撤销已发生的事实、不置旗(交付收尾核对须继续)、诚实回执 + C3 命令回执审计。
    if (phase === "already_delivered" || phase === "external_write_done") {
      const runId = await latestRunId(exec, taskId);
      await appendAudit(exec, {
        actor: opts.actor,
        authority: "OPERATOR",
        action: "TASK_ABORT_REQUESTED",
        taskId,
        beforeState: fromState,
        afterState: fromState,
        detail: {
          fromState,
          phase: "delivery",
          runId,
          expectedStateVersion: opts.expectedStateVersion ?? null,
          idempotencyKey,
          requestTime: new Date().toISOString(),
          actualResult: "no_op",
          controlState: phase,
          note:
            phase === "already_delivered"
              ? "交付已完成:停止请求不撤销已发生的外部提交(零状态变更,诚实回执)"
              : "外部提交已发生(perform 完成、交付回执未落):停止请求不撤销已发生的提交,不置旗;交付收尾照常核对(DELIVERED 或 NEEDS_RECONCILE)",
        },
      });
      return { ok: true, fromState, phase: "delivery", controlState: phase };
    }
    if (task["abort_requested_at"] !== null && task["abort_requested_at"] !== undefined) {
      // 幂等:旗标已置;回执仍按当前真实相位(重复点击不重复生效,不虚报)
      return { ok: true, alreadyRequested: true, fromState, phase: "delivery", controlState: phase };
    }
    await exec.execute(sql`
      UPDATE tasks SET abort_requested_at = now(), updated_at = now()
      WHERE id = ${taskId} AND abort_requested_at IS NULL
    `);
    const runId = await latestRunId(exec, taskId);
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: "TASK_ABORT_REQUESTED",
      taskId,
      beforeState: fromState,
      afterState: fromState,
      detail: {
        fromState,
        phase: "delivery",
        runId,
        expectedStateVersion: opts.expectedStateVersion ?? null,
        idempotencyKey,
        requestTime: new Date().toISOString(),
        actualResult: "requested",
        controlState: phase,
        note:
          phase === "external_in_progress"
            ? "外部动作已在进行,不声称 STOP_CONFIRMED,结果以远端核对为准"
            : phase === "external_outcome_unknown"
              ? "交付执行已失败/冲突:外部副作用是否发生不能确定(结果以核对/Reconcile 为准);停止请求阻止后续外部写入"
              : "尚未发生外部写入(边界检查将阻止其发生)",
      },
    });
    return { ok: true, fromState, phase: "delivery", controlState: phase };
  }

  if (isTerminal(fromState)) return { ok: false, reason: `state_terminal:${fromState}`, fromState };
  if (!ABORTABLE_STATES.has(fromState)) {
    await appendAudit(exec, {
      actor: opts.actor,
      authority: "OPERATOR",
      action: "TASK_ABORT_REJECTED",
      taskId,
      detail: { reason: `abort_requires_in_flight:${fromState}`, note: "非在飞任务走 pause/decision 路径(语义不混)" },
    });
    return { ok: false, reason: `abort_requires_in_flight:${fromState}`, fromState };
  }
  if (task["abort_requested_at"] !== null && task["abort_requested_at"] !== undefined) {
    return { ok: true, alreadyRequested: true, fromState, phase: "run" }; // 幂等:旗标已置,不重复审计生效
  }
  await exec.execute(sql`
    UPDATE tasks SET abort_requested_at = now(), updated_at = now()
    WHERE id = ${taskId} AND abort_requested_at IS NULL
  `);
  const runId = await latestRunId(exec, taskId);
  await appendAudit(exec, {
    actor: opts.actor,
    authority: "OPERATOR",
    action: "TASK_ABORT_REQUESTED",
    taskId,
    beforeState: fromState,
    afterState: fromState,
    detail: {
      fromState,
      phase: "run",
      runId,
      expectedStateVersion: opts.expectedStateVersion ?? null,
      idempotencyKey,
      requestTime: new Date().toISOString(),
      actualResult: "requested",
      // C1/C2:停止确认前不构成获得人工控制权(worker 轮询生效/Run 确认后才是 STOP_CONFIRMED)
      controlState: "stop_pending_confirmation",
      note: "abort 旗标置位(RECEIVED);worker 轮询生效(APPLIED);run=CANCELLED+任务终态=STOP_CONFIRMED",
    },
  });
  return { ok: true, fromState, phase: "run", controlState: "stop_pending_confirmation" };
}

/** 紧急停止旗标读取(RELAY-CONTROL-READY-03 F-1 修复:Gate 编排链接入旗标 —— 独立函数供
 *  gate-orchestrator 前置/后置检查与 goal-loop 交付防线共用;单点语义,零第二控制面)。 */
export async function isAbortRequested(exec: Exec, taskId: string): Promise<boolean> {
  const r = await exec.execute(sql`SELECT abort_requested_at FROM tasks WHERE id = ${taskId}`);
  const v = r.rows[0]?.["abort_requested_at"];
  return v !== null && v !== undefined;
}
