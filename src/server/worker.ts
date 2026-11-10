// Worker 驱动(P0-02C D-7)。
// 契约:server 只知道"能推进一拍 Goal Loop"的驱动器;**不知道**模型细节。
//   - live     : 真实 Pi runtime(src/runtime/*);模型配置缺失 ⇒ FAIL-CLOSED(不启动 Run)
//   - stub     : 由调用方(测试)注入的确定性桩;UI/API 必须显式标注
//   - external : 独立 relay-worker 进程驱动,本进程不代跑
// 本文件不复制状态机:推进全部交给 core.goalLoopTick(runtime 组合由本层注入)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../core/db.ts";
import type { GoalLoopTickReport } from "../core/goal-loop.ts";
import type { ProposeDeliveryInput, DeliveryIO } from "../core/delivery.ts";
import type { WorkspaceManifest } from "../core/changesets.ts";
import { executeRun } from "../runtime/runner.ts";
import { runReviewerSession } from "../runtime/reviewer.ts";
import { resolveVendoredPi, type PiInstallation } from "../runtime/pi-version.ts";
import { snapshotManifest } from "../runtime/workspace-manifest.ts";
import { cleanupSandbox, type ModelConfig, type SandboxSpec } from "../runtime/sandbox.ts";
import type { EgressStatus } from "../runtime/egress.ts";
import type { CheckSpec } from "../core/evidence.ts";

export type WorkerMode = "live" | "stub" | "external";

export interface WorkerDriver {
  mode: WorkerMode;
  /** 推进一拍;返回 core 的 tick 报告(未经改写)。 */
  tick(): Promise<GoalLoopTickReport>;
  /** 最近一次 tick 的事实(健康视图用);未跑过则为 null。 */
  lastTick(): { at: string; status: string; summary: Record<string, unknown> } | null;
}

export interface CapturedDelivery {
  taskId: string;
  attempt: number;
  stageRepoDir: string;
  manifest: WorkspaceManifest;
  baseCommitSha: string;
  commitSha: string;
}

/** 交付装配:把"本拍捕获的候选事实"接到 core 的交付链上。 */
export interface DeliveryFactory {
  propose(captured: CapturedDelivery): Promise<ProposeDeliveryInput>;
  io(captured: CapturedDelivery): Promise<DeliveryIO>;
}

export interface LiveWorkerOptions {
  db: RelayDb;
  pi?: PiInstallation;
  /** 缺省从 env 读取;缺失 ⇒ tick 返回 provider_not_configured(不启动任何 Run) */
  model?: ModelConfig;
  sandbox?: "docker" | "host-fallback";
  egress?: EgressStatus;
  workerId?: string;
  ttlSeconds?: number;
  wallSeconds?: number;
  heartbeatSeconds?: number;
  reserveCallsPerRun?: number;
  reviewerReserveCallsPerRun?: number;
  reviewAttempts?: number;
  evidenceChecks?: CheckSpec[];
  delivery?: DeliveryFactory;
  /** 候选 stage 仓库根目录(交付用) */
  stageBaseDir?: string;
  /** 每个 task 的目标文本(默认取 goal.raw_input) */
  goalTextFor?: (taskId: string) => Promise<string>;
  /** 工作区种子(透传 executeRun.prepareWorkspace;测试/任务初始化) */
  prepareWorkspace?: (workspaceDir: string) => void;
  /**
   * 测试注入口(仅 host-fallback + 桩;正式路径禁用):stub Pi argv/env。
   * 注入时 workerMode 必须显式标 stub(UI/API 如实披露,不冒充真实模型执行)。
   */
  stubInjection?: {
    argv: string[];
    coderEnv: Record<string, string>;
    reviewerEnv: Record<string, string>;
  };
}

function envModel(): ModelConfig | null {
  const provider = process.env.RELAY_PI_PROVIDER;
  const model = process.env.RELAY_PI_MODEL;
  const apiKey = process.env.RELAY_PI_API_KEY;
  const baseUrl = process.env.RELAY_PI_BASE_URL;
  if (!provider || !model || !apiKey || !baseUrl) return null;
  return { provider, model, apiKey, baseUrl };
}

/**
 * 真实 worker 驱动:组合 runtime(runner/reviewer)与 core(goal-loop)。
 * FAIL-CLOSED:模型未配置 / docker 出口未就绪 ⇒ 不领取任务,直接回报。
 */
export function createLiveWorkerDriver(options: LiveWorkerOptions): WorkerDriver {
  const captured = new Map<string, CapturedDelivery>();
  const sandboxes: SandboxSpec[] = [];
  let last: { at: string; status: string; summary: Record<string, unknown> } | null = null;

  const pi = options.pi ?? resolveVendoredPi();
  const workerId = options.workerId ?? "relay-worker-1";

  const goalTextFor = async (taskId: string): Promise<string> => {
    if (options.goalTextFor) return options.goalTextFor(taskId);
    const res = await options.db.execute(sql`
      SELECT g.raw_input FROM tasks t JOIN goals g ON g.id = t.goal_id WHERE t.id = ${taskId}
    `);
    return String(res.rows[0]?.["raw_input"] ?? "");
  };

  const goalIdFor = async (taskId: string): Promise<string | null> => {
    const res = await options.db.execute(sql`SELECT goal_id FROM tasks WHERE id = ${taskId}`);
    const v = res.rows[0]?.["goal_id"];
    return v === null || v === undefined ? null : String(v);
  };

  return {
    // D-7/R-3:桩注入 ⇒ 代码面强制标注 stub(不依赖调用方自觉),杜绝以 live 名义展示桩执行
    mode: options.stubInjection ? ("stub" as const) : "live",
    lastTick: () => last,
    async tick(): Promise<GoalLoopTickReport> {
      const model = options.model ?? envModel();
      if (!model) {
        last = { at: new Date().toISOString(), status: "provider_not_configured", summary: { note: "未配置 RELAY_PI_* ⇒ 本拍不领取任务" } };
        return { status: "IDLE_PROVIDER_DOWN", goalStates: [] };
      }
      if (options.sandbox === "docker" && !options.egress?.ok) {
        last = { at: new Date().toISOString(), status: "egress_not_ready", summary: { note: "docker 模式需先 ensureEgress(FAIL-CLOSED)" } };
        return { status: "IDLE_PROVIDER_DOWN", goalStates: [] };
      }
      const { goalLoopTick } = await import("../core/goal-loop.ts");
      const report = await goalLoopTick(options.db, {
        actor: workerId,
        workerId,
        ttlSeconds: options.ttlSeconds ?? 60,
        runTask: async (claim) => {
          const goalId = await goalIdFor(claim.taskId);
          const goalText = await goalTextFor(claim.taskId);
          const injection = options.stubInjection;
          const result = await executeRun(options.db, pi, {
            taskId: claim.taskId,
            goal: goalText,
            allowedScope: ["/workspace"],
            attempt: claim.attempt,
            ownerId: claim.ownerId,
            fencingToken: claim.fencingToken,
            model,
            sandbox: options.sandbox ?? "host-fallback",
            ...(options.egress ? { egress: options.egress } : {}),
            wallSeconds: options.wallSeconds ?? 120,
            heartbeatSeconds: options.heartbeatSeconds ?? 10,
            ...(goalId ? { budget: { goalId, reserveCallsPerRun: options.reserveCallsPerRun ?? 4 } } : {}),
            ...(options.stageBaseDir ? { deliveryStaging: { baseDir: options.stageBaseDir } } : {}),
            ...(options.prepareWorkspace ? { prepareWorkspace: options.prepareWorkspace } : {}),
            ...(injection ? { argvOverride: injection.argv, envOverride: injection.coderEnv } : {}),
          });
          sandboxes.push(result.sandboxSpec);
          const cc = result.detail["candidateCommit"] as { commitSha?: string; baseCommitSha?: string; stageRepoDir?: string } | undefined;
          if (cc?.commitSha && cc.stageRepoDir) {
            captured.set(claim.taskId, {
              taskId: claim.taskId,
              attempt: claim.attempt,
              stageRepoDir: cc.stageRepoDir,
              manifest: snapshotManifest(result.sandboxSpec.workspaceDir),
              baseCommitSha: cc.baseCommitSha ?? "",
              commitSha: cc.commitSha,
            });
          }
          return {
            outcome: result.outcome,
            taskId: claim.taskId,
            runId: result.runId,
            workspaceDir: result.sandboxSpec.workspaceDir,
          };
        },
        gate: {
          reviewAttempts: options.reviewAttempts ?? 2,
          ...(options.evidenceChecks ? { evidenceChecks: options.evidenceChecks } : {}),
          reviewRun: async (input) => {
            const goalId = await goalIdFor(input.taskId);
            const injection = options.stubInjection;
            return runReviewerSession(options.db, pi, {
              taskId: input.taskId,
              attempt: input.attempt,
              goalText: input.goalText,
              changeset: input.changeset,
              evidenceSummaries: input.evidenceSummaries,
              model,
              sandbox: options.sandbox ?? "host-fallback",
              ...(options.egress ? { egress: options.egress } : {}),
              heartbeatSeconds: options.heartbeatSeconds ?? 10,
              wallSeconds: options.wallSeconds ?? 120,
              ...(goalId ? { budget: { goalId, reserveCallsPerRun: options.reviewerReserveCallsPerRun ?? 2 } } : {}),
              ...(input.workspaceDir ? { workspaceDirOverride: input.workspaceDir } : {}),
              heartbeatFn: input.heartbeat,
              ...(injection ? { argvOverride: injection.argv, envOverride: injection.reviewerEnv } : {}),
            });
          },
        },
        ...(options.delivery
          ? {
              delivery: {
                propose: async ({ taskId, attempt }) => {
                  const c = captured.get(taskId);
                  if (!c) throw new Error("delivery_not_captured:" + taskId);
                  return options.delivery!.propose(c);
                },
                io: async (taskId) => {
                  const c = captured.get(taskId);
                  if (!c) throw new Error("delivery_not_captured:" + taskId);
                  return options.delivery!.io(c);
                },
              },
            }
          : {}),
      });
      last = {
        at: new Date().toISOString(),
        status: report.status,
        summary: {
          claimed: report.tick?.claimed?.taskId ?? null,
          run: report.run?.outcome ?? null,
          gate: report.gate?.status ?? null,
          delivery: report.delivery?.execute ?? null,
        },
      };
      // 沙箱清理(证据已随 Run 落库)
      while (sandboxes.length > 0) {
        const s = sandboxes.pop();
        if (s) cleanupSandbox(s);
      }
      return report;
    },
  };
}

/** 外部 worker 模式占位:本进程不代跑(控制台只报告"由独立进程驱动")。 */
export function createExternalWorkerDriver(note: string): WorkerDriver {
  return {
    mode: "external",
    lastTick: () => null,
    tick: async () => {
      throw new Error(`external_worker_mode:${note}`);
    },
  };
}
