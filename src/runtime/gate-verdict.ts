// Reviewer 裁决围栏解析(P0-02A C-2):结构化裁决的唯一可信入口。
// 围栏形态(Run 输出内,最后一个生效):
//   ```relay-gate-verdict
//   verdict: PASS | REWORK | BLOCK
//   findings: 自由文本(可多行)
//   ```
// 解析失败/无围栏/verdict 非法 ⇒ found:false —— 不猜测、不默认 PASS(缺省即不通过)。
export type ParsedGateVerdict =
  | { found: true; verdict: "PASS" | "REWORK" | "BLOCK"; findings: string }
  | { found: false; error: string };

const FENCE_RE = /```relay-gate-verdict\s*\n([\s\S]*?)```/g;
const VERDICTS = new Set(["PASS", "REWORK", "BLOCK"]);

export function parseGateVerdict(text: string): ParsedGateVerdict {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) return { found: false, error: "no_gate_verdict_fence" };
  const body = matches[matches.length - 1]![1] ?? "";
  let verdict: string | null = null;
  let findings: string | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(verdict|findings)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "verdict") verdict = m[2]!.trim().toUpperCase();
    else findings = m[2]!.trim();
  }
  if (!verdict || !VERDICTS.has(verdict)) return { found: false, error: `invalid_verdict:${verdict ?? "missing"}` };
  return { found: true, verdict: verdict as "PASS" | "REWORK" | "BLOCK", findings: findings ?? "" };
}

/** 构建 Reviewer 提示词(上下文隔离:需求 + 变更集 + 证据摘要;**不含 Coder Handoff 叙事**)。 */
export function buildReviewerPrompt(input: {
  taskId: string;
  attempt: number;
  goalText: string;
  changedFiles: Record<string, string[]>;
  candidateSha: string;
  evidenceSummaries: Array<{ id: string; kind: string; passed: boolean }>;
  workspacePath: string;
}): string {
  const files = [
    ...input.changedFiles.added?.map((p) => `+ ${p}`) ?? [],
    ...input.changedFiles.modified?.map((p) => `~ ${p}`) ?? [],
    ...input.changedFiles.removed?.map((p) => `- ${p}`) ?? [],
  ].join("\n");
  const evidence = input.evidenceSummaries
    .map((e) => `- [${e.kind}] id=${e.id} passed=${e.passed}`)
    .join("\n");
  return [
    `你是独立质量 Reviewer(与实现者完全独立的 Run,不得采信实现者的自我陈述)。`,
    `任务 ${input.taskId}(attempt ${input.attempt})的需求:`,
    input.goalText,
    ``,
    `候选变更(清单 sha256=${input.candidateSha}):`,
    files || "(无文件变更)",
    ``,
    `Worker 侧证据摘要:`,
    evidence || "(无)",
    ``,
    `要求:`,
    `1) 用 relay_read 检查 ${input.workspacePath} 中被修改/新增的文件,对照需求独立核验;`,
    `2) 证据为 Worker 侧可信采集,可采信其 passed 字段,但内容正确性由你判断;`,
    `3) 输出必须以如下围栏结尾,否则视为无效审查:`,
    "```relay-gate-verdict",
    "verdict: PASS|REWORK|BLOCK",
    "findings: <一句话结论>",
    "```",
    `标准:满足需求且无缺陷=PASS;有可修复缺陷=REWORK;严重问题/越界/不可验收=BLOCK。`,
  ].join("\n");
}
