// 清理安全中央守卫(P0-总包阶段 D4)。
// 背景:P0-ACCEPT 曾实锤 `tmpRoots.push(tmpdir())` 险删 /tmp(EPERM 拦下——"权限碰巧不足"不是安全)。
// 本模块提供纯逻辑守卫 safeRm:递归删除前强制校验,拒绝:
//   1) 绝对禁止面:根目录 "/"、系统临时根(/tmp 与 os.tmpdir())、当前仓库根(含其子树);
//   2) HOME 本体(子树须经显式 roots + 哨兵放行,如 ~/.relay/stage);
//   3) roots(本次创建记录)之外的一切路径;
//   4) 无哨兵文件的目标(哨兵在创建时写入,证明"该目录由本次运行创建");
//   5) symlink 逃逸(realpath 归一后再校验)。
// 用法:创建临时目录时 markRunDir(dir)(写哨兵);删除时 safeRm(dir, { roots: [...], sentinel: RUN_SENTINEL })。
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** 哨兵文件名(点前缀:不影响 workspace 清单/Discovery 文件列举)。 */
export const RUN_SENTINEL = ".relay-run-sentinel";

/** 仓库根(本文件位于 src/runtime/ ⇒ 上两级)。 */
export const REPO_ROOT = resolve(new URL("../../", import.meta.url).pathname);

export class SafeRmRefusalError extends Error {
  readonly target: string;
  readonly reason: string;
  constructor(target: string, reason: string) {
    super(`safeRm 拒绝删除 ${target}:${reason}`);
    this.name = "SafeRmRefusalError";
    this.target = target;
    this.reason = reason;
  }
}

/** 创建时打哨兵(证明目录归属;元数据留审计线索)。 */
export function markRunDir(dir: string, meta: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, RUN_SENTINEL),
    JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid, ...meta }),
    "utf8",
  );
}

/** mkdtemp 的守卫搭档:创建即打哨兵并原样返回(便于内联:`push(markTemp(mkdtempSync(...)))`)。 */
export function markTemp<T extends string>(dir: T): T {
  markRunDir(dir);
  return dir;
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * 受守卫的递归删除。任何拒绝都抛 SafeRmRefusalError(不静默、不降级)。
 * - force 语义与 rmSync 一致(目标不存在 ⇒ no-op);
 * - roots:本次运行创建的目录记录(允许目标=根或其子路径);
 * - sentinel:要求目标(或其位于某 root 内的祖先)存在哨兵文件。
 */
export function safeRm(
  target: string,
  opts: { roots: string[]; sentinel?: string },
): { ok: true } {
  if (!isAbsolute(target)) {
    throw new SafeRmRefusalError(target, "relative_path(必须显式绝对路径)");
  }
  // 归一化:存在的路径走 realpath(破 symlink 逃逸),不存在走 resolve(与 force 语义一致)
  let t: string;
  try {
    t = realpathSync(target);
  } catch {
    t = resolve(target);
  }
  // 1) 绝对禁止面(lexical,先于 no-op 短路:危险形状的目标无论是否存在都拒绝)
  // (先于 roots:即使误把禁止面声明进 roots 也拒)
  const forbiddenExact = new Set([resolve("/"), resolve("/tmp"), resolve(tmpdir()), resolve(homedir())]);
  if (forbiddenExact.has(t)) {
    throw new SafeRmRefusalError(t, "forbidden_exact(/、/tmp、tmpdir、HOME 本体)");
  }
  if (isWithin(t, REPO_ROOT)) {
    throw new SafeRmRefusalError(t, `repo_root_subtree(仓库根及其子树不可删除:${REPO_ROOT})`);
  }
  if (t === resolve(homedir())) {
    throw new SafeRmRefusalError(t, "home_exact");
  }
  // force 语义:目标不存在 ⇒ 无物可删,no-op(先于归属/哨兵校验)
  if (!existsSync(t)) {
    return { ok: true };
  }
  // 2) roots 归属(本此创建记录;无记录 ⇒ 拒)
  const roots = (opts.roots ?? []).map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
  if (roots.length === 0) throw new SafeRmRefusalError(t, "no_roots_declared(未声明本次创建记录)");
  const root = roots.find((r) => isWithin(t, r));
  if (!root) {
    throw new SafeRmRefusalError(t, `outside_declared_roots(${roots.map((r) => r).join(", ")})`);
  }
  // 3) 哨兵(目标自身或其位于 root 内的祖先;证明目录由本运行创建)
  if (opts.sentinel) {
    let probe = t;
    let found = false;
    for (;;) {
      if (existsSync(join(probe, opts.sentinel))) {
        found = true;
        break;
      }
      if (probe === root || !isWithin(probe, root)) break;
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
    if (!found) {
      throw new SafeRmRefusalError(t, `sentinel_missing(${opts.sentinel};目录非本运行创建或记录丢失)`);
    }
  }
  rmSync(t, { recursive: true, force: true });
  return { ok: true };
}
