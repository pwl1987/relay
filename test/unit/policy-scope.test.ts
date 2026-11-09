// V02 最小作用域单测:越权写 DENIED,目标语义为确定性函数(默认拒绝,NFR-03)。
import { describe, expect, it } from "vitest";
import { checkPathScope, normalizePath } from "../../src/core/policy.ts";

describe("V02 路径作用域策略", () => {
  it("空作用域 = 默认拒绝", () => {
    expect(checkPathScope([], "/work/src/a.ts").allowed).toBe(false);
    expect(checkPathScope([], "/work/src/a.ts").reason).toBe("scope_empty_default_deny");
  });

  it("作用域内精确与子路径放行", () => {
    const scope = ["/work/src", "/docs"];
    expect(checkPathScope(scope, "/work/src/a.ts").allowed).toBe(true);
    expect(checkPathScope(scope, "/work/src/sub/deep/b.ts").allowed).toBe(true);
    expect(checkPathScope(scope, "/docs/readme.md").allowed).toBe(true);
    expect(checkPathScope(scope, "/work/src").allowed).toBe(true); // 前缀本身即边界
  });

  it("路径段边界:/work/src 不放行 /work/srcx", () => {
    const scope = ["/work/src"];
    expect(checkPathScope(scope, "/work/srcx/evil.ts").allowed).toBe(false);
    expect(checkPathScope(scope, "/work/srcx").allowed).toBe(false);
  });

  it("越权路径 DENIED 且目标不变语义(V02 主断言)", () => {
    const scope = ["/work/src"];
    const outside = checkPathScope(scope, "/etc/passwd");
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toBe("path_outside_allowed_scope");
    expect(checkPathScope(scope, "/home/ubuntu/.ssh/id_rsa").allowed).toBe(false);
    expect(checkPathScope(scope, "/work/other/file").allowed).toBe(false);
  });

  it("目录穿越被拒", () => {
    const scope = ["/work/src"];
    expect(checkPathScope(scope, "/work/src/../../../etc/passwd").allowed).toBe(false);
    expect(normalizePath("/work/src/../../../etc/passwd")).toBeNull();
    expect(normalizePath("/../etc")).toBeNull();
    expect(normalizePath("relative/path")).toBeNull(); // 本层只接受绝对路径
  });

  it("合法规范化", () => {
    expect(normalizePath("/work/src/./sub/../a.ts")).toBe("/work/src/a.ts");
    expect(normalizePath("/work/src//double//slash")).toBe("/work/src/double/slash");
  });

  it("作用域条目非法即拒绝(配置错误不得放行)", () => {
    expect(checkPathScope(["../escape"], "/anything").allowed).toBe(false);
    expect(checkPathScope(["../escape"], "/anything").reason).toBe("invalid_scope_entry");
  });

  it("NUL 字节拒绝", () => {
    expect(checkPathScope(["/work"], "/work/a\0b").allowed).toBe(false);
    expect(normalizePath("/work/a\0b")).toBeNull();
  });
});
