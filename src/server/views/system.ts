// 只读视图·System(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT + 本地只读 git)。
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import type { RelayDb } from "../../core/db.ts";
import { iso, num, str, json, type Row, repoRootFromModule } from "./shared.ts";

/** Server 进程启动时刻(System 页 uptime 基准)。 */
const serverStartedAt = new Date().toISOString();

export interface SystemView {
  relay: { head: string | null; headShort: string | null; version: string; startedAt: string; uptimeSeconds: number; node: string };
  db: { ok: boolean; serverVersion: string | null; schema: string | null; error: string | null };
  worker: { mode: string; active: boolean; lastTick: { status: string; at: string } | null; activeLeases: number; lastLeaseHeartbeat: string | null };
  github: { deliveryByState: Record<string, number>; lastDeliveredAt: string | null; recentIntents: Array<{ id: string; capability: string; state: string; target: string; updatedAt: string }> };
  provider: { configured: boolean; providerName: string | null; modelName: string | null; probed: false; lastModelRef: string | null; note: string };
  recentErrors: Array<{ kind: string; subject: string; detail: string; ts: string | null }>;
}

let cachedHead: { sha: string | null; at: number } = { sha: null, at: 0 };

/** 本仓库 HEAD(1h 缓存;只读 git rev-parse,零网络)。 */
export function relayHead(force = false): string | null {
  const now = Date.now();
  if (!force && cachedHead.sha && now - cachedHead.at < 3600_000) return cachedHead.sha;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRootFromModule(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    cachedHead = { sha: sha || null, at: now };
    return cachedHead.sha;
  } catch {
    cachedHead = { sha: null, at: now };
    return null;
  }
}

export interface WorkerRuntimeInfo {
  mode: string;
  active: boolean;
  lastTick: { status: string; at: string } | null;
}

/** P0-UI-6:系统页(HEAD/DB/Worker/GitHub/Provider/uptime/最近错误;全部只读事实)。 */
export async function systemView(db: RelayDb, workerInfo: WorkerRuntimeInfo): Promise<SystemView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };

  let dbOk = true;
  let dbError: string | null = null;
  let serverVersion: string | null = null;
  try {
    const v = await exec.execute(sql`SELECT version() AS v`);
    serverVersion = str(v.rows[0]?.["v"]) || null;
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : String(err);
  }

  const leaseRows = await exec.execute(sql`
    SELECT count(*)::int AS n, max(heartbeat_at) AS at FROM leases
    WHERE lease_expires_at > now()
  `);

  const deliveryRows = await exec.execute(sql`
    SELECT delivery_state, count(*)::int AS n FROM candidate_changesets GROUP BY delivery_state
  `);
  const deliveryByState: Record<string, number> = {};
  for (const r of deliveryRows.rows) deliveryByState[str(r["delivery_state"])] = num(r["n"]);
  const lastDelivered = await exec.execute(sql`
    SELECT max(delivered_at) AS at FROM candidate_changesets WHERE delivery_state = 'DELIVERED'
  `);
  const intentRows = await exec.execute(sql`
    SELECT id, capability, state, target, updated_at FROM action_intents
    ORDER BY updated_at DESC LIMIT 8
  `);

  const lastModel = await exec.execute(sql`SELECT model_ref FROM runs ORDER BY started_at DESC LIMIT 1`);

  const errRuns = await exec.execute(sql`
    SELECT id, outcome, detail->>'reason' AS reason, started_at FROM runs
    WHERE outcome IN ('FAILED','TIMEOUT','INTERRUPTED','CANCELLED') ORDER BY started_at DESC LIMIT 5
  `);
  const errDelivery = await exec.execute(sql`
    SELECT id, delivery_state, task_id, created_at FROM candidate_changesets
    WHERE delivery_state IN ('CONFLICT','FAILED') ORDER BY created_at DESC LIMIT 3
  `);
  const errAudit = await exec.execute(sql`
    SELECT seq, action, detail, ts FROM audit_events
    WHERE action LIKE '%FAILED%' OR action LIKE '%REJECTED%' ORDER BY seq DESC LIMIT 5
  `);
  const recentErrors: SystemView["recentErrors"] = [];
  for (const r of errRuns.rows) {
    recentErrors.push({ kind: "run_" + str(r["outcome"]).toLowerCase(), subject: str(r["id"]), detail: str(r["reason"]) || "无原因记录", ts: iso(r["started_at"]) });
  }
  for (const r of errDelivery.rows) {
    recentErrors.push({ kind: "delivery_" + str(r["delivery_state"]).toLowerCase(), subject: str(r["id"]), detail: "任务 " + str(r["task_id"]) + " 交付异常", ts: iso(r["created_at"]) });
  }
  for (const r of errAudit.rows) {
    const detail = json<Record<string, unknown>>(r["detail"], {});
    recentErrors.push({ kind: str(r["action"]), subject: "#" + num(r["seq"]), detail: typeof detail["reason"] === "string" ? String(detail["reason"]) : "", ts: iso(r["ts"]) });
  }

  const head = relayHead();
  return {
    relay: {
      head,
      headShort: head ? head.slice(0, 10) : null,
      version: "0.1.0-p0",
      startedAt: serverStartedAt,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    },
    db: { ok: dbOk, serverVersion, schema: process.env.RELAY_DB_SCHEMA ?? null, error: dbError },
    worker: {
      mode: workerInfo.mode,
      active: workerInfo.active,
      lastTick: workerInfo.lastTick,
      activeLeases: leaseRows.rows.length ? num(leaseRows.rows[0]!["n"]) : 0,
      lastLeaseHeartbeat: iso(leaseRows.rows[0]?.["at"]),
    },
    github: {
      deliveryByState,
      lastDeliveredAt: iso(lastDelivered.rows[0]?.["at"]),
      recentIntents: intentRows.rows.map((r) => ({
        id: str(r["id"]),
        capability: str(r["capability"]),
        state: str(r["state"]),
        target: str(r["target"]),
        updatedAt: iso(r["updated_at"]) ?? "",
      })),
    },
    provider: {
      configured: Boolean(process.env.RELAY_PI_PROVIDER && process.env.RELAY_PI_MODEL && process.env.RELAY_PI_BASE_URL),
      providerName: process.env.RELAY_PI_PROVIDER ?? null,
      modelName: process.env.RELAY_PI_MODEL ?? null,
      probed: false,
      lastModelRef: lastModel.rows.length ? str(lastModel.rows[0]!["model_ref"]) : null,
      note: "零探测;最近 model_ref 来自 runs 原始事实。",
    },
    recentErrors: recentErrors.slice(0, 10),
  };
}
