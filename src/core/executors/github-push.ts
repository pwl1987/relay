// GitHub push 执行器(P0-02B D-7;Scoped GitHub Executor)。
// 安全语义:
//  - check:ls-remote 读目标分支真实头(不存在 = "");
//  - perform:非 force push payloadSha:refs/heads/<branch>(无 + 前缀/无 --force;基线不匹配由
//    executeIntent 的前置核对与 git 自身的非 fast-forward 拒绝双保险,绝不覆盖他人提交);
//  - 凭据:只接受宿主 0600 credential 文件路径(store 格式),经 git credential.helper 注入;
//    **令牌本体不进 argv/env/日志**;错误文本中的 `x-access-token:<secret>` 段被脱敏;
//  - env 最小化 + GIT_TERMINAL_PROMPT=0 + HOME 阻断(宿主 gitconfig credential helper 侧信道);
//  - 权限不足/令牌缺失 ⇒ git 非零退出 ⇒ perform 抛错 ⇒ intent FAILED(安全失败,无部分状态)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import type { IntentExecutor, IntentRef } from "../intents.ts";

const execFileP = promisify(execFile);

/** 凭据文件最低要求:存在、常规文件、0600(可信执行器自证面)。 */
export function credentialFileValid(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

export interface GitHubPushExecutorOptions {
  /** 含 payload 提交对象的 stage 仓库(push/fetch 的对象源) */
  sourceRepo: string;
  /** 宿主 0600 credential 文件(store 格式);null = 匿名(仅本地 bare 仓库测试用) */
  credentialFile?: string | null;
  gitBin?: string;
}

/** 从错误文本中脱敏任何 `user:secret@` 形的凭据段(纵深防御;git 正常路径不回显)。 */
export function redactCredentials(text: string): string {
  return text.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, "$1<redacted>@");
}

async function git(options: GitHubPushExecutorOptions, ...args: string[]): Promise<string> {
  const cred = options.credentialFile
    ? ["-c", "credential.helper=", "-c", `credential.helper=store --file=${options.credentialFile}`]
    : [];
  try {
    const { stdout } = await execFileP(options.gitBin ?? "git", ["-C", options.sourceRepo, ...cred, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: "/nonexistent", // 阻断宿主 gitconfig 全局 helper(凭据侧信道)
      },
      windowsHide: true,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(redactCredentials(`git ${args[0]} failed: ${(e.stderr ?? e.message ?? "").trim().slice(-500)}`));
  }
}

export function createGitHubPushExecutor(options: GitHubPushExecutorOptions): IntentExecutor {
  return {
    async check(intent: IntentRef): Promise<string> {
      const ref = `refs/heads/${intent.branch ?? "main"}`;
      const out = await git(options, "ls-remote", intent.target, ref);
      const firstLine = out.split("\n")[0] ?? "";
      return firstLine.split(/\s+/)[0] ?? "";
    },
    async perform(intent: IntentRef): Promise<void> {
      if (!intent.payloadSha || !intent.branch) {
        throw new Error(`github_push intent ${intent.id} missing payloadSha/branch`);
      }
      if (options.credentialFile && !credentialFileValid(options.credentialFile)) {
        // 可信执行器侧防御:凭据面不满足直接失败(上游 Policy 已先行裁决 credential_missing)
        throw new Error("credential_file_invalid:0600 常规文件要求不满足");
      }
      // 刻意非 force:远端若在核对后再次漂移,git 以非 fast-forward 拒绝(不覆盖)
      await git(options, "push", intent.target, `${intent.payloadSha}:refs/heads/${intent.branch}`);
    },
  };
}
