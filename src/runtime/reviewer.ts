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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayDb, Exec } from "../core/db.ts";
import { appendAudit } from "../core/audit.ts";
import { reserveBudget, settleBudget } from "../core/budget.ts";
import type { GateVerdict } from "../core/gates.ts";
import {
  prepareRunDirs,
  launchPi,
  sandboxPaths,
  newRunId,
  appliedMaxOutputTokens,
  type ModelConfig,
  type SandboxSpec,
} from "./sandbox.ts";
import { rewriteBaseUrlForContainer, verifyEgressRules, type EgressStatus } from "./egress.ts";
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
  // docker 分支:模型 baseUrl 必须指向宿主出口代理(与 runner 同款重写;FAIL-CLOSED 校验同款)。
  // 实测坑(772eb0c 后首跑):缺此重写 ⇒ 容器内连自身 loopback → pi auto_retry×3 → stopReason=error。
  let model = spec.model;
  if (spec.sandbox === "docker") {
    const eg = spec.egress;
    if (!eg?.ok || !eg.subnet || !eg.hostIp || !eg.modelPort || !verifyEgressRules(eg.subnet, eg.hostIp, eg.modelPort)) {
      return { ok: false, reason: "egress_rules_missing", rawOutput: "", reviewerRunId: runId };
    }
    model = { ...spec.model, baseUrl: rewriteBaseUrlForContainer(spec.model.baseUrl, eg) };
  }

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
              ${model.provider + "/" + model.model},
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
        ${model.provider + "/" + model.model},
        ${JSON.stringify({
          role: "reviewer",
          reserveCalls,
          // R2-REMEDIATION-01:最终采用值与来源入 Evidence(与 coder run 同口径)
          maxOutputTokens: appliedMaxOutputTokens(model),
          maxOutputTokensSource: model.maxOutputTokens === undefined ? "default" : "config",
        })}::jsonb,
        ${spec.sandbox}, 'RUNNING')
    `),
  );

  // 2) 沙箱(独立 HOME;models.json 仅占位 key —— 密钥隔离,P0-02A C-8)。
  //    workspaceDirOverride:Reviewer 直接检查 Coder 候选工作区(共享挂载;cleanup 只删本 RunDir)
  const sandboxSpec = prepareRunDirs(tmpdir(), spec.sandbox, model);
  if (spec.workspaceDirOverride) {
    // 共享候选工作区:权限面已由 runner 建好(目录 o+rwX;容器 UID 写入的文件不重 chmod——
    // 宿主非属主无权 chmod,Reviewer 只读候选,无需改权)
    sandboxSpec.workspaceDir = spec.workspaceDirOverride;
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
    turnBudget: reserveCalls,
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
    // G-4:docker 模式对共享候选工作区强制 FS 级只读挂载(prompt 级禁令之外的 OS 层强制);
    // 该标志同时决定工具审计落点(HOME 或工作区),读回时用同一判定(避免"假缺失")。
    const workspaceReadOnly = spec.sandbox === "docker" && Boolean(spec.workspaceDirOverride);
    const live: PiRpcSession = launchPi({
      spec: sandboxSpec,
      pi,
      model,
      egress: spec.egress,
      allowedCommands: [], // Reviewer 只读:禁一切 exec
      workspaceReadOnly,
      execTimeoutMs: spec.execTimeoutMs,
      argvOverride: spec.argvOverride,
      envOverride: spec.envOverride,
    });
    session = live;
    await live.request("get_state", undefined, 20_000);
    await session.prompt(prompt);

    const deadline = Date.now() + spec.wallSeconds * 1000;
    let settled = false;
    const countTurns = () =>
      live.allRecords().filter((r) => r.type === "message_end" && r.message?.role === "assistant").length;
    for (;;) {
      if (live.allRecords().some((r) => r.type === "agent_settled")) {
        settled = true;
        break;
      }
      if (reason !== "runner_error") break; // 止损触发
      if (countTurns() >= reserveCalls) {
        live.kill("SIGKILL");
        await raceExit(live, 3000);
        outcome = "BUDGET_EXHAUSTED";
        reason = "budget_turns_cap";
        break;
      }
      if (Date.now() >= deadline) {
        live.kill("SIGKILL");
        await raceExit(live, 3000);
        outcome = "TIMEOUT";
        reason = "wall_budget_exceeded";
        break;
      }
      if (live.exitStatus !== null) {
        outcome = "FAILED";
        reason = "rpc_disconnect";
        break;
      }
      await sleep(100);
    }

    const turns = countTurns();
    let rawOutput = live.assistantText();
    let parsed = parseGateVerdict("");
    if (settled) {
      parsed = parseGateVerdict(rawOutput);
      if (!parsed.found) {
        // 兜底:assistant 文本块为空时(实测:auto_retry 后 content 形态异常),扫描
        // assistant message_end 的原始 JSON(还原转义换行)找裁决围栏 —— 仍是模型自述,非虚构。
        const dump = live
          .allRecords()
          .filter((r) => r.type === "message_end" && (r.message as { role?: string } | undefined)?.role === "assistant")
          .map((r) => JSON.stringify(r.message ?? {}).replace(/\\n/g, "\n"))
          .join("\n");
        parsed = parseGateVerdict(dump);
        if (parsed.found) {
          rawOutput = dump;
        } else if (!rawOutput) {
          rawOutput = dump.slice(0, 2000); // 如实保留原始面供审计(不虚构)
        }
      }
      if (parsed.found) {
        outcome = "SUCCEEDED";
        reason = parsed.verdict;
      } else {
        outcome = "FAILED";
        reason = `no_verdict:${parsed.error}`;
      }
    } else if (reason === "runner_error" && live.exitStatus !== null) {
      outcome = "FAILED";
      reason = "rpc_disconnect";
    }

    // Worker 侧可观测:失败时记录记录面事实(回合数/原文长度/事件类型/stderr 尾),不虚构输出
    const recordTypes = session.allRecords().reduce<Record<string, number>>((acc, r) => {
      const k = String(r.type ?? "?");
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    // G-4 后 Reviewer 的工具审计落在一次性 HOME(/pihome)而非候选面(候选面只读)。
    // 该文件随 run 目录消亡 ⇒ 在此读回并摘要入 runs.detail(否则 Worker 侧看不到 Reviewer 的工具决策)。
    const toolAudit = readReviewerToolAudit(sandboxSpec, workspaceReadOnly);
    await db
      .transaction(async (tx) =>
        (tx as unknown as Exec).execute(sql`
          UPDATE runs SET outcome = ${outcome},
            detail = ${JSON.stringify({
              role: "reviewer",
              turns,
              reason,
              verdict: parsed.found ? parsed.verdict : null,
              rawLen: rawOutput.length,
              rawHead: rawOutput.slice(0, 300),
              recordTypes,
              ...(toolAudit ? { toolAudit } : {}),
              stderrTail: live.stderrText ? live.stderrText.slice(-400) : undefined,
            })}::jsonb,
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

/**
 * 读回 Reviewer 的工具审计摘要(G-4:只读候选面 ⇒ 审计落在一次性 HOME /pihome;
 * 非只读场景 ⇒ 审计落在工作区 .relay)。
 * 路径判定与启动参数一致(workspaceReadOnly 决定 RELAY_TOOL_AUDIT 指向),避免"假缺失"。
 * 返回 {lines, denied, reasons, missing} —— 让 Worker/运维在看板上看到 Reviewer 读了什么、被拒了什么;
 * 文件缺失时显式标记 missing=true(不静默吞掉可观测性缺口)。
 */
function readReviewerToolAudit(
  spec: SandboxSpec,
  workspaceReadOnly: boolean,
): { lines: number; denied: number; reasons: string[]; missing?: boolean } | null {
  const path = workspaceReadOnly
    ? join(spec.homeDir, "tool-audit.jsonl") // RELAY_TOOL_AUDIT=/pihome/tool-audit.jsonl → 宿主 homeDir
    : join(spec.workspaceDir, ".relay", "tool-audit.jsonl"); // 常规:工作区内审计
  try {
    if (!existsSync(path)) return { lines: 0, denied: 0, reasons: [], missing: true };
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const denied: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { tool?: string; denied?: boolean; reason?: string };
        if (obj.denied === true) denied.push(`${obj.tool ?? "?"}:${obj.reason ?? "unknown"}`);
      } catch {
        /* 单行损坏不影响摘要 */
      }
    }
    return { lines: lines.length, denied: denied.length, reasons: denied.slice(0, 10) };
  } catch {
    return { lines: 0, denied: 0, reasons: [], missing: true };
  }
}
