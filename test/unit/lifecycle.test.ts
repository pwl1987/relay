// 状态机转移表单测:非法转移必须被静态拒绝(V08 的静态面)。
import { describe, expect, it } from "vitest";
import {
  GATED_TRANSITIONS,
  TERMINAL_STATES,
  TRANSITIONS,
  TASK_STATES,
  isGatedTransition,
  isLegalTransition,
  isTerminal,
  leaseReleasedOn,
} from "../../src/core/lifecycle.ts";

describe("状态机转移表", () => {
  it("主链合法转移全部通过", () => {
    const mainPath = ["CREATED", "READY", "LEASED", "RUNNING", "SUBMITTED", "VERIFYING", "ACCEPTED"];
    for (let i = 0; i < mainPath.length - 1; i++) {
      expect(isLegalTransition(mainPath[i]!, mainPath[i + 1]!), `${mainPath[i]}->${mainPath[i + 1]}`).toBe(true);
    }
  });

  it("关键非法转移被拒绝", () => {
    const illegal: Array<[string, string]> = [
      ["CREATED", "ACCEPTED"], // 不得跳过主链直接验收
      ["READY", "ACCEPTED"],
      ["READY", "VERIFYING"],
      ["LEASED", "ACCEPTED"],
      ["RUNNING", "ACCEPTED"], // 未 SUBMITTED/VERIFYING 不得验收(假 DONE 语义面)
      ["VERIFYING", "RUNNING"], // 不得倒退
      ["VERIFYING", "LEASED"],
      ["ACCEPTED", "READY"], // 终态不可复活
      ["ACCEPTED", "REWORK"],
      ["FAILED", "READY"],
      ["CANCELLED", "READY"],
      ["SUBMITTED", "RUNNING"],
      ["REWORK", "ACCEPTED"],
    ];
    for (const [from, to] of illegal) {
      expect(isLegalTransition(from, to), `${from}->${to} 必须非法`).toBe(false);
    }
  });

  it("恢复/暂停/阻断语义存在", () => {
    expect(isLegalTransition("RUNNING", "NEEDS_RECONCILE")).toBe(true);
    expect(isLegalTransition("RUNNING", "REWORK")).toBe(true);
    expect(isLegalTransition("NEEDS_RECONCILE", "READY")).toBe(true);
    expect(isLegalTransition("NEEDS_RECONCILE", "BLOCKED")).toBe(true);
    expect(isLegalTransition("REWORK", "READY")).toBe(true);
    expect(isLegalTransition("PAUSED", "READY")).toBe(true);
    expect(isLegalTransition("BLOCKED", "READY")).toBe(true);
    expect(isLegalTransition("RUNNING", "PAUSED")).toBe(true);
  });

  it("终态不可再转移", () => {
    for (const terminal of TERMINAL_STATES) {
      expect(TRANSITIONS[terminal]).toEqual([]);
      expect(isTerminal(terminal)).toBe(true);
    }
    expect(isTerminal("RUNNING")).toBe(false);
  });

  it("所有状态都有转移行且自洽", () => {
    for (const state of TASK_STATES) {
      const row = TRANSITIONS[state];
      expect(row, `missing row for ${state}`).toBeDefined();
      for (const to of row) {
        expect(TASK_STATES).toContain(to);
      }
    }
  });

  it("Gate 锁定 VERIFYING->ACCEPTED(V08)", () => {
    expect(isGatedTransition("VERIFYING", "ACCEPTED")).toBe(true);
    expect(GATED_TRANSITIONS.has("VERIFYING->ACCEPTED")).toBe(true);
    expect(isGatedTransition("VERIFYING", "REWORK")).toBe(false);
    expect(isGatedTransition("RUNNING", "SUBMITTED")).toBe(false);
  });

  it("离开工作链释放租约", () => {
    expect(leaseReleasedOn("ACCEPTED")).toBe(true);
    expect(leaseReleasedOn("REWORK")).toBe(true);
    expect(leaseReleasedOn("RUNNING")).toBe(false);
    expect(leaseReleasedOn("SUBMITTED")).toBe(false);
  });
});
