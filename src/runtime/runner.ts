// Run 生命周期执行器(P0-01B 合同条款 4/5)。
// 职责:在持有租约(fencing)的前提下驱动一个 Pi RPC Run,并把结果落库。
// 边界:
// - Run 成功 != 任务 ACCEPTED;本执行器最多推进到 VERIFYING,VERIFYING->ACCEPTED 必须过 Gate(V08)。
// - 心跳续租被拒(租约失效)⇒ 立即终止 Pi 子进程并停止推进 —— 失效 Run 不再产生副作用。
// - 超时/取消:终止 Pi 子进程,run 落 TIMEOUT/CANCELLED,任务按合法转移推进(有租约时)。
// - 恢复 = 从 DB 重建上下文(resume_mode=context_rebuild),不假装恢复模型内部状态。
// - 沙箱目录的清理属调用方(runner 不删,保证测试/生产先收集 tool-audit 证据)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RelayDb, Exec } from "../core/db.ts";
import { appendAudit } from "../core/audit.ts";
import { advanceTask, heartbeat } from "../core/lease.ts";
import type { TaskState } from "../core/lifecycle.ts";
import {
  prepareRunDirs,
  launchPi,
  sandboxPaths,
  newRunId,
  dockerAvailable,
  budgetEvidence,
  type ModelConfig,
  type SandboxSpec,
} from "./sandbox.ts";
import { detectHostIp, rewriteBaseUrlForContainer, verifyEgressRules, type EgressStatus } from "./egress.ts";
import type { PiInstallation } from "./pi-version.ts";
import { PiRpcSession, type PiSpawnOptions, type RpcRecord } from "./pi-rpc.ts";
import { buildRunPrompt, contextDigest, parseHandoff, type Handoff, type HandoffParse } from "./context.ts";
import { reserveBudget, settleBudget, releaseBudget } from "../core/budget.ts";
import { recordChangeset, bindCandidateCommit } from "../core/changesets.ts";
import { snapshotManifest } from "./workspace-manifest.ts";
import { createCandidateCommit, GitCandidateError } from "./git-candidate.ts";

export type RunOutcome = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CANCELLED" | "INTERRUPTED" | "BUDGET_EXHAUSTED";

export interface RunSpec {
  taskId: string;
  goal: string;
  allowedScope: readonly string[];
  /** relay_exec 命令白名单(透传 task.allowed_commands;缺省 = 禁 exec) */
  allowedCommands?: readonly string[];
  attempt: number;
  ownerId: string;
  fencingToken: number;
  model: ModelConfig;
  sandbox: "docker" | "host-fallback";
  /** 出口约束状态(docker 必需;executeRun 内核验并改写 baseUrl 为宿主出口 IP) */
  egress?: EgressStatus;
  /** 预算账本(goal 级 model_calls 必须有带 limit 的行,FAIL-CLOSED);缺省 = 不走账本(仅测试) */
  budget?: {
    goalId: string;
    /** 每 Run 预留的模型请求数(实际按 assistant 回合核算;超出部分如实入账并标 overshoot) */
    reserveCallsPerRun?: number;
    tokenReserveIn?: number;
    tokenReserveOut?: number;
  };
  /** wall-clock 预算(秒):到点终止 Pi,run=TIMEOUT */
  wallSeconds: number;
  /** 心跳间隔(秒);租约 TTL = 3×interval(interval = TTL/3) */
  heartbeatSeconds: number;
  execTimeoutMs?: number;
  /** 恢复 Run 的重建上下文(来自上一 run 的 session 行) */
  priorHandoff?: { runId: string; handoff: Handoff | null } | null;
  extraInstructions?: string;
  /** 取消信号(轮询;置 true ⇒ SIGTERM→SIGKILL,run=CANCELLED) */
  cancelSignal?: { cancelled: boolean };
  /** 工作区种子(宿主侧,prepareRunDirs 后、启动前调用;任务初始化/测试预置) */
  prepareWorkspace?: (workspaceDir: string) => void;
  /** 心跳函数注入口(默认真实 heartbeat;故障注入测试用) */
  heartbeatFn?: (tx: Exec) => Promise<{ ok: boolean; reason?: string }>;
  /** 测试注入口:stub RPC argv/env(仅 host-fallback 语义;正式路径禁用) */
  argvOverride?: string[];
  envOverride?: Record<string, string>;
  onRecord?: PiSpawnOptions["onRecord"];
  /** P0-02B D-2:交付绑定的任务必须提供 stage 根目录(候选 commit 在此构建,独立于 run 目录)。
   * 缺省 = 不构建候选 commit(git_* 列为 null ⇒ Proposal 拒绝 no_commit_binding)。 */
  deliveryStaging?: { baseDir: string };
}

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  handoff: HandoffParse;
  toolAuditPath: string;
  toolCallEvents: number;
  detail: Record<string, unknown>;
  /** 沙箱目录(证据收集后由调用方 cleanupSandbox) */
  sandboxSpec: SandboxSpec;
  /** 候选变更集(SUCCEEDED 时由 Worker 侧记录;失败路径无候选) */
  changesetId: string | null;
  /** P0-02B D-2:候选 commit stage 仓库宿主路径(交付绑定任务且构建成功时存在) */
  candidateStageRepoDir?: string;
}

async function insertRun(exec: Exec, spec: RunSpec, model: ModelConfig, runId: string, sandbox: SandboxSpec): Promise<void> {
  await exec.execute(sql`
    INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, sandbox, outcome)
    VALUES (${runId}, ${spec.taskId}, ${spec.attempt}, 'pi-rpc',
      ${model.provider + "/" + model.model},
      ${detectInputCommitSha(sandbox.workspaceDir)},
      ${JSON.stringify({
        wallSeconds: spec.wallSeconds,
        // R2-REMEDIATION-01:Evidence 记录最终采用值与来源(默认/配置);Run 全程可审计
        // (READINESS-01 子包②:两字段单一来源=budgetEvidence,三口径同源)
        ...budgetEvidence(model),
      })}::jsonb,
      ${sandbox.mode}, 'RUNNING')
  `);
}

function detectInputCommitSha(workspaceDir: string): string | null {
  const head = join(workspaceDir, ".git", "HEAD");
  if (!existsSync(head)) return null;
  try {
    const ref = readFileSync(head, "utf8").trim();
    if (ref.startsWith("ref: ")) {
      const refPath = join(workspaceDir, ".git", ref.slice(5));
      return existsSync(refPath) ? readFileSync(refPath, "utf8").trim() : null;
    }
    return ref || null;
  } catch {
    return null;
  }
}

/** Run 前记录的输入 commit(runs.input_commit_sha)——候选 commit 的权威 base(P0-02B F-5)。 */
async function loadInputCommitSha(db: RelayDb, runId: string): Promise<string | null> {
  try {
    const res = await db.execute(sql`SELECT input_commit_sha FROM runs WHERE id = ${runId}`);
    const v = res.rows[0]?.["input_commit_sha"];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function updateRun(
  exec: Exec,
  runId: string,
  outcome: RunOutcome,
  detail: Record<string, unknown>,
): Promise<void> {
  await exec.execute(sql`
    UPDATE runs SET outcome = ${outcome}, detail = ${JSON.stringify(detail)}::jsonb,
      ended_at = now()
    WHERE id = ${runId}
  `);
}

async function insertSession(
  exec: Exec,
  runId: string,
  resumeMode: "fresh" | "context_rebuild",
  digest: string,
  handoffRef: Record<string, unknown>,
): Promise<void> {
  await exec.execute(sql`
    INSERT INTO sessions (id, run_id, checkpoint_ref, handoff_ref, context_digest, resume_mode)
    VALUES (${"sess-" + randomUUID()}, ${runId}, NULL,
      ${JSON.stringify(handoffRef)}::jsonb, ${digest}, ${resumeMode})
  `);
}

/** 读取最新 session(供恢复 Run 构建重建上下文)。 */
export async function latestSession(
  db: RelayDb,
  taskId: string,
): Promise<{ runId: string; handoff: Handoff | null; resumeMode: string } | null> {
  const res = await db.execute(sql`
    SELECT s.run_id, s.handoff_ref, s.resume_mode FROM sessions s
    JOIN runs r ON r.id = s.run_id
    WHERE r.task_id = ${taskId}
    ORDER BY r.started_at DESC, s.created_at DESC
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return null;
  const ref = row["handoff_ref"] as Record<string, unknown> | null;
  return {
    runId: String(row["run_id"]),
    handoff: (ref?.["handoff"] as Handoff | undefined) ?? null,
    resumeMode: String(row["resume_mode"]),
  };
}

/**
 * 执行一个 Run(调用方已持有租约;LEASED→RUNNING 的 advance 由本函数完成)。
 * 返回时 run 行/session 行已落库;成功路径任务推进 SUBMITTED→VERIFYING。
 * 心跳被拒 ⇒ INTERRUPTED,不做任何任务推进(无权威)。
 */
export async function executeRun(db: RelayDb, pi: PiInstallation, spec: RunSpec): Promise<RunResult> {
  // docker 路径:出口白名单必须已建立(FAIL-CLOSED);baseUrl 指向宿主的 localhost 须改写为出口 IP
  let model = spec.model;
  if (spec.sandbox === "docker") {
    const eg = spec.egress;
    if (!eg?.ok || !eg.subnet || !eg.hostIp || !eg.modelPort || !verifyEgressRules(eg.subnet, eg.hostIp, eg.modelPort)) {
      throw new Error("egress_rules_missing:docker Run 需先 ensureEgress+verify,FAIL-CLOSED");
    }
    // localhost → 宿主出口 IP;端口 → 代理端口(共享重写助手;Review Run 同款,reviewer.ts)
    model = { ...spec.model, baseUrl: rewriteBaseUrlForContainer(spec.model.baseUrl, eg) };
  }
  const runId = newRunId();
  const sandboxSpec = prepareRunDirs(tmpdir(), spec.sandbox, model);
  spec.prepareWorkspace?.(sandboxSpec.workspaceDir);
  // 种子文件须对容器 SANDBOX_UID 可读/可写(宿主 umask 可能 660)
  execFileSync("chmod", ["-R", "o+rwX", sandboxSpec.workspaceDir], { timeout: 30_000 });
  // 候选基线快照(种子后的工作区 = 变更基线;Run 结束后再快照对比,P0-02A C-1)
  const baseManifest = snapshotManifest(sandboxSpec.workspaceDir);
  let changesetId: string | null = null;
  let session: PiRpcSession | null = null;
  let outcome: RunOutcome = "FAILED";
  let detail: Record<string, unknown> = {};
  let handoff: HandoffParse = { found: false, error: "absent" };
  // Worker 侧工具事件(可信持久化源):RPC 事件流的 tool_call 原文,与 workspace 内
  // 可被模型改写的 tool-audit.jsonl 互为印证;后者仅辅助(P0-01C C-1)。
  const toolEvents: RpcRecord[] = [];
  const onRecord: PiSpawnOptions["onRecord"] = (r) => {
    if (String(r.type ?? "").includes("tool")) toolEvents.push(r);
    spec.onRecord?.(r);
  };

  // 止损状态:lease_lost(业务拒绝=权威已失)/ heartbeat_errors(DB 连续异常=权威不可验证)。
  // 两者都 ⇒ 立即终止 Pi 且不做任何任务推进;后者由 Supervisor 过期回收收尾(TTL 有界)。
  let abortReason: "lease_lost" | "heartbeat_errors" | null = null;
  let hbErrorStreak = 0;
  const hbTimer = setInterval(() => {
    void Promise.resolve()
      .then(() => {
        const hb = spec.heartbeatFn ?? ((tx: Exec) => heartbeat(tx, spec.taskId, spec.ownerId, spec.fencingToken, spec.heartbeatSeconds * 3));
        return db.transaction(async (tx) => hb(tx as unknown as Exec));
      })
      .then((r) => {
        hbErrorStreak = 0;
        if (!r.ok) {
          abortReason = "lease_lost";
          session?.kill("SIGKILL"); // 失效 Run 止损:立即终止 Pi(租约已失,无权推进任务)
        }
      })
      .catch((e: Error) => {
        // 心跳事务本身失败(DB 抖动/连接断):权威不可验证,P0-01C 合同要求连续失败即停。
        hbErrorStreak += 1;
        hbLastError = e.message;
        if (hbErrorStreak >= 2) {
          abortReason = "heartbeat_errors";
          session?.kill("SIGKILL");
        }
      });
  }, spec.heartbeatSeconds * 1000);
  let hbLastError: string | undefined = undefined;
  let ledgerId: string | null = null;
  let reservedCalls = 0;
  const tokenLedgers: Array<{ ledgerId: string; reserved: number; kind: "tokens_in" | "tokens_out" }> = [];

  try {
    // 1) LEASED -> RUNNING(租约权威内)
    const adv = await db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "LEASED", "RUNNING"),
    );
    if (!adv.ok) throw new Error(`advance to RUNNING rejected: ${adv.reason}`);

    // 1.5) 预算预留(FAIL-CLOSED):model_calls 无带 limit 的账本行或超限 ⇒ 不启动 Pi,
    //      任务 RUNNING→BLOCKED(budget_exhausted),run 行如实落 BUDGET_EXHAUSTED。
    if (spec.budget) {
      const reserveAmount = spec.budget.reserveCallsPerRun ?? 4;
      const reserve = await db.transaction(async (tx) =>
        reserveBudget(tx as unknown as Exec, {
          kind: "model_calls", amount: reserveAmount,
          scopeType: "goal", scopeId: spec.budget!.goalId,
          taskScope: { scopeType: "task", scopeId: spec.taskId },
        }),
      );
      if (!reserve.ok) {
        await db.transaction(async (tx) => insertRun(tx as unknown as Exec, spec, model, runId, sandboxSpec));
        await db.transaction(async (tx) =>
          advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "RUNNING", "BLOCKED"),
        );
        outcome = "BUDGET_EXHAUSTED";
        detail = { reason: reserve.reason, ledgerId: reserve.ledgerId };
        // 落库与审计统一由 finally 完成(此处 return,finally 写 BUDGET_EXHAUSTED)
        return {
          runId, outcome, handoff,
          toolAuditPath: join(sandboxSpec.workspaceDir, ".relay", "tool-audit.jsonl"),
          toolCallEvents: 0, detail,
          sandboxSpec,
          changesetId: null,
        };
      }
      ledgerId = reserve.ledgerId!;
      reservedCalls = spec.budget.reserveCallsPerRun ?? 4;
      // tokens 预留(有行才限流,无行跳过):保守默认 50k(FAIL-CLOSED 方向);
      // 预算极紧的调用方显式传 tokenReserveIn/Out 调低。
      for (const [kind, amount] of [["tokens_in", spec.budget.tokenReserveIn ?? 50_000], ["tokens_out", spec.budget.tokenReserveOut ?? 50_000]] as const) {
        if (amount <= 0) continue;
        const tr = await db.transaction(async (tx) =>
          reserveBudget(tx as unknown as Exec, {
            kind, amount,
            scopeType: "goal", scopeId: spec.budget!.goalId,
            taskScope: { scopeType: "task", scopeId: spec.taskId },
          }),
        );
        if (tr.ok && tr.ledgerId) tokenLedgers.push({ ledgerId: tr.ledgerId, reserved: amount, kind });
      }
    }

    // 2) run 行落库(RUNNING)
    await db.transaction(async (tx) => insertRun(tx as unknown as Exec, spec, model, runId, sandboxSpec));

    // 3) 上下文与 prompt(恢复 Run 注入上一 handoff)
    const paths = sandboxPaths(sandboxSpec);
    const prompt = buildRunPrompt({
      taskId: spec.taskId,
      attempt: spec.attempt,
      goal: spec.goal,
      allowedScope: spec.allowedScope,
      workspacePath: paths.workspace,
      priorHandoff: spec.priorHandoff
        ? {
            runId: spec.priorHandoff.runId,
            resumeMode: "context_rebuild",
            handoff: spec.priorHandoff.handoff,
            note: "进程/会话状态不可恢复;仅以本记录重建认知。",
          }
        : null,
      extraInstructions: spec.extraInstructions,
    });
    const promptDigest = contextDigest(prompt);
    await db.transaction(async (tx) =>
      insertSession(tx as unknown as Exec, runId, spec.priorHandoff ? "context_rebuild" : "fresh", promptDigest, {
        priorRunId: spec.priorHandoff?.runId ?? null,
      }),
    );

    // 4) 启动 Pi(沙箱)+ 握手 + prompt
    session = launchPi({
      spec: sandboxSpec,
      pi,
      model,
      egress: spec.egress,
      allowedCommands: spec.allowedCommands,
      execTimeoutMs: spec.execTimeoutMs,
      argvOverride: spec.argvOverride,
      envOverride: spec.envOverride,
      onRecord,
    });
    await session.request("get_state", undefined, 20_000);
    await session.prompt(prompt);

    // 5) 等待终态:settled / 进程退出 / wall 预算 / 取消信号 / **回合硬顶(机器强制预算)**
    const deadline = Date.now() + spec.wallSeconds * 1000;
    let settled = false;
    const liveSession = session;
    const countAssistantTurns = () =>
      liveSession.allRecords().filter((r) => r.type === "message_end" && r.message?.role === "assistant").length;
    for (;;) {
      if (session.allRecords().some((r) => r.type === "agent_settled")) {
        settled = true;
        break;
      }
      if (abortReason) break;
      if (spec.budget && countAssistantTurns() >= (spec.budget.reserveCallsPerRun ?? 4)) {
        // 回合硬顶:预留数即本 Run 允许的 assistant 回合上限,达顶即终止(机械不可破,
        // 结算实际用量 ≤ 预留,账本上限不可能被单个 Run 突破)
        session.kill("SIGKILL");
        await raceExit(session, 3000);
        outcome = "BUDGET_EXHAUSTED";
        detail = {
          reason: "budget_turns_cap",
          cap: spec.budget.reserveCallsPerRun ?? 4,
          turns: countAssistantTurns(),
        };
        break;
      }
      if (spec.cancelSignal?.cancelled) {
        session.kill("SIGTERM");
        await raceExit(session, 2000);
        if (session.exitStatus === null) session.kill("SIGKILL");
        outcome = "CANCELLED";
        detail = { reason: "cancelled_by_caller" };
        break;
      }
      if (Date.now() >= deadline) {
        session.kill("SIGKILL");
        await raceExit(session, 3000);
        outcome = "TIMEOUT";
        detail = { reason: "wall_budget_exceeded", wallSeconds: spec.wallSeconds };
        break;
      }
      if (session.exitStatus !== null) {
        const exit = session.exitStatus;
        if (abortReason) {
          outcome = "INTERRUPTED";
          detail = { reason: abortReason, exit };
        } else {
          outcome = "FAILED";
          detail = { reason: "rpc_disconnect", exit };
        }
        break;
      }
      await sleep(100);
    }

    if (outcome === "FAILED") {
      if (abortReason && !settled) {
        // 等待循环内止损触发(IPC 断开即退出);确认子进程死透
        await raceExit(session, 3000);
        if (session.exitStatus === null) session.kill("SIGKILL");
        outcome = "INTERRUPTED";
        detail =
          abortReason === "heartbeat_errors"
            ? { reason: "heartbeat_errors", killedBy: "heartbeat_db_error_streak", lastError: hbLastError }
            : { reason: "lease_lost", killedBy: "heartbeat_rejection" };
      } else if (settled) {
        // settled:结构化 Handoff 解析(缺失/畸形如实记录,不虚构);结果回写 session 行
        handoff = parseHandoff(session.assistantText());
        await db
          .transaction(async (tx) => {
            await (tx as unknown as Exec).execute(sql`
              UPDATE sessions SET handoff_ref = ${JSON.stringify({
                priorRunId: spec.priorHandoff?.runId ?? null,
                handoff: handoff.found ? handoff.handoff : null,
                error: handoff.found ? null : handoff.error,
              })}::jsonb
              WHERE run_id = ${runId}
            `);
          })
          .catch(() => {});
        const audit = readToolAudit(sandboxSpec);
        const deniedCount = audit.filter((a) => a["denied"] === true).length;
        outcome = "SUCCEEDED";
        detail = {
          toolCallEvents: session.countToolCallEvents(),
          toolAuditLines: audit.length,
          toolDenied: deniedCount,
          // Worker 侧可信工具事件(RPC 事件流原文;workspace 文件仅辅助,P0-01C C-1)
          toolEvents: toolEvents.slice(0, 200),
          handoff: handoff.found
            ? handoff.handoff
            : { error: handoff.error, detail: (handoff as { detail?: string }).detail },
        };
        // 5.5) 候选变更集(Worker 侧可信采集;SUCCEEDED 才有候选,P0-02A C-1)
        // 越界 violation 如实记录(sandbox 强制下不应发生;Gate 编排层消费时裁决)。
        try {
          const candidateManifest = snapshotManifest(sandboxSpec.workspaceDir);
          const cs = await db.transaction(async (tx) =>
            recordChangeset(
              tx as unknown as Exec,
              {
                taskId: spec.taskId,
                runId,
                attempt: spec.attempt,
                base: baseManifest,
                candidate: candidateManifest,
                requirement: {
                  goalText: spec.goal,
                  taskId: spec.taskId,
                  allowedScope: spec.allowedScope,
                  allowedCommands: spec.allowedCommands ?? [],
                },
              },
              spec.ownerId,
            ),
          );
          changesetId = cs.id;
          detail = { ...detail, changeset: { id: cs.id, baseSha: cs.baseSha, candidateSha: cs.candidateSha, requirementSha: cs.requirementSha, diff: cs.diff, violations: cs.violations } };
          // 5.6) 候选 Git Commit(D-2):交付绑定任务在独立 stage 仓库构建并绑定(树==清单往返核验);
          // 失败 ⇒ 阻断交付(无绑定 ⇒ Proposal 拒 no_commit_binding),不影响 Run/Gate 质量链。
          if (spec.deliveryStaging) {
            try {
              // 候选 base = Run 前记录的 input_commit_sha(P0-02B 补验 F-5 收敛):
              // 不得事后重探测工作区 HEAD —— 模型若在 Run 期间自行 commit,重探测会让 base 漂移。
              const baseCommit = await loadInputCommitSha(db, runId);
              if (!baseCommit) throw new GitCandidateError("base_commit_missing");
              const staged = await createCandidateCommit({
                workspaceDir: sandboxSpec.workspaceDir,
                baseCommitSha: baseCommit,
                candidateManifest,
                diff: cs.diff,
                taskId: spec.taskId,
                attempt: spec.attempt,
                changesetId: cs.id,
                stagingDir: spec.deliveryStaging.baseDir,
              });
              const bound = await db.transaction(async (tx) =>
                bindCandidateCommit(tx as unknown as Exec, {
                  changesetId: cs.id,
                  taskId: spec.taskId,
                  attempt: spec.attempt,
                  baseCommitSha: staged.baseCommitSha,
                  treeSha: staged.treeSha,
                  commitSha: staged.commitSha,
                  stageRepoDir: staged.stageRepoDir,
                }, spec.ownerId),
              );
              if (!bound.ok) {
                detail = { ...detail, candidateCommitError: bound.reason };
              } else {
                detail = {
                  ...detail,
                  candidateCommit: {
                    commitSha: staged.commitSha,
                    treeSha: staged.treeSha,
                    baseCommitSha: staged.baseCommitSha,
                    stageRepoDir: staged.stageRepoDir,
                    filesChanged: staged.filesChanged,
                    treeVerified: staged.treeVerified,
                  },
                };
              }
            } catch (e) {
              detail = { ...detail, candidateCommitError: e instanceof GitCandidateError ? `${e.reason}: ${e.message}` : (e as Error).message };
            }
          }
        } catch (e) {
          detail = { ...detail, changesetError: (e as Error).message };
        }
        // 6) 成功路径推进:RUNNING->SUBMITTED->VERIFYING(VERIFYING->ACCEPTED 属 Gate,P0-02A 编排)
        const advSub = await db.transaction(async (tx) =>
          advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "RUNNING", "SUBMITTED"),
        );
        if (!advSub.ok) {
          outcome = "FAILED";
          detail = { ...detail, reason: `advance_submitted_rejected:${advSub.reason}` };
        } else {
          const advVer = await db.transaction(async (tx) =>
            advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "SUBMITTED", "VERIFYING"),
          );
          if (!advVer.ok) {
            outcome = "FAILED";
            detail = { ...detail, reason: `advance_verifying_rejected:${advVer.reason}` };
          }
        }
      }
    }

    // 回合硬顶(仍持租约):任务 RUNNING→BLOCKED(budget_exhausted);与预留失败同语义。
    if (outcome === "BUDGET_EXHAUSTED" && detail["reason"] === "budget_turns_cap") {
      const advBlk = await db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "RUNNING", "BLOCKED"),
      );
      if (!advBlk.ok) detail = { ...detail, taskAdvanceRejected: advBlk.reason };
    }

    // 超时/取消(仍持租约):按合法转移收尾任务;推进被拒(租约已失)则留给 Supervisor。
    if (outcome === "TIMEOUT" || outcome === "CANCELLED") {
      const toTask: TaskState = outcome === "TIMEOUT" ? "FAILED" : "CANCELLED";
      const advEnd = await db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "RUNNING", toTask),
      );
      if (!advEnd.ok) detail = { ...detail, taskAdvanceRejected: advEnd.reason };
    }
  } catch (e) {
    outcome = "FAILED";
    const msg = (e as Error).message ?? "";
    const exit = session?.exitStatus ?? null;
    if (exit && !exit.expected) {
      // 外因进程死亡(docker kill/崩溃):真实 RPC 断连,非 Runner 自身错误
      await raceExit(session!, 3000);
      detail = { reason: "rpc_disconnect", exit, stderrTail: session?.stderrText.slice(-2000) || undefined };
    } else if (abortReason) {
      outcome = "INTERRUPTED";
      detail = { reason: abortReason, error: msg, lastError: hbLastError };
    } else {
      detail = {
        reason: "runner_error",
        error: msg,
        stderrTail: session?.stderrText ? session.stderrText.slice(-2000) : undefined,
      };
    }
    session?.kill("SIGKILL");
  } finally {
    clearInterval(hbTimer);
    session?.kill("SIGKILL"); // 幂等:已退出无害
    // 预算核算:实际 assistant 回合数(不可测 ⇒ 保守记 1);tokens 按 usage 实测,
    // 缺失 ⇒ 保守估算入账(FAIL-CLOSED 方向:宁可多记不少记)。
    if (ledgerId) {
      const assistantEnds = session
        ? session.allRecords().filter((r) => r.type === "message_end" && r.message?.role === "assistant")
        : [];
      const actualCalls = session ? Math.max(assistantEnds.length, 1) : 0;
      if (actualCalls > reservedCalls) detail = { ...detail, budgetOvershoot: { reserved: reservedCalls, actual: actualCalls } };
      const usage = assistantEnds.reduce(
        (acc, r) => {
          const u = (r.message as { usage?: { input?: number; output?: number } } | undefined)?.usage;
          return { in: acc.in + (u?.input ?? 0), out: acc.out + (u?.output ?? 0) };
        },
        { in: 0, out: 0 },
      );
      const conservativeIn = usage.in > 0 ? usage.in : 20_000;
      const conservativeOut = usage.out > 0 ? usage.out : 4_000;
      detail = { ...detail, budget: { actualCalls, tokensIn: conservativeIn, tokensOut: conservativeOut } };
      await db
        .transaction(async (tx) =>
          settleBudget(tx as unknown as Exec, ledgerId!, { reservedAmount: reservedCalls, actualAmount: actualCalls }),
        )
        .catch(() => {});
      for (const tl of tokenLedgers) {
        const actual = tl.kind === "tokens_in" ? conservativeIn : conservativeOut;
        await db
          .transaction(async (tx) =>
            settleBudget(tx as unknown as Exec, tl.ledgerId, { reservedAmount: tl.reserved, actualAmount: actual }),
          )
          .catch(() => {});
      }
    } else if (tokenLedgers.length > 0) {
      for (const tl of tokenLedgers) {
        await db.transaction(async (tx) => releaseBudget(tx as unknown as Exec, tl.ledgerId, tl.reserved)).catch(() => {});
      }
    }
    await db
      .transaction(async (tx) => updateRun(tx as unknown as Exec, runId, outcome, detail))
      .catch(() => {});
    await appendAuditSafe(db, spec, runId, outcome, detail);
  }

  return {
    runId,
    outcome,
    handoff,
    toolAuditPath: join(sandboxSpec.workspaceDir, ".relay", "tool-audit.jsonl"),
    toolCallEvents: Number(detail["toolCallEvents"] ?? 0),
    detail,
    sandboxSpec,
    changesetId,
    // P0-02B:候选 stage 仓库(交付绑定任务;调用方在 DELIVERED/处置后清理)
    ...(typeof detail["candidateCommit"] === "object" && detail["candidateCommit"] !== null
      ? { candidateStageRepoDir: (detail["candidateCommit"] as { stageRepoDir?: string }).stageRepoDir }
      : {}),
  };
}

async function raceExit(session: PiRpcSession, ms: number): Promise<void> {
  await Promise.race([session.exited, sleep(ms)]);
}

async function appendAuditSafe(
  db: RelayDb,
  spec: RunSpec,
  runId: string,
  outcome: RunOutcome,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.transaction(async (tx) =>
      appendAudit(tx as unknown as Exec, {
        actor: spec.ownerId,
        authority: "WORKER",
        action: `RUN_${outcome}`,
        taskId: spec.taskId,
        detail: { runId, outcome, ...detail },
      }),
    );
  } catch {
    /* run 行已记录结果;审计尽力而为(租约丢失时任务行仍不可碰) */
  }
}

/** 读取 tool-audit.jsonl 机器可读工具审计(越权证据源)。 */
export function readToolAudit(spec: SandboxSpec): Array<Record<string, unknown>> {
  const auditPath = join(spec.workspaceDir, ".relay", "tool-audit.jsonl");
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
