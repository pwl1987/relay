// P0-02B 补验 F-4/N-4:拒绝提示的可行动性与"不得含禁止字符"不变量。
// 提示是给模型看的**示例文本**:若示例里出现被禁字符(; & | ` 换行 $( ${),模型照抄会再次被拒 ——
// 恰是本次要消除的回合浪费 ⇒ 此处用断言锁死。
import { describe, expect, it } from "vitest";
import { execDenialHint, readDenialHint } from "../../src/runtime/relay-tools.extension.ts";

// 与 checkCommandScope 同一禁止集
const FORBIDDEN = /[;&|`\n]/;

describe("P0-02B:relay_exec 拒绝提示(execDenialHint)", () => {
  it("已知拒绝原因均有提示", () => {
    expect(execDenialHint("shell_metacharacters_forbidden")).toBeTruthy();
    expect(execDenialHint("command_not_allowed:python3")).toBeTruthy();
    expect(execDenialHint("exec_not_authorized")).toBeTruthy();
    expect(execDenialHint("empty_command")).toBeTruthy();
    expect(execDenialHint(undefined)).toBe("");
    expect(execDenialHint("some_unknown_reason")).toBe("");
  });

  it("提示文本不含任何禁止字符(F-4 的不变量:模型照抄不会再被拒)", () => {
    const hints = [
      execDenialHint("shell_metacharacters_forbidden"),
      execDenialHint("command_not_allowed:python3"),
      execDenialHint("exec_not_authorized"),
      execDenialHint("empty_command"),
    ];
    for (const h of hints) {
      expect(h.length).toBeGreaterThan(0);
      expect(h.includes("`")).toBe(false); // 反引号本身是被禁字符
      expect(FORBIDDEN.test(h)).toBe(false); // ; & | ` 换行 均不得出现
      expect(h.includes("$(")).toBe(false);
      expect(h.includes("${")).toBe(false);
    }
  });

  it("提示给出可执行的下一步(写文件用重定向)", () => {
    const h = execDenialHint("shell_metacharacters_forbidden");
    expect(h).toContain("echo");
    expect(h).toContain("result.txt");
  });
});

describe("P0-02B:relay_read 拒绝提示(readDenialHint)", () => {
  it("覆盖 checkReadScope 的实际 reason 集合(N-6)", () => {
    expect(readDenialHint("allowed_root_not_configured")).toBeTruthy();
    expect(readDenialHint("outside_allowed_root:/workspace")).toBeTruthy();
    expect(readDenialHint("resolve_failed:EACCES")).toBeTruthy();
    expect(readDenialHint("resolve_failed:ENOENT")).toBeTruthy();
    expect(readDenialHint("not_regular_file")).toBeTruthy();
    expect(readDenialHint("stat_failed:EACCES")).toBeTruthy();
    expect(readDenialHint(undefined)).toBe("");
  });

  it("提示文本不含任何禁止字符", () => {
    const hints = [
      readDenialHint("allowed_root_not_configured"),
      readDenialHint("outside_allowed_root:/workspace"),
      readDenialHint("resolve_failed:EACCES"),
      readDenialHint("resolve_failed:ENOENT"),
      readDenialHint("not_regular_file"),
      readDenialHint("stat_failed:EACCES"),
    ];
    for (const h of hints) {
      expect(h.length).toBeGreaterThan(0);
      expect(FORBIDDEN.test(h)).toBe(false);
    }
  });
});
