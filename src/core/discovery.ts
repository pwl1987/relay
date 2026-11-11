// Discovery 编排(REWORK-1;US-02 P0 最小):Goal 的一次模型驱动分析,持久化 + 降级。
// - 不复制第二套状态机:零任务状态推进(Discovery 不领取/不推进;仅 Goal 维度的调查记录);
// - FAIL-CLOSED:预算账本行缺失 ⇒ 拒绝;模型未配置 ⇒ 不发起;
// - **失败降级不伪造**:outcome=FAILED 行如实保留 reason;视图侧继续展示规则推导并标注来源,
//   绝不把规则面冒充模型结论;
// - 幂等面:同一 Goal 可多次 analyze(每次追加一行;视图取最新;审计留痕)。
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { RelayDb, Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";
import { runDiscoverySession, type DiscoveryReport, type DiscoveryRunResult } from "../runtime/discovery.ts";
import type { PiInstallation } from "../runtime/pi-version.ts";
import type { ModelConfig } from "../runtime/sandbox.ts";
import type { EgressStatus } from "../runtime/egress.ts";

export interface GoalDiscoverySpec {
  goalId: string;
  model: ModelConfig;
  sandbox: "docker" | "host-fallback";
  egress?: EgressStatus;
  /** 被调查项目目录(operator 指定;模型只读该面) */
  projectDir: string;
  /** 预算声明(FAIL-CLOSED:goal 无 model_calls 账本行 ⇒ 拒绝;此处同时可追加账本上限) */
  reserveCallsPerRun?: number;
  wallSeconds?: number;
  actor: string;
  /** 测试注入口(仅 host-fallback + 桩;正式路径禁用) */
  argvOverride?: string[];
  envOverride?: Record<string, string>;
}

export interface GoalDiscoveryResult {
  ok: boolean;
  reason?: string;
  discoveryId?: string;
  report?: DiscoveryReport;
  runId?: string;
  source: "model" | "failed";
}

/**
 * 对一个 Goal 执行一次模型驱动 Discovery 并持久化。
 * 失败(预算/解析/超时/断连)时落 FAILED 行并返回 source=failed —— 调用方如实展示,规则面兜底。
 */
export async function runGoalDiscovery(db: RelayDb, pi: PiInstallation, spec: GoalDiscoverySpec): Promise<GoalDiscoveryResult> {
  // 1) Goal 存在性 + 首任务(runs.task_id NOT NULL ⇒ Discovery Run 挂 goal 首任务)
  const goalRes = await db.execute(sql`SELECT id, raw_input, state FROM goals WHERE id = ${spec.goalId}`);
  const goal = goalRes.rows[0];
  if (!goal) return { ok: false, reason: "goal_not_found", source: "failed" };
  const taskRes = await db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${spec.goalId} ORDER BY created_at ASC LIMIT 1`);
  const taskId = taskRes.rows[0]?.["id"];
  if (!taskId) return { ok: false, reason: "goal_has_no_task", source: "failed" };
  // 2) 预算账本保障(FAIL-CLOSED:无 model_calls 行 ⇒ ensure 建行仍需 limit>0;无上限不可发起模型)
  const ledger = await db.execute(sql`
    SELECT id, limit_value, used, reserved FROM budget_ledger
    WHERE scope_type='goal' AND scope_id=${spec.goalId} AND kind='model_calls'
  `);
  const row = ledger.rows[0];
  if (!row || row["limit_value"] === null || Number(row["limit_value"]) <= 0) {
    return { ok: false, reason: "budget_ledger_missing_or_unlimited", source: "failed" };
  }
  const reserveCalls = spec.reserveCallsPerRun ?? 3;
  // 3) 只读会话(runner 注入 workspaceDirOverride = projectDir;docker 只读挂载)
  const result: DiscoveryRunResult = await runDiscoverySession(db, pi, {
    goalId: spec.goalId,
    taskId: String(taskId),
    rawInput: String(goal["raw_input"]),
    model: spec.model,
    sandbox: spec.sandbox,
    ...(spec.egress ? { egress: spec.egress } : {}),
    wallSeconds: spec.wallSeconds ?? 180,
    budget: { reserveCallsPerRun: reserveCalls },
    ...(spec.argvOverride ? { argvOverride: spec.argvOverride } : {}),
    ...(spec.envOverride ? { envOverride: spec.envOverride } : {}),
    workspaceDirOverride: spec.projectDir,
  });
  // 4) 持久化(SUCCEEDED ⇒ report + sha;FAILED ⇒ reason 如实;两态都进 discoveries)
  const discoveryId = `disc-${randomUUID()}`;
  const contentSha = result.ok && result.report
    ? createHash("sha256").update(JSON.stringify(result.report)).digest("hex")
    : null;
  await db.transaction(async (tx) => {
    const e = tx as unknown as Exec;
    await e.execute(sql`
      INSERT INTO discoveries (id, goal_id, run_id, outcome, reason, report, content_sha256, model_ref, sandbox)
      VALUES (${discoveryId}, ${spec.goalId}, ${result.runId}, ${result.ok ? "SUCCEEDED" : "FAILED"},
        ${result.ok ? null : (result.reason ?? "unknown")},
        ${result.ok && result.report ? JSON.stringify(result.report) : null}::jsonb,
        ${contentSha}, ${spec.model.provider + "/" + spec.model.model}, ${spec.sandbox})
    `);
    await appendAudit(e, {
      actor: spec.actor,
      authority: "OPERATOR",
      action: result.ok ? "DISCOVERY_SUCCEEDED" : "DISCOVERY_FAILED",
      detail: {
        discoveryId,
        goalId: spec.goalId,
        runId: result.runId,
        reason: result.ok ? null : result.reason,
        source: result.ok ? "model" : "failed",
        note: result.ok ? "模型分析持久化(来源=模型;回放经 discoveries+runs)" : "失败如实落记;视图降级规则面并标注来源",
      },
    });
  });
  if (result.ok) return { ok: true, discoveryId, report: result.report, runId: result.runId, source: "model" };
  return { ok: false, reason: result.reason, discoveryId, runId: result.runId, source: "failed" };
}

/** Goal 最新 Discovery 记录(视图用;含来源徽章语义)。 */
export async function latestDiscovery(db: RelayDb, goalId: string): Promise<Record<string, unknown> | null> {
  const res = await db.execute(sql`
    SELECT id, run_id, outcome, reason, report, content_sha256, model_ref, sandbox, created_at
    FROM discoveries WHERE goal_id = ${goalId} ORDER BY created_at DESC LIMIT 1
  `);
  return res.rows[0] ?? null;
}
