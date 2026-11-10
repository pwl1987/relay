// relay_exec 命令白名单矩阵(P0-01C C-1;V02 段语义的命令版)。
import { describe, expect, it } from "vitest";
import { checkCommandScope } from "../../src/runtime/relay-tools.extension.ts";

describe("checkCommandScope(最小命令能力)", () => {
  it("空白名单 ⇒ 一律拒绝(任务未授权命令能力)", () => {
    expect(checkCommandScope(null, "ls").ok).toBe(false);
    expect(checkCommandScope([], "ls").ok).toBe(false);
    expect(checkCommandScope([], "ls").reason).toBe("exec_not_authorized");
  });

  it("前缀匹配:精确相等或前缀+空格(段边界)", () => {
    const allow = ["node", "npm test", "ls -la"];
    expect(checkCommandScope(allow, "node").ok).toBe(true);
    expect(checkCommandScope(allow, "node server.js").ok).toBe(true);
    expect(checkCommandScope(allow, "npm test -- --run").ok).toBe(true);
    expect(checkCommandScope(allow, "ls -la /workspace").ok).toBe(true);
    // 段边界:不允许 "npmx" 因 "npm" 放行
    expect(checkCommandScope(allow, "npmx").ok).toBe(false);
    expect(checkCommandScope(allow, "npm run x").ok).toBe(false); // "npm test" ≠ "npm run"
  });

  it("shell 控制字符全禁(白名单只针对单条简单命令)", () => {
    const allow = ["echo"];
    for (const bad of [
      "echo a;cat /etc/passwd",
      "echo a|cat",
      "echo a&whoami",
      "echo `id`",
      "echo a\nrm -rf /",
      "echo $(cat /etc/passwd)", // 命令替换(复核 MAJOR:此前未禁)
      "echo ${HOME}/secret", // 变量展开逃逸
      "echo $((1+1))", // 算术展开
    ]) {
      const r = checkCommandScope(allow, bad);
      expect(r.ok, bad).toBe(false);
      expect(r.reason).toBe("shell_metacharacters_forbidden");
    }
  });

  it("越权命令给出首 token 拒绝原因(可审计)", () => {
    const r = checkCommandScope(["node"], "cat /etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("command_not_allowed:cat");
  });
});
