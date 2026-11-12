// WEB-UX-03C §3 单元测试:工作区左侧栏投影 workspaceSidebarView(纯读;项目归组/状态点/待决数)。
// 归组规则与 projectsView 一致(最近 Task allowed_scope 与注册表路径互为前缀);零模型、零 egress。
// WEB-UX-03C.1 P0-2:goalStatusView.projectName 与侧栏归组必须同源(matchProjectByScope 唯一规则)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { goalStatusView, matchProjectByScope, workspaceSidebarView } from "../../src/server/views/goal.ts";

const PROJ_ENV = "RELAY_PROJECTS_FILE";

describe("WEB-UX-03C §3:workspaceSidebarView(零模型)", () => {
  let t: TestDb;
  let dir: string;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    t = await createTestDb("workspace-sidebar");
    const stmts = [
      sql`INSERT INTO goals (id, raw_input, state) VALUES
          ('g-exec','给系统加 Excel 导出','ACTIVE'),
          ('g-dec','调查接口偶发出错','ACTIVE'),
          ('g-done','修好登录页','ACTIVE'),
          ('g-un','整理目录结构','ACTIVE'),
          ('g-notask','补充文档','ACTIVE')`,
      sql`INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES
          ('t-exec','g-exec','RUNNING','["/tmp/proj-lam"]'::jsonb),
          ('t-dec','g-dec','NEEDS_DECISION','["/tmp/proj-lam"]'::jsonb),
          ('t-done','g-done','ACCEPTED','["/tmp/proj-wps"]'::jsonb),
          ('t-un','g-un','READY','["/elsewhere"]'::jsonb)`,
      sql`INSERT INTO decisions (id, task_id, goal_id, level, question, state)
          VALUES ('d-1','t-dec','g-dec','D3','是否允许扩大作用域?','OPEN')`,
    ];
    for (const s of stmts) await t.db.execute(s);
    dir = mkdtempSync(join(tmpdir(), "ws-sidebar-"));
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify({ projects: [{ name: "LAMICE", path: "/tmp/proj-lam" }, { name: "WPS", path: "/tmp/proj-wps" }] }),
    );
    savedEnv = process.env[PROJ_ENV];
    process.env[PROJ_ENV] = join(dir, "projects.json");
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env[PROJ_ENV];
    else process.env[PROJ_ENV] = savedEnv;
    rmSync(dir, { recursive: true, force: true });
    await t.cleanup();
  });

  it("项目归组 + 状态点优先级 + 未决数;未匹配 Goal 落未分组", async () => {
    const v = await workspaceSidebarView(t.db);
    // 注册表顺序;无 Goal 的注册项目也列出
    expect(v.projects.map((p) => p.name)).toEqual(["LAMICE", "WPS"]);
    const lam = v.projects[0]!.goals;
    const lamExec = lam.find((g) => g.id === "g-exec")!;
    expect(lamExec.phase).toBe("executing");
    const lamDec = lam.find((g) => g.id === "g-dec")!;
    expect(lamDec.phase).toBe("waiting_user"); // 待决优先于在途(用户注意先)
    expect(lamDec.pendingDecisions).toBe(1);
    const wps = v.projects[1]!.goals.find((g) => g.id === "g-done")!;
    expect(wps.phase).toBe("done");
    // 未匹配 scope / 无任务 ⇒ 未分组、idle
    const ids = v.ungrouped.map((g) => g.id).sort();
    expect(ids).toEqual(["g-notask", "g-un"]);
    expect(v.ungrouped.every((g) => g.phase === "idle")).toBe(true);
    // 标题=raw_input 原文(截断由客户端负责);状态点数据不含 UUID/Run/model/SHA
    expect(lamExec.title).toBe("给系统加 Excel 导出");
  });

  it("03C.1 P0-2:goalStatusView.projectName 与侧栏归组同源;未识别 ⇒ null(禁默认工作区兜底)", async () => {
    // 绑定:最近 Task allowed_scope 命中注册表(与 workspaceSidebarView 同一 matchProjectByScope)
    const bound = await goalStatusView(t.db, "g-exec");
    expect(bound).toBeTruthy();
    expect(bound!.projectName).toBe("LAMICE");
    expect((await workspaceSidebarView(t.db)).projects[0]!.goals.some((g) => g.id === "g-exec")).toBe(true);
    // 未识别 scope / 无任务 ⇒ null(客户端如实显示「项目未绑定」)
    expect((await goalStatusView(t.db, "g-un"))!.projectName).toBeNull();
    expect((await goalStatusView(t.db, "g-notask"))!.projectName).toBeNull();
    // 唯一规则直测:前缀双向;无匹配 ⇒ null
    const reg = { projects: [{ name: "A", path: "/repos/a" }, { name: "B", path: "/repos/b" }] };
    expect(matchProjectByScope(["/repos/a/src"], reg)).toBe("A");
    expect(matchProjectByScope(["/repos/a"], reg)).toBe("A");
    expect(matchProjectByScope(["/elsewhere"], reg)).toBeNull();
    expect(matchProjectByScope([], reg)).toBeNull();
  });
});
