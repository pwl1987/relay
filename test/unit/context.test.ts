// Handoff 契约与上下文摘要单测(结构化 Handoff 是 Run 结果的唯一机器可读载体)。
import { describe, expect, it } from "vitest";
import { buildRunPrompt, contextDigest, parseHandoff } from "../../src/runtime/context.ts";

describe("relay-handoff 解析", () => {
  it("合法块解析成功", () => {
    const r = parseHandoff('前言\n```relay-handoff\n{"status":"done","summary":"ok"}\n```\n后记');
    expect(r.found).toBe(true);
    if (r.found) expect(r.handoff.summary).toBe("ok");
  });

  it("多个块以最后一个为准", () => {
    const r = parseHandoff(
      '```relay-handoff\n{"status":"blocked","summary":"first"}\n```\n中间\n```relay-handoff\n{"status":"done","summary":"last"}\n```',
    );
    expect(r.found).toBe(true);
    if (r.found) expect(r.handoff.summary).toBe("last");
  });

  it("缺失块如实报 absent(不虚构)", () => {
    expect(parseHandoff("没有块的普通输出")).toEqual({ found: false, error: "absent" });
  });

  it("畸形 JSON / 非法 status / 未闭合如实报 malformed", () => {
    expect(parseHandoff("```relay-handoff\n{bad json\n```").found).toBe(false);
    const badStatus = parseHandoff('```relay-handoff\n{"status":"wat","summary":"x"}\n```');
    expect(badStatus).toMatchObject({ found: false, error: "malformed" });
    expect(parseHandoff('```relay-handoff\n{"status":"done","summary":"x"}\n')).toMatchObject({
      found: false,
      error: "malformed",
    });
  });
});

describe("Run prompt 构建", () => {
  it("包含任务上下文/边界告知/handoff 契约;恢复 Run 注入重建说明", () => {
    const fresh = buildRunPrompt({
      taskId: "t1",
      attempt: 1,
      goal: "整理目录",
      allowedScope: ["/workspace"],
      workspacePath: "/workspace",
      priorHandoff: null,
    });
    expect(fresh).toContain("task: t1");
    expect(fresh).toContain("goal: 整理目录");
    expect(fresh).toContain("relay_read");
    expect(fresh).toContain("relay-handoff");
    expect(fresh).not.toContain("上次 Run");

    const rebuilt = buildRunPrompt({
      taskId: "t1",
      attempt: 2,
      goal: "整理目录",
      allowedScope: ["/workspace"],
      workspacePath: "/workspace",
      priorHandoff: { runId: "run-x", resumeMode: "context_rebuild", handoff: { status: "done", summary: "半程" }, note: "n" },
    });
    expect(rebuilt).toContain("context_rebuild");
    expect(rebuilt).toContain("半程");
    expect(rebuilt).toContain("请以此重建工作认知");
  });

  it("contextDigest 稳定且区分内容", () => {
    expect(contextDigest("a")).toBe(contextDigest("a"));
    expect(contextDigest("a")).not.toBe(contextDigest("b"));
    expect(contextDigest("a")).toHaveLength(64);
  });
});
