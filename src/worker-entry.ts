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
import { resolveMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from "./runtime/sandbox.ts";
import { appendAudit } from "./core/audit.ts";
import { ensureEgress, type EgressStatus } from "./runtime/egress.ts";
import { FUNCTIONAL_EVIDENCE_KINDS } from "./core/gates.ts";
import type { CheckSpec } from "./core/evidence.ts";
import type { Exec } from "./core/db.ts";

export interface WorkerEntryOptions {
  dbUrl?: string;
  intervalMs?: number;
  workerId?: string;
}

export interface WorkerEntryHandle {
  stop(): Promise<void>;
}

/** RELAY-CONTROL-READY-03 P0-2:生产 Gate 可用性 —— 功能性机器检查的环境配置入口。
 *  RELAY_EVIDENCE_CHECKS_JSON = CheckSpec[](确定性 CheckSpec/沙箱执行,同一 Gate 证据链):
 *  kind 限功能性证据(deterministic_test/api_behavior;SAFETY-CLOSE-02 P0-B),command=argv
 *  字符串数组(直启无 shell),cwdWorkspace 缺省 true(在候选工作区执行),timeoutMs 1s~600s。
 *  严格校验 fail-closed:非法配置 ⇒ 启动即抛(同 RELAY_MAX_OUTPUT_TOKENS 语义);未配置 ⇒
 *  不注入 ⇒ Gate 编排保守停机(不得由任意用户消息、模型文本或 manifestVerify 顶替)。
 *  生产重启/配置变更不在本包授权范围(仅提供机制与校验;实际取值=部署包决策)。 */
export function resolveEvidenceChecks(raw: string | undefined): CheckSpec[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`RELAY_EVIDENCE_CHECKS_JSON 非法 JSON(fail-closed):${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("RELAY_EVIDENCE_CHECKS_JSON 必须为 CheckSpec 数组(fail-closed)");
  if (parsed.length === 0) {
    throw new Error("RELAY_EVIDENCE_CHECKS_JSON 空数组(fail-closed):留空=不配置=保守停机;请清除该变量而非传空数组");
  }
  const out: CheckSpec[] = [];
  for (const item of parsed) {
    const s = (item ?? {}) as Record<string, unknown>;
    const kind = String(s["kind"] ?? "");
    if (!FUNCTIONAL_EVIDENCE_KINDS.has(kind)) {
      throw new Error(
        `RELAY_EVIDENCE_CHECKS_JSON.kind 必须为功能性证据(${[...FUNCTIONAL_EVIDENCE_KINDS].join("/")});得到 ${kind}(fail-closed)`,
      );
    }
    const cmd = s["command"];
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === "string" && c.length > 0)) {
      throw new Error("RELAY_EVIDENCE_CHECKS_JSON.command 必须为非空字符串数组(argv 直启,无 shell;fail-closed)");
    }
    const timeoutMs = s["timeoutMs"];
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600_000)
    ) {
      throw new Error("RELAY_EVIDENCE_CHECKS_JSON.timeoutMs 必须在 1000~600000(fail-closed)");
    }
    // P0-A A4:网络能力须单独授权 —— allowEgressNetwork 仅接受显式布尔;true 时执行器仍会
    // 校验 egress 白名单(未验证 ⇒ FAIL-CLOSED),此处只做配置面类型收口。
    if (s["allowEgressNetwork"] !== undefined && typeof s["allowEgressNetwork"] !== "boolean") {
      throw new Error("RELAY_EVIDENCE_CHECKS_JSON.allowEgressNetwork 必须为布尔(缺省 false=容器禁网;fail-closed)");
    }
    // P0-A A5:cwdWorkspace 显式归一 —— false 保留(容器内 /tmp + 工作区只读,不构成宿主绕过);
    // 缺省/true ⇒ true(候选工作区)。非法类型(非布尔)⇒ fail-closed 拒绝配置。
    if (s["cwdWorkspace"] !== undefined && typeof s["cwdWorkspace"] !== "boolean") {
      throw new Error("RELAY_EVIDENCE_CHECKS_JSON.cwdWorkspace 必须为布尔(缺省 true=候选工作区;fail-closed)");
    }
    out.push({
      kind: kind as CheckSpec["kind"],
      command: cmd as string[],
      ...(s["cwdWorkspace"] === false ? { cwdWorkspace: false } : { cwdWorkspace: true }),
      ...(timeoutMs !== undefined ? { timeoutMs: Number(timeoutMs) } : {}),
      ...(s["allowEgressNetwork"] === true ? { allowEgressNetwork: true } : {}),
      ...(typeof s["expectOutputContains"] === "string" && (s["expectOutputContains"] as string).length > 0
        ? { expectOutputContains: s["expectOutputContains"] as string }
        : {}),
    });
  }
  return out;
}

/** 启动独立 worker(测试与生产同入口;调用方负责 closeDb)。 */
export function startWorkerEntry(opts: WorkerEntryOptions = {}): {
  handle: WorkerEntryHandle;
  driver: WorkerDriver;
  dbUrl: string;
} {
  // P0-2:检查配置在连接 DB 之前解析(非法 ⇒ 启动即抛,零连接零副作用)
  const evidenceChecks = resolveEvidenceChecks(process.env.RELAY_EVIDENCE_CHECKS_JSON);
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
    ...(evidenceChecks ? { evidenceChecks } : {}),
  };
  const driver = createLiveWorkerDriver(driverOptions);
  // R2-REMEDIATION-01:输出上限配置横幅(非法配置 ⇒ 启动即抛=fail-closed;未配置=默认 8192)
  const maxOutputTokensConfigured = resolveMaxOutputTokens(process.env.RELAY_MAX_OUTPUT_TOKENS);
  const banner = `[relay-worker] started workerId=${workerId} intervalMs=${intervalMs} sandbox=${process.env.RELAY_WEB_SANDBOX === "host-fallback" ? "host-fallback" : "docker"} maxOutputTokens=${maxOutputTokensConfigured ?? DEFAULT_MAX_OUTPUT_TOKENS}${maxOutputTokensConfigured === undefined ? "(默认)" : "(配置)"} evidenceChecks=${evidenceChecks ? evidenceChecks.length : "未配置(Gate 保守停机)"} pid=${process.pid}`;
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
            console.log(
              `[relay-worker] egress ${eg.ok ? `ready(network=${eg.network})` : `unavailable:${eg.reason ?? "?"}`}`,
            );
          } catch (err) {
            console.log(
              `[relay-worker] egress init failed:${err instanceof Error ? err.message : String(err)}(FAIL-CLOSED 不领取)`,
            );
          }
        }
      }
      const report = await driver.tick();
      console.log(
        `[relay-worker] tick status=${report.status} claimed=${report.tick?.claimed?.taskId ?? "-"} at=${new Date().toISOString()}`,
      );
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
