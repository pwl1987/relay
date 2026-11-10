// Gate 测试辅助:Reviewer Run 播种(runs 行 role=reviewer)+ 绑定版裁决记录。
// 绑定缺省:无变更集流程 candidateSha/requirementSha 为 null(仅当确无变更集时合法);
// attempt 缺省取任务当前 attempt。
import { sql } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import type { RelayDb, Exec } from "../../src/core/db.ts";
import { recordGateVerdict, type GateVerdict, type RecordGateResult } from "../../src/core/gates.ts";

export async function seedReviewerRun(
  db: RelayDb,
  spec: { taskId: string; attempt?: number; runId?: string },
): Promise<string> {
  const runId = spec.runId ?? `run-rv-${randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO runs (id, task_id, attempt, runtime, model_ref, budget, sandbox, outcome, detail)
    VALUES (${runId}, ${spec.taskId}, ${spec.attempt ?? 1}, 'stub', 'stub/reviewer',
      '{"role":"reviewer"}'::jsonb, 'host-fallback', 'SUCCEEDED', '{"role":"reviewer"}'::jsonb)
  `);
  return runId;
}

export interface BoundGateSpec {
  taskId: string;
  verdict: GateVerdict;
  reviewer?: string;
  attempt?: number;
  candidateSha?: string | null;
  requirementSha?: string | null;
  reviewerRunId?: string;
  coderRunId?: string | null;
  evidenceIds?: string[];
}

export async function recordBoundGate(db: RelayDb, spec: BoundGateSpec): Promise<RecordGateResult> {
  let attempt = spec.attempt;
  if (attempt === undefined) {
    const r = await db.execute(sql`SELECT attempt FROM tasks WHERE id = ${spec.taskId}`);
    attempt = Number(r.rows[0]?.["attempt"] ?? 1);
  }
  const reviewerRunId = spec.reviewerRunId ?? (await seedReviewerRun(db, { taskId: spec.taskId, attempt }));
  // PASS 必须引用证据(Gate 绑定铁律):未显式给 evidenceIds 时,播种一条真实的
  // 确定性证据行(内容即本辅助的执行事实;candidateSha 用 "" 哨兵对齐无候选流程)。
  let evidenceIds = spec.evidenceIds;
  if (spec.verdict === "PASS" && !evidenceIds) {
    const rawOutput = `gate-helper deterministic check: task=${spec.taskId} attempt=${attempt} ok`;
    const id = `ev-${randomUUID().slice(0, 8)}`;
    const contentSha = createHash("sha256").update(rawOutput, "utf8").digest("hex");
    await db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES (${id}, ${spec.taskId}, ${attempt}, ${spec.candidateSha ?? ""}, 'deterministic_test',
        true, ${rawOutput}, ${JSON.stringify({ mode: "host-fallback", node: process.version, host: "test" })}::jsonb,
        ${contentSha}, 'gate-helper')
    `);
    evidenceIds = [id];
  }
  return db.transaction(async (tx) =>
    recordGateVerdict(tx as unknown as Exec, {
      taskId: spec.taskId,
      verdict: spec.verdict,
      reviewer: spec.reviewer ?? "reviewer-bound",
      attempt,
      candidateSha: spec.candidateSha ?? null,
      requirementSha: spec.requirementSha ?? null,
      testEnv: { mode: "host-fallback", node: process.version, host: "test" },
      reviewerRunId,
      coderRunId: spec.coderRunId ?? null,
      ...(evidenceIds ? { evidenceIds } : {}),
    }),
  );
}
