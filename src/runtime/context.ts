// Run Context 与结构化 Handoff(P0-01B 合同条款 4;ADR-0003:Session 仅保留
// Run Context/Checkpoint/Handoff/恢复引用;恢复 = 重建上下文,不假装恢复模型内部状态)。
import { createHash } from "node:crypto";

export interface RunContextInput {
  taskId: string;
  attempt: number;
  goal: string;
  allowedScope: readonly string[];
  workspacePath: string; // 容器内视角(/workspace)或宿主路径(host-fallback)
  priorHandoff?: {
    runId: string;
    resumeMode: "context_rebuild";
    handoff: Handoff | null;
    note: string;
  } | null;
  extraInstructions?: string;
}

export interface Handoff {
  status: "done" | "blocked" | "need_input";
  summary: string;
  [k: string]: unknown;
}

export type HandoffParse =
  | { found: true; handoff: Handoff }
  | { found: false; error: "absent" | "malformed"; detail?: string };

/**
 * 构造 Run prompt:任务上下文 + 工具边界告知 + Handoff 契约。
 * 上下文与指令都以文本进入模型;授权边界不依赖模型遵守(Policy+OS 层强制),这里只做告知。
 */
export function buildRunPrompt(input: RunContextInput): string {
  const lines: string[] = [];
  lines.push("# Relay Task Run");
  lines.push(`task: ${input.taskId} (attempt ${input.attempt})`);
  lines.push(`goal: ${input.goal}`);
  lines.push(`workspace: ${input.workspacePath}`);
  lines.push(`allowed scope: ${input.allowedScope.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("工具边界:你只有 relay_read 与 relay_exec 两个工具;只能访问 workspace 内的文件。");
  lines.push("越权访问会被拒绝并记录;不要尝试绕过。");
  if (input.priorHandoff) {
    lines.push("");
    lines.push(`# 上次 Run 的 Handoff(run ${input.priorHandoff.runId},恢复方式:${input.priorHandoff.resumeMode})`);
    lines.push("上次 Run 的进程与会话状态已丢失;以下是落库的 Handoff 记录,请以此重建工作认知:");
    lines.push(input.priorHandoff.handoff ? JSON.stringify(input.priorHandoff.handoff, null, 1) : "(无结构化 handoff,仅有任务上下文)");
    lines.push(`note: ${input.priorHandoff.note}`);
  }
  if (input.extraInstructions) {
    lines.push("");
    lines.push(input.extraInstructions);
  }
  lines.push("");
  lines.push("完成(或无法推进)时,最后一律输出如下 fenced 块(必须合法 JSON):");
  lines.push("```relay-handoff");
  lines.push('{"status":"done|blocked|need_input","summary":"<一句话结果>"}');
  lines.push("```");
  return lines.join("\n");
}

export function contextDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/** 解析最后一个 relay-handoff fenced 块(模型可能输出多个,以最后为准)。 */
export function parseHandoff(assistantText: string): HandoffParse {
  const fence = "```relay-handoff";
  const last = assistantText.lastIndexOf(fence);
  if (last < 0) return { found: false, error: "absent" };
  const bodyStart = last + fence.length;
  const close = assistantText.indexOf("```", bodyStart);
  if (close < 0) return { found: false, error: "malformed", detail: "unclosed fence" };
  const body = assistantText.slice(bodyStart, close).trim();
  try {
    const parsed = JSON.parse(body) as Handoff;
    if (typeof parsed.status !== "string" || typeof parsed.summary !== "string") {
      return { found: false, error: "malformed", detail: "missing status/summary" };
    }
    if (!["done", "blocked", "need_input"].includes(parsed.status)) {
      return { found: false, error: "malformed", detail: `bad status:${parsed.status}` };
    }
    return { found: true, handoff: parsed };
  } catch (e) {
    return { found: false, error: "malformed", detail: (e as Error).message };
  }
}
