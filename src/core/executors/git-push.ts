// git push 执行器(测试/本地 mock 用;真实 GitHub 集成属 P0-02B,须细粒度 PAT)。
// check: ls-remote 读取目标真实头 SHA;perform: 非 force push payloadSha:refs/heads/<branch>。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntentExecutor, IntentRef } from "../intents.ts";

const execFileP = promisify(execFile);

export interface GitPushExecutorOptions {
  /** 含 payload 提交的源工作仓(push 需要对象存在) */
  sourceRepo: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export function createGitPushExecutor(options: GitPushExecutorOptions): IntentExecutor {
  return {
    async check(intent: IntentRef): Promise<string> {
      const ref = `refs/heads/${intent.branch ?? "main"}`;
      const out = await git(options.sourceRepo, "ls-remote", intent.target, ref);
      const firstLine = out.split("\n")[0] ?? "";
      return firstLine.split(/\s+/)[0] ?? "";
    },
    async perform(intent: IntentRef): Promise<void> {
      if (!intent.payloadSha || !intent.branch) {
        throw new Error(`git_push intent ${intent.id} missing payloadSha/branch`);
      }
      // 刻意不带 --force:V10 语义(基线不匹配时拒绝覆盖,不做历史重写)
      await git(
        options.sourceRepo,
        "push",
        intent.target,
        `${intent.payloadSha}:refs/heads/${intent.branch}`,
      );
    },
  };
}
