// 可信 Evidence 采集(P0-02A C-3;合同条款 3/7)。
// 原则:
// - Evidence 由 **可信执行器**(Worker 侧进程)执行并落库,不依赖 Agent 可改写的 workspace 日志。
// - passed 由 Worker 按退出码/探针结果判定,模型文本不参与判定。
// - 每条证据记录:原始输出原文、时间(DB now())、环境(node/沙箱/命令)、内容 sha256、产出者,
//   并绑定 (task, attempt, candidate_sha) —— SHA 变化后旧证据不参与 Gate。
// - 确定性检查命令默认在 Run 工作区执行(cwdWorkspace),超时即失败(FAIL-CLOSED 方向)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { sha256Hex } from "./changesets.ts";

export type EvidenceKind = "deterministic_test" | "api_behavior" | "reviewer_output" | "candidate_manifest_verify";

export interface EvidenceEnv {
  mode: string; // docker | host-fallback | worker-host(检查执行面)
  node: string;
  host: string;
  command?: string;
  [k: string]: unknown;
}

export interface EvidenceInput {
  taskId: string;
  attempt: number;
  candidateSha: string;
  kind: EvidenceKind;
  passed: boolean;
  rawOutput: string;
  env: EvidenceEnv;
  producedBy: string;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  passed: boolean;
  contentSha256: string;
  candidateSha: string;
  attempt: number;
}

export async function recordEvidence(exec: Exec, input: EvidenceInput): Promise<EvidenceRow> {
  const id = `ev-${randomUUID()}`;
  const contentSha = sha256Hex(input.rawOutput);
  await exec.execute(sql`
    INSERT INTO gate_evidence
      (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
    VALUES (${id}, ${input.taskId}, ${input.attempt}, ${input.candidateSha}, ${input.kind},
      ${input.passed}, ${input.rawOutput}, ${JSON.stringify(input.env)}::jsonb,
      ${contentSha}, ${input.producedBy})
  `);
  await appendAudit(exec, {
    actor: input.producedBy,
    authority: "WORKER",
    action: `EVIDENCE_${input.kind.toUpperCase()}`,
    taskId: input.taskId,
    detail: {
      evidenceId: id,
      kind: input.kind,
      passed: input.passed,
      contentSha256: contentSha,
      candidateSha: input.candidateSha,
      attempt: input.attempt,
    },
  });
  return {
    id,
    kind: input.kind,
    passed: input.passed,
    contentSha256: contentSha,
    candidateSha: input.candidateSha,
    attempt: input.attempt,
  };
}

export function workerEnv(mode: string, extra: Record<string, unknown> = {}): EvidenceEnv {
  return { mode, node: process.version, host: os.hostname(), ...extra };
}

// ---------- 确定性检查(可信执行器) ----------

export interface CheckSpec {
  kind: EvidenceKind;
  /** argv 形式执行(不经 shell);非零退出 = failed */
  command: readonly string[];
  /** true = 在 Run 工作区执行(候选内容面);缺省宿主 cwd */
  cwdWorkspace?: boolean;
  timeoutMs?: number;
  /** 期望输出包含的子串(可选强化断言;缺失 = 仅按退出码) */
  expectOutputContains?: string;
}

export interface CheckResult {
  passed: boolean;
  rawOutput: string;
  env: EvidenceEnv;
}

/** 执行一条确定性检查(真实子进程;argv 直启,无 shell 注入面)。 */
export function runCheck(spec: CheckSpec, workspaceDir: string): Promise<CheckResult> {
  const cwd = spec.cwdWorkspace ? workspaceDir : process.cwd();
  const env = workerEnv("worker-host", { command: spec.command.join(" "), cwd });
  return new Promise((resolve) => {
    execFile(
      spec.command[0]!,
      [...spec.command.slice(1)],
      { cwd, timeout: spec.timeoutMs ?? 60_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const rawOutput = [`$ ${spec.command.join(" ")}`, stdout ?? "", stderr ?? ""].join("\n").trimEnd();
        if (err) {
          const timedOut = (err as { killed?: boolean }).killed === true;
          resolve({
            passed: false,
            rawOutput: `${rawOutput}\n[exit=${timedOut ? "TIMEOUT" : String((err as { code?: unknown }).code ?? "nonzero")}]`,
            env,
          });
          return;
        }
        const containsOk = spec.expectOutputContains ? rawOutput.includes(spec.expectOutputContains) : true;
        resolve({ passed: containsOk, rawOutput, env });
      },
    );
  });
}

/** 执行检查并落库(绑定当前 attempt/candidate_sha)。 */
export async function collectCheckEvidence(
  exec: Exec,
  spec: CheckSpec & { taskId: string; attempt: number; candidateSha: string; producedBy: string },
  workspaceDir: string,
): Promise<EvidenceRow & { rawOutput: string; env: EvidenceEnv }> {
  const result = await runCheck(spec, workspaceDir);
  const row = await recordEvidence(exec, {
    taskId: spec.taskId,
    attempt: spec.attempt,
    candidateSha: spec.candidateSha,
    kind: spec.kind,
    passed: result.passed,
    rawOutput: result.rawOutput,
    env: result.env,
    producedBy: spec.producedBy,
  });
  return { ...row, rawOutput: result.rawOutput, env: result.env };
}

// ---------- 读取(消费时核验) ----------

export interface EvidenceIntegrityRow extends EvidenceRow {
  taskId: string;
  rawOutput: string;
  env: EvidenceEnv;
  producedBy: string;
}

export async function getEvidence(exec: Exec, id: string): Promise<EvidenceIntegrityRow | null> {
  const res = await exec.execute(sql`
    SELECT id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by
    FROM gate_evidence WHERE id = ${id}
  `);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]),
    taskId: String(r["task_id"]),
    attempt: Number(r["attempt"]),
    candidateSha: String(r["candidate_sha"]),
    kind: String(r["kind"]),
    passed: r["passed"] === true,
    rawOutput: String(r["raw_output"]),
    env: r["env"] as EvidenceEnv,
    contentSha256: String(r["content_sha256"]),
    producedBy: String(r["produced_by"]),
  };
}

/** 消费侧完整性核验:存在 + 绑定匹配 + passed + digest 与原文一致。 */
export function verifyEvidenceIntegrity(
  row: EvidenceIntegrityRow,
  binding: { taskId: string; attempt: number; candidateSha: string },
): { ok: boolean; reason?: string } {
  if (row.taskId !== binding.taskId) return { ok: false, reason: "evidence_task_mismatch" };
  if (row.attempt !== binding.attempt) return { ok: false, reason: "evidence_attempt_mismatch" };
  if (row.candidateSha !== binding.candidateSha) return { ok: false, reason: "evidence_sha_mismatch" };
  if (!row.passed) return { ok: false, reason: "evidence_not_passed" };
  if (sha256Hex(row.rawOutput) !== row.contentSha256) return { ok: false, reason: "evidence_digest_mismatch" };
  return { ok: true };
}
