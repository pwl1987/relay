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
  D3: "永不超时自动批准:超时仅标记 EXPIRED_STILL_BLOCKED,任务停留 NEEDS_DECISION 等待人",
  D4: "禁止(创建即拒绝)",
};

export const IN_FLIGHT_STATES = ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"];

/** P0-UI-4:决策支持五要素(全部由既有列确定性推导;不伪造系统未有的判断)。 */
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
    D2: "D2 级决策:仅当创建时已声明 fallback 才可由循环自动执行;当前行等待人工裁决或按已授权 fallback 处理。",
    D3: "D3 级决策:涉及需人工批准的事项(Gate 消费 BLOCK、Review 有界失败或外部副作用),**永不超时自动批准**。",
    D4: "D4 级:系统禁止此类决策(创建即拒绝)。",
  };
  const why =
    (levelWhy[input.level] ?? "级别 " + input.level + " 需人工裁决。") +
    (input.taskState ? " 任务当前 " + input.taskState + ",在裁决前不推进。" : "") +
    (input.blockedReason ? " 阻塞原因:" + input.blockedReason : "");
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
        ? "未登记专用风险说明;该决策关联的操作按架构要求可回滚(交付绑定远端 SHA,本地 bare/真实远端均可核对)。"
        : "未登记专用风险说明;请结合问题与受影响文件评估。";
  const impactOfNoAction =
    (input.deadline ? "期限 " + input.deadline + ";逾期 " : "无期限;") +
    (input.level === "D3"
      ? "仅标记 EXPIRED_STILL_BLOCKED,任务停留等待,**不会自动批准**;其他安全任务不受影响继续推进。"
      : "按超时语义处理(见超时行为)。");
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
