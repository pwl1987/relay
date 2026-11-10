// GitHub 安全交付链编排(P0-02B D-4..D-10)。
// 链路:Gate PASS(已消费)→ Action Proposal(D-4)→ Policy(D-5,默认拒绝)→
//       Action Intent 两阶段(D-6,复用 intents.ts)→ Scoped Executor(D-7,注入)→
//       Observation/DELIVERED(D-8,远端核对)→ Reconcile 映射(D-10)。
// 铁律:
//  - 授权基础 = 已消费的绑定版 Gate PASS(绑当前 task/attempt/candidate_sha/requirement);
//  - Proposal 前重核 commit 绑定(D-3:树 sha 是内容承诺,漂移即拒绝 ⇒ 重新验证);
//  - DELIVERED 必须以远端核对为前提(HEAD==payload 且远端树内容逐文件==候选清单);
//  - 重复请求幂等(同一 intent 单行单推);任务 ACCEPTED 为终态,交付层失败不回滚质量结论,
//    仅落 CONFLICT/FAILED 交付状态 + D3 决策行(人工恢复)。
// IO 边界:executor / 绑定重核 / 远端内容核验由 runtime 注入(core 保持无 git/网络 IO)。
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { latestChangeset } from "./changesets.ts";
import { checkDeliveryPolicy, type DeliveryPolicyConfig } from "./delivery-policy.ts";
import {
  reserveIntent,
  executeIntent,
  reconcileIntent,
  type IntentExecutor,
  type ReconcileDecision,
} from "./intents.ts";
import type { WorkspaceManifest } from "./changesets.ts";

/** 候选 commit 绑定事实(三 SHA;core 侧类型,runtime/git-candidate 提供核验实现)。 */
export interface CommitBinding {
  gitBaseCommitSha: string;
  gitTreeSha: string;
  gitCommitSha: string;
}

export interface ProposalRow {
  id: string;
  taskId: string;
  attempt: number;
  changesetId: string;
  gateVerdictId: string;
  capability: string;
  target: string;
  branch: string;
  expectedRemoteSha: string;
  commitSha: string;
  state: string;
  policyDetail: Record<string, unknown>;
}

export interface BindingVerifier {
  (binding: CommitBinding): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ProposeDeliveryInput {
  taskId: string;
  attempt: number;
  target: string;
  branch: string;
  /** 执行前期望的远端分支头(执行时再次核对;漂移 ⇒ CONFLICT) */
  expectedRemoteSha: string;
  policy: DeliveryPolicyConfig;
  /** 凭据就绪事实(调用方已按 0600 文件校验;Policy 据此裁决 credential_missing) */
  credentialPresent: boolean;
  /** D-3 绑定重核(runtime 注入;拒绝无重核的 Proposal —— FAIL-CLOSED) */
  verifyCommitBinding: BindingVerifier;
  actor?: string;
}

export type ProposeDeliveryResult =
  | { ok: true; proposal: ProposalRow; created: boolean }
  | { ok: false; reason: string; proposal?: ProposalRow };

async function loadChangesetForDelivery(
  exec: Exec,
  taskId: string,
  attempt: number,
): Promise<{ ok: false; reason: string } | { ok: true; cs: NonNullable<Awaited<ReturnType<typeof latestChangeset>>> }> {
  const cs = await latestChangeset(exec, taskId);
  if (!cs) return { ok: false, reason: "no_changeset" };
  if (cs.attempt !== attempt) return { ok: false, reason: "attempt_mismatch" };
  return { ok: true, cs };
}

/** 查询可作授权基础的裁决:已消费 PASS 且绑定当前 task/attempt/候选/需求。 */
async function findConsumedPass(exec: Exec, taskId: string, attempt: number, candidateSha: string, requirementSha: string): Promise<string | null> {
  const res = await exec.execute(sql`
    SELECT id FROM task_gate_verdicts
    WHERE task_id = ${taskId} AND verdict = 'PASS' AND consumed_at IS NOT NULL
      AND attempt = ${attempt} AND candidate_sha = ${candidateSha} AND requirement_sha = ${requirementSha}
    ORDER BY created_at DESC LIMIT 1
  `);
  return res.rows[0] ? String(res.rows[0]!["id"]) : null;
}

function proposalFromRow(r: Record<string, unknown>): ProposalRow {
  return {
    id: String(r["id"]),
    taskId: String(r["task_id"]),
    attempt: Number(r["attempt"]),
    changesetId: String(r["changeset_id"]),
    gateVerdictId: String(r["gate_verdict_id"]),
    capability: String(r["capability"]),
    target: String(r["target"]),
    branch: String(r["branch"]),
    expectedRemoteSha: String(r["expected_remote_sha"]),
    commitSha: String(r["commit_sha"]),
    state: String(r["state"]),
    policyDetail: r["policy_detail"] as Record<string, unknown>,
  };
}

const PROPOSAL_SELECT = sql`
  SELECT id, task_id, attempt, changeset_id, gate_verdict_id, capability, target, branch,
         expected_remote_sha, commit_sha, state, policy_detail
  FROM action_proposals`;

export async function getProposal(exec: Exec, proposalId: string): Promise<ProposalRow | null> {
  const res = await exec.execute(sql`${PROPOSAL_SELECT} WHERE id = ${proposalId}`);
  return res.rows[0] ? proposalFromRow(res.rows[0]!) : null;
}

/**
 * D-4/D-5:提出交付并做 Policy 裁决。任何拒绝都落 proposal 行(POLICY_DENIED)+ 审计(可追溯)。
 * 同一 changeset 重复提出 ⇒ 同一行(UNIQUE(changeset_id) 幂等),拒绝原因/期望头可被更新重审。
 */
export async function proposeDelivery(exec: Exec, input: ProposeDeliveryInput): Promise<ProposeDeliveryResult> {
  const actor = input.actor ?? "delivery";
  const reject = async (reason: string, detail?: Record<string, unknown>): Promise<ProposeDeliveryResult> => {
    await appendAudit(exec, {
      actor,
      authority: "WORKER",
      action: "DELIVERY_PROPOSE_REJECTED",
      taskId: input.taskId,
      detail: { reason, ...(detail ?? {}) },
    });
    return { ok: false, reason };
  };

  // 1) 任务必须已过 Gate(ACCEPTED 终态;未过 Gate 的候选不得推送 —— 反例 3)
  const taskRes = await exec.execute(sql`SELECT id, state, goal_id FROM tasks WHERE id = ${input.taskId}`);
  const trow = taskRes.rows[0];
  if (!trow) return reject("task_not_found");
  if (String(trow["state"]) !== "ACCEPTED") return reject("task_not_accepted", { state: String(trow["state"]) });

  // 2) 变更集必须存在、匹配 attempt 且已绑定候选 commit(D-2 产物)
  const loaded = await loadChangesetForDelivery(exec, input.taskId, input.attempt);
  if (!loaded.ok) return reject(loaded.reason);
  const cs = loaded.cs;
  if (!cs.gitCommitSha || !cs.gitTreeSha || !cs.gitBaseCommitSha) return reject("no_commit_binding", { changesetId: cs.id });
  const gitBaseCommitSha = cs.gitBaseCommitSha;
  const gitTreeSha = cs.gitTreeSha;
  const gitCommitSha = cs.gitCommitSha;

  // 3) D-3 绑定重核:commit 对象仍在、树 sha/父 commit 与记录一致(内容漂移 ⇒ 必须重新验证)
  const binding = await input.verifyCommitBinding({
    gitBaseCommitSha,
    gitTreeSha,
    gitCommitSha,
  });
  if (!binding.ok) return reject(`commit_binding_${binding.reason}`, { changesetId: cs.id });

  // 4) 授权基础 = 已消费的绑定版 PASS(候选内容/需求版本/attempt 全对齐)
  const gateVerdictId = await findConsumedPass(exec, input.taskId, input.attempt, cs.candidateSha, cs.requirementSha);
  if (!gateVerdictId) return reject("no_gate_authorization", { changesetId: cs.id, candidateSha: cs.candidateSha });

  // 5) Policy(确定性默认拒绝)
  const verdict = checkDeliveryPolicy(input.policy, {
    capability: "github.push",
    target: input.target,
    branch: input.branch,
    commitSha: gitCommitSha,
    expectedRemoteSha: input.expectedRemoteSha,
    gateVerdictId,
    credentialPresent: input.credentialPresent,
  });
  const state = verdict.allowed ? "POLICY_APPROVED" : "POLICY_DENIED";
  const policyDetail = { reason: verdict.reason, repoSlug: verdict.repoSlug, gateVerdictId, verified: true };
  const id = `prop-${randomUUID()}`;
  const res = await exec.execute(sql`
    INSERT INTO action_proposals
      (id, task_id, attempt, changeset_id, gate_verdict_id, capability, target, branch,
       expected_remote_sha, commit_sha, state, policy_detail)
    VALUES (${id}, ${input.taskId}, ${input.attempt}, ${cs.id}, ${gateVerdictId}, 'github.push',
      ${input.target}, ${input.branch}, ${input.expectedRemoteSha}, ${gitCommitSha}, ${state},
      ${JSON.stringify(policyDetail)}::jsonb)
    ON CONFLICT (changeset_id) DO UPDATE SET
      target = EXCLUDED.target, branch = EXCLUDED.branch,
      expected_remote_sha = EXCLUDED.expected_remote_sha, commit_sha = EXCLUDED.commit_sha,
      gate_verdict_id = EXCLUDED.gate_verdict_id, state = EXCLUDED.state,
      policy_detail = EXCLUDED.policy_detail, updated_at = now()
    RETURNING id, (xmax = 0) AS created
  `);
  const proposalId = String(res.rows[0]!["id"]);
  const created = res.rows[0]!["created"] === true;
  const proposal = (await getProposal(exec, proposalId))!;

  await appendAudit(exec, {
    actor,
    authority: "WORKER",
    action: verdict.allowed ? "PROPOSAL_CREATED" : "PROPOSAL_POLICY_DENIED",
    taskId: input.taskId,
    detail: {
      proposalId,
      changesetId: cs.id,
      commitSha: cs.gitCommitSha,
      target: input.target,
      branch: input.branch,
      expectedRemoteSha: input.expectedRemoteSha,
      policyReason: verdict.reason,
      state,
    },
  });
  if (!verdict.allowed) return { ok: false, reason: verdict.reason, proposal };
  return { ok: true, proposal, created };
}

// —— 阶段执行 ——

export interface DeliveryIO {
  /** Scoped GitHub Executor(D-7;runtime 注入) */
  executor: IntentExecutor;
  /** D-8 远端内容核验(runtime 注入;DELIVERED 的硬前提) */
  verifyRemoteContent: (commitSha: string) => Promise<{ ok: true } | { ok: false; mismatches: string[] }>;
  /** 候选清单(远端树核对基准) */
  manifest: WorkspaceManifest;
}

export type DeliveryExecutionResult =
  | { ok: true; state: "DELIVERED"; remoteHead: string; intentId: string }
  | { ok: false; state: "CONFLICT" | "FAILED" | "NEEDS_RECONCILE"; reason: string; intentId?: string };

async function loadChangeset(exec: Exec, proposal: ProposalRow) {
  const res = await exec.execute(sql`
    SELECT id, task_id, candidate_sha, delivery_state, git_commit_sha FROM candidate_changesets WHERE id = ${proposal.changesetId}
  `);
  return res.rows[0] ?? null;
}

/** 幂等键(D-9):task+changeset+commit+expected 任一变化 ⇒ 新意图(旧证据不跨版本复用的交付面同构)。 */
export function deliveryIdempotencyKey(proposal: ProposalRow): string {
  return createHash("sha256")
    .update(JSON.stringify([proposal.taskId, proposal.changesetId, proposal.commitSha, proposal.expectedRemoteSha]))
    .digest("hex");
}

async function markDelivered(db: RelayDb, proposal: ProposalRow, intentId: string, remoteHead: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    await (tx as unknown as Exec).execute(sql`
      UPDATE candidate_changesets SET delivery_state = 'DELIVERED',
        delivery_intent_id = ${intentId}, delivered_remote_head = ${remoteHead}, delivered_at = now()
      WHERE id = ${proposal.changesetId}
    `);
    await (tx as unknown as Exec).execute(sql`
      UPDATE action_proposals SET state = 'CONSUMED', updated_at = now() WHERE id = ${proposal.id}
    `);
    await appendAudit(tx as unknown as Exec, {
      actor,
      authority: "WORKER",
      action: "DELIVERY_DELIVERED",
      taskId: proposal.taskId,
      detail: { proposalId: proposal.id, intentId, commitSha: proposal.commitSha, remoteHead, note: "远端 HEAD 与树内容均已核对" },
    });
  });
}

async function markConflict(db: RelayDb, proposal: ProposalRow, intentId: string | null, reason: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    await (tx as unknown as Exec).execute(sql`
      UPDATE candidate_changesets SET delivery_state = 'CONFLICT',
        delivery_intent_id = COALESCE(${intentId}, delivery_intent_id)
      WHERE id = ${proposal.changesetId}
    `);
    const goalRow = await (tx as unknown as Exec).execute(sql`SELECT goal_id FROM tasks WHERE id = ${proposal.taskId}`);
    const goalId = goalRow.rows[0]?.["goal_id"] === null || goalRow.rows[0]?.["goal_id"] === undefined ? null : String(goalRow.rows[0]!["goal_id"]);
    await (tx as unknown as Exec).execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, state)
      VALUES (${`dec-dl-${randomUUID()}`}, ${proposal.taskId}, ${goalId}, 'D3',
        ${`delivery_conflict:${reason}(远端漂移/核对失败;人工处置,永不自动批准)`}, 'OPEN')
    `);
    await appendAudit(tx as unknown as Exec, {
      actor,
      authority: "WORKER",
      action: "DELIVERY_CONFLICT",
      taskId: proposal.taskId,
      detail: { proposalId: proposal.id, intentId, reason, note: "交付层冲突不回滚 Gate 结论(ACCEPTED 终态);D3 人工处置" },
    });
  });
}

async function markFailed(db: RelayDb, proposal: ProposalRow, intentId: string | null, reason: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    await (tx as unknown as Exec).execute(sql`
      UPDATE candidate_changesets SET delivery_state = 'FAILED',
        delivery_intent_id = COALESCE(${intentId}, delivery_intent_id)
      WHERE id = ${proposal.changesetId}
    `);
    await appendAudit(tx as unknown as Exec, {
      actor,
      authority: "WORKER",
      action: "DELIVERY_FAILED",
      taskId: proposal.taskId,
      detail: { proposalId: proposal.id, intentId, reason, note: "安全失败:ChangeSet 不得标 DELIVERED(反例 9)" },
    });
  });
}

/**
 * D-6..D-9:执行已批准的 Proposal(两阶段意图 + 前置核对 + 远端核对后 DELIVERED)。
 * 结果不明(EXECUTING 残留)⇒ NEEDS_RECONCILE,由 reconcileDelivery 先查真实状态再决策。
 */
export async function executeDelivery(
  db: RelayDb,
  io: DeliveryIO,
  proposalId: string,
  options: { actor?: string } = {},
): Promise<DeliveryExecutionResult> {
  const actor = options.actor ?? "delivery";
  const exec = db as unknown as Exec;
  const proposal = await getProposal(exec, proposalId);
  if (!proposal) return { ok: false, state: "FAILED", reason: "proposal_not_found" };
  if (proposal.state === "POLICY_DENIED") return { ok: false, state: "FAILED", reason: "proposal_policy_denied" };

  // 已消费 ⇒ 幂等 no-op(不重推);若 changeset 尚未标 DELIVERED(回执丢失的历史窗口),走核对后补记
  if (proposal.state === "CONSUMED") {
    let head: string;
    try {
      head = await io.executor.check({
        id: proposal.id, taskId: proposal.taskId, capability: proposal.capability,
        target: proposal.target, branch: proposal.branch,
        expectedRemoteSha: proposal.expectedRemoteSha, payloadSha: proposal.commitSha,
      });
    } catch (err) {
      return { ok: false, state: "NEEDS_RECONCILE", reason: `consumed_check_failed:${(err as Error).message.slice(0, 200)}` };
    }
    if (head === proposal.commitSha) {
      const content = await io.verifyRemoteContent(proposal.commitSha);
      if (!content.ok) {
        await markConflict(db, proposal, null, `postverify:${content.mismatches.join(",")}`, actor);
        return { ok: false, state: "CONFLICT", reason: "remote_content_mismatch" };
      }
      const cs = await loadChangeset(exec, proposal);
      if (cs && String(cs["delivery_state"]) !== "DELIVERED") {
        await markDelivered(db, proposal, `recovered-${proposal.id}`, head, actor);
      }
      return { ok: true, state: "DELIVERED", remoteHead: head, intentId: `recovered-${proposal.id}` };
    }
    return { ok: false, state: "CONFLICT", reason: "consumed_but_remote_head_moved", intentId: undefined };
  }
  if (proposal.state !== "POLICY_APPROVED") {
    return { ok: false, state: "FAILED", reason: `proposal_state_${proposal.state}` };
  }

  const intentKey = deliveryIdempotencyKey(proposal);
  const reserved = await db.transaction(async (tx) =>
    reserveIntent(tx as unknown as Exec, {
      taskId: proposal.taskId,
      idempotencyKey: intentKey,
      capability: proposal.capability,
      target: proposal.target,
      branch: proposal.branch,
      expectedRemoteSha: proposal.expectedRemoteSha,
      payloadSha: proposal.commitSha,
    }),
  );
  const intentId = reserved.id;
  await db.transaction(async (tx) => {
    await (tx as unknown as Exec).execute(sql`
      UPDATE candidate_changesets SET delivery_state = 'DELIVERING', delivery_intent_id = ${intentId}
      WHERE id = ${proposal.changesetId}
    `);
  });

  let result: Awaited<ReturnType<typeof executeIntent>>;
  try {
    result = await executeIntent(db as unknown as Exec, io.executor, intentId, { actor });
  } catch (err) {
    // executor.check 抛错(鉴权失败/远端不可达/凭据无效)在 executeIntent 内不被捕获:
    // 语义 = 明确失败且无副作用 ⇒ FAILED(安全失败,反例 2;绝不留半状态)
    await markFailed(db, proposal, intentId, `executor_error:${(err as Error).message.slice(0, 300)}`, actor);
    return { ok: false, state: "FAILED", reason: `executor_error:${(err as Error).message.slice(0, 200)}`, intentId };
  }
  if (result.ok) {
    // D-8:写成功 ≠ DELIVERED。先核对远端 HEAD,再逐文件核对远端树内容。
    let head: string;
    try {
      head = await io.executor.check({
        id: intentId, taskId: proposal.taskId, capability: proposal.capability,
        target: proposal.target, branch: proposal.branch,
        expectedRemoteSha: proposal.expectedRemoteSha, payloadSha: proposal.commitSha,
      });
    } catch (err) {
      // 写后核对不可达 = 结果不明 ⇒ NEEDS_RECONCILE(先查真实状态,绝不盲推/盲标 DELIVERED)
      await appendAudit(db as unknown as Exec, {
        actor, authority: "WORKER", action: "DELIVERY_NEEDS_RECONCILE",
        taskId: proposal.taskId, intentId,
        detail: { proposalId: proposal.id, reason: `postverify_check_failed:${(err as Error).message.slice(0, 200)}` },
      });
      return { ok: false, state: "NEEDS_RECONCILE", reason: "postverify_check_failed", intentId };
    }
    if (head !== proposal.commitSha) {
      await markConflict(db, proposal, intentId, `postverify_head_moved:expected ${proposal.commitSha} actual ${head}`, actor);
      return { ok: false, state: "CONFLICT", reason: "postverify_head_moved", intentId };
    }
    const content = await io.verifyRemoteContent(proposal.commitSha);
    if (!content.ok) {
      await markConflict(db, proposal, intentId, `postverify:${content.mismatches.slice(0, 10).join(",")}`, actor);
      return { ok: false, state: "CONFLICT", reason: "remote_content_mismatch", intentId };
    }
    await markDelivered(db, proposal, intentId, head, actor);
    return { ok: true, state: "DELIVERED", remoteHead: head, intentId };
  }
  if (result.state === "CONFLICT") {
    await markConflict(db, proposal, intentId, `remote_drift:${result.reason}(expected ${proposal.expectedRemoteSha} actual ${result.actual ?? "unknown"})`, actor);
    return { ok: false, state: "CONFLICT", reason: result.reason, intentId };
  }
  if (result.state === "EXECUTING") {
    await appendAudit(db as unknown as Exec, {
      actor, authority: "WORKER", action: "DELIVERY_NEEDS_RECONCILE",
      taskId: proposal.taskId, intentId,
      detail: { proposalId: proposal.id, reason: result.reason },
    });
    return { ok: false, state: "NEEDS_RECONCILE", reason: result.reason, intentId };
  }
  await markFailed(db, proposal, intentId, `perform_failed:${result.reason}`, actor);
  return { ok: false, state: "FAILED", reason: result.reason, intentId };
}

export type DeliveryReconcileResult =
  | { decision: ReconcileDecision | "already_completed"; state: "DELIVERED" | "PROPOSED" | "CONFLICT"; remoteHead?: string };

/**
 * D-10:结果不明时的恢复入口。先查远端真实状态再决策(绝不盲目重推):
 *  - 副作用已生效(远端头==payload)⇒ 内容核对 ⇒ DELIVERED(不重做);
 *  - 目标仍 == 期望 ⇒ 未发生,回到 PROPOSED(可安全重试);
 *  - 目标漂移 ⇒ CONFLICT + D3 决策行(人工处置)。
 */
export async function reconcileDelivery(
  db: RelayDb,
  io: DeliveryIO,
  intentId: string,
  options: { actor?: string } = {},
): Promise<DeliveryReconcileResult> {
  const actor = options.actor ?? "delivery-reconciler";
  const exec = db as unknown as Exec;
  const intentRes = await exec.execute(sql`SELECT payload_sha FROM action_intents WHERE id = ${intentId}`);
  const payloadSha = intentRes.rows[0] ? String(intentRes.rows[0]!["payload_sha"]) : null;
  const propRes = await exec.execute(sql`
    SELECT id, task_id, changeset_id FROM action_proposals WHERE commit_sha = ${payloadSha ?? ""}
  `);
  const prow = propRes.rows[0];
  if (!prow || !payloadSha) {
    return { decision: "already_completed", state: "CONFLICT", remoteHead: undefined };
  }
  const proposal = (await getProposal(exec, String(prow["id"])))!;
  const r = await reconcileIntent(db as unknown as Exec, io.executor, intentId, { actor });

  if (r.decision === "already_completed") {
    // 回执已写:按 DELIVERED 收尾(补远端核对,不在恢复路径降低标准)
    let content: Awaited<ReturnType<typeof io.verifyRemoteContent>>;
    try {
      content = await io.verifyRemoteContent(payloadSha);
    } catch (err) {
      await markConflict(db, proposal, intentId, `reconcile_verify_failed:${(err as Error).message.slice(0, 200)}`, actor);
      return { decision: r.decision, state: "CONFLICT", ...(r.actualRemoteHead !== undefined ? { remoteHead: r.actualRemoteHead } : {}) };
    }
    if (!content.ok) {
      await markConflict(db, proposal, intentId, `reconcile_postverify:${content.mismatches.slice(0, 10).join(",")}`, actor);
      return { decision: r.decision, state: "CONFLICT", ...(r.actualRemoteHead !== undefined ? { remoteHead: r.actualRemoteHead } : {}) };
    }
    const cs = await loadChangeset(exec, proposal);
    if (cs && String(cs["delivery_state"]) !== "DELIVERED") {
      await markDelivered(db, proposal, intentId, payloadSha, actor);
    }
    return { decision: r.decision, state: "DELIVERED", ...(r.actualRemoteHead !== undefined ? { remoteHead: r.actualRemoteHead } : {}) };
  }
  if (r.decision === "SIDE_EFFECT_CONFIRMED") {
    // 副作用已发生(远端头==payload):核对内容后补 DELIVERED,绝不重推
    let content: Awaited<ReturnType<typeof io.verifyRemoteContent>>;
    try {
      content = await io.verifyRemoteContent(payloadSha);
    } catch (err) {
      await markConflict(db, proposal, intentId, `reconcile_verify_failed:${(err as Error).message.slice(0, 200)}`, actor);
      return { decision: r.decision, state: "CONFLICT", remoteHead: r.actualRemoteHead };
    }
    if (!content.ok) {
      await markConflict(db, proposal, intentId, `reconcile_postverify:${content.mismatches.slice(0, 10).join(",")}`, actor);
      return { decision: r.decision, state: "CONFLICT", remoteHead: r.actualRemoteHead };
    }
    await markDelivered(db, proposal, intentId, payloadSha, actor);
    return { decision: r.decision, state: "DELIVERED", remoteHead: r.actualRemoteHead };
  }
  if (r.decision === "SIDE_EFFECT_ABSENT_REEXECUTE_SAFE") {
    await db.transaction(async (tx) => {
      await (tx as unknown as Exec).execute(sql`
        UPDATE candidate_changesets SET delivery_state = 'PROPOSED' WHERE id = ${proposal.changesetId} AND delivery_state = 'DELIVERING'
      `);
      await appendAudit(tx as unknown as Exec, {
        actor, authority: "RECONCILER", action: "DELIVERY_RECONCILE_SAFE_RETRY",
        taskId: proposal.taskId, intentId,
        detail: { decision: r.decision, actualRemoteHead: r.actualRemoteHead },
      });
    });
    return { decision: r.decision, state: "PROPOSED", remoteHead: r.actualRemoteHead };
  }
  await markConflict(db, proposal, intentId, `reconcile_remote_moved(actual ${r.actualRemoteHead ?? "unknown"})`, actor);
  return { decision: r.decision, state: "CONFLICT", remoteHead: r.actualRemoteHead };
}
