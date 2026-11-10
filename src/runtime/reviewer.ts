// 独立 Reviewer Run(P0-02A C-2;CONSTRUCTION_PLAN P0-02A "独立 Reviewer")。
// 与 Coder Run 的隔离铁律:
// - **独立 Run**:独立 Pi RPC 会话 + 独立沙箱 HOME;runs 行 role=reviewer(Gate 绑定校验身份);
// - **独立上下文**:输入 = 需求 + 变更集清单 + 证据摘要,**不含 Coder Handoff 叙事**;
// - **只读策略**:relay_exec 白名单为空(禁 exec),仅 relay_read —— Reviewer 物理上不可写候选;
// - 模型调用经同一 budget_ledger 预留/核算(与 Coder 同账本);回合硬顶同样生效;
// - 验证租约心跳由本执行器代持(编排方注入 heartbeatFn);连续异常 ⇒ 杀 Pi、ok:false(止损)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { RelayDb, Exec } from "../core/db.ts";
import { appendAudit } from "../core/audit.ts";
import { reserveBudget, settleBudget } from "../core/budget.ts";
import type { GateVerdict } from "../core/gates.ts";
import {
  prepareRunDirs,
  launchPi,
  sandboxPaths,
  newRunId,
  type ModelConfig,
  type SandboxSpec,
} from "./sandbox.ts";
import type { EgressStatus } from "./egress.ts";
import type { PiInstallation } from "./pi-version.ts";
import { PiRpcSession } from "./pi-rpc.ts";
import { buildReviewerPrompt, parseGateVerdict } from "./gate-verdict.ts";
import { contextDigest } from "./context.ts";

export interface ReviewerSpec {
  taskId: string;
  attempt: number;
  goalText: string;
  changeset: {
    candidateSha: string;
    changedFiles: Record<string, string[]>;
  };
  evidenceSummaries: Array<{ id: string; kind: string; passed: boolean }>;
  model: ModelConfig;
  sandbox: "docker" | "host-fallback";
  egress?: EgressStatus;
  /** 验证租约心跳(编排方注入:heartbeatVerificationLease);连续 ≥2 异常 ⇒ 止损 */
  heartbeatFn?: (tx: Exec) => Promise<{ ok: boolean; reason?: string }>;
  heartbeatSeconds: number;
  wallSeconds: number;
  budget?: { goalId: string; reserveCallsPerRun?: number };
  execTimeoutMs?: number;
  /** 测试注入口:stub RPC argv/env(仅 host-fallback;正式路径禁用) */
  argvOverride?: string[];
  envOverride?: Record<string, string>;
  /**
   * 复用已有候选工作区(Reviewer 必须检查 Coder 的候选,而非自己的空沙箱)。
   * 沙箱 HOME/ext 仍一次性;workspace 指向该目录;cleanupSandbox 只删 runDir,不影响候选。
   */
  workspaceDirOverride?: string;
}

export interface ReviewerResult {
  ok: boolean;
  reason?: string;
  verdict?: GateVerdict;
  findings?: string;
  rawOutput: string;
  reviewerRunId: string;
  sandboxSpec?: SandboxSpec;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function raceExit(session: PiRpcSession, ms: number): Promise<void> {
  await Promise.race([session.exited, sleep(ms)]);
}

/**
 * 执行一次独立 Reviewer Run。任务状态不由本函数推进(VERIFYING 由编排方消费裁决时推进)。
 * 返回 ok=false 时 reason 指明失败面:budget_exhausted / lease_lost / heartbeat_errors /
 * rpc_disconnect / no_verdict / runner_error —— 编排方据此走有界重试或 NEEDS_DECISION。
 */
export async function runReviewerSession(db: RelayDb, pi: PiInstallation, spec: ReviewerSpec): Promise<ReviewerResult> {
  const runId = newRunId();
  const reserveCalls = spec.budget?.reserveCallsPerRun ?? 2;
  const reviewerLeaseHeartbeat = spec.heartbeatFn;

  // 0) 预算预留(FAIL-CLOSED;与 Coder 同 goal 账本)
  let ledgerId: string | null = null;
  if (spec.budget) {
    const reserve = await db.transaction(async (tx) =>
      reserveBudget(tx as unknown as Exec, {
        kind: "model_calls",
        amount: reserveCalls,
        scopeType: "goal",
        scopeId: spec.budget!.goalId,
        taskScope: { scopeType: "task", scopeId: spec.taskId },
      }),
    );
    if (!reserve.ok) {
      await db
        .transaction(async (tx) =>
          (tx as unknown as Exec).execute(sql`
            INSERT INTO runs (id, task_id, attempt, runtime, model_ref, budget, sandbox, outcome, detail)
            VALUES (${runId}, ${spec.taskId}, ${spec.attempt}, 'pi-rpc',
              ${spec.model.provider + "/" + spec.model.model},
              ${JSON.stringify({ role: "reviewer", reason: reserve.reason })}::jsonb,
              ${spec.sandbox}, 'BUDGET_EXHAUSTED', '{"role":"reviewer"}'::jsonb)
          `),
        )
        .catch(() => {});
      return { ok: false, reason: "budget_exhausted", rawOutput: "", reviewerRunId: runId };
    }
    ledgerId = reserve.ledgerId!;
  }

  // 1) run 行(role=reviewer 身份锚;Gate 绑定校验 detail->>'role')
  await db.transaction(async (tx) =>
    (tx as unknown as Exec).execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, budget, sandbox, outcome)
      VALUES (${runId}, ${spec.taskId}, ${spec.attempt}, 'pi-rpc',
        ${spec.model.provider + "/" + spec.model.model},
        ${JSON.stringify({ role: "reviewer", reserveCalls })}::jsonb,
        ${spec.sandbox}, 'RUNNING')
    `),
  );

  // 2) 沙箱(独立 HOME;models.json 仅占位 key —— 密钥隔离,P0-02A C-8)。
  //    workspaceDirOverride:Reviewer 直接检查 Coder 候选工作区(共享挂载;cleanup 只删本 RunDir)
  const sandboxSpec = prepareRunDirs(tmpdir(), spec.sandbox, spec.model);
  if (spec.workspaceDirOverride) {
    sandboxSpec.workspaceDir = spec.workspaceDirOverride;
    execFileSync("chmod", ["-R", "o+rwX", sandboxSpec.workspaceDir], { timeout: 30_000 });
  }
  const paths = sandboxPaths(sandboxSpec);
  const prompt = buildReviewerPrompt({
    taskId: spec.taskId,
    attempt: spec.attempt,
    goalText: spec.goalText,
    changedFiles: spec.changeset.changedFiles,
    candidateSha: spec.changeset.candidateSha,
    evidenceSummaries: spec.evidenceSummaries,
    workspacePath: paths.workspace,
  });
  await db
    .transaction(async (tx) =>
      (tx as unknown as Exec).execute(sql`
        INSERT INTO sessions (id, run_id, checkpoint_ref, handoff_ref, context_digest, resume_mode)
        VALUES (${"sess-" + randomUUID()}, ${runId}, NULL,
          ${JSON.stringify({ role: "reviewer" })}::jsonb, ${contextDigest(prompt)}, 'fresh')
      `),
    )
    .catch(() => {});

  let session: PiRpcSession | null = null;
  let outcome: "SUCCEEDED" | "FAILED" | "TIMEOUT" | "INTERRUPTED" | "BUDGET_EXHAUSTED" = "FAILED";
  let reason = "runner_error";
  let hbErrorStreak = 0;
  const hbTimer = reviewerLeaseHeartbeat
    ? setInterval(() => {
        void db
          .transaction(async (tx) => reviewerLeaseHeartbeat!(tx as unknown as Exec))
          .then((r) => {
            hbErrorStreak = 0;
            if (!r.ok) {
              reason = "lease_lost";
              session?.kill("SIGKILL"); // 验证租约失效:Reviewer 立即止损,无权继续
            }
          })
          .catch(() => {
            hbErrorStreak += 1;
            if (hbErrorStreak >= 2) {
              reason = "heartbeat_errors";
              session?.kill("SIGKILL");
            }
          });
      }, spec.heartbeatSeconds * 1000)
    : null;

  try {
    session = launchPi({
      spec: sandboxSpec,
      pi,
      model: spec.model,
      egress: spec.egress,
      allowedCommands: [], // Reviewer 只读:禁一切 exec
      execTimeoutMs: spec.execTimeoutMs,
      argvOverride: spec.argvOverride,
      envOverride: spec.envOverride,
    });
    await session.request("get_state", undefined, 20_000);
    await session.prompt(prompt);

    const deadline = Date.now() + spec.wallSeconds * 1000;
    let settled = false;
    const countTurns = () =>
      session!.allRecords().filter((r) => r.type === "message_end" && r.message?.role === "assistant").length;
    for (;;) {
      if (session.allRecords().some((r) => r.type === "agent_settled")) {
        settled = true;
        break;
      }
      if (reason !== "runner_error") break; // 止损触发
      if (countTurns() >= reserveCalls) {
        session.kill("SIGKILL");
        await raceExit(session, 3000);
        outcome = "BUDGET_EXHAUSTED";
        reason = "budget_turns_cap";
        break;
      }
      if (Date.now() >= deadline) {
        session.kill("SIGKILL");
        await raceExit(session, 3000);
        outcome = "TIMEOUT";
        reason = "wall_budget_exceeded";
        break;
      }
      if (session.exitStatus !== null) {
        outcome = "FAILED";
        reason = "rpc_disconnect";
        break;
      }
      await sleep(100);
    }

    const rawOutput = session.assistantText();
    let parsed = parseGateVerdict("");
    if (settled) {
      parsed = parseGateVerdict(rawOutput);
      if (parsed.found) {
        outcome = "SUCCEEDED";
        reason = parsed.verdict;
      } else {
        outcome = "FAILED";
        reason = `no_verdict:${parsed.error}`;
      }
    } else if (reason === "runner_error" && session.exitStatus !== null) {
      outcome = "FAILED";
      reason = "rpc_disconnect";
    }

    const turns = countTurns();
    await db
      .transaction(async (tx) =>
        (tx as unknown as Exec).execute(sql`
          UPDATE runs SET outcome = ${outcome},
            detail = ${JSON.stringify({ role: "reviewer", turns, reason, verdict: parsed.found ? parsed.verdict : null })}::jsonb,
            ended_at = now()
          WHERE id = ${runId}
        `),
      )
      .catch(() => {});
    if (ledgerId) {
      await db
        .transaction(async (tx) =>
          settleBudget(tx as unknown as Exec, ledgerId!, { reservedAmount: reserveCalls, actualAmount: Math.max(turns, 1) }),
        )
        .catch(() => {});
    }
    await appendAuditSafe(db, spec, runId, outcome, reason, turns);

    if (outcome !== "SUCCEEDED") {
      return { ok: false, reason, rawOutput, reviewerRunId: runId, sandboxSpec };
    }
    return {
      ok: true,
      verdict: parsed.found ? parsed.verdict : undefined,
      findings: parsed.found ? parsed.findings : undefined,
      rawOutput,
      reviewerRunId: runId,
      sandboxSpec,
    };
  } catch (e) {
    session?.kill("SIGKILL");
    const msg = (e as Error).message ?? "unknown";
    await db
      .transaction(async (tx) =>
        (tx as unknown as Exec).execute(sql`
          UPDATE runs SET outcome = 'FAILED',
            detail = ${JSON.stringify({ role: "reviewer", reason: "runner_error", error: msg })}::jsonb,
            ended_at = now()
          WHERE id = ${runId}
        `),
      )
      .catch(() => {});
    if (ledgerId) {
      await db
        .transaction(async (tx) =>
          settleBudget(tx as unknown as Exec, ledgerId!, { reservedAmount: reserveCalls, actualAmount: 1 }),
        )
        .catch(() => {});
    }
    await appendAuditSafe(db, spec, runId, "FAILED", `runner_error:${msg}`, 0);
    return { ok: false, reason: `runner_error:${msg}`, rawOutput: "", reviewerRunId: runId, sandboxSpec };
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    session?.kill("SIGKILL"); // 幂等
  }
}

async function appendAuditSafe(
  db: RelayDb,
  spec: ReviewerSpec,
  runId: string,
  outcome: string,
  reason: string,
  turns: number,
): Promise<void> {
  try {
    await db.transaction(async (tx) =>
      appendAudit(tx as unknown as Exec, {
        actor: "reviewer-run",
        authority: "GATE",
        action: `REVIEWER_RUN_${outcome}`,
        taskId: spec.taskId,
        detail: { runId, outcome, reason, turns, attempt: spec.attempt },
      }),
    );
  } catch {
    /* 尽力而为 */
  }
}
