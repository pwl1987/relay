// Candidate ChangeSet(P0-02A C-1;CONSTRUCTION_PLAN P0-02A "Candidate Diff")。
// 语义:Worker 侧(可信执行器)在 Run 启动前与结束后对 Run 工作区做清单对比
// (相对路径 -> sha256),diff 出增/改/删,清单内容 sha256 即 candidate_sha。
// 绑定:task/run/attempt + requirement_sha(需求快照:goal 原文 + 任务约束)。
// 影响面核验:changed 路径必须落在 allowed_scope 前缀内(越界 = violations,如实记录)。
// 纯函数(manifest/diff/sha)与落库分离:core 不做文件 IO,清单采集由 runtime 提供。
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";

/** 工作区清单条目:相对路径 -> 内容 sha256。 */
export type WorkspaceManifest = ReadonlyMap<string, string>;

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 清单内容的规范序列化(排序后 JSON),其 sha256 即 base/candidate_sha。 */
export function manifestSha(manifest: WorkspaceManifest): string {
  const entries = [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify(entries));
}

export interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export function diffManifests(base: WorkspaceManifest, candidate: WorkspaceManifest): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [p, h] of candidate) {
    const bh = base.get(p);
    if (bh === undefined) added.push(p);
    else if (bh !== h) modified.push(p);
  }
  for (const p of base.keys()) if (!candidate.has(p)) removed.push(p);
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { added: added.sort(byPath), modified: modified.sort(byPath), removed: removed.sort(byPath) };
}

/** 需求快照 sha256(goal 原文 + 任务约束;绑定需求版本,变更即旧 Gate 失效)。 */
export function requirementSha(input: {
  goalText: string;
  taskId: string;
  allowedScope: readonly string[];
  allowedCommands: readonly string[];
}): string {
  return sha256Hex(
    JSON.stringify({
      goalText: input.goalText,
      taskId: input.taskId,
      allowedScope: [...input.allowedScope].sort(),
      allowedCommands: [...input.allowedCommands].sort(),
    }),
  );
}

/** 影响面:changed 路径是否落在 allowed_scope 前缀内(逐条核验,violation 全量记录)。 */
export function impactScope(
  diff: ManifestDiff,
  allowedScope: readonly string[],
): { inScope: string[]; violations: string[] } {
  const changed = [...diff.added, ...diff.modified, ...diff.removed];
  const inScope: string[] = [];
  const violations: string[] = [];
  for (const p of changed) {
    const ok = allowedScope.some((root) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));
    (ok ? inScope : violations).push(p);
  }
  return { inScope, violations };
}

/**
 * 影响面核验(挂载点换算):清单路径相对工作区根,scope 根为容器内绝对路径
 * (如 /workspace)。把等于挂载点的 scope 根映射为 "."(工作区根)后做前缀匹配 ——
 * 沙箱保证 Run 只能写挂载工作区,故挂载点即候选全集的边界。
 */
export function impactScopeWithMount(
  diff: ManifestDiff,
  allowedScope: readonly string[],
  workspaceMount = "/workspace",
): { inScope: string[]; violations: string[] } {
  const roots = allowedScope.map((s) => (s === workspaceMount ? "." : s));
  const changed = [...diff.added, ...diff.modified, ...diff.removed];
  const inScope: string[] = [];
  const violations: string[] = [];
  for (const p of changed) {
    const ok = roots.some((root) => root === "." || p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`));
    (ok ? inScope : violations).push(p);
  }
  return { inScope, violations };
}

export interface RecordedChangeset {
  id: string;
  baseSha: string;
  candidateSha: string;
  requirementSha: string;
  diff: ManifestDiff;
  violations: string[];
}

/** 落库 + 审计。workspaceMount:Run 工作区在容器内的挂载路径(默认 /workspace)。
 * violation 不阻断记录 —— 如实记录,Gate 层消费时裁决。 */
export async function recordChangeset(
  exec: Exec,
  spec: {
    taskId: string;
    runId: string;
    attempt: number;
    base: WorkspaceManifest;
    candidate: WorkspaceManifest;
    requirement: { goalText: string; taskId: string; allowedScope: readonly string[]; allowedCommands: readonly string[] };
    workspaceMount?: string;
  },
  actor = "worker",
): Promise<RecordedChangeset> {
  const diff = diffManifests(spec.base, spec.candidate);
  const baseSha = manifestSha(spec.base);
  const candidateSha = manifestSha(spec.candidate);
  const reqSha = requirementSha(spec.requirement);
  const impact = impactScopeWithMount(diff, spec.requirement.allowedScope, spec.workspaceMount ?? "/workspace");
  const id = `cs-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO candidate_changesets
      (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope)
    VALUES (${id}, ${spec.taskId}, ${spec.runId}, ${spec.attempt},
      ${baseSha}, ${candidateSha}, ${reqSha},
      ${JSON.stringify(diff)}::jsonb, ${JSON.stringify(impact)}::jsonb)
  `);
  await appendAudit(exec, {
    actor,
    authority: "WORKER",
    action: "CHANGESET_RECORDED",
    taskId: spec.taskId,
    detail: { changesetId: id, runId: spec.runId, attempt: spec.attempt, baseSha, candidateSha, requirementSha: reqSha, diff, impact },
  });
  return { id, baseSha, candidateSha, requirementSha: reqSha, diff, violations: impact.violations };
}

export interface ChangesetRow {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  baseSha: string;
  candidateSha: string;
  requirementSha: string;
  changedFiles: Record<string, string[]>;
  impactScope: Record<string, string[]>;
  // P0-02B D-1:三 SHA 区分(候选 commit 绑定;未构建 commit 时为 null)
  gitBaseCommitSha: string | null;
  gitTreeSha: string | null;
  gitCommitSha: string | null;
  deliveryState: string;
  deliveredRemoteHead: string | null;
}

/** 当前生效变更集(该 task 最新 attempt 的最新一条;Gate 绑定的比对基准)。 */
export async function latestChangeset(exec: Exec, taskId: string): Promise<ChangesetRow | null> {
  const res = await exec.execute(sql`
    SELECT id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha,
           changed_files, impact_scope,
           git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head
    FROM candidate_changesets WHERE task_id = ${taskId}
    ORDER BY attempt DESC, created_at DESC LIMIT 1
  `);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]),
    taskId: String(r["task_id"]),
    runId: String(r["run_id"]),
    attempt: Number(r["attempt"]),
    baseSha: String(r["base_sha"]),
    candidateSha: String(r["candidate_sha"]),
    requirementSha: String(r["requirement_sha"]),
    changedFiles: r["changed_files"] as Record<string, string[]>,
    impactScope: r["impact_scope"] as Record<string, string[]>,
    gitBaseCommitSha: (r["git_base_commit_sha"] as string | null) ?? null,
    gitTreeSha: (r["git_tree_sha"] as string | null) ?? null,
    gitCommitSha: (r["git_commit_sha"] as string | null) ?? null,
    deliveryState: String(r["delivery_state"] ?? "NONE"),
    deliveredRemoteHead: (r["delivered_remote_head"] as string | null) ?? null,
  };
}

/** 绑定候选 commit 到变更集(D-2 产物落库;binding 前提:仍是该 task 最新变更集)。 */
export async function bindCandidateCommit(
  exec: Exec,
  spec: {
    changesetId: string;
    taskId: string;
    attempt: number;
    baseCommitSha: string;
    treeSha: string;
    commitSha: string;
    stageRepoDir: string;
  },
  actor = "worker",
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 仍须是最新变更集(绑定过期候选 ⇒ 拒绝)
  const latest = await latestChangeset(exec, spec.taskId);
  if (!latest || latest.id !== spec.changesetId) return { ok: false, reason: "changeset_not_latest" };
  await exec.execute(sql`
    UPDATE candidate_changesets
    SET git_base_commit_sha = ${spec.baseCommitSha}, git_tree_sha = ${spec.treeSha},
        git_commit_sha = ${spec.commitSha}
    WHERE id = ${spec.changesetId}
  `);
  await appendAudit(exec, {
    actor,
    authority: "WORKER",
    action: "GIT_COMMIT_BOUND",
    taskId: spec.taskId,
    detail: {
      changesetId: spec.changesetId,
      attempt: spec.attempt,
      baseCommitSha: spec.baseCommitSha,
      treeSha: spec.treeSha,
      commitSha: spec.commitSha,
      stageRepoDir: spec.stageRepoDir,
      note: "三 SHA 区分:candidate_sha(清单)≠ tree_sha ≠ commit_sha;树==清单往返核验已通过",
    },
  });
  return { ok: true };
}
