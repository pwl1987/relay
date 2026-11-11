// 工具层与 Policy 层语义一致性(V02 对齐矩阵)+ relay_exec 环境清洗。
// 扩展自包含(checkReadScope),本测试用同一对抗矩阵固定它与 src/core/policy.ts 的一致性;
// 扩展侧额外做 realpath 解析 —— 符号链接逃逸在工具层即被阻断(P0-00 R1 残余风险的收口)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPathScope } from "../../src/core/policy.ts";
import { checkReadScope, runScopedExec, scrubExecEnv } from "../../src/runtime/relay-tools.extension.ts";

describe("工具层 × Policy 层 V02 对齐矩阵", () => {
  let root: string;
  beforeAll(() => {
    root = markTemp(mkdtempSync(join(tmpdir(), "relay-parity-")));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "in-root.txt"), "x");
    writeFileSync(join(root, "sub", "nested.txt"), "y");
    writeFileSync("/tmp/relay-parity-outside.txt", "outside");
    // 符号链接逃逸:root 内的链接指向 root 外
    symlinkSync("/tmp/relay-parity-outside.txt", join(root, "escape-link.txt"));
  });
  afterAll(() => {
    safeRm(root, { roots: [root], sentinel: RUN_SENTINEL });
    rmSync("/tmp/relay-parity-outside.txt", { force: true });
  });

  const cases: Array<{ name: string; path: () => string; allow: boolean }> = [
    { name: "root 内文件", path: () => join(root, "in-root.txt"), allow: true },
    { name: "root 内嵌套", path: () => join(root, "sub", "nested.txt"), allow: true },
    { name: "../ 穿越", path: () => join(root, "..", "relay-parity-escape-target"), allow: false },
    { name: "/etc/passwd", path: () => "/etc/passwd", allow: false },
    { name: "前缀字面命中(段边界)", path: () => root.replace(/\/$/, "") + "x/file.txt", allow: false },
  ];

  for (const c of cases) {
    it(`矩阵:${c.name} → ${c.allow ? "ALLOW" : "DENY"}(两层一致)`, () => {
      const path = c.path();
      const policy = checkPathScope([root], path);
      const tool = checkReadScope(root, path);
      expect(policy.allowed, `policy: ${policy.reason}`).toBe(c.allow);
      expect(tool.ok, `tool: ${tool.reason}`).toBe(c.allow);
    });
  }

  it("分层语义:授权(policy)与可实现性(tool)分离 —— 作用域内不存在的文件,policy 放行、tool 拒绝", () => {
    const path = join(root, "nope.txt");
    expect(checkPathScope([root], path).allowed).toBe(true); // 授权面:在作用域内
    const tool = checkReadScope(root, path);
    expect(tool.ok).toBe(false); // 工具面:realpath 失败,不可实现
    expect(tool.reason).toContain("resolve_failed");
  });

  it("符号链接逃逸:工具层 realpath 阻断(P0-00 R1 收口)", () => {
    const tool = checkReadScope(root, join(root, "escape-link.txt"));
    expect(tool.ok).toBe(false);
    expect(tool.reason).toContain("outside_allowed_root");
  });

  it("allowedRoot 未配置 ⇒ 一律拒绝(default deny 同源)", () => {
    expect(checkReadScope(null, join(root, "in-root.txt")).ok).toBe(false);
  });
});

describe("relay_exec 与环境清洗", () => {
  it("执行命令捕获 stdout/exitCode", () => {
    const r = runScopedExec({ cwd: tmpdir(), command: "echo relay-exec-ok", env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("relay-exec-ok");
  });

  it("非零退出如实回传", () => {
    const r = runScopedExec({ cwd: tmpdir(), command: "exit 3", env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode).toBe(3);
  });

  it("超时被硬性终止", () => {
    const r = runScopedExec({ cwd: tmpdir(), command: "sleep 30", timeoutMs: 500, env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode).not.toBe(0);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("scrubExecEnv 排除凭据类变量,仅白名单透传", () => {
    const env = scrubExecEnv({
      PATH: "/usr/bin",
      HOME: "/h",
      SSH_AUTH_SOCK: "/tmp/agent",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "y",
      DOCKER_HOST: "z",
      AWS_SECRET_ACCESS_KEY: "w",
      SECRET_EXTRA: "s",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/h");
    expect(Object.keys(env).join(",")).not.toMatch(/SSH|GH_|GITHUB|DOCKER|AWS|SECRET/);
  });
});
