// Pi 版本锁定(P0-01B 合同条款 2)。
// Relay 只允许 vendored 安装(@earendil-works/pi-coding-agent,精确版本入 package-lock),
// 禁止依赖可能自行更新的全局 pi(P0-00 实测:实验期间 1.4.0 自更新为 1.5.0)。
// 双重校验:包声明版本 + 实际执行 --version 输出,三方(锁定常量/包声明/二进制)一致才放行。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { markRunDir, safeRm, RUN_SENTINEL } from "./safe-rm.ts";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 锁定的 Pi 版本(升级必须改这里 + package.json,并在 REVIEW 中留证)。 */
export const RELAY_PI_VERSION = "1.5.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface PiInstallation {
  /** dist/bundle/cli.js 绝对路径(以 node <cliPath> 方式执行,绝不走 PATH)。 */
  cliPath: string;
  /** 包声明版本。 */
  version: string;
  /** 包目录(容器只读挂载来源)。 */
  packageDir: string;
  /** 仓库根(= node_modules 父目录)。 */
  repoRoot: string;
}

/** 从本文件位置向上找 package.json,确定仓库根(测试/运行共用,不依赖 cwd)。 */
export function resolveRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsPackageJson(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found from ${import.meta.url}`);
}

function existsPackageJson(dir: string): boolean {
  return existsSync(join(dir, "package.json"));
}

/**
 * 解析 vendored Pi:路径直接钉死为 <repoRoot>/node_modules/@earendil-works/pi-coding-agent。
 * 不走任何模块解析 API(该包 ESM-only 的 exports 无 require 条件,且解析会引入
 * 全局/上级目录歧义)—— 钉死路径即"禁依赖全局 pi"的结构性保证。
 * 未安装(全新克隆未 npm ci)或版本不符即抛错(拒启)。
 */
export function resolveVendoredPi(repoRoot: string = resolveRepoRoot()): PiInstallation {
  const packageDir = join(repoRoot, "node_modules", PI_PACKAGE);
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`vendored pi missing at ${packageDir}(先 npm ci 安装锁定版本)`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version: string;
    bin: { pi: string };
  };
  if (pkg.version !== RELAY_PI_VERSION) {
    throw new Error(
      `vendored pi version mismatch: package=${pkg.version} locked=${RELAY_PI_VERSION}(升级须改 RELAY_PI_VERSION 并留证)`,
    );
  }
  const cliPath = join(packageDir, pkg.bin.pi);
  if (!existsSync(cliPath)) throw new Error(`pi cli missing: ${cliPath}`);
  return { cliPath, version: pkg.version, packageDir, repoRoot: resolve(repoRoot) };
}

/**
 * 运行时二探:实际执行 vendored cli --version,与锁定常量一致才放行。
 * 用一次性临时 HOME,避免读取/写入任何共享 ~/.pi。
 */
export function verifyPiRuntime(pi: PiInstallation): { cliPath: string; version: string } {
  const scratchHome = mkdtempSync(join(tmpdir(), "relay-pi-verify-"));
  markRunDir(scratchHome, { kind: "pi-version-scratch" });
  try {
    const out = execFileSync(process.execPath, [pi.cliPath, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { HOME: scratchHome, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb" },
    }).trim();
    if (out !== RELAY_PI_VERSION) {
      throw new Error(`pi runtime version mismatch: binary=${out} locked=${RELAY_PI_VERSION}`);
    }
    return { cliPath: pi.cliPath, version: out };
  } finally {
    safeRm(scratchHome, { roots: [scratchHome], sentinel: RUN_SENTINEL });
  }
}
