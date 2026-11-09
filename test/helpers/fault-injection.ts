// 故障注入与 mock git 工具(父进程侧)。
// SIGKILL 死亡核验是 P0-00 独立复核的修正条件之一:kill 后必须断言进程真的死了。
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RelayDb } from "../../src/core/db.ts";
import { sql } from "drizzle-orm";

const execFileP = promisify(execFile);

const HELPERS_DIR = path.resolve(import.meta.dirname);

// 带输出捕获与一次性退出 promise 的子进程(close 只发射一次,重复等待会挂起——v04 首跑实测教训)
export interface HelperChild extends ChildProcess {
  outText: string;
  errText: string;
  exited: Promise<void>;
}

export function spawnHelper(
  helperName: "hold-worker.ts" | "push-execute.ts",
  args: string[],
  env: Record<string, string>,
): HelperChild {
  const child = spawn(process.execPath, [path.join(HELPERS_DIR, helperName), ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as HelperChild;
  child.outText = "";
  child.errText = "";
  child.stdout?.on("data", (d) => (child.outText += String(d)));
  child.stderr?.on("data", (d) => (child.errText += String(d)));
  child.exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return child;
}

// SIGKILL 并核验进程确实死亡(独立复核教训:kill -9 子壳只会杀包装进程)。
export async function kill9AndAssertDead(child: HelperChild, timeoutMs = 5000): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("child has no pid");
  child.kill("SIGKILL");
  await Promise.race([child.exited, sleep(timeoutMs)]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await pidAlive(pid);
    if (!alive) return;
    await sleep(50);
  }
  throw new Error(`STILL-ALIVE(BAD): pid ${pid} 在 SIGKILL 后仍然存活`);
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    await execFileP("ps", ["-p", String(pid)]);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 轮询直至条件满足或超时
export async function waitFor<T>(
  what: string,
  poll: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await poll();
    if (last !== null) return last;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout: ${what}`);
}

export async function waitTaskState(
  db: RelayDb,
  taskId: string,
  want: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(
    `task ${taskId} -> ${want}`,
    async () => {
      const res = await db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
      const state = res.rows[0]?.["state"];
      return state === want ? state : null;
    },
    timeoutMs,
  );
}

// —— 本地 mock git 仓(外部副作用靶场;不触碰任何真实远端)——
export interface MockGit {
  root: string;
  workRepo: string;
  bareRemote: string;
  /** 初始 main 头(执行前预期 expectedRemoteSha 的基线) */
  initialHead: string;
  cleanup(): Promise<void>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

export async function createMockGit(): Promise<MockGit> {
  const root = await mkdtemp(path.join(tmpdir(), "relay-p01a-git-"));
  const bareRemote = path.join(root, "remote.git");
  const workRepo = path.join(root, "work");
  await execFileP("git", ["init", "--bare", "-b", "main", bareRemote]);
  await execFileP("git", ["init", "-b", "main", workRepo]);
  await git(workRepo, "config", "user.name", "relay-test");
  await git(workRepo, "config", "user.email", "relay@test.local");
  await git(workRepo, "remote", "add", "origin", bareRemote);
  await writeFile(path.join(workRepo, "base.txt"), "base\n");
  await git(workRepo, "add", "-A");
  await git(workRepo, "commit", "-m", "base");
  await git(workRepo, "push", "origin", "main");
  const initialHead = await remoteHeadSha(workRepo, bareRemote);
  return {
    root,
    workRepo,
    bareRemote,
    initialHead,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function remoteHeadSha(fromDir: string, bareRemote: string, branch = "main"): Promise<string> {
  const out = await git(fromDir, "ls-remote", bareRemote, `refs/heads/${branch}`);
  return out.split(/\s+/)[0] ?? "";
}

// 在工作仓产生 payload 提交,返回其 SHA
export async function commitPayload(
  workRepo: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await mkdir(path.dirname(path.join(workRepo, file)), { recursive: true });
  await writeFile(path.join(workRepo, file), content);
  await git(workRepo, "add", "-A");
  await git(workRepo, "commit", "-m", message);
  return git(workRepo, "rev-parse", "HEAD");
}
