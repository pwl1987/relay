// 机器强制预算(P0-01C C-2;架构 §6 / SECURITY_MODEL T09 / V11)。
// 语义:**先预留再执行后核算**。预留失败(无账本行/超限)⇒ Run 不启动(FAIL-CLOSED)。
// - kind=model_calls 必须有带 limit 的账本行(goal 级由 planner 从 goals.budget 创建);
//   没有 limit 的行 = 仅记账不设限(tokens 等),但 model_calls 无行/无 limit ⇒ 一律拒绝。
// - 行锁单事务:SELECT FOR UPDATE → 校验 → 变更;拒绝落审计(append-only)。
// - 金额不可测(如 usage 缺失)⇒ 由调用方传入保守估算值入账(FAIL-CLOSED 方向:宁可多记)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";

export type BudgetKind = "model_calls" | "tokens_in" | "tokens_out" | "wall_seconds";
export type BudgetScopeType = "goal" | "task" | "run";

export interface BudgetRef {
  scopeType: BudgetScopeType;
  scopeId: string;
  kind: BudgetKind;
}

export interface ReserveResult {
  ok: boolean;
  reason?: string;
  ledgerId?: string;
  remainingAfterReserve?: number;
}

interface LedgerRow {
  id: string;
  limit_value: number | null;
  reserved: number;
  used: number;
}

async function findLedger(exec: Exec, ref: BudgetRef, forUpdate: boolean): Promise<LedgerRow | null> {
  const res = await exec.execute(sql`
    SELECT id, limit_value, reserved, used FROM budget_ledger
    WHERE scope_type = ${ref.scopeType} AND scope_id = ${ref.scopeId} AND kind = ${ref.kind}
    ${ref.kind === "model_calls" ? sql`ORDER BY (CASE WHEN limit_value IS NOT NULL THEN 0 ELSE 1 END), id ASC` : sql``}
    ${forUpdate ? sql`FOR UPDATE` : sql``}
    LIMIT 1
  `);
  return (res.rows[0] as LedgerRow | undefined) ?? null;
}

/**
 * 预留额度。model_calls 沿 task→goal 链向上找第一张**带 limit** 的账本行:
 * task 行(若有)优先;否则 goal 行;两者皆无 ⇒ budget_not_configured(FAIL-CLOSED 拒绝)。
 * 其余 kind 仅在已存在行时记账/限流,无行 = 不设限(返回 ok 且不建行)。
 */
export async function reserveBudget(
  exec: Exec,
  ref: { kind: BudgetKind; amount: number; scopeType: BudgetScopeType; scopeId: string; taskScope?: { scopeType: BudgetScopeType; scopeId: string } },
): Promise<ReserveResult> {
  const { kind, amount } = ref;
  const candidates: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [];
  if (ref.taskScope) candidates.push(ref.taskScope);
  candidates.push({ scopeType: ref.scopeType, scopeId: ref.scopeId });

  for (const c of candidates) {
    const row = await findLedger(exec, { ...c, kind }, true);
    if (!row) continue;
    if (kind === "model_calls" && row.limit_value === null) continue; // 无 limit 行不作 model_calls 授权
    if (row.limit_value === null) {
      return { ok: true, ledgerId: row.id }; // 记账型 kind 无需限额判断
    }
    const remaining = row.limit_value - row.used - row.reserved;
    if (amount > remaining) {
      await appendAudit(exec, {
        actor: "budget",
        authority: "SUPERVISOR",
        action: "BUDGET_RESERVE_REJECTED",
        detail: { scopeType: c.scopeType, scopeId: c.scopeId, kind, amount, limit: row.limit_value, used: row.used, reserved: row.reserved },
      });
      return { ok: false, reason: "budget_exhausted", ledgerId: row.id };
    }
    await exec.execute(sql`
      UPDATE budget_ledger SET reserved = reserved + ${amount}, updated_at = now() WHERE id = ${row.id}
    `);
    return { ok: true, ledgerId: row.id, remainingAfterReserve: remaining - amount };
  }
  if (kind === "model_calls") {
    await appendAudit(exec, {
      actor: "budget",
      authority: "SUPERVISOR",
      action: "BUDGET_RESERVE_REJECTED",
      detail: { kind, amount, reason: "no_limited_ledger_row" },
    });
    return { ok: false, reason: "budget_not_configured" };
  }
  return { ok: true }; // 非 model_calls 且无行:仅跳过(记账型容错)
}

/** 核算:实际用量入 used,释放预留。amount 不可测时由调用方给保守估算(FAIL-CLOSED 方向)。 */
export async function settleBudget(
  exec: Exec,
  ledgerId: string,
  opts: { reservedAmount: number; actualAmount: number },
): Promise<void> {
  const res = await exec.execute(sql`
    UPDATE budget_ledger SET
      reserved = GREATEST(reserved - ${opts.reservedAmount}, 0),
      used = used + ${opts.actualAmount},
      updated_at = now()
    WHERE id = ${ledgerId}
  `);
  void res;
}

/** 释放预留(执行未发生/Run 中止)。 */
export async function releaseBudget(exec: Exec, ledgerId: string, reservedAmount: number): Promise<void> {
  await exec.execute(sql`
    UPDATE budget_ledger SET reserved = GREATEST(reserved - ${reservedAmount}, 0), updated_at = now()
    WHERE id = ${ledgerId}
  `);
}

/** 建账本行(planner/测试用);同 (scope,kind) 唯一。 */
export async function ensureLedgerRow(
  exec: Exec,
  ref: BudgetRef & { limit?: number | null },
): Promise<string> {
  const id = `bl-${randomUUID()}`;
  await exec.execute(sql`
    INSERT INTO budget_ledger (id, scope_type, scope_id, kind, limit_value)
    VALUES (${id}, ${ref.scopeType}, ${ref.scopeId}, ${ref.kind}, ${ref.limit ?? null})
  `);
  return id;
}

/** 读取用量快照(测试/报告用)。 */
export async function ledgerSnapshot(
  db: { execute(q: ReturnType<typeof sql>): Promise<{ rows: Array<Record<string, unknown>> }> },
  scopeType: BudgetScopeType,
  scopeId: string,
): Promise<Array<{ kind: string; limit: number | null; reserved: number; used: number }>> {
  const res = await db.execute(sql`
    SELECT kind, limit_value, reserved, used FROM budget_ledger
    WHERE scope_type = ${scopeType} AND scope_id = ${scopeId} ORDER BY kind
  `);
  return res.rows.map((r) => ({
    kind: String(r["kind"]),
    limit: r["limit_value"] === null ? null : Number(r["limit_value"]),
    reserved: Number(r["reserved"]),
    used: Number(r["used"]),
  }));
}
