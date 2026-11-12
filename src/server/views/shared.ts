// 只读视图·公共层(WEB-UX-01 §4.3 自 src/server/views.ts 最小拆分;行为不变)。
// 铁律不变:本目录**只含 SELECT**(src/server/views.ts 时代即如此);不产生状态、不写库、
// 不复制第二套状态机;可用动作由 core 的转移表裁决。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLegalTransition } from "../../core/lifecycle.ts";

export type Row = Record<string, unknown>;

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function num(v: unknown): number {
  return Number(v ?? 0);
}

export function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

export function repoRootFromModule(): string {
  // src/server/views/shared.ts ⇒ 仓库根(与 process.cwd 解耦)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

// ---------------- 跨页共享的任务/运行/变更集/决策形状 ----------------

export interface TaskStateCounts {
  [state: string]: number;
}

export interface TaskView {
  id: string;
  goalId: string | null;
  state: string;
  stateVersion: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  gateRequired: boolean;
  allowedScope: string[];
  allowedCommands: string[];
  blockedReason: string | null;
  retryNotBefore: string | null;
  createdAt: string;
  updatedAt: string;
  openDecision: { id: string; level: string; question: string; state: string; deadline: string | null } | null;
  availableActions: Array<{ id: string; label: string; toState: string }>;
}

export interface EvidenceView {
  id: string;
  kind: string;
  passed: boolean;
  attempt: number;
  candidateSha: string;
  contentSha256: string;
  producedBy: string;
  createdAt: string;
  rawOutput: string;
  env: Record<string, unknown>;
}

export interface GateVerdictView {
  id: string;
  verdict: string;
  reviewer: string;
  attempt: number | null;
  candidateSha: string | null;
  requirementSha: string | null;
  reviewerRunId: string | null;
  coderRunId: string | null;
  evidenceIds: string[];
  testEnv: Record<string, unknown>;
  consumedAt: string | null;
  consumedBy: string | null;
  createdAt: string;
  /** 证据是否来自当前候选(SHA 不匹配 ⇒ 需重验) */
  staleEvidence: boolean;
}

export interface ChangesetSummary {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  baseSha: string;
  candidateSha: string;
  requirementSha: string;
  gitBaseCommitSha: string | null;
  gitTreeSha: string | null;
  gitCommitSha: string | null;
  changedFiles: { added: string[]; modified: string[]; removed: string[] };
  impactScope: { inScope: string[]; violations: string[] };
  deliveryState: string;
  deliveredRemoteHead: string | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  taskId: string;
  attempt: number;
  outcome: string;
  sandbox: string;
  modelRef: string;
  role: string | null;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface DecisionGuidance {
  why: string;
  recommended: string | null;
  alternatives: string[];
  risk: string | null;
  impactOfNoAction: string;
}

export interface DecisionView {
  id: string;
  taskId: string | null;
  goalId: string | null;
  level: string;
  question: string;
  fallback: Record<string, unknown> | null;
  deadline: string | null;
  state: string;
  verdict: Record<string, unknown> | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  taskState: string | null;
  taskStateVersion: number | null;
  /** 超时后的默认行为(D3 恒为"永不自动批准") */
  timeoutBehavior: string;
  affectedFiles: string[];
  reversible: boolean;
  canApprove: boolean;
  canReject: boolean;
  canDefer: boolean;
  /** OPERATOR-CONSOLE-00 P0-UI-4:决策支持五要素(为何需人工/推荐/备选/风险/不处理影响) */
  guidance: DecisionGuidance;
}

export const TIMEOUT_BEHAVIOR: Record<string, string> = {
  D0: "作用域内自动执行(不产生决策行)",
  D1: "作用域内自动执行(不产生决策行)",
  D2: "仅按创建时已声明的 fallback 自动执行",
  D3: "永不自动批准:超时后任务保持等待,直到你亲自处理",
  D4: "禁止(创建即拒绝)",
};

export const IN_FLIGHT_STATES = ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"];

/** P0-UI-4:决策支持五要素(全部由既有列确定性推导;不伪造系统未有的判断)。
 *  WEB-UX-02:文案改用户语言,不在给普通用户的解释里出现内部级别/枚举术语。 */
export function decisionGuidance(input: {
  level: string;
  question: string;
  fallback: Record<string, unknown> | null;
  taskState: string | null;
  blockedReason: string | null;
  deadline: string | null;
  reversible: boolean;
}): DecisionGuidance {
  const levelWhy: Record<string, string> = {
    D2: "这件事按任务创建时登记的预案处理;当前正在等待你确认,或按已登记预案执行。",
    D3: "这件事需要你亲自决定(涉及结果验收、复核未通过或对外操作)。Relay 永远不会替你自动批准。",
    D4: "该类操作被安全策略禁止(系统创建即拒绝)。",
  };
  const why =
    (levelWhy[input.level] ?? "这件事需要人工确认后才能继续。") +
    (input.taskState ? " 相关任务当前处于等待状态,在你处理前不会继续推进。" : "") +
    (input.blockedReason ? " 原因:" + input.blockedReason : "");
  const fb = input.fallback ?? {};
  const recommendedRaw = fb["recommended"] ?? fb["action"] ?? null;
  const recommended =
    typeof recommendedRaw === "string" && recommendedRaw.trim()
      ? recommendedRaw
      : recommendedRaw && typeof recommendedRaw === "object"
        ? JSON.stringify(recommendedRaw)
        : null;
  const alternatives = Array.isArray(fb["alternatives"])
    ? (fb["alternatives"] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const riskRaw = fb["risk"] ?? null;
  const risk =
    typeof riskRaw === "string" && riskRaw.trim()
      ? riskRaw
      : input.reversible
        ? "未登记专门的风险说明;相关操作按架构要求可回滚(交付绑定远端提交,可核对)。"
        : "未登记专门的风险说明;请结合问题与受影响文件评估。";
  const impactOfNoAction =
    (input.deadline ? "逾期后:" : "") +
    (input.level === "D3"
      ? "任务会继续等你,其他工作不受影响,不会自动批准。"
      : "将按超时规则处理;任务保持等待,不会自动通过。");
  return {
    why,
    recommended,
    alternatives,
    risk,
    impactOfNoAction,
  };
}

export function availableActionsFor(task: TaskView, hasOpenDecision: boolean): TaskView["availableActions"] {
  const actions: TaskView["availableActions"] = [];
  const can = (to: string): boolean => isLegalTransition(task.state, to);
  if (task.state === "NEEDS_DECISION" && hasOpenDecision) {
    if (can("READY")) actions.push({ id: "decision_approve", label: "批准决策(任务→READY)", toState: "READY" });
    if (can("FAILED")) actions.push({ id: "decision_reject", label: "拒绝决策(任务→FAILED)", toState: "FAILED" });
  }
  if (["BLOCKED", "PAUSED", "NEEDS_RECONCILE"].includes(task.state)) {
    if (can("READY")) actions.push({ id: "resume", label: "恢复任务(→READY)", toState: "READY" });
  }
  return actions;
}
