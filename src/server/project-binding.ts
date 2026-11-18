// 三套目录模型的唯一装配面(项目目录 / 对话框目录 / 交付目标)。
// 单一真源 = Goal 创建事务内冻结的项目身份绑定(GOAL_PLANNED.detail.project;12R 已有)。
//   项目目录   = binding.path —— 宿主上项目工作副本的来源(项目注册表权威)
//   对话框目录 = 沙箱工作区(容器内恒为 /workspace)= 项目目录的工作副本
//   交付目标   = binding.repo @ binding.branch
// 口径纪律(本次统一的根因):allowed_scope 恒为"工作区挂载根"(容器 /workspace);
// 宿主项目路径只存在于绑定事实里,不再冒充作用域 —— 否则影响面核验
// (core/changesets.ts impactScopeWithMount)会把全部相对路径判为越界,Gate 永远过不了。
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayDb } from "../core/db.ts";
import type { GoalProjectBinding } from "../core/goals.ts";
import type { ProposeDeliveryInput, DeliveryIO } from "../core/delivery.ts";
import type { WorkspaceManifest } from "../core/changesets.ts";
import { DEFAULT_DELIVERY_POLICY, normalizeRepoSlug } from "../core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../runtime/git-candidate.ts";
import { makeCredentialStore, type CredentialStore } from "../runtime/github-credentials.ts";
import { markTemp, safeRm, RUN_SENTINEL } from "../runtime/safe-rm.ts";

/** 沙箱工作区在容器内的挂载根(唯一作用域口径;allowed_scope 恒为此)。 */
export const WORKSPACE_MOUNT = "/workspace";

/** 绑定形状校验(jsonb 反序列化面;缺失/损坏 = 未绑定,绝不按目录字符串兜底)。 */
function isBinding(v: unknown): v is GoalProjectBinding {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b["name"] === "string" &&
    typeof b["path"] === "string" &&
    (b["repo"] === null || typeof b["repo"] === "string") &&
    (b["branch"] === null || typeof b["branch"] === "string")
  );
}

/**
 * Goal 绑定的项目身份(创建时点冻结事实)。
 * 取最早一条 GOAL_PLANNED = 创建时点权威(幂等重放只读不重写)。
 */
export async function readGoalProjectBinding(db: RelayDb, goalId: string): Promise<GoalProjectBinding | null> {
  const res = await db.execute(sql`
    SELECT detail->'project' AS project
    FROM audit_events
    WHERE action = 'GOAL_PLANNED' AND detail->>'goalId' = ${goalId}
    ORDER BY seq ASC
    LIMIT 1
  `);
  const v = res.rows[0]?.["project"];
  return isBinding(v) ? v : null;
}

/** Task → 所属 Goal → 项目绑定。 */
export async function readTaskProjectBinding(db: RelayDb, taskId: string): Promise<GoalProjectBinding | null> {
  const res = await db.execute(sql`SELECT goal_id FROM tasks WHERE id = ${taskId}`);
  const gid = res.rows[0]?.["goal_id"];
  if (gid === null || gid === undefined) return null;
  return readGoalProjectBinding(db, String(gid));
}

/**
 * 绑定项目目录可种子化先验(FAIL-CLOSED;返回当前 HEAD sha)。三态判据:
 *   成功且 clean ⇒ 放行(返回 HEAD sha)/ dirty ⇒ project_dirty_uncommitted / 探针失败 ⇒ 拒绝。
 * 1) 必须是目录;2) 必须是含提交的 Git 仓库(未提交内容无从界定交付基线);
 * 3) 工作树状态必须**可靠验证为干净** —— 存在未提交 tracked 修改/暂存/untracked 文件即拒绝;
 *    status 探针失败(如 .git/index 不可读/损坏)≠ clean,一律拒绝(独立复核实证的 fail-open
 *    根因:探针失败曾被吞成空串误判 clean 放行 ⇒ 不可验证状态进入种子与交付链)。
 * REWORK 口径:绝不吞入用户本地修改(不进工作副本)、绝不静默忽略(抛错即拒)、
 * 绝不误交付(脏/不可验证状态永远到不了交付链)。gitignore 的构建产物不算改动(git 同口径);
 * `--untracked-files=normal` 显式覆盖本地配置,防 status 配置掩盖 untracked。
 * 错误面只给固定 reason(不回显 git stderr,不报计数之外的文件名;错误可能进审计/决策卡)。
 */
export function assertProjectSeedable(projectPath: string): string {
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory())
    throw new Error(`project_path_not_a_directory:${projectPath}`);
  // Git 探针必须区分「成功 / 失败」:失败绝不折叠为空串语义(空串在 status 面即 clean = fail-open)。
  const git = (args: string[]): { ok: boolean; out: string } => {
    try {
      return {
        ok: true,
        out: execFileSync("git", ["-C", projectPath, ...args], {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      };
    } catch {
      return { ok: false, out: "" };
    }
  };
  const repoProbe = git(["rev-parse", "--git-dir"]);
  if (!repoProbe.ok || !repoProbe.out.trim()) throw new Error(`project_not_a_git_repo:${projectPath}`);
  const headProbe = git(["rev-parse", "--verify", "HEAD"]);
  const headSha = headProbe.out.trim();
  // 40 = SHA-1 仓库;64 = SHA-256 仓库(两者都接受;探针失败或其余形态 = HEAD 不可验证 ⇒ 拒绝)
  if (!headProbe.ok || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha))
    throw new Error(`project_no_commits:${projectPath}`);
  const statusProbe = git(["status", "--porcelain", "--untracked-files=normal"]);
  // 根因修复:status 探针失败 ≠ clean。HEAD 可读但工作树状态不可验证 ⇒ 拒绝(绝不放行)。
  if (!statusProbe.ok) throw new Error(`project_status_unverifiable:${projectPath}`);
  if (statusProbe.out.trim().length > 0) {
    const n = statusProbe.out.split("\n").filter((l) => l.trim().length > 0).length;
    throw new Error(`project_dirty_uncommitted:${n}`);
  }
  return headSha;
}

/**
 * 项目目录 → 对话框目录:按注册 Git 项目**当前 HEAD**构建隔离干净工作副本
 * (git fetch HEAD + reset --hard:工作树内容从 git 对象构建 ⇒ 未提交改动天然不可能混入;
 * .git 必须存在 —— 候选 commit 构建要求工作区是 git 仓库
 * (runtime/git-candidate.ts:workspaceDir/.git 不存在即 not_a_git_workspace;身份由该层
 * 显式 -c user.name/email 提供,不依赖源仓库 config)。
 * 隔离:fetch 一次性取对象,不在副本配置任何 remote ⇒ 与源项目零持续关联(fetch 走 pack
 * 传输,不共享 inode)。工作副本内预置的系统目录(如 runner 的 .relay/)不受影响
 * (reset --hard 只动 git 跟踪面)。脏项目在 assertProjectSeedable 先验处 FAIL-CLOSED。
 */
export function seedWorkspaceFromProject(projectPath: string, workspaceDir: string): void {
  const headSha = assertProjectSeedable(projectPath);
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", workspaceDir, ...args], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  git(["init", "--quiet"]);
  git(["fetch", "--quiet", "--no-tags", projectPath, "HEAD"]);
  // 精确锚定到先验时点的 HEAD(而非 fetch 当刻):两步之间源仓库即使前进,副本仍取先验事实。
  git(["reset", "--hard", "--quiet", headSha]);
}

export interface CapturedDelivery {
  taskId: string;
  attempt: number;
  stageRepoDir: string;
  manifest: WorkspaceManifest;
  baseCommitSha: string;
  commitSha: string;
}

/** 交付装配:把"本拍捕获的候选事实"接到 core 的交付链上。 */
export interface DeliveryFactory {
  propose(captured: CapturedDelivery): Promise<ProposeDeliveryInput>;
  io(captured: CapturedDelivery): Promise<DeliveryIO>;
}

/**
 * 会话级远端写凭据(0600 PAT 文件 → credential-store);惰性建一次,进程退出即删。
 * 缺失/非法 ⇒ null ⇒ credentialPresent=false ⇒ Policy 拒绝远端写
 * (FAIL-CLOSED:绝不降级为匿名远端写;本地目标不受影响)。
 */
let sessionCredential: CredentialStore | null = null;
function sessionCredentialFile(): string | null {
  const raw = process.env["RELAY_GITHUB_TOKEN_FILE"];
  if (!raw || !raw.trim()) return null;
  if (!sessionCredential) {
    try {
      sessionCredential = makeCredentialStore(raw.trim());
    } catch (err) {
      console.error(
        `[relay-delivery] DELIVERY_CREDENTIAL_INVALID(交付凭据面不满足;Policy 将拒绝远端写) ${(err as Error).message}`,
      );
      return null;
    }
    process.once("exit", () => {
      try {
        sessionCredential?.cleanup();
      } catch {
        /* 尽力而为 */
      }
    });
  }
  return sessionCredential.path;
}

/** 本地目标(绝对路径/file://)= 匿名可写;远端目标必须持凭据。 */
function isLocalTarget(target: string): boolean {
  return /^(\/|file:\/\/|\.\/)/.test(target);
}

export interface DeliveryAssemblyOptions {
  /** 远端写凭据(0600 credential-store 文件);缺省 = 匿名(仅本地目标可用)。 */
  credentialFile?: string | null;
  actor?: string;
}

/**
 * 交付目标装配:绑定(repo@branch)→ Proposal 输入 + 执行 IO。
 * 同一套装配同时服务本地 bare 远端(演练)与 GitHub(生产):git ls-remote/push 对本地路径
 * 天然可用,差异只在凭据 —— 故不设两套装配(避免口径再次漂移)。
 * 未绑定交付目标(target 空)⇒ 交由 Policy 拒绝(不猜目标、不抛、不生成 D3 噪音卡)。
 */
export function buildDeliveryFactory(binding: GoalProjectBinding, opts: DeliveryAssemblyOptions = {}): DeliveryFactory {
  const target = (binding.repo ?? "").trim();
  const branch = (binding.branch ?? "main").trim() || "main";
  const actor = opts.actor ?? "relay-delivery";
  const credentialFile = opts.credentialFile !== undefined ? opts.credentialFile : sessionCredentialFile();
  const repoSlug = normalizeRepoSlug(target) ?? target.toLowerCase();
  const policy = { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [repoSlug] };
  // 本地目标匿名可写;远端目标无凭据 ⇒ credentialPresent=false ⇒ Policy 拒绝(FAIL-CLOSED)
  const credentialPresent = isLocalTarget(target) ? true : credentialFile !== null;
  return {
    async propose(c: CapturedDelivery): Promise<ProposeDeliveryInput> {
      const base = {
        taskId: c.taskId,
        attempt: c.attempt,
        target,
        branch,
        expectedRemoteSha: "",
        policy,
        credentialPresent,
        verifyCommitBinding: makeCommitBindingVerifier(() => c.stageRepoDir),
        actor,
      };
      if (!target) return base;
      // 远端分支真实头(空串 = 分支尚不存在 = 本次创建分支);执行前再核对,漂移即 CONFLICT
      const executor = createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile });
      base.expectedRemoteSha = await executor.check({
        id: `probe-${c.taskId}`,
        taskId: c.taskId,
        capability: "github.push",
        target,
        branch,
        expectedRemoteSha: null,
        payloadSha: c.commitSha,
      });
      return base;
    },
    async io(c: CapturedDelivery): Promise<DeliveryIO> {
      return {
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile }),
        manifest: c.manifest,
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = markTemp(mkdtempSync(join(tmpdir(), "relay-delivery-verify-")));
          try {
            const r = await verifyRemoteCommitContent({
              target,
              commitSha,
              manifest: c.manifest,
              scratchDir: scratch,
              credentialFile,
            });
            return r.ok ? { ok: true } : { ok: false, mismatches: r.mismatches };
          } finally {
            safeRm(scratch, { roots: [scratch], sentinel: RUN_SENTINEL });
          }
        },
      };
    },
  };
}

/**
 * 内建交付工厂(生产缺省):按 task 的项目绑定解析交付目标。
 * 未绑定项目 ⇒ target 空 ⇒ Policy 拒绝(不猜目标、不静默跳过)。
 */
export function buildBoundDeliveryFactory(db: RelayDb, opts: DeliveryAssemblyOptions = {}): DeliveryFactory {
  const resolve = async (taskId: string): Promise<GoalProjectBinding> =>
    (await readTaskProjectBinding(db, taskId)) ?? { name: "", path: "", repo: null, branch: null };
  return {
    async propose(c) {
      return buildDeliveryFactory(await resolve(c.taskId), opts).propose(c);
    },
    async io(c) {
      return buildDeliveryFactory(await resolve(c.taskId), opts).io(c);
    },
  };
}
