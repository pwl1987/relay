// 只读视图·Models/Usage(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;纯观察,零探测)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../../core/db.ts";
import { iso, num, str, type Row } from "./shared.ts";

export interface ModelsUsageView {
  provider: {
    configured: boolean;
    providerName: string | null;
    modelName: string | null;
    baseUrlHost: string | null;
    probed: false;
    note: string;
  };
  classification: { status: "UNREGISTERED"; note: string };
  recentRuns: Array<{ id: string; taskId: string; modelRef: string; outcome: string; sandbox: string; role: string | null; startedAt: string; endedAt: string | null; durationMs: number | null }>;
  recentDiscoveries: Array<{ id: string; goalId: string; modelRef: string; outcome: string; reason: string | null; createdAt: string }>;
  budgetTotals: { modelCalls: { limit: number | null; reserved: number; used: number }; tokensInUsed: number; tokensOutUsed: number; wallSecondsUsed: number };
  perGoal: Array<{ goalId: string; rawInput: string; limit: number | null; reserved: number; used: number }>;
  outcomes: { byOutcome: Record<string, number>; reasons: Array<{ reason: string; n: number }> };
}

/** P0-UI-5:模型观察面。零探测(probed 恒 false);Key/凭据零返回(redact 兜底之外本层就不取)。 */
export async function modelsUsageView(db: RelayDb): Promise<ModelsUsageView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const providerName = process.env.RELAY_PI_PROVIDER ?? null;
  const modelName = process.env.RELAY_PI_MODEL ?? null;
  const baseUrl = process.env.RELAY_PI_BASE_URL ?? null;
  let baseUrlHost: string | null = null;
  if (baseUrl) {
    try {
      baseUrlHost = new URL(baseUrl).host;
    } catch {
      baseUrlHost = null;
    }
  }

  const runRows = await exec.execute(sql`
    SELECT id, task_id, model_ref, outcome, sandbox, detail->>'role' AS role, started_at, ended_at
    FROM runs ORDER BY started_at DESC LIMIT 30
  `);
  const recentRuns = runRows.rows.map((r) => {
    const s = iso(r["started_at"]);
    const e = iso(r["ended_at"]);
    const durationMs = s && e ? new Date(e).getTime() - new Date(s).getTime() : null;
    return {
      id: str(r["id"]),
      taskId: str(r["task_id"]),
      modelRef: str(r["model_ref"]),
      outcome: str(r["outcome"]),
      sandbox: str(r["sandbox"]),
      role: r["role"] === null ? null : str(r["role"]),
      startedAt: s ?? "",
      endedAt: e,
      durationMs,
    };
  });

  const discRows = await exec.execute(sql`
    SELECT id, goal_id, model_ref, outcome, reason, created_at
    FROM discoveries ORDER BY created_at DESC LIMIT 10
  `);

  const outcomeRows = await exec.execute(sql`
    SELECT outcome, count(*)::int AS n FROM runs GROUP BY outcome
  `);
  const byOutcome: Record<string, number> = {};
  for (const r of outcomeRows.rows) byOutcome[str(r["outcome"])] = num(r["n"]);
  const reasonRows = await exec.execute(sql`
    SELECT detail->>'reason' AS reason, count(*)::int AS n FROM runs
    WHERE outcome IN ('FAILED','TIMEOUT','INTERRUPTED','CANCELLED') AND detail->>'reason' IS NOT NULL
    GROUP BY detail->>'reason' ORDER BY n DESC LIMIT 10
  `);

  const totalsRows = await exec.execute(sql`
    SELECT kind, sum(coalesce(limit_value, 0)) AS limit_sum, sum(reserved) AS reserved_sum, sum(used) AS used_sum
    FROM budget_ledger GROUP BY kind
  `);
  const byKind = new Map<string, { limitSum: number; reserved: number; used: number }>();
  let hasModelLimit = false;
  for (const r of totalsRows.rows) {
    const kind = str(r["kind"]);
    const limitSum = num(r["limit_sum"]);
    if (kind === "model_calls" && num(r["limit_sum"]) > 0) hasModelLimit = true;
    byKind.set(kind, { limitSum, reserved: num(r["reserved_sum"]), used: num(r["used_sum"]) });
  }
  const mc = byKind.get("model_calls");
  const perGoalRows = await exec.execute(sql`
    SELECT bl.scope_id AS goal_id, g.raw_input, bl.limit_value, bl.reserved, bl.used
    FROM budget_ledger bl LEFT JOIN goals g ON g.id = bl.scope_id
    WHERE bl.scope_type = 'goal' AND bl.kind = 'model_calls'
    ORDER BY bl.updated_at DESC LIMIT 50
  `);

  return {
    provider: {
      configured: Boolean(providerName && modelName && baseUrl),
      providerName,
      modelName,
      baseUrlHost,
      probed: false,
      note: "本页零模型探测;是否可用以运行时事实(runs/discoveries)为准。凭据一律不显示。",
    },
    classification: {
      status: "UNREGISTERED",
      note: "Provider Registry 属 MODEL-POLICY-01(ADR-0009 设计冻结,激活前置=MVP 最终 ACCEPTED);当前仅记录 model_ref 原文,本地/云端分类不伪造。",
    },
    recentRuns,
    recentDiscoveries: discRows.rows.map((r) => ({
      id: str(r["id"]),
      goalId: str(r["goal_id"]),
      modelRef: str(r["model_ref"]),
      outcome: str(r["outcome"]),
      reason: r["reason"] === null ? null : str(r["reason"]),
      createdAt: iso(r["created_at"]) ?? "",
    })),
    budgetTotals: {
      modelCalls: {
        limit: hasModelLimit && mc ? mc.limitSum : null,
        reserved: mc ? mc.reserved : 0,
        used: mc ? mc.used : 0,
      },
      tokensInUsed: byKind.get("tokens_in")?.used ?? 0,
      tokensOutUsed: byKind.get("tokens_out")?.used ?? 0,
      wallSecondsUsed: byKind.get("wall_seconds")?.used ?? 0,
    },
    perGoal: perGoalRows.rows.map((r) => ({
      goalId: str(r["goal_id"]),
      rawInput: str(r["raw_input"]),
      limit: r["limit_value"] === null ? null : num(r["limit_value"]),
      reserved: num(r["reserved"]),
      used: num(r["used"]),
    })),
    outcomes: {
      byOutcome,
      reasons: reasonRows.rows.map((r) => ({ reason: str(r["reason"]), n: num(r["n"]) })),
    },
  };
}
