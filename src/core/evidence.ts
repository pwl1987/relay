// 可信 Evidence 采集(P0-02A C-3;合同条款 3/7)。
// 证据四类语义(RELAY-SAFETY-CLOSE-02 P0-B;详见 gates.ts FUNCTIONAL_EVIDENCE_KINDS 注):
//   candidate_manifest_verify = 候选完整性(硬门,不证明行为);deterministic_test/api_behavior =
//   功能性证据(证明行为,代码变更 PASS 必需);reviewer_output = 独立 Review(永不充当机器证据)。
// 原则:
// - Evidence 由 **可信执行器**(Worker 侧进程)执行并落库,不依赖 Agent 可改写的 workspace 日志。
// - passed 由 Worker 按退出码/探针结果判定,模型文本不参与判定。
// - 每条证据记录:原始输出原文、时间(DB now())、环境(node/沙箱/命令)、内容 sha256、产出者,
//   并绑定 (task, attempt, candidate_sha) —— SHA 变化后旧证据不参与 Gate。
// - RELAY-CONTROL-SAFETY-04 P0-A:候选功能检查一律经 CheckRunner 端口在沙箱内执行
//   (runtime 提供 docker 实现;非 root/cap-drop ALL/显式最小 env/默认禁网/资源上限/
//   超时杀整个容器进程组)。**宿主 execFile 已从本层移除** —— 反例实证
//   (p0-mvp/control-safety-04/evidence/:读 Worker 哨兵 env/cwdWorkspace=false 落宿主仓库根/
//   宿主任意路径落盘/超时孙进程残留)。runner 未注入 ⇒ failClosedCheckRunner(FAIL-CLOSED:
//   检查按失败处理,绝不退回宿主执行);cwdWorkspace=false/任意 argv 不构成宿主绕过面(容器内)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { sha256Hex } from "./changesets.ts";

export type EvidenceKind = "deterministic_test" | "api_behavior" | "reviewer_output" | "candidate_manifest_verify";

export interface EvidenceEnv {
  mode: string; // docker | host-fallback | sandbox-fail-closed | reviewer 等(如实记录执行面)
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
  /** argv 形式执行(不经 shell);非零退出 = failed;在沙箱容器内执行(P0-A) */
  command: readonly string[];
  /** true = 在 Run 工作区执行(候选内容面,容器内 /workspace rw);false = 容器内 /tmp 执行,
   *  工作区只读挂载 —— **不构成宿主绕过**(P0-A A5);缺省 true */
  cwdWorkspace?: boolean;
  timeoutMs?: number;
  /** 期望输出包含的子串(可选强化断言;缺失 = 仅按退出码) */
  expectOutputContains?: string;
  /** 默认禁止外网(P0-A A4);true = 使用已验证的 egress 桥接网络(未验证 ⇒ FAIL-CLOSED) */
  allowEgressNetwork?: boolean;
}

export interface CheckResult {
  passed: boolean;
  rawOutput: string;
  env: EvidenceEnv;
}

/** 检查执行中止旗标(可选;翻转 ⇒ runner 终止整个执行进程组,P0-A A4)。 */
export interface CheckAbortSignal {
  cancelled: boolean;
}

/**
 * 检查执行器端口(P0-A A1/A2):候选功能检查的**唯一**执行面,由 runtime 注入
 * (生产 = docker 沙箱执行器;测试可注入确定性 stub)。core 不 import runtime(分层不变)。
 * 语义契约:未注入/沙箱不可用/配置越权 ⇒ FAIL-CLOSED(检查按失败处理,绝不退回宿主执行);
 * 证据 env 如实记录执行面(docker/沙箱事实),供 A7 绑定与审计。
 */
export type CheckRunner = (
  spec: CheckSpec,
  workspaceDir: string,
  opts?: { abortSignal?: CheckAbortSignal },
) => Promise<CheckResult>;

/** FAIL-CLOSED 默认 runner(P0-A A6):执行器未注入 ⇒ 检查失败(绝不以 Worker 宿主权限执行)。 */
export const failClosedCheckRunner: CheckRunner = (spec) => {
  return Promise.resolve({
    passed: false,
    rawOutput: [
      `$ ${spec.command.join(" ")}`,
      "[exit=SANDBOX_RUNNER_UNAVAILABLE] 检查执行器未注入:候选功能检查不得以 Worker 宿主权限执行" +
        "(RELAY-CONTROL-SAFETY-04 P0-A fail-closed);请配置沙箱执行器后重验",
    ].join("\n"),
    env: workerEnv("sandbox-fail-closed", {
      command: spec.command.join(" "),
      note: "CheckRunner 未注入 ⇒ FAIL-CLOSED,未执行任何宿主命令",
    }),
  });
};

/** 执行检查并落库(绑定当前 attempt/candidate_sha;runner 必经 CheckRunner 端口)。 */
export async function collectCheckEvidence(
  exec: Exec,
  spec: CheckSpec & { taskId: string; attempt: number; candidateSha: string; producedBy: string },
  workspaceDir: string,
  runner: CheckRunner = failClosedCheckRunner,
  opts: { abortSignal?: CheckAbortSignal } = {},
): Promise<EvidenceRow & { rawOutput: string; env: EvidenceEnv }> {
  const result = await runner(spec, workspaceDir, opts);
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
