// Gate 编排器(P0-02A C-2/C-4/C-5/C-6 的组合层;CONSTRUCTION_PLAN "测试/Reality Gate")。
// 流程(Run SUCCEEDED 后,由 goalLoopTick 调用):
//   1. acquireVerificationLease —— 接管租约,模型 Worker 残留 TTL 权威即时作废;
//   2. 证据采集(可信执行器:确定性检查/真实 API 行为检查,Worker 侧落库);
//   3. 独立 Reviewer Run(注入回调,core 不依赖 runtime);期间验证租约由 Reviewer 执行器代持心跳;
//   4. recordGateVerdict(绑定版)+ consumeGateVerdict(单事务消费:PASS→ACCEPTED /
//      REWORK→READY(退避)/ BLOCK→NEEDS_DECISION(D3 行));
//   5. Review 有界重试耗尽 ⇒ 直接 NEEDS_DECISION(保守停机,不烧模型循环)。
// 任何一步失败都保持可恢复:验证租约有 TTL ⇒ 到期被 reclaim ⇒ 新 attempt 重验;
// 旧 PASS 因绑定失配不可消费 —— 无假通过、无双重裁决、无永久失联。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { advanceTask } from "./lease.ts";
import { latestChangeset, type ChangesetRow } from "./changesets.ts";
import { collectCheckEvidence, recordEvidence, workerEnv, type CheckSpec, type EvidenceRow } from "./evidence.ts";
import { acquireVerificationLease, heartbeatVerificationLease, expireVerificationLease } from "./verify-lease.ts";
import {
  recordGateVerdict,
  consumeGateVerdict,
  isDocsOnlyChanges,
  FUNCTIONAL_EVIDENCE_KINDS,
  type GateVerdict,
  type GateTestEnv,
} from "./gates.ts";
import { isAbortRequested } from "./ops.ts";

export interface ReviewRunInput {
  taskId: string;
  attempt: number;
  goalText: string;
  changeset: { candidateSha: string; changedFiles: Record<string, string[]> };
  evidenceSummaries: Array<{ id: string; kind: string; passed: boolean }>;
  /** Coder 候选工作区宿主路径(Reviewer 共享检查;不存在时为 undefined) */
  workspaceDir?: string;
  /** 验证租约心跳(Reviewer Run 期间代持;由 runtime reviewer 执行器调用) */
  heartbeat: (tx: Exec) => Promise<{ ok: boolean; reason?: string }>;
}

export interface ReviewRunResult {
  ok: boolean;
  reason?: string;
  verdict?: GateVerdict;
  findings?: string;
  reviewerRunId: string;
  rawOutput: string;
}

export interface GateOrchestrationOptions {
  verifierId?: string;
  verificationTtlSeconds?: number;
  /** Worker 侧可信检查(确定性测试/真实 API 行为);在 Run 工作区执行 */
  evidenceChecks?: Array<CheckSpec>;
  /** 内建候选清单复验(runtime 注入;core 不 import runtime)。
   *  生产默认机器证据:重采工作区清单比对 candidate_sha;未配置机器检查时的兜底(D1)。 */
  manifestVerify?: (spec: {
    taskId: string;
    attempt: number;
    candidateSha: string;
    changedFileCount: number;
    workspaceDir: string;
  }) => Promise<{ ok: boolean; rawOutput: string }>;
  /** 独立 Reviewer Run(runtime 注入;core 不 import runtime) */
  reviewRun: (input: ReviewRunInput) => Promise<ReviewRunResult>;
  /** Review 有界重试次数(默认 2;耗尽 ⇒ NEEDS_DECISION) */
  reviewAttempts?: number;
  /** REWORK 释放退避秒(默认 10) */
  backoffSeconds?: number;
  /** 测试环境记录(证据与裁决绑定;缺省由 orchestrator 采集 worker 基本面) */
  testEnv?: GateTestEnv;
  /** 预算:Reviewer Run 预留请求数与 goal(透传注入回调,由调用方消费;此处仅声明) */
  reviewerBudgetGoalId?: string;
}

export interface GateOrchestrationInput {
  taskId: string;
  attempt: number;
  coderRunId: string;
  /** Run 工作区宿主路径(证据检查 cwdWorkspace 用;缺省 = 检查在宿主 cwd 执行) */
  workspaceDir?: string;
  actor?: string;
}

export interface GateOrchestrationResult {
  status: "ACCEPTED" | "REWORK" | "NEEDS_DECISION" | "SKIPPED" | "FAILED" | "CANCELLED";
  reason?: string;
  gateId?: string;
  changesetId?: string;
  evidenceIds: string[];
  violations: string[];
}

/**
 * 编排一次完整 Gate(调用时机:runTask 返回 SUCCEEDED 且任务已被 runner 推进 VERIFYING)。
 * 返回 status 供 tick 报告与测试断言;所有拒绝/失败路径均留审计。
 */
export async function orchestrateGate(
  db: RelayDb,
  input: GateOrchestrationInput,
  gate: GateOrchestrationOptions,
): Promise<GateOrchestrationResult> {
  const actor = input.actor ?? "gate-orchestrator";
  const verifierId = gate.verifierId ?? "gate-orchestrator";
  const ttl = gate.verificationTtlSeconds ?? 60;
  const evidenceIds: string[] = [];
  const noEvidence = (status: GateOrchestrationResult["status"], reason: string): GateOrchestrationResult => ({
    status,
    reason,
    evidenceIds,
    violations: [],
  });

  // 0) gate_required 快速通道
  const taskRes = await db.execute(sql`SELECT gate_required, goal_id FROM tasks WHERE id = ${input.taskId}`);
  const trow = taskRes.rows[0];
  if (!trow) return noEvidence("FAILED", "task_not_found");
  if (trow["gate_required"] !== true) {
    // D6:gate_required=false 不得成为代码变更逃避验证的通道 —— 代码变更候选仍强制编排;
    // 仅 docs-only/无变更集候选保留 SKIPPED(合法豁免;覆盖事实审计留痕)。
    const csPre = await latestChangeset(db as unknown as Exec, input.taskId);
    const codeChange =
      csPre !== null &&
      csPre.attempt === input.attempt &&
      csPre.runId === input.coderRunId &&
      !isDocsOnlyChanges(csPre.changedFiles);
    if (!codeChange) {
      await appendAudit(db as unknown as Exec, {
        actor,
        authority: "GATE",
        action: "GATE_SKIPPED",
        taskId: input.taskId,
        detail: { reason: "gate_not_required" },
      });
      return noEvidence("SKIPPED", "gate_not_required");
    }
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "GATE",
      action: "GATE_REQUIRED_OVERRIDE",
      taskId: input.taskId,
      detail: { reason: "gate_required_false_but_code_change", changesetId: csPre.id },
    });
  }

  // 1) 验证租约接管(C-5)
  const lease = await db.transaction(async (tx) =>
    acquireVerificationLease(tx as unknown as Exec, input.taskId, verifierId, ttl),
  );
  if (!lease.ok) return noEvidence("FAILED", `verify_lease_rejected:${lease.reason}`);

  // 2) 变更集(必须存在且匹配本 attempt + coder run)
  const changeset = await latestChangeset(db as unknown as Exec, input.taskId);
  if (!changeset || changeset.attempt !== input.attempt || changeset.runId !== input.coderRunId) {
    return noEvidence("FAILED", `changeset_mismatch:${changeset?.attempt ?? "none"}!=${input.attempt}`);
  }
  if ((changeset.impactScope.violations ?? []).length > 0) {
    // 影响面越界(沙箱下不应发生;发生即不进 Review,交回收重验 + 审计)
    const violations = changeset.impactScope.violations ?? [];
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "GATE",
      action: "GATE_IMPACT_VIOLATION",
      taskId: input.taskId,
      detail: { violations, changesetId: changeset.id },
    });
    return { status: "FAILED", reason: "impact_scope_violations", changesetId: changeset.id, evidenceIds, violations };
  }

  // 2.4) 紧急停止接入(RELAY-CONTROL-READY-03 F-1 修复):abort 旗标在 VERIFYING 阶段(含
  // Run 成功后至 Gate 编排窗口)被置位 ⇒ Gate 编排立即 STOP:VERIFYING→CANCELLED(验证租约
  // 权威)+TASK_ABORT_CONFIRMED 审计;不采证/不烧 Reviewer/不记录/不消费/不交付 —— 授权来源=
  // 操作者显式 abort/takeover(AGENT_CONTROL §4"立即撤销后续执行资格")。
  const abortStop = async (): Promise<GateOrchestrationResult> => {
    const adv = await db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, input.taskId, verifierId, lease.fencingToken, "VERIFYING", "CANCELLED"),
    );
    if (!adv.ok) {
      return {
        status: "FAILED" as const,
        reason: `abort_advance_rejected:${(adv as { reason?: string }).reason}`,
        changesetId: changeset.id,
        evidenceIds,
        violations: [],
      };
    }
    await expireVerificationLease(db as unknown as Exec, input.taskId, actor);
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "GATE",
      action: "TASK_ABORT_CONFIRMED",
      taskId: input.taskId,
      detail: {
        changesetId: changeset.id,
        candidateSha: changeset.candidateSha,
        note: "紧急停止旗标生效:VERIFYING→CANCELLED;裁决不记录不消费,交付不发生(STOP_CONFIRMED=本审计)",
      },
    });
    return {
      status: "CANCELLED" as const,
      reason: "abort_requested",
      changesetId: changeset.id,
      evidenceIds,
      violations: [],
    };
  };
  if (await isAbortRequested(db as unknown as Exec, input.taskId)) {
    return await abortStop();
  }

  // 2.5) 机器证据配置预检(ADR-0012 #7;RELAY-QUALITY-LOCAL-01 D1/D3 + RELAY-SAFETY-CLOSE-02 P0-B):
  // 代码变更候选必须配置**功能性**机器检查(deterministic_test/api_behavior)——候选完整性复验
  // (manifestVerify)是硬门但不证明行为,单凭完整性 + Reviewer PASS 不得 ACCEPTED。
  // 无功能检查 ⇒ 先跑完整性硬门(失败即 candidate_manifest_verify_failed),随后无论完整性
  // 结果如何都保守停机 NEEDS_DECISION(不进 Reviewer,不烧模型预算;恢复仅经 ops API)。
  const evidenceSummaries: Array<{ id: string; kind: string; passed: boolean }> = [];
  const machineEvidenceRequired = !isDocsOnlyChanges(changeset.changedFiles);
  const changedFileCount =
    (changeset.changedFiles.added?.length ?? 0) +
    (changeset.changedFiles.modified?.length ?? 0) +
    (changeset.changedFiles.removed?.length ?? 0);
  const hasFunctionalChecks = (gate.evidenceChecks ?? []).some((c) => FUNCTIONAL_EVIDENCE_KINDS.has(c.kind));
  /** 保守停机(Reviewer m-5 去重):VERIFYING→NEEDS_DECISION + D3 决策行 + 终止验证租约 + 审计。
   *  恢复仅经 ops API;永不自动批准。 */
  const conservativeStop = async (
    reason: string,
    question: string,
    auditAction: string,
    auditDetail: Record<string, unknown>,
  ) => {
    const adv = await db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, input.taskId, verifierId, lease.fencingToken, "VERIFYING", "NEEDS_DECISION"),
    );
    if (!adv.ok) {
      return {
        status: "FAILED" as const,
        reason: `needs_decision_advance_rejected:${(adv as { reason?: string }).reason}`,
        changesetId: changeset.id,
        evidenceIds,
        violations: [],
      };
    }
    const goalId = trow["goal_id"] === null ? null : String(trow["goal_id"]);
    await db.transaction(async (tx) =>
      (tx as unknown as Exec).execute(sql`
        INSERT INTO decisions (id, task_id, goal_id, level, question, state)
        VALUES (${"dec-" + randomUUID()}, ${input.taskId}, ${goalId}, 'D3', ${question}, 'OPEN')
      `),
    );
    await expireVerificationLease(db as unknown as Exec, input.taskId, actor);
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "GATE",
      action: auditAction,
      taskId: input.taskId,
      beforeState: "VERIFYING",
      afterState: "NEEDS_DECISION",
      detail: { changesetId: changeset.id, candidateSha: changeset.candidateSha, ...auditDetail },
    });
    return { status: "NEEDS_DECISION" as const, reason, changesetId: changeset.id, evidenceIds, violations: [] };
  };
  if (machineEvidenceRequired && !hasFunctionalChecks) {
    if (gate.manifestVerify && input.workspaceDir) {
      // 完整性硬门仍先执行(候选不一致/零编辑空提交 ⇒ 更精确的拦截原因):
      const mv = await gate.manifestVerify({
        taskId: input.taskId,
        attempt: input.attempt,
        candidateSha: changeset.candidateSha,
        changedFileCount,
        workspaceDir: input.workspaceDir,
      });
      const mvRow = await recordEvidence(db as unknown as Exec, {
        taskId: input.taskId,
        attempt: input.attempt,
        candidateSha: changeset.candidateSha,
        kind: "candidate_manifest_verify",
        passed: mv.ok,
        rawOutput: mv.rawOutput,
        env: workerEnv("worker-host", { command: "builtin:candidate_manifest_verify", cwd: input.workspaceDir }),
        producedBy: verifierId,
      });
      evidenceIds.push(mvRow.id);
      // 复验事实同步进入 Reviewer 证据摘要(Reviewer m-6;不影响裁决,纯一致性)
      evidenceSummaries.push({ id: mvRow.id, kind: mvRow.kind, passed: mvRow.passed });
      if (!mv.ok) {
        // 复验失败 ⇒ 保守停机(候选完整性问题,不进 Reviewer)
        return await conservativeStop(
          "candidate_manifest_verify_failed",
          "candidate_manifest_verify_failed:候选清单复验失败(内容不一致或零编辑空提交),保守停机(永不自动批准)",
          "CANDIDATE_MANIFEST_VERIFY_FAILED",
          { evidenceId: mvRow.id, note: "候选清单复验失败 ⇒ 不放行,保守停机" },
        );
      }
      // 完整性通过但无功能检查 ⇒ 仍保守停机(P0-B:manifest + Reviewer PASS 不得 ACCEPTED)
      return await conservativeStop(
        "functional_evidence_unconfigured",
        "functional_evidence_unconfigured:候选完整性复验通过,但未配置功能性机器检查(deterministic_test/api_behavior);完整性不证明行为,单凭 manifest + Reviewer PASS 不得 ACCEPTED ⇒ 保守停机(永不自动批准)",
        "FUNCTIONAL_EVIDENCE_UNCONFIGURED",
        { evidenceId: mvRow.id, note: "完整性通过但无功能证据 ⇒ 不放行,保守停机" },
      );
    }
    return await conservativeStop(
      "functional_evidence_unconfigured",
      "functional_evidence_unconfigured:代码变更候选未配置功能性机器检查(deterministic_test/api_behavior),保守停机(永不自动批准);需配置确定性检查后重验",
      "FUNCTIONAL_EVIDENCE_UNCONFIGURED",
      { note: "代码变更无功能检查 ⇒ 不放行,保守停机" },
    );
  }

  // 3) 证据采集(可信执行器)
  for (const check of gate.evidenceChecks ?? []) {
    const row = await collectCheckEvidence(
      db as unknown as Exec,
      {
        ...check,
        taskId: input.taskId,
        attempt: input.attempt,
        candidateSha: changeset.candidateSha,
        producedBy: verifierId,
      },
      input.workspaceDir ?? process.cwd(),
    );
    evidenceIds.push(row.id);
    evidenceSummaries.push({ id: row.id, kind: row.kind, passed: row.passed });
  }

  // 3.5) 必需检查失败 ⇒ 保守停机(P0-B:证据不足不得 ACCEPTED;不烧 Reviewer —— 候选已注定
  // 无法通过 record/consume 双侧校验,重试 Reviewer 只消耗模型预算)。
  const failedCheck = evidenceSummaries.find((s) => !s.passed);
  if (failedCheck) {
    return await conservativeStop(
      `evidence_failed:${failedCheck.kind}`,
      `evidence_failed:${failedCheck.kind}:必需机器检查失败,证据不足 ⇒ 保守停机(永不自动批准;恢复仅经 ops API)`,
      "REQUIRED_EVIDENCE_FAILED",
      { evidenceId: failedCheck.id, kind: failedCheck.kind, note: "必需检查 FAILED ⇒ 不放行,保守停机" },
    );
  }

  // goal 文本(Reviewer 上下文输入)
  let goalText = "";
  if (trow["goal_id"]) {
    const g = await db.execute(sql`SELECT raw_input FROM goals WHERE id = ${trow["goal_id"]}`);
    goalText = String(g.rows[0]?.["raw_input"] ?? "");
  }

  // 4) 独立 Reviewer Run(有界重试)
  const attempts = gate.reviewAttempts ?? 2;
  let review: ReviewRunResult | null = null;
  for (let i = 0; i < attempts; i++) {
    const r = await gate.reviewRun({
      taskId: input.taskId,
      attempt: input.attempt,
      goalText,
      changeset: { candidateSha: changeset.candidateSha, changedFiles: changeset.changedFiles },
      evidenceSummaries: [...evidenceSummaries],
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      heartbeat: (tx) => heartbeatVerificationLease(tx, input.taskId, verifierId, lease.fencingToken, ttl),
    });
    // Reviewer 原始输出落证据(可信采集;无论成败,留档审计)
    const evRow = await recordEvidence(db as unknown as Exec, {
      taskId: input.taskId,
      attempt: input.attempt,
      candidateSha: changeset.candidateSha,
      kind: "reviewer_output",
      passed: r.ok && r.verdict !== undefined,
      rawOutput: r.rawOutput || `(no output; reason=${r.reason ?? "unknown"})`,
      env: gate.testEnv ?? { mode: "reviewer", node: "unknown", host: "unknown" },
      producedBy: verifierId,
    });
    if (r.ok && r.verdict) {
      review = r;
      evidenceIds.push(evRow.id);
      evidenceSummaries.push({ id: evRow.id, kind: evRow.kind, passed: evRow.passed });
      break;
    }
    review = r;
    evidenceIds.push(evRow.id);
    evidenceSummaries.push({ id: evRow.id, kind: evRow.kind, passed: evRow.passed });
    await appendAudit(db as unknown as Exec, {
      actor,
      authority: "GATE",
      action: "REVIEW_ATTEMPT_FAILED",
      taskId: input.taskId,
      detail: { attempt: i + 1, of: attempts, reason: r.reason ?? "no_verdict", reviewerRunId: r.reviewerRunId },
    });
    // 权威已失(lease_lost/heartbeat_errors)或预算触顶(budget_exhausted/budget_turns_cap)⇒ 不再重试:
    // 前者无权推进,后者重试只会烧穿同一账本(FAIL-CLOSED 方向)
    if (r.reason === "lease_lost" || r.reason === "heartbeat_errors" || (r.reason ?? "").startsWith("budget")) break;
  }

  const reviewerVerdictOk = review !== null && review.ok && review.verdict !== undefined;
  if (!reviewerVerdictOk) {
    // Review 有界重试耗尽/权威丢失 ⇒ 保守 NEEDS_DECISION(不烧模型循环;恢复经 ops API)
    const adv = await db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, input.taskId, verifierId, lease.fencingToken, "VERIFYING", "NEEDS_DECISION"),
    );
    if (adv.ok) {
      const goalId = trow["goal_id"] === null ? null : String(trow["goal_id"]);
      await db.transaction(async (tx) =>
        (tx as unknown as Exec).execute(sql`
          INSERT INTO decisions (id, task_id, goal_id, level, question, state)
          VALUES (${"dec-rv-" + randomUUID()}, ${input.taskId}, ${goalId}, 'D3',
            ${"review_failed:Reviewer Run 有界重试耗尽,需人工裁决(永不自动批准)"}, 'OPEN')
        `),
      );
      await expireVerificationLease(db as unknown as Exec, input.taskId, actor);
      await appendAudit(db as unknown as Exec, {
        actor,
        authority: "GATE",
        action: "DECISION_BLOCK",
        taskId: input.taskId,
        beforeState: "VERIFYING",
        afterState: "NEEDS_DECISION",
        detail: { reason: review?.reason ?? "no_verdict", note: "Review 失败保守停机;恢复仅经 ops API" },
      });
      return {
        status: "NEEDS_DECISION",
        reason: review?.reason ?? "no_verdict",
        changesetId: changeset.id,
        evidenceIds,
        violations: [],
      };
    }
    return {
      status: "FAILED",
      reason: `needs_decision_advance_rejected:${(adv as { reason?: string }).reason}`,
      changesetId: changeset.id,
      evidenceIds,
      violations: [],
    };
  }

  // 4.5) 紧急停止后置检查(F-1 修复:Reviewer 可能已烧但旗标在编排骨内到达)⇒ 裁决不记录
  // 不消费、交付不发生;Reviewer 证据留档(已烧事实),任务 STOP:CANCELLED。
  if (await isAbortRequested(db as unknown as Exec, input.taskId)) {
    return await abortStop();
  }

  // 5) 记录 + 消费(绑定版)
  const recorded = await db.transaction(async (tx) =>
    recordGateVerdict(tx as unknown as Exec, {
      taskId: input.taskId,
      verdict: review!.verdict!,
      reviewer: verifierId,
      attempt: input.attempt,
      candidateSha: changeset.candidateSha,
      requirementSha: changeset.requirementSha,
      testEnv: gate.testEnv ?? { mode: "worker", node: "unknown", host: "unknown" },
      reviewerRunId: review!.reviewerRunId,
      coderRunId: input.coderRunId,
      evidenceIds,
    }),
  );
  if (!recorded.ok) {
    return {
      status: "FAILED",
      reason: `gate_record_rejected:${recorded.reason}`,
      changesetId: changeset.id,
      evidenceIds,
      violations: [],
    };
  }
  const consumed = await db.transaction(async (tx) =>
    consumeGateVerdict(tx as unknown as Exec, {
      taskId: input.taskId,
      gateId: recorded.id,
      actor,
      ownerId: verifierId,
      fencingToken: lease.fencingToken,
      backoffSeconds: gate.backoffSeconds ?? 10,
    }),
  );
  if (!consumed.ok) {
    return {
      status: "FAILED",
      reason: `gate_consume_rejected:${consumed.reason}`,
      gateId: recorded.id,
      changesetId: changeset.id,
      evidenceIds,
      violations: [],
    };
  }
  const status = consumed.state === "ACCEPTED" ? "ACCEPTED" : consumed.state === "READY" ? "REWORK" : "NEEDS_DECISION";
  return {
    status,
    gateId: recorded.id,
    changesetId: changeset.id,
    evidenceIds,
    violations: [],
    ...(review!.findings ? { reason: review!.findings } : {}),
  };
}

/** 变更集断言辅助(测试/编排方复用)。 */
export async function requireChangeset(exec: Exec, taskId: string): Promise<ChangesetRow> {
  const cs = await latestChangeset(exec, taskId);
  if (!cs) throw new Error(`changeset missing for task ${taskId}`);
  return cs;
}

// EvidenceRow 类型仅用于类型导出面(避免未使用告警)
export type { EvidenceRow };
