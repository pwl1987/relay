// relay-worker 独立入口(P0-总包阶段 E1):**唯一调度权威**在本进程。
// 组合既有核心环路(零第二状态机):
//   - supervisor 环路:租约回收 / NEEDS_RECONCILE Reconcile / REWORK 释放(src/core/supervisor.ts);
//   - goal 环路:claim → Run → Gate → 交付(src/server/worker.ts 的 live driver;FAIL-CLOSED 同 server live);
//   - 环路熔断/审计由 startSafeLoop 承载(连续错误熔断 + TICK_ERROR 审计)。
// 环境:RELAY_DB_URL、RELAY_PI_*(未配置 ⇒ FAIL-CLOSED 不领取,进程仍运行并打健康日志)、
//       RELAY_WORKER_INTERVAL_MS(缺省 15s)、RELAY_WORKER_ID、RELAY_WEB_SANDBOX、RELAY_WEB_STAGE_DIR。
// 生命周期:SIGTERM/SIGINT 优雅停(等待当拍结束);SIGKILL 由 Supervisor 租约回收兜底(US-05/V04)。
import { homedir } from "node:os";
import { join } from "node:path";
import { connectDb, closeDb } from "./core/db.ts";
import { startSupervisorLoop } from "./core/supervisor.ts";
import type { SafeLoopHandle } from "./core/loop-safety.ts";
import { startSafeLoop } from "./core/loop-safety.ts";
import { createLiveWorkerDriver, type WorkerDriver } from "./server/worker.ts";
import { appendAudit } from "./core/audit.ts";
import { ensureEgress, type EgressStatus } from "./runtime/egress.ts";
import type { Exec } from "./core/db.ts";

export interface WorkerEntryOptions {
  dbUrl?: string;
  intervalMs?: number;
  workerId?: string;
}

export interface WorkerEntryHandle {
  stop(): Promise<void>;
}

/** 启动独立 worker(测试与生产同入口;调用方负责 closeDb)。 */
export function startWorkerEntry(opts: WorkerEntryOptions = {}): { handle: WorkerEntryHandle; driver: WorkerDriver; dbUrl: string } {
  const intervalMs = opts.intervalMs ?? Number(process.env.RELAY_WORKER_INTERVAL_MS ?? "15000");
  const workerId = opts.workerId ?? process.env.RELAY_WORKER_ID ?? "relay-worker-1";
  const { pool, db } = connectDb(opts.dbUrl ?? process.env.RELAY_DB_URL, process.env.RELAY_DB_SCHEMA || undefined);
  // 阶段六(运营实例):live docker 驱动要求出口栈(ensureEgress;与 discovery/API 同机制)。
  // driver 持本对象引用,egress 在首拍前惰性初始化并回填;FAIL-CLOSED 语义不变:
  // provider 未配置 / egress 未就绪 ⇒ driver tick 回报不领取(IDLE_PROVIDER_DOWN)。
  const driverOptions: Parameters<typeof createLiveWorkerDriver>[0] = {
    db,
    workerId,
    sandbox: process.env.RELAY_WEB_SANDBOX === "host-fallback" ? "host-fallback" : "docker",
    stageBaseDir: process.env.RELAY_WEB_STAGE_DIR ?? join(homedir(), ".relay", "stage"),
  };
  const driver = createLiveWorkerDriver(driverOptions);
  const banner = `[relay-worker] started workerId=${workerId} intervalMs=${intervalMs} sandbox=${process.env.RELAY_WEB_SANDBOX === "host-fallback" ? "host-fallback" : "docker"} pid=${process.pid}`;
  console.log(banner);

  // supervisor 环路:租约回收/Reconcile/REWORK 释放(独立于 goal 环路,间隔可不同)
  // Supervisor 只做回收/Reconcile/释放(无执行器 ⇒ claim:false;领取归 goal 环路,E1 复核修正)
  const supervisor: SafeLoopHandle = startSupervisorLoop(db, { intervalMs, workerId, claim: false });
  // goal 环路:一拍 = driver.tick()(与 server live driver 同构;FAIL-CLOSED:provider 未配置 ⇒ IDLE_PROVIDER_DOWN 不领取)
  let egressInitDone = false;
  const goal: SafeLoopHandle = startSafeLoop(
    async () => {
      if (!egressInitDone) {
        egressInitDone = true;
        const base = process.env.RELAY_PI_BASE_URL;
        if (base) {
          try {
            const eg: EgressStatus = await ensureEgress(base);
            driverOptions.egress = eg.ok ? eg : undefined;
            console.log(`[relay-worker] egress ${eg.ok ? `ready(network=${eg.network})` : `unavailable:${eg.reason ?? "?"}`}`);
          } catch (err) {
            console.log(`[relay-worker] egress init failed:${err instanceof Error ? err.message : String(err)}(FAIL-CLOSED 不领取)`);
          }
        }
      }
      const report = await driver.tick();
      console.log(`[relay-worker] tick status=${report.status} claimed=${report.tick?.claimed?.taskId ?? "-"} at=${new Date().toISOString()}`);
      return report;
    },
    { intervalMs },
  );

  const startedAt = Date.now();
  void db
    .transaction(async (tx) =>
      appendAudit(tx as unknown as Exec, {
        actor: workerId,
        authority: "SUPERVISOR",
        action: "WORKER_STARTED",
        detail: { workerId, pid: process.pid, intervalMs, banner },
      }),
    )
    .catch(() => {});

  const stop = async (): Promise<void> => {
    supervisor.stop();
    goal.stop();
    await db
      .transaction(async (tx) =>
        appendAudit(tx as unknown as Exec, {
          actor: workerId,
          authority: "SUPERVISOR",
          action: "WORKER_STOPPED",
          detail: { workerId, pid: process.pid, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
        }),
      )
      .catch(() => {});
    await closeDb({ pool, db }).catch(() => {});
  };
  return { handle: { stop }, driver, dbUrl: opts.dbUrl ?? process.env.RELAY_DB_URL ?? "" };
}

const isMain = process.argv[1] !== undefined && process.argv[1]!.endsWith("worker-entry.ts");
if (isMain) {
  const { handle } = startWorkerEntry();
  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[relay-worker] ${sig} received;graceful stop…`);
    await handle.stop();
    console.log("[relay-worker] stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
