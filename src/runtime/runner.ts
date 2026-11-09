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
  type ModelConfig,
  type SandboxSpec,
} from "./sandbox.ts";
import type { PiInstallation } from "./pi-version.ts";
import { PiRpcSession, type PiSpawnOptions } from "./pi-rpc.ts";
import { buildRunPrompt, contextDigest, parseHandoff, type Handoff, type HandoffParse } from "./context.ts";

export type RunOutcome = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CANCELLED" | "INTERRUPTED";

export interface RunSpec {
  taskId: string;
  goal: string;
  allowedScope: readonly string[];
  attempt: number;
  ownerId: string;
  fencingToken: number;
  model: ModelConfig;
  sandbox: "docker" | "host-fallback";
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
  /** 测试注入口:stub RPC argv/env(仅 host-fallback 语义;正式路径禁用) */
  argvOverride?: string[];
  envOverride?: Record<string, string>;
  onRecord?: PiSpawnOptions["onRecord"];
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
}

async function insertRun(exec: Exec, spec: RunSpec, runId: string, sandbox: SandboxSpec): Promise<void> {
  await exec.execute(sql`
    INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, sandbox, outcome)
    VALUES (${runId}, ${spec.taskId}, ${spec.attempt}, 'pi-rpc',
      ${spec.model.provider + "/" + spec.model.model},
      ${detectInputCommitSha(sandbox.workspaceDir)},
      ${JSON.stringify({ wallSeconds: spec.wallSeconds })}::jsonb,
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
  const runId = newRunId();
  const sandboxSpec = prepareRunDirs(tmpdir(), spec.sandbox, spec.model);
  spec.prepareWorkspace?.(sandboxSpec.workspaceDir);
  // 种子文件须对容器 SANDBOX_UID 可读/可写(宿主 umask 可能 660)
  execFileSync("chmod", ["-R", "o+rwX", sandboxSpec.workspaceDir], { timeout: 30_000 });
  let session: PiRpcSession | null = null;
  let outcome: RunOutcome = "FAILED";
  let detail: Record<string, unknown> = {};
  let handoff: HandoffParse = { found: false, error: "absent" };

  let leaseLost = false;
  const hbTimer = setInterval(() => {
    void db
      .transaction(async (tx) =>
        heartbeat(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, spec.heartbeatSeconds * 3),
      )
      .then((r) => {
        if (!r.ok) {
          leaseLost = true;
          session?.kill("SIGKILL"); // 失效 Run 止损:立即终止 Pi(租约已失,无权推进任务)
        }
      })
      .catch(() => {});
  }, spec.heartbeatSeconds * 1000);

  try {
    // 1) LEASED -> RUNNING(租约权威内)
    const adv = await db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, spec.taskId, spec.ownerId, spec.fencingToken, "LEASED", "RUNNING"),
    );
    if (!adv.ok) throw new Error(`advance to RUNNING rejected: ${adv.reason}`);

    // 2) run 行落库(RUNNING)
    await db.transaction(async (tx) => insertRun(tx as unknown as Exec, spec, runId, sandboxSpec));

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
      model: spec.model,
      execTimeoutMs: spec.execTimeoutMs,
      argvOverride: spec.argvOverride,
      envOverride: spec.envOverride,
      onRecord: spec.onRecord,
    });
    await session.request("get_state", undefined, 20_000);
    await session.prompt(prompt);

    // 5) 等待终态:settled / 进程退出 / wall 预算 / 取消信号
    const deadline = Date.now() + spec.wallSeconds * 1000;
    let settled = false;
    for (;;) {
      if (session.allRecords().some((r) => r.type === "agent_settled")) {
        settled = true;
        break;
      }
      if (leaseLost) break;
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
        if (leaseLost) {
          outcome = "INTERRUPTED";
          detail = { reason: "lease_lost", exit };
        } else {
          outcome = "FAILED";
          detail = { reason: "rpc_disconnect", exit };
        }
        break;
      }
      await sleep(100);
    }

    if (outcome === "FAILED") {
      if (leaseLost && !settled) {
        // 等待循环内租约丢失(IPC 断开即退出);确认子进程死透
        await raceExit(session, 3000);
        if (session.exitStatus === null) session.kill("SIGKILL");
        outcome = "INTERRUPTED";
        detail = { reason: "lease_lost", killedBy: "heartbeat_rejection" };
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
          handoff: handoff.found
            ? handoff.handoff
            : { error: handoff.error, detail: (handoff as { detail?: string }).detail },
        };
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
    } else if (leaseLost) {
      outcome = "INTERRUPTED";
      detail = { reason: "lease_lost", error: msg };
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
