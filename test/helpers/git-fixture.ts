// Git 夹具(P0-02B:本地 bare 仓库先行验证全部失败窗口;确定性,零网络)。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitInit(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export interface WorkspaceFixture {
  dir: string;
  /** 初始 commit(= Run 前工作区 HEAD,交付链的 base) */
  baseCommitSha: string;
  /** 在工作区应用候选变更(增/改/删/可执行位) */
  apply(files: Record<string, string | { content: string; mode?: number }>, removes?: string[]): void;
  head(): string;
}

/** 建一个真实 git 工作区仓库(候选 Run 工作区的种子形态)。 */
export function makeWorkspaceRepo(base?: string): WorkspaceFixture {
  const dir = mkdtempSync(join(base ?? tmpdir(), "relay-ws-"));
  gitInit(dir, ["init", "--initial-branch=main"]);
  git(dir, "config", "user.email", "relay-test@localhost");
  git(dir, "config", "user.name", "Relay Test");
  writeFileSync(join(dir, "README.md"), "# seed repo\n", "utf8");
  writeFileSync(join(dir, "src.txt"), "base content\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  const baseCommitSha = git(dir, "rev-parse", "HEAD").trim();
  return {
    dir,
    baseCommitSha,
    apply(files, removes = []) {
      for (const [rel, spec] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        const content = typeof spec === "string" ? spec : spec.content;
        writeFileSync(full, content, "utf8");
        if (typeof spec !== "string" && spec.mode !== undefined) chmodSync(full, spec.mode);
      }
      for (const rel of removes) {
        execFileSync("rm", ["-rf", join(dir, rel)]);
      }
    },
    head() {
      return git(dir, "rev-parse", "HEAD").trim();
    },
  };
}

export interface BareRemoteFixture {
  dir: string;
  url: string;
  /** 外部推进 main(模拟另一位写者;不经 Relay 链) */
  pushHead(sourceRepo: string, sha: string): void;
  head(ref?: string): string;
  commitCount(ref?: string): number;
}

/** 建一个 bare 远端(交付目标沙箱;允许按 SHA fetch 供远端内容核验)。 */
export function makeBareRemote(base?: string): BareRemoteFixture {
  const dir = mkdtempSync(join(base ?? tmpdir(), "relay-remote-"));
  gitInit(dir, ["init", "--bare", "--initial-branch=main"]);
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true"); // 按SHA抓取(远端内容核验用)
  git(dir, "config", "core.logAllRefUpdates", "true");
  return {
    dir,
    url: dir,
    pushHead(sourceRepo: string, sha: string) {
      execFileSync("git", ["-C", sourceRepo, "push", "--quiet", dir, `${sha}:refs/heads/main`], { encoding: "utf8" });
    },
    head(ref = "main") {
      try {
        const out = execFileSync("git", ["-C", dir, "rev-parse", `refs/heads/${ref}`], { encoding: "utf8" });
        return out.trim();
      } catch {
        return ""; // 分支尚不存在
      }
    },
    commitCount(ref = "main") {
      try {
        return Number(git(dir, "rev-list", "--count", `refs/heads/${ref}`).trim());
      } catch {
        return 0;
      }
    },
  };
}

/** 候选清单(与 snapshotManifest 同构:相对路径 -> 内容 sha256;由调用方从工作区生成)。 */
export function manifestOf(dir: string, files: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const rel of files) {
    const h = createHash("sha256").update(execFileSync("cat", [join(dir, rel)]));
    m.set(rel, h.digest("hex"));
  }
  return m;
}

export function addSymlink(dir: string, linkPath: string, target: string): void {
  symlinkSync(target, join(dir, linkPath));
}
