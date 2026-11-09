// V02 最小作用域策略(确定性函数,不依赖模型):默认拒绝(NFR-03)。
// 完整 Operator Policy 引擎属 P0-01B/P0-02;本文件只承载"越权写 DENIED"的状态层语义。
export interface ScopeVerdict {
  allowed: boolean;
  reason: string;
}

// 将路径规范化为绝对 POSIX 路径;拒绝越出根的 ".."(返回 null 表示非法)。
export function normalizePath(input: string): string | null {
  if (input.includes("\0")) return null;
  const isAbs = input.startsWith("/");
  const parts = input.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        if (isAbs) return null; // /.. 越出根
        return null; // 相对路径越出基准,视为非法(本层只接受绝对路径)
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (!isAbs) return null; // 本层策略只接受绝对路径,避免相对基准歧义
  return "/" + out.join("/");
}

function hasPathPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(prefix + "/");
}

// allowedScope 为空 ⇒ 一律 DENIED(默认拒绝)。
// 目录前缀必须按路径段匹配:/work/src 不放行 /work/srcx。
export function checkPathScope(scope: readonly string[], path: string): ScopeVerdict {
  const norm = normalizePath(path);
  if (norm === null) {
    return { allowed: false, reason: "invalid_path" };
  }
  if (scope.length === 0) {
    return { allowed: false, reason: "scope_empty_default_deny" };
  }
  const prefixes: string[] = [];
  for (const entry of scope) {
    const p = normalizePath(entry);
    if (p === null) {
      return { allowed: false, reason: "invalid_scope_entry" };
    }
    prefixes.push(p);
  }
  for (const prefix of prefixes) {
    if (hasPathPrefix(norm, prefix)) {
      return { allowed: true, reason: "in_scope" };
    }
  }
  return { allowed: false, reason: "path_outside_allowed_scope" };
}
