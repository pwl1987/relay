// 只读视图·Projects(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT + 本地只读 git 事实)。
import { sql } from "drizzle-orm";
import { basename, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { RelayDb } from "../../core/db.ts";
import { iso, str, type Row, repoRootFromModule } from "./shared.ts";

export interface ProjectView {
  name: string;
  path: string;
  repo: string | null;
  branch: string | null;
  health: "ok" | "unreachable";
  healthDetail: string | null;
  gitBranch: string | null;
  gitHead: string | null;
  recentGoals: Array<{ id: string; rawInput: string; state: string; updatedAt: string }>;
  goalCount: number;
  /** WEB-UX-02 §8:项目卡片用户面(运行中/已完成计数与最近更新时间;确定性推导,零新增状态) */
  runningCount: number;
  doneCount: number;
  lastUpdatedAt: string | null;
}

export interface ProjectsView {
  source: string | null;
  configured: boolean;
  note: string;
  projects: ProjectView[];
}

export interface ProjectRegistryEntry {
  name: string;
  path: string;
  repo?: string;
  branch?: string;
}

/** 项目注册文件(受控 registry;WEB-UX-01 §4.5 New Goal 绑定的唯一权威路径来源)。 */
export function readProjectRegistry(): { source: string | null; projects: ProjectRegistryEntry[] } {
  const explicit = process.env.RELAY_PROJECTS_FILE;
  const defaultRegistryPath = join(repoRootFromModule(), "config", "projects.json");
  const file = explicit && explicit.trim() ? explicit : defaultRegistryPath;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { projects?: unknown };
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];
    return {
      source: file,
      projects: list
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .slice(0, 20)
        .map((p) => ({
          name: typeof p["name"] === "string" ? p["name"] : basename(String(p["path"] ?? "project")),
          path: typeof p["path"] === "string" ? p["path"] : "",
          repo: typeof p["repo"] === "string" ? p["repo"] : undefined,
          branch: typeof p["branch"] === "string" ? p["branch"] : undefined,
        }))
        .filter((p) => p.path.length > 0),
    };
  } catch {
    return { source: file, projects: [] };
  }
}

function localGitFacts(path: string): { exists: boolean; gitBranch: string | null; gitHead: string | null; detail: string | null } {
  try {
    statSync(path);
  } catch {
    return { exists: false, gitBranch: null, gitHead: null, detail: "目录不存在或不可读" };
  }
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  const head = run(["rev-parse", "HEAD"]);
  if (!head) return { exists: true, gitBranch: null, gitHead: null, detail: "存在但不是可读的 git 工作树" };
  return { exists: true, gitBranch: run(["rev-parse", "--abbrev-ref", "HEAD"]), gitHead: head, detail: null };
}

/** P0-UI-2:最小项目列表(注册文件 + 本地只读 git 事实 + 经 allowed_scope 关联的最近 Goal)。 */
export async function projectsView(db: RelayDb): Promise<ProjectsView> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const registry = readProjectRegistry();
  const note =
    registry.projects.length === 0
      ? "未配置项目注册文件(config/projects.json 或 RELAY_PROJECTS_FILE);格式:{\"projects\":[{\"name\",\"path\",\"repo\",\"branch\"}]}。本页仅观察,不调度。"
      : "来源=项目注册文件;健康=本地目录/git 只读事实;Goal 关联经任务 allowed_scope 前缀匹配(当前 Goal 创建流未绑定项目时显示为空)。";
  const projects: ProjectView[] = [];
  for (const entry of registry.projects) {
    const facts = localGitFacts(entry.path);
    const link = await exec.execute(sql`
      SELECT g.id, g.raw_input, g.state, g.updated_at
      FROM tasks t
      JOIN jsonb_array_elements_text(t.allowed_scope) s ON true
      JOIN goals g ON g.id = t.goal_id
      WHERE ${entry.path} LIKE s || '%'
      ORDER BY g.updated_at DESC
    `);
    const seen = new Set<string>();
    const recentGoals: ProjectView["recentGoals"] = [];
    let goalCount = 0;
    let runningCount = 0;
    let doneCount = 0;
    let lastUpdatedAt: string | null = null;
    for (const r of link.rows) {
      const gid = str(r["id"]);
      if (seen.has(gid)) continue;
      seen.add(gid);
      goalCount += 1;
      const st = str(r["state"]);
      // 运行中=尚在推进;已完成=到达成功终态(失败/取消不计入"已完成",如实)
      if (["READY", "LEASED", "RUNNING", "SUBMITTED", "VERIFYING", "WAITING", "NEEDS_DECISION", "REWORK", "PAUSED", "NEEDS_RECONCILE", "BLOCKED", "PLANNED"].includes(st)) runningCount += 1;
      if (["ACCEPTED", "SUCCEEDED", "COMPLETED"].includes(st)) doneCount += 1;
      if (!lastUpdatedAt) lastUpdatedAt = iso(r["updated_at"]);
      if (recentGoals.length < 3) {
        recentGoals.push({ id: gid, rawInput: str(r["raw_input"]), state: st, updatedAt: iso(r["updated_at"]) ?? "" });
      }
    }
    projects.push({
      name: entry.name,
      path: entry.path,
      repo: entry.repo ?? null,
      branch: entry.branch ?? null,
      health: facts.exists && facts.gitHead ? "ok" : "unreachable",
      healthDetail: facts.detail,
      gitBranch: facts.gitBranch,
      gitHead: facts.gitHead,
      recentGoals,
      goalCount,
      runningCount,
      doneCount,
      lastUpdatedAt,
    });
  }
  return { source: registry.source, configured: registry.projects.length > 0, note, projects };
}
