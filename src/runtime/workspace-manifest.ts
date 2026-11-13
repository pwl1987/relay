// Run 工作区清单采集(P0-02A C-1 的 runtime 侧;core/changesets.ts 承载 diff/落库)。
// 语义:递归清单(相对路径 -> 内容 sha256),排除 .relay(Worker 审计目录,非候选内容)。
// Worker 侧采集(可信执行器),模型不可参与;符号链接跳过(不追随,防逃逸)。
import { createHash, type Hash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { WorkspaceManifest } from "../core/changesets.ts";
import { manifestSha } from "../core/changesets.ts";

// P0-02B:候选面语义 = 工作文件;".git" 是仓库元数据(候选 commit 由 git-candidate 单独构建),
// 混入清单会让 candidate_sha 随 git 内部状态抖动。既有测试种子无 .git,行为兼容。
export const MANIFEST_EXCLUDE = new Set([".relay", ".git"]);

export function snapshotManifest(rootDir: string): WorkspaceManifest {
  const manifest = new Map<string, string>();
  if (!existsSync(rootDir)) return manifest;
  walk(rootDir, rootDir, manifest);
  return manifest;
}

function walk(root: string, dir: string, out: Map<string, string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录跳过(如实缺失,不虚构)
  }
  for (const e of entries) {
    if (MANIFEST_EXCLUDE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue; // 不追随链接(防逃逸)
    if (e.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    let hash: Hash;
    try {
      hash = createHash("sha256");
      hash.update(readFileSync(full));
    } catch {
      continue; // 不可读文件跳过
    }
    const rel = relative(root, full).split(sep).join("/");
    out.set(rel, hash.digest("hex"));
  }
}

// ---------- 候选清单复验(RELAY-QUALITY-LOCAL-01 D1:生产默认机器证据) ----------

export interface CandidateManifestVerifyResult {
  ok: boolean;
  rawOutput: string;
}

/**
 * 内建确定性检查:重采候选工作区清单并与变更集 candidate_sha 比对。
 * 通过 ⇔ 清单哈希一致 **且** 变更集非空(零编辑空提交拦截,F1 历史失败模式)。
 * 失败 ⇒ 候选内容与 Gate 绑定面不一致或为空,不得放行。纯确定性,无模型参与。
 */
export function verifyCandidateManifest(
  workspaceDir: string,
  candidateSha: string,
  changedFileCount: number,
): CandidateManifestVerifyResult {
  const lines: string[] = [
    `workspace=${workspaceDir}`,
    `candidate_sha256=${candidateSha}`,
    `changed_files=${changedFileCount}`,
  ];
  try {
    const manifest = snapshotManifest(workspaceDir);
    const actual = manifestSha(manifest);
    const ok = actual === candidateSha && changedFileCount > 0;
    lines.push(`files=${manifest.size}`, `manifest_sha256=${actual}`, ok ? "verify=ok" : "verify=mismatch");
    return { ok, rawOutput: lines.join("\n") };
  } catch (err) {
    lines.push(`verify=error:${(err as Error).message}`);
    return { ok: false, rawOutput: lines.join("\n") };
  }
}
