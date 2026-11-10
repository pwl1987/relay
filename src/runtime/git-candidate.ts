// 候选 Git Commit 构建(P0-02B D-2/D-3 runtime 侧;core/delivery.ts 承载编排与落库)。
// 语义:
//  - 候选内容是 Run 工作区的**未提交工作树**,且沙箱 run 目录在证据采集后即删;
//    因此 commit 在独立的 stage 仓库构建(clone 工作区仓库 → 覆写候选内容 → commit),
//    stage 仓库生命周期由调用方持有(交付完成/冲突处置后可删;refs/relay-candidates/ 防对象被 gc)。
//  - 三 SHA 区分(D-1):candidate_sha=清单内容 sha256(changesets.ts)≠ git tree sha ≠ git commit sha。
//  - 往返核验(D-2):commit 树逐文件内容 sha256 必须等于候选清单;不一致 ⇒ 阻断(content_mismatch)。
//    清单语义 = 常规文件(workspace-manifest:排除 .relay/.git,不追随符号链接);
//    stage 树中残留的符号链接先移除后再 add,保证树路径集合 == 清单路径集合。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, copyFileSync, rmSync, existsSync, statSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceManifest } from "../core/changesets.ts";
import type { CommitBinding } from "../core/delivery.ts";

const execFileP = promisify(execFile);

export class GitCandidateError extends Error {
  // 注意:不得用 TS 参数属性(constructor(readonly x))——裸 node strip-types 子进程不支持
  // (run-worker 等故障注入 helper 经裸 node 加载 runner ⇒ git-candidate,参数属性会炸掉启动)。
  reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `git-candidate: ${reason}`);
    this.reason = reason;
  }
}

/** git 子进程封装:显式 stdio pipe;错误消息只带 stderr 尾(不放大日志面)。 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitCandidateError("git_failed", `git ${args[0]} failed: ${(e.stderr ?? e.message ?? "").trim().slice(-500)}`);
  }
}

/** 二进制安全读取 blob(清单散列基于原始字节;utf8 解码会破坏非文本内容比对)。 */
async function gitBuffer(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 递归移除 stage 工作树内的符号链接(对齐清单语义:不追随、不入候选树)。 */
function stripSymlinks(root: string, dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      unlinkSync(full);
      continue;
    }
    if (e.isDirectory()) stripSymlinks(root, full);
  }
}

/** 把候选清单语义的内容同步进 stage 工作树:应用 diff(增/改/删),源是 Run 工作区。 */
function applyCandidate(stageDir: string, workspaceDir: string, diff: { added: string[]; modified: string[]; removed: string[] }): void {
  for (const rel of [...diff.added, ...diff.modified]) {
    const src = join(workspaceDir, ...rel.split("/"));
    const dst = join(stageDir, ...rel.split("/"));
    if (!existsSync(src) || lstatSync(src).isSymbolicLink()) continue; // 清单语义外(理论不可达),树核验兜底
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    chmodSync(dst, statSync(src).mode); // 保留可执行位等
  }
  for (const rel of diff.removed) {
    const dst = join(stageDir, ...rel.split("/"));
    if (existsSync(dst)) rmSync(dst, { force: true });
  }
}

export interface CandidateCommitResult {
  stageRepoDir: string;
  baseCommitSha: string;
  treeSha: string;
  commitSha: string;
  /** 树==清单往返核验通过(commit 后逐文件 sha256 对比候选清单) */
  treeVerified: true;
  filesChanged: number;
}

export interface CreateCandidateCommitInput {
  workspaceDir: string;
  /** 候选状态相对的基线 commit(= Run 工作区仓库在 Run 前的 HEAD) */
  baseCommitSha: string;
  /** Run 后完整候选清单(runner 采集;核验基准) */
  candidateManifest: WorkspaceManifest;
  /** 变更集 diff(recordChangeset 已产出的增/改/删清单) */
  diff: { added: string[]; modified: string[]; removed: string[] };
  taskId: string;
  attempt: number;
  changesetId: string;
  /** stage 仓库宿主位置(调用方生命周期;不得位于沙箱 run 目录内) */
  stagingDir: string;
}

/**
 * 在独立 stage 仓库构建候选 commit(克隆工作区仓库 → 覆写候选内容 → commit → 树往返核验)。
 * 工作区仓库必须是 git 仓库且 baseCommitSha 存在;任何不一致抛 GitCandidateError(阻断,不进 Proposal)。
 */
export async function createCandidateCommit(input: CreateCandidateCommitInput): Promise<CandidateCommitResult> {
  if (!existsSync(join(input.workspaceDir, ".git"))) {
    throw new GitCandidateError("not_a_git_workspace", `workspace is not a git repo: ${input.workspaceDir}`);
  }
  // base commit 必须存在(cat-file -e 以 commit 语义)
  await git(input.workspaceDir, "cat-file", "-e", `${input.baseCommitSha}^{commit}`);
  mkdirSync(input.stagingDir, { recursive: true });
  const stageRepoDir = join(input.stagingDir, `relay-stage-${input.changesetId}-${randomUUID().slice(0, 8)}`);
  // --no-local --no-hardlinks:独立对象副本(源 run 目录之后会被删除)
  await git(input.workspaceDir, "clone", "--no-local", "--no-hardlinks", "--quiet", input.workspaceDir, stageRepoDir);
  try {
    applyCandidate(stageRepoDir, input.workspaceDir, input.diff);
    stripSymlinks(stageRepoDir, stageRepoDir);
    await git(stageRepoDir, "add", "-A");
    await git(
      stageRepoDir,
      "-c", "user.name=Relay Candidate Builder",
      "-c", "user.email=relay@localhost",
      "commit", "--quiet", "-m", `relay: task ${input.taskId} attempt ${input.attempt} (changeset ${input.changesetId})`,
    );
    const commitSha = (await git(stageRepoDir, "rev-parse", "HEAD")).trim();
    const treeSha = (await git(stageRepoDir, "rev-parse", "HEAD^{tree}")).trim();
    // 候选 commit 必须恰以 base 为父(克隆分支 HEAD == base;防御未来改动破坏此前提)
    const parentSha = (await git(stageRepoDir, "rev-parse", `${commitSha}~1`)).trim();
    if (parentSha !== input.baseCommitSha) {
      throw new GitCandidateError("base_parent_mismatch", `candidate parent ${parentSha} != base ${input.baseCommitSha}`);
    }
    // 树==清单往返核验(D-2):路径集合相等 + 每文件内容 sha256 相等;不一致即阻断
    const roundTrip = await verifyTreeAgainstManifest(stageRepoDir, commitSha, input.candidateManifest);
    if (!roundTrip.ok) {
      throw new GitCandidateError("content_mismatch", `candidate tree != manifest: ${roundTrip.mismatches.slice(0, 5).join(",")}`);
    }
    // 本地引用防 gc(commit 由 detached worktree 语义产生,不在任何分支上;refs/relay-candidates/* 非分支,不推送)
    await git(stageRepoDir, "update-ref", `refs/relay-candidates/${input.changesetId}`, commitSha);
    return {
      stageRepoDir,
      baseCommitSha: input.baseCommitSha,
      treeSha,
      commitSha,
      treeVerified: true,
      filesChanged: input.diff.added.length + input.diff.modified.length + input.diff.removed.length,
    };
  } catch (err) {
    // 构建失败即清理 stage(不留下半成品)
    rmSync(stageRepoDir, { recursive: true, force: true });
    throw err;
  }
}

/** ls-tree -r -z 解析(mode SP type SP blobsha NUL path NUL);符号链接(mode 120000)按清单语义剔除。 */
async function listTreeBlobPaths(repoDir: string, rev: string): Promise<Map<string, string>> {
  const out = await git(repoDir, "ls-tree", "-r", "-z", rev);
  const map = new Map<string, string>();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const tabAt = entry.indexOf("\t");
    if (tabAt < 0) continue;
    const meta = entry.slice(0, tabAt).split(/\s+/); // [mode, type, blobSha]
    const path = entry.slice(tabAt + 1);
    if (meta[0] === "120000") continue; // 符号链接:清单语义外
    map.set(path, meta[2]!);
  }
  return map;
}

/** D-2 往返核验:commit 树路径集合与内容 sha256 必须逐项等于候选清单。 */
export async function verifyTreeAgainstManifest(
  repoDir: string,
  commitSha: string,
  manifest: WorkspaceManifest,
): Promise<{ ok: true } | { ok: false; mismatches: string[] }> {
  const tree = await listTreeBlobPaths(repoDir, `${commitSha}^{tree}`);
  const mismatches: string[] = [];
  for (const [path, blobSha] of tree) {
    if (!manifest.has(path)) {
      mismatches.push(`extra_in_tree:${path}`);
      continue;
    }
    const h = sha256Buffer(await gitBuffer(repoDir, "cat-file", "blob", blobSha!));
    if (h !== manifest.get(path)) mismatches.push(`content_mismatch:${path}`);
  }
  for (const path of manifest.keys()) {
    if (!tree.has(path)) mismatches.push(`missing_in_tree:${path}`);
  }
  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}

// —— 绑定重核与远端核验(D-3/D-8;注入 delivery core 的 IO 回调工厂) ——

/** D-3 绑定重核:stage 仓库内 commit 对象仍在、其树 sha/父 commit 与记录值一致(树 sha 是内容承诺)。 */
export function makeCommitBindingVerifier(
  stageRepoDir: () => string | null | undefined,
): (binding: CommitBinding) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async (binding) => {
    const repo = stageRepoDir();
    if (!repo || !existsSync(join(repo, ".git"))) return { ok: false, reason: "stage_repo_missing" };
    try {
      await git(repo, "cat-file", "-e", `${binding.gitCommitSha}^{commit}`);
      const tree = (await git(repo, "rev-parse", `${binding.gitCommitSha}^{tree}`)).trim();
      if (tree !== binding.gitTreeSha) return { ok: false, reason: "tree_sha_drift" };
      const parent = (await git(repo, "rev-parse", `${binding.gitCommitSha}~1`)).trim();
      if (parent !== binding.gitBaseCommitSha) return { ok: false, reason: "base_parent_drift" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `binding_verify_failed:${(err as Error).message.slice(0, 200)}` };
    }
  };
}

export interface RemoteVerifyResult {
  ok: boolean;
  mismatches: string[];
  remoteHead?: string;
}

/** D-8 远端内容核验:fetch 目标 commit,逐文件内容 sha256 对比候选清单(集合 + 内容双等)。 */
export async function verifyRemoteCommitContent(input: {
  target: string;
  commitSha: string;
  manifest: WorkspaceManifest;
  /** 可复用的暂存目录(fetch 目标区;调用方生命周期) */
  scratchDir: string;
  /** 私有仓库读凭据文件(0600;缺省 = 匿名,本地 bare 仓库够用) */
  credentialFile?: string | null;
}): Promise<RemoteVerifyResult> {
  mkdirSync(input.scratchDir, { recursive: true });
  const repo = join(input.scratchDir, "verify");
  if (!existsSync(join(repo, ".git"))) {
    await execFileP("git", ["init", "--quiet", repo], { encoding: "utf8" });
    await git(repo, "remote", "add", "target", input.target);
  }
  const credArgs = credentialArgs(input.credentialFile);
  const fetchArgs = ["fetch", "--quiet", "target", input.commitSha];
  await execFileP("git", ["-C", repo, ...credArgs, ...fetchArgs], {
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  }).catch(async (err) => {
    // 远端未协商 allow-any-sha 时按 sha 抓取可能被拒;失败如实上抛(调用方 CONFLICT/FAILED 处置)
    const e = err as { stderr?: string };
    throw new GitCandidateError("remote_fetch_failed", `fetch ${input.commitSha}: ${(e.stderr ?? "").trim().slice(-300)}`);
  });
  const remoteHead = (await git(repo, "rev-parse", "FETCH_HEAD")).trim();
  const tree = await listTreeBlobPaths(repo, "FETCH_HEAD^{tree}");
  const mismatches: string[] = [];
  for (const [path, blobSha] of tree) {
    if (!input.manifest.has(path)) {
      mismatches.push(`extra_on_remote:${path}`);
      continue;
    }
    const h = sha256Buffer(await gitBuffer(repo, "cat-file", "blob", blobSha!));
    if (h !== input.manifest.get(path)) mismatches.push(`remote_content_mismatch:${path}`);
  }
  for (const path of input.manifest.keys()) {
    if (!tree.has(path)) mismatches.push(`missing_on_remote:${path}`);
  }
  return { ok: mismatches.length === 0, mismatches, remoteHead };
}

/** 凭据参数(argv 只含 helper 声明与文件路径,令牌本体不进 argv/env)。 */
function credentialArgs(credentialFile?: string | null): string[] {
  if (!credentialFile) return [];
  return ["-c", "credential.helper=", "-c", `credential.helper=store --file=${credentialFile}`];
}

/** git 子进程最小 env:禁交互提示;不继承宿主(避免宿主 credential helper/GITHUB_* 泄入)。 */
function gitEnv(): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/nonexistent", // 阻断全局/系统 gitconfig 的凭据 helper 侧信道
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** 相对路径规范化(测试夹具用):统一 POSIX 分隔。 */
export function toRelPath(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}
