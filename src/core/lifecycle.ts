// Relay Task 状态机(docs/DETAILED_ARCHITECTURE.md §3 的最小实现)。
// 纯函数,无 IO:转移合法性唯一由 TRANSITIONS 决定;任何状态推进必须经本表校验。
export const TASK_STATES = [
  "CREATED",
  "READY",
  "LEASED",
  "RUNNING",
  "SUBMITTED",
  "VERIFYING",
  "ACCEPTED",
  "REWORK",
  "NEEDS_RECONCILE",
  "NEEDS_DECISION",
  "PAUSED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ["ACCEPTED", "FAILED", "CANCELLED"];

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

// 持有租约的工作链状态:claim 后进入,advance 需 fencing
export const LEASED_CHAIN: readonly TaskState[] = [
  "LEASED",
  "RUNNING",
  "SUBMITTED",
  "VERIFYING",
];

export function inLeasedChain(state: string): boolean {
  return (LEASED_CHAIN as readonly string[]).includes(state);
}

export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  CREATED: ["READY", "BLOCKED", "FAILED", "CANCELLED"],
  READY: ["LEASED", "BLOCKED", "NEEDS_DECISION", "PAUSED", "FAILED", "CANCELLED"],
  LEASED: ["RUNNING", "NEEDS_RECONCILE", "FAILED", "CANCELLED"],
  RUNNING: [
    "SUBMITTED",
    "NEEDS_RECONCILE",
    "REWORK",
    "NEEDS_DECISION",
    "PAUSED",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ],
  SUBMITTED: ["VERIFYING", "NEEDS_RECONCILE", "FAILED", "CANCELLED"],
  // VERIFYING→NEEDS_DECISION(P0-02A):Gate 消费 BLOCK / Review 有界失败 ⇒ 需人裁决,
  // 永不自动批准(T07);恢复仅经 ops API(actor 授权 + state_version 校验)。
  VERIFYING: ["ACCEPTED", "REWORK", "NEEDS_DECISION", "NEEDS_RECONCILE", "FAILED", "CANCELLED"],
  REWORK: ["READY", "FAILED", "CANCELLED"],
  NEEDS_RECONCILE: ["READY", "BLOCKED", "FAILED", "CANCELLED"],
  // NEEDS_DECISION/PAUSED/BLOCKED -> READY 的恢复属 Supervisor/Owner 运维动作
  // (决策解析/恢复授权,P0-01C Goal Loop 落地;P0-01A 仅承载转移表合法性本身)
  NEEDS_DECISION: ["READY", "BLOCKED", "FAILED", "CANCELLED"],
  PAUSED: ["READY", "FAILED", "CANCELLED"],
  BLOCKED: ["READY", "FAILED", "CANCELLED"],
  ACCEPTED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isLegalTransition(from: string, to: string): boolean {
  const row = TRANSITIONS[from as TaskState];
  if (!row) return false;
  return row.includes(to as TaskState);
}

// 需要 Gate PASS 裁决的转移(V08 最小门锁;完整 Gate 编排属 P0-02A)
export const GATED_TRANSITIONS: ReadonlySet<string> = new Set(["VERIFYING->ACCEPTED"]);

export function isGatedTransition(from: string, to: string): boolean {
  return GATED_TRANSITIONS.has(`${from}->${to}`);
}

// 离开工作链的转移:成功提交后释放租约
export function leaseReleasedOn(to: string): boolean {
  return to === "ACCEPTED" || to === "REWORK";
}
