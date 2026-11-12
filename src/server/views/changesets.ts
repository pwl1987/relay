// 只读视图·Changeset/Evidence(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../../core/db.ts";
import { isLegalTransition } from "../../core/lifecycle.ts";
import {
  iso,
  num,
  str,
  json,
  type Row,
  type TaskView,
  type GateVerdictView,
  type ChangesetSummary,
  type RunView,
  type DecisionView,
  type EvidenceView,
  availableActionsFor,
  decisionGuidance,
  TIMEOUT_BEHAVIOR,
} from "./shared.ts";

export interface ChangesetDetail {
  changeset: ChangesetSummary;
  task: TaskView | null;
  goal: { id: string; rawInput: string; state: string } | null;
  gates: GateVerdictView[];
  evidence: EvidenceView[];
  runs: RunView[];
  proposal: {
    id: string;
    state: string;
    capability: string;
    target: string;
    branch: string;
    expectedRemoteSha: string;
    commitSha: string;
    policyDetail: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  } | null;
  intent: { id: string; state: string; capability: string; target: string; branch: string; payloadSha: string; expectedRemoteSha: string; createdAt: string; updatedAt: string } | null;
  decisions: DecisionView[];
  /** 证据时效:绑定候选与当前候选不一致 ⇒ 需要重验 */
  evidenceFreshness: { currentCandidateSha: string; staleGateCount: number; verdict: "FRESH" | "STALE" };
}

export async function changesetDetailView(db: RelayDb, changesetId: string): Promise<ChangesetDetail | null> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const cs = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head, created_at
    FROM candidate_changesets WHERE id = ${changesetId}
  `);
  const row = cs.rows[0];
  if (!row) return null;
  const taskId = str(row["task_id"]);

  const changeset: ChangesetSummary = {
    id: str(row["id"]),
    taskId,
    runId: str(row["run_id"]),
    attempt: num(row["attempt"]),
    baseSha: str(row["base_sha"]),
    candidateSha: str(row["candidate_sha"]),
    requirementSha: str(row["requirement_sha"]),
    gitBaseCommitSha: row["git_base_commit_sha"] === null ? null : str(row["git_base_commit_sha"]),
    gitTreeSha: row["git_tree_sha"] === null ? null : str(row["git_tree_sha"]),
    gitCommitSha: row["git_commit_sha"] === null ? null : str(row["git_commit_sha"]),
    changedFiles: json<ChangesetSummary["changedFiles"]>(row["changed_files"], { added: [], modified: [], removed: [] }),
    impactScope: json<ChangesetSummary["impactScope"]>(row["impact_scope"], { inScope: [], violations: [] }),
    deliveryState: str(row["delivery_state"]),
    deliveredRemoteHead: row["delivered_remote_head"] === null ? null : str(row["delivered_remote_head"]),
    createdAt: iso(row["created_at"]) ?? "",
  };

  const taskRows = await exec.execute(sql`
    SELECT id, goal_id, state, state_version, attempt, max_attempts, priority, gate_required,
           allowed_scope, allowed_commands, blocked_reason, retry_not_before, created_at, updated_at
    FROM tasks WHERE id = ${taskId}
  `);
  const trow = taskRows.rows[0];
  let task: TaskView | null = null;
  if (trow) {
    const decRows = await exec.execute(sql`
      SELECT id, level, question, state, deadline FROM decisions
      WHERE task_id = ${taskId} AND state IN ('OPEN','EXPIRED_STILL_BLOCKED') ORDER BY created_at LIMIT 1
    `);
    const d = decRows.rows[0];
    task = {
      id: taskId,
      goalId: trow["goal_id"] === null ? null : str(trow["goal_id"]),
      state: str(trow["state"]),
      stateVersion: num(trow["state_version"]),
      attempt: num(trow["attempt"]),
      maxAttempts: num(trow["max_attempts"]),
      priority: num(trow["priority"]),
      gateRequired: trow["gate_required"] === true,
      allowedScope: json<string[]>(trow["allowed_scope"], []),
      allowedCommands: json<string[]>(trow["allowed_commands"], []),
      blockedReason: trow["blocked_reason"] === null ? null : str(trow["blocked_reason"]),
      retryNotBefore: iso(trow["retry_not_before"]),
      createdAt: iso(trow["created_at"]) ?? "",
      updatedAt: iso(trow["updated_at"]) ?? "",
      openDecision: d ? { id: str(d["id"]), level: str(d["level"]), question: str(d["question"]), state: str(d["state"]), deadline: iso(d["deadline"]) } : null,
      availableActions: [],
    };
    task.availableActions = availableActionsFor(task, Boolean(d));
  }

  const gateRows = await exec.execute(sql`
    SELECT id, verdict, reviewer, attempt, candidate_sha, requirement_sha, reviewer_run_id, coder_run_id,
           evidence_ids, test_env, consumed_at, consumed_by, created_at
    FROM task_gate_verdicts WHERE task_id = ${taskId} ORDER BY created_at DESC
  `);
  const gates: GateVerdictView[] = gateRows.rows.map((r) => {
    const cand = r["candidate_sha"] === null ? null : str(r["candidate_sha"]);
    return {
      id: str(r["id"]),
      verdict: str(r["verdict"]),
      reviewer: str(r["reviewer"]),
      attempt: r["attempt"] === null ? null : num(r["attempt"]),
      candidateSha: cand,
      requirementSha: r["requirement_sha"] === null ? null : str(r["requirement_sha"]),
      reviewerRunId: r["reviewer_run_id"] === null ? null : str(r["reviewer_run_id"]),
      coderRunId: r["coder_run_id"] === null ? null : str(r["coder_run_id"]),
      evidenceIds: json<string[]>(r["evidence_ids"], []),
      testEnv: json<Record<string, unknown>>(r["test_env"], {}),
      consumedAt: iso(r["consumed_at"]),
      consumedBy: r["consumed_by"] === null ? null : str(r["consumed_by"]),
      createdAt: iso(r["created_at"]) ?? "",
      staleEvidence: cand !== null && cand !== changeset.candidateSha,
    };
  });

  const evRows = await exec.execute(sql`
    SELECT id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by, created_at
    FROM gate_evidence WHERE task_id = ${taskId} ORDER BY created_at DESC LIMIT 100
  `);
  const evidence: EvidenceView[] = evRows.rows.map((r) => ({
    id: str(r["id"]),
    kind: str(r["kind"]),
    passed: r["passed"] === true,
    attempt: num(r["attempt"]),
    candidateSha: str(r["candidate_sha"]),
    contentSha256: str(r["content_sha256"]),
    producedBy: str(r["produced_by"]),
    createdAt: iso(r["created_at"]) ?? "",
    rawOutput: str(r["raw_output"]).slice(0, 8000),
    env: json<Record<string, unknown>>(r["env"], {}),
  }));

  const runRows = await exec.execute(sql`
    SELECT id, task_id, attempt, outcome, sandbox, model_ref, detail, started_at, ended_at
    FROM runs WHERE task_id = ${taskId} ORDER BY started_at DESC LIMIT 50
  `);
  const runs: RunView[] = runRows.rows.map((r) => {
    const detail = json<Record<string, unknown>>(r["detail"], {});
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      attempt: num(r["attempt"]),
      outcome: str(r["outcome"]),
      sandbox: str(r["sandbox"]),
      modelRef: str(r["model_ref"]),
      role: detail["role"] === undefined ? null : str(detail["role"]),
      startedAt: iso(r["started_at"]) ?? "",
      endedAt: iso(r["ended_at"]),
      reason: detail["reason"] === undefined ? null : str(detail["reason"]),
      detail,
    };
  });

  const propRows = await exec.execute(sql`
    SELECT id, state, capability, target, branch, expected_remote_sha, commit_sha, policy_detail, created_at, updated_at
    FROM action_proposals WHERE changeset_id = ${changesetId} ORDER BY created_at DESC LIMIT 1
  `);
  const prow = propRows.rows[0];
  const proposal = prow
    ? {
        id: str(prow["id"]),
        state: str(prow["state"]),
        capability: str(prow["capability"]),
        target: str(prow["target"]),
        branch: str(prow["branch"]),
        expectedRemoteSha: str(prow["expected_remote_sha"]),
        commitSha: str(prow["commit_sha"]),
        policyDetail: json<Record<string, unknown>>(prow["policy_detail"], {}),
        createdAt: iso(prow["created_at"]) ?? "",
        updatedAt: iso(prow["updated_at"]) ?? "",
      }
    : null;

  let intent: ChangesetDetail["intent"] = null;
  if (prow) {
    const iRows = await exec.execute(sql`
      SELECT id, state, capability, target, branch, payload_sha, expected_remote_sha, created_at, updated_at
      FROM action_intents WHERE task_id = ${taskId} AND payload_sha = ${str(prow["commit_sha"])} ORDER BY created_at DESC LIMIT 1
    `);
    const i = iRows.rows[0];
    if (i) {
      intent = {
        id: str(i["id"]),
        state: str(i["state"]),
        capability: str(i["capability"]),
        target: str(i["target"]),
        branch: str(i["branch"]),
        payloadSha: str(i["payload_sha"]),
        expectedRemoteSha: str(i["expected_remote_sha"]),
        createdAt: iso(i["created_at"]) ?? "",
        updatedAt: iso(i["updated_at"]) ?? "",
      };
    }
  }

  const decRows = await exec.execute(sql`
    SELECT id, task_id, goal_id, level, question, fallback, deadline, state, verdict, decided_by, decided_at, created_at
    FROM decisions WHERE task_id = ${taskId} ORDER BY created_at DESC
  `);
  const decisions: DecisionView[] = decRows.rows.map((r) => {
    const level = str(r["level"]);
    const state = str(r["state"]);
    const pending = state === "OPEN" || state === "EXPIRED_STILL_BLOCKED";
    const legal = task ? isLegalTransition(task.state, "READY") : false;
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      level,
      question: str(r["question"]),
      fallback: json<Record<string, unknown> | null>(r["fallback"], null),
      deadline: iso(r["deadline"]),
      state,
      verdict: json<Record<string, unknown> | null>(r["verdict"], null),
      decidedBy: r["decided_by"] === null ? null : str(r["decided_by"]),
      decidedAt: iso(r["decided_at"]),
      createdAt: iso(r["created_at"]) ?? "",
      taskState: task?.state ?? null,
      taskStateVersion: task?.stateVersion ?? null,
      timeoutBehavior: TIMEOUT_BEHAVIOR[level] ?? "未登记",
      affectedFiles: [...changeset.changedFiles.added, ...changeset.changedFiles.modified, ...changeset.changedFiles.removed],
      reversible: level === "D3",
      canApprove: pending && level !== "D4" && legal,
      canReject: pending && level !== "D4",
      canDefer: pending && level !== "D4",
      guidance: decisionGuidance({
        level,
        question: str(r["question"]),
        fallback: json<Record<string, unknown> | null>(r["fallback"], null),
        taskState: task?.state ?? null,
        blockedReason: task?.blockedReason ?? null,
        deadline: iso(r["deadline"]),
        reversible: level === "D3",
      }),
    };
  });

  let goal: ChangesetDetail["goal"] = null;
  if (task?.goalId) {
    const gRows = await exec.execute(sql`SELECT id, raw_input, state FROM goals WHERE id = ${task.goalId}`);
    const g = gRows.rows[0];
    if (g) goal = { id: str(g["id"]), rawInput: str(g["raw_input"]), state: str(g["state"]) };
  }

  const staleGateCount = gates.filter((g) => g.staleEvidence).length;
  return {
    changeset,
    task,
    goal,
    gates,
    evidence,
    runs,
    proposal,
    intent,
    decisions,
    evidenceFreshness: {
      currentCandidateSha: changeset.candidateSha,
      staleGateCount,
      verdict: staleGateCount > 0 ? "STALE" : "FRESH",
    },
  };
}

/** 变更集列表(ChangeSet 页的选择器)。 */
export async function changesetListView(db: RelayDb): Promise<ChangesetSummary[]> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const rows = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head, created_at
    FROM candidate_changesets ORDER BY created_at DESC LIMIT 200
  `);
  return rows.rows.map((r) => ({
    id: str(r["id"]),
    taskId: str(r["task_id"]),
    runId: str(r["run_id"]),
    attempt: num(r["attempt"]),
    baseSha: str(r["base_sha"]),
    candidateSha: str(r["candidate_sha"]),
    requirementSha: str(r["requirement_sha"]),
    gitBaseCommitSha: r["git_base_commit_sha"] === null ? null : str(r["git_base_commit_sha"]),
    gitTreeSha: r["git_tree_sha"] === null ? null : str(r["git_tree_sha"]),
    gitCommitSha: r["git_commit_sha"] === null ? null : str(r["git_commit_sha"]),
    changedFiles: json<ChangesetSummary["changedFiles"]>(r["changed_files"], { added: [], modified: [], removed: [] }),
    impactScope: json<ChangesetSummary["impactScope"]>(r["impact_scope"], { inScope: [], violations: [] }),
    deliveryState: str(r["delivery_state"]),
    deliveredRemoteHead: r["delivered_remote_head"] === null ? null : str(r["delivered_remote_head"]),
    createdAt: iso(r["created_at"]) ?? "",
  }));
}
