// Gate:绑定版记录 + 一次性消费(P0-02A C-4/C-6;V08 最小门锁的完整化)。
// 绑定铁律(旧 PASS 不跨版本):
// - 每份裁决绑定 (taskId, attempt, candidate_sha, requirement_sha, test_env, reviewer_run_id, evidence_ids);
// - PASS 记录前置:变更集存在且 sha/requirement 匹配、Reviewer Run 身份独立(role=reviewer 且
//   reviewer_run_id != coder run_id —— 编码 Agent 不能自宣验收)、证据全量完整(passed+digest);
// - 消费在单事务内二次校验全部绑定,任一失配(新 attempt/候选变更/需求变更)⇒ 拒绝 + 审计;
// - 每份裁决至多消费一次(consumed_at/consumed_by)。
// 消费语义(VERIFYING 出口):PASS→ACCEPTED;REWORK→REWORK(+退避);BLOCK→NEEDS_DECISION
// (+D3 决策行,恢复仅经 ops API,永不自动批准)。模型文本 DONE 不产生任何裁决行。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { advanceTask } from "./lease.ts";
import { latestChangeset } from "./changesets.ts";
import { getEvidence, verifyEvidenceIntegrity } from "./evidence.ts";
import { expireVerificationLease } from "./verify-lease.ts";

export type GateVerdict = "PASS" | "REWORK" | "BLOCK";

/** 机器检查证据类别(区别于 reviewer_output;ADR-0012 #7/CONTRACTS §5)。
 *  candidate_manifest_verify = 内建候选清单复验(生产默认;RELAY-QUALITY-LOCAL-01 D1)。 */
export const MACHINE_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  "deterministic_test",
  "api_behavior",
  "candidate_manifest_verify",
]);

/**
 * 确定性 N/A 适用规则(ADR-0012 #7/CONTRACTS §5 机器质量门;RELAY-QUALITY-LOCAL-01 D4):
 * docs-only 变更(全部 .md/.markdown)豁免机器测试证据 —— 纯文档无机器测试可跑,
 * 豁免由本规则确定性给出,不需要模型或人工判断。
 * 刻意不含 .txt 等通用文本:任务产物(如 result.txt)不是文档,按代码变更处理(fail-closed)。
 * 空文件清单视同代码变更(fail-closed):零编辑空提交正是要拦截的异常,不得借"无文件"逃逸。
 */
export function isDocsOnlyChanges(
  changedFiles: { added?: string[]; modified?: string[]; removed?: string[] } | null | undefined,
): boolean {
  if (!changedFiles) return false;
  const all = [...(changedFiles.added ?? []), ...(changedFiles.modified ?? []), ...(changedFiles.removed ?? [])];
  if (all.length === 0) return false;
  return all.every((f) => /\.(md|markdown)$/i.test(f));
}

export interface GateTestEnv {
  mode: string;
  node: string;
  host: string;
  [k: string]: unknown;
}

export interface RecordGateSpec {
  taskId: string;
  verdict: GateVerdict;
  reviewer: string;
  attempt: number;
  /** 当前候选清单 sha;无变更集的纯分析任务可为 null(且仅当无变更集时允许) */
  candidateSha: string | null;
  requirementSha: string | null;
  testEnv: GateTestEnv;
  /** Reviewer Run(runs 行,detail.role=reviewer);必须 != coder run */
  reviewerRunId: string;
  /** Coder Run(变更集来源 run),用于独立性校验 */
  coderRunId: string | null;
  /** PASS 必须引用;REWORK/BLOCK 可空 */
  evidenceIds?: string[];
  id?: string;
}

export type RecordGateResult = { ok: true; id: string } | { ok: false; reason: string };

export async function recordGateVerdict(exec: Exec, spec: RecordGateSpec): Promise<RecordGateResult> {
  const changeset = await latestChangeset(exec, spec.taskId);

  // 绑定一致性(记录时即校验,消费时二次校验)
  if (spec.candidateSha !== null || changeset !== null) {
    if (!changeset) return { ok: false, reason: "changeset_missing" };
    if (changeset.attempt !== spec.attempt)
      return { ok: false, reason: `changeset_attempt_mismatch:${changeset.attempt}!=${spec.attempt}` };
    if (changeset.candidateSha !== spec.candidateSha) return { ok: false, reason: "candidate_sha_mismatch" };
    if (changeset.requirementSha !== spec.requirementSha) return { ok: false, reason: "requirement_sha_mismatch" };
    if (spec.coderRunId !== null && changeset.runId !== spec.coderRunId)
      return { ok: false, reason: "coder_run_mismatch" };
  }

  // Reviewer 独立性:reviewer_run 必须存在且 role=reviewer,且不得等于 coder run
  if (!spec.reviewerRunId || spec.reviewerRunId === spec.coderRunId) {
    return { ok: false, reason: "reviewer_independence_violation" };
  }
  const runRow = await exec.execute(sql`
    SELECT detail->>'role' AS role, task_id FROM runs WHERE id = ${spec.reviewerRunId}
  `);
  const rr = runRow.rows[0];
  if (!rr) return { ok: false, reason: "reviewer_run_not_found" };
  if (String(rr["role"] ?? "") !== "reviewer") return { ok: false, reason: "reviewer_run_not_reviewer" };
  if (String(rr["task_id"] ?? "") !== spec.taskId) return { ok: false, reason: "reviewer_run_task_mismatch" };

  // 测试环境绑定:PASS 必须携带
  if (spec.verdict === "PASS" && (!spec.testEnv || !spec.testEnv.mode)) {
    return { ok: false, reason: "test_env_missing" };
  }

  // 证据完整性(PASS 必须引用且全量通过;REWORK/BLOCK 引用则同样核验)。
  // 证据绑定 candidateSha 用 "" 哨兵对齐无候选流程(evidence.candidate_sha NOT NULL)。
  const evidenceIds = spec.evidenceIds ?? [];
  if (spec.verdict === "PASS" && evidenceIds.length === 0) return { ok: false, reason: "evidence_missing" };
  const evidenceKinds = new Set<string>();
  for (const eid of evidenceIds) {
    const ev = await getEvidence(exec, eid);
    if (!ev) return { ok: false, reason: `evidence_not_found:${eid}` };
    const binding = { taskId: spec.taskId, attempt: spec.attempt, candidateSha: spec.candidateSha ?? "" };
    const integrity = verifyEvidenceIntegrity(ev, binding);
    if (!integrity.ok) return { ok: false, reason: `evidence_invalid:${eid}:${integrity.reason}` };
    evidenceKinds.add(ev.kind);
  }

  // 最低机器证据(ADR-0012 #7/CONTRACTS §5;RELAY-QUALITY-LOCAL-01 D1/D2/D3):
  // 代码变更候选的 PASS 必须引用至少一条机器检查证据;reviewer_output 不得单独充当。
  // 豁免仅两条确定性路径:docs-only 变更(上方 N/A 规则)与无变更集纯分析(candidateSha=null)。
  if (spec.verdict === "PASS" && spec.candidateSha !== null && !isDocsOnlyChanges(changeset?.changedFiles ?? null)) {
    const hasMachine = [...evidenceKinds].some((k) => MACHINE_EVIDENCE_KINDS.has(k));
    if (!hasMachine) return { ok: false, reason: "machine_evidence_missing" };
  }

  const id = spec.id ?? `gate-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO task_gate_verdicts
      (id, task_id, commit_ref, verdict, reviewer, attempt, candidate_sha, requirement_sha,
       test_env, reviewer_run_id, coder_run_id, evidence_ids)
    VALUES (${id}, ${spec.taskId}, ${spec.candidateSha}, ${spec.verdict}, ${spec.reviewer},
      ${spec.attempt}, ${spec.candidateSha}, ${spec.requirementSha},
      ${JSON.stringify(spec.testEnv)}::jsonb, ${spec.reviewerRunId}, ${spec.coderRunId},
      ${JSON.stringify(evidenceIds)}::jsonb)
  `);
  await appendAudit(exec, {
    actor: spec.reviewer,
    authority: "GATE",
    action: `GATE_${spec.verdict}`,
    taskId: spec.taskId,
    detail: {
      verdict: spec.verdict,
      gateId: id,
      attempt: spec.attempt,
      candidateSha: spec.candidateSha,
      requirementSha: spec.requirementSha,
      reviewerRunId: spec.reviewerRunId,
      coderRunId: spec.coderRunId,
      evidenceIds,
      testEnv: spec.testEnv,
    },
  });
  return { ok: true, id };
}

export interface GateRow {
  id: string;
  taskId: string;
  verdict: GateVerdict;
  attempt: number | null;
  candidateSha: string | null;
  requirementSha: string | null;
  reviewerRunId: string | null;
  coderRunId: string | null;
  evidenceIds: string[];
  consumedAt: string | Date | null;
}

async function getGateRow(exec: Exec, gateId: string): Promise<GateRow | null> {
  const res = await exec.execute(sql`
    SELECT id, task_id, verdict, attempt, candidate_sha, requirement_sha,
           reviewer_run_id, coder_run_id, evidence_ids, consumed_at
    FROM task_gate_verdicts WHERE id = ${gateId} FOR UPDATE
  `);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]),
    taskId: String(r["task_id"]),
    verdict: String(r["verdict"]) as GateVerdict,
    attempt: r["attempt"] === null ? null : Number(r["attempt"]),
    candidateSha: (r["candidate_sha"] as string | null) ?? null,
    requirementSha: (r["requirement_sha"] as string | null) ?? null,
    reviewerRunId: (r["reviewer_run_id"] as string | null) ?? null,
    coderRunId: (r["coder_run_id"] as string | null) ?? null,
    evidenceIds: (r["evidence_ids"] as string[] | null) ?? [],
    consumedAt: (r["consumed_at"] as string | Date | null) ?? null,
  };
}

export type ConsumeGateResult =
  | { ok: true; gateId: string; verdict: GateVerdict; state: string }
  | { ok: false; gateId: string; reason: string; state?: string };

/**
 * 消费裁决(单事务:绑定二次校验 + 状态推进 + consumed 标记 + 审计)。
 * 推进权威 = 验证租约(ownerId/fencingToken 来自 acquireVerificationLease)。
 * - PASS → ACCEPTED(租约释放)
 * - REWORK → REWORK(租约释放,+ backoffSeconds 退避回 READY)
 * - BLOCK → NEEDS_DECISION(+ D3 决策行;显式终止租约;恢复仅经 ops API)
 * 任何绑定失配(旧 attempt/旧候选/旧需求/已消费/证据失效)⇒ 拒绝,任务状态不变。
 */
export async function consumeGateVerdict(
  exec: Exec,
  spec: {
    taskId: string;
    gateId: string;
    actor: string;
    ownerId: string;
    fencingToken: number;
    backoffSeconds?: number;
  },
): Promise<ConsumeGateResult> {
  const gate = await getGateRow(exec, spec.gateId);
  if (!gate) return { ok: false, gateId: spec.gateId, reason: "gate_not_found" };
  if (gate.taskId !== spec.taskId) return { ok: false, gateId: spec.gateId, reason: "gate_task_mismatch" };
  if (gate.consumedAt) return { ok: false, gateId: spec.gateId, reason: "already_consumed" };

  const taskRes = await exec.execute(sql`
    SELECT state, attempt, goal_id FROM tasks WHERE id = ${spec.taskId} FOR UPDATE
  `);
  const t = taskRes.rows[0];
  if (!t) return { ok: false, gateId: spec.gateId, reason: "task_not_found" };
  const taskState = String(t["state"]);
  const taskAttempt = Number(t["attempt"]);

  // 绑定二次校验:attempt / candidate / requirement 全部对当前事实
  if (gate.attempt === null || gate.attempt !== taskAttempt) {
    await rejectConsume(exec, spec, gate, `stale_attempt:${gate.attempt}!=${taskAttempt}`, taskState);
    return {
      ok: false,
      gateId: spec.gateId,
      reason: `stale_attempt:${gate.attempt}!=${taskAttempt}`,
      state: taskState,
    };
  }
  const changeset = await latestChangeset(exec, spec.taskId);
  const curSha = changeset?.candidateSha ?? null;
  const curReq = changeset?.requirementSha ?? null;
  if (gate.candidateSha !== curSha) {
    await rejectConsume(exec, spec, gate, `stale_candidate:${gate.candidateSha}!=${curSha}`, taskState);
    return {
      ok: false,
      gateId: spec.gateId,
      reason: `stale_candidate:${gate.candidateSha}!=${curSha}`,
      state: taskState,
    };
  }
  if (gate.requirementSha !== curReq) {
    await rejectConsume(exec, spec, gate, "requirement_sha_mismatch", taskState);
    return { ok: false, gateId: spec.gateId, reason: "requirement_sha_mismatch", state: taskState };
  }
  if (gate.reviewerRunId && changeset && gate.reviewerRunId === changeset.runId) {
    await rejectConsume(exec, spec, gate, "reviewer_independence_violation", taskState);
    return { ok: false, gateId: spec.gateId, reason: "reviewer_independence_violation", state: taskState };
  }
  // 证据完整性复验(测试失败/证据失效 ⇒ 不得绿色)
  const evidenceKinds = new Set<string>();
  for (const eid of gate.evidenceIds) {
    const ev = await getEvidence(exec, eid);
    if (!ev) {
      await rejectConsume(exec, spec, gate, `evidence_not_found:${eid}`, taskState);
      return { ok: false, gateId: spec.gateId, reason: `evidence_not_found:${eid}`, state: taskState };
    }
    const integrity = verifyEvidenceIntegrity(ev, {
      taskId: spec.taskId,
      attempt: taskAttempt,
      candidateSha: gate.candidateSha ?? "",
    });
    if (!integrity.ok) {
      await rejectConsume(exec, spec, gate, `evidence_invalid:${eid}:${integrity.reason}`, taskState);
      return {
        ok: false,
        gateId: spec.gateId,
        reason: `evidence_invalid:${eid}:${integrity.reason}`,
        state: taskState,
      };
    }
    evidenceKinds.add(ev.kind);
  }
  // 最低机器证据复验(与 recordGateVerdict 同规则;防绕过编排直录旧格式 PASS)
  if (gate.verdict === "PASS" && gate.candidateSha !== null && !isDocsOnlyChanges(changeset?.changedFiles ?? null)) {
    const hasMachine = [...evidenceKinds].some((k) => MACHINE_EVIDENCE_KINDS.has(k));
    if (!hasMachine) {
      await rejectConsume(exec, spec, gate, "machine_evidence_missing", taskState);
      return { ok: false, gateId: spec.gateId, reason: "machine_evidence_missing", state: taskState };
    }
  }

  if (taskState !== "VERIFYING") {
    return { ok: false, gateId: spec.gateId, reason: `state_mismatch:${taskState}`, state: taskState };
  }

  // 推进(复用 advanceTask:租约权威 + 转移表 + gate 门槛)
  if (gate.verdict === "PASS") {
    const adv = await advanceTask(exec, spec.taskId, spec.ownerId, spec.fencingToken, "VERIFYING", "ACCEPTED");
    if (!adv.ok) {
      await rejectConsume(exec, spec, gate, `advance_rejected:${adv.reason}`, taskState);
      return { ok: false, gateId: spec.gateId, reason: `advance_rejected:${adv.reason}`, state: taskState };
    }
  } else if (gate.verdict === "REWORK") {
    const adv = await advanceTask(exec, spec.taskId, spec.ownerId, spec.fencingToken, "VERIFYING", "REWORK");
    if (!adv.ok) {
      await rejectConsume(exec, spec, gate, `advance_rejected:${adv.reason}`, taskState);
      return { ok: false, gateId: spec.gateId, reason: `advance_rejected:${adv.reason}`, state: taskState };
    }
    const backoff = spec.backoffSeconds ?? 0;
    await exec.execute(sql`
      UPDATE tasks SET state = 'READY', state_version = state_version + 1,
        retry_not_before = now() + make_interval(secs => ${backoff}), updated_at = now()
      WHERE id = ${spec.taskId} AND state = 'REWORK'
    `);
    await appendAudit(exec, {
      actor: spec.actor,
      authority: "GATE",
      action: "RETRY_READY",
      taskId: spec.taskId,
      beforeState: "REWORK",
      afterState: "READY",
      detail: { reason: "gate_rework_released", backoffSeconds: backoff, gateId: spec.gateId },
    });
  } else {
    // BLOCK → NEEDS_DECISION(+ D3 决策行;显式终止租约;永不自动批准,恢复仅经 ops)
    const adv = await advanceTask(exec, spec.taskId, spec.ownerId, spec.fencingToken, "VERIFYING", "NEEDS_DECISION");
    if (!adv.ok) {
      await rejectConsume(exec, spec, gate, `advance_rejected:${adv.reason}`, taskState);
      return { ok: false, gateId: spec.gateId, reason: `advance_rejected:${adv.reason}`, state: taskState };
    }
    const goalId = t["goal_id"] === null ? null : String(t["goal_id"]);
    await exec.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, state)
      VALUES (${"dec-" + randomUUID()}, ${spec.taskId}, ${goalId}, 'D3',
        ${"gate_block:Reviewer BLOCK,需人工裁决(永不自动批准)"}, 'OPEN')
    `);
    await expireVerificationLease(exec, spec.taskId, spec.actor);
    await appendAudit(exec, {
      actor: spec.actor,
      authority: "GATE",
      action: "DECISION_BLOCK",
      taskId: spec.taskId,
      beforeState: "VERIFYING",
      afterState: "NEEDS_DECISION",
      detail: { gateId: spec.gateId, note: "Reviewer BLOCK ⇒ 需人批准;恢复仅经 ops API(T07)" },
    });
  }

  // 消费标记(一次性语义)
  await exec.execute(sql`
    UPDATE task_gate_verdicts SET consumed_at = now(), consumed_by = ${spec.actor}
    WHERE id = ${spec.gateId}
  `);
  await appendAudit(exec, {
    actor: spec.actor,
    authority: "GATE",
    action: "GATE_CONSUMED",
    taskId: spec.taskId,
    beforeState: "VERIFYING",
    afterState: gate.verdict === "PASS" ? "ACCEPTED" : gate.verdict === "REWORK" ? "READY" : "NEEDS_DECISION",
    detail: { gateId: spec.gateId, verdict: gate.verdict, attempt: taskAttempt, candidateSha: gate.candidateSha },
  });
  const finalState = gate.verdict === "PASS" ? "ACCEPTED" : gate.verdict === "REWORK" ? "READY" : "NEEDS_DECISION";
  return { ok: true, gateId: spec.gateId, verdict: gate.verdict, state: finalState };
}

async function rejectConsume(
  exec: Exec,
  spec: { taskId: string; gateId: string; actor: string },
  gate: GateRow,
  reason: string,
  state: string,
): Promise<void> {
  await appendAudit(exec, {
    actor: spec.actor,
    authority: "GATE",
    action: "GATE_CONSUME_REJECTED",
    taskId: spec.taskId,
    beforeState: state,
    afterState: state,
    detail: {
      gateId: gate.id,
      verdict: gate.verdict,
      reason,
      gateAttempt: gate.attempt,
      gateCandidateSha: gate.candidateSha,
    },
  });
}
