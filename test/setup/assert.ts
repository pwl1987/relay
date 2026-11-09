// 结果类型断言 helper:失败时抛出完整 JSON(证据优于模糊断言),同时收窄 TS 联合类型。
import type { ClaimResult } from "../../src/core/lease.ts";
import type { AdvanceResult } from "../../src/core/lease.ts";

export function assertOk(r: ClaimResult): asserts r is Extract<ClaimResult, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功,实际被拒: ${JSON.stringify(r)}`);
}

export function assertFail(r: ClaimResult): asserts r is Extract<ClaimResult, { ok: false }> {
  if (r.ok) throw new Error(`期望被拒,实际成功: ${JSON.stringify(r)}`);
}

export function assertAdvanceOk(r: AdvanceResult): asserts r is Extract<AdvanceResult, { ok: true }> {
  if (!r.ok) throw new Error(`期望推进成功,实际被拒: ${JSON.stringify(r)}`);
}

export function assertAdvanceFail(r: AdvanceResult): asserts r is Extract<AdvanceResult, { ok: false }> {
  if (r.ok) throw new Error(`期望推进被拒,实际成功: ${JSON.stringify(r)}`);
}
