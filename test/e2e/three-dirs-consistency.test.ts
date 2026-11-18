// 三套目录模型(项目目录 / 对话框目录 / 交付目标)统一:端到端一致性验证。
// 全链:真实 Web/API 入口(POST /api/goals 绑定项目)→ live driver(**不注入** prepareWorkspace 与
// delivery ⇒ 走生产同款内建装配:项目目录→对话框目录 seed + 绑定→交付目标)→ stub 大脑 →
// 真实候选 commit → 真实交付到本地 bare 远端 → 远端内容核验 → 视图同源。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装)。
// 断言:
//   T1 作用域口径统一:绑定项目后 Task.allowed_scope 恒为工作区挂载根 ["/workspace"]
//      (旧口径 = 宿主项目路径 ⇒ 影响面核验把全部变更判越界,Gate 永过不了)。
//   T2 对话框目录 = 项目目录的工作副本:交付树里含项目源码(README.md/src.txt)+ stub 新增文件。
//   T3 影响面核验零越界:impact_scope.violations 为空。
//   T4 交付目标 = 绑定登记的 repo:远端 main 头 == 候选 commit sha(真实 push,非文案)。
//   T5 视图同源:goalStatusView 的 projectName/projectPath/workspaceMount/deliveryTarget 与绑定一致。
//   T6 项目关联按绑定:projectsView 的项目卡片含本 Goal(不再按目录字符串)。
// 隔离:一次性合成注册表 + 一次性 bare 远端(绝不读受保护 config/projects.json);
//   零生产连接/零真实模型/零外部交付;用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver } from "../../src/server/worker.ts";
import { makeWorkspaceRepo, makeBareRemote } from "../helpers/git-fixture.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";
import { goalStatusView } from "../../src/server/views/goal.ts";
import { projectsView } from "../../src/server/views/projects.ts";

const PASSWORD = "three-dirs-pw";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const PROJ_ENV = "RELAY_PROJECTS_FILE";
const PROJECT_NAME = "demo";

describe.skipIf(process.env.RELAY_E2E !== "1")("三套目录模型统一:端到端一致性(真实项目目录 + stub 大脑)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  let driver: ReturnType<typeof createLiveWorkerDriver>;
  const tmpRoots: string[] = [];
  let projectDir = "";
  let remoteUrl = "";
  let goalId = "";
  let taskId = "";
  let changesetId = "";
  let savedEnv: string | undefined;

  beforeAll(async () => {
    t = await createTestDb("three-dirs");
    // 真实项目目录(含真实 git 仓库与真实文件)—— 必须是真目录,否则 seed 无从验证
    const projBase = mkdtempSync(join(tmpdir(), "three-dirs-proj-"));
    tmpRoots.push(projBase);
    const project = makeWorkspaceRepo(projBase);
    projectDir = project.dir;
    // 一次性本地 bare 远端(真实交付目标)
    const remoteBase = mkdtempSync(join(tmpdir(), "three-dirs-remote-"));
    tmpRoots.push(remoteBase);
    const remote = makeBareRemote(remoteBase);
    remoteUrl = remote.url;
    // 一次性合成注册表(绝不指向受保护 config/projects.json)
    const regDir = mkdtempSync(join(tmpdir(), "three-dirs-reg-"));
    tmpRoots.push(regDir);
    const reg = join(regDir, "projects.json");
    writeFileSync(
      reg,
      JSON.stringify({
        projects: [{ name: PROJECT_NAME, path: projectDir, repo: remoteUrl, branch: "main" }],
      }),
    );
    savedEnv = process.env[PROJ_ENV];
    process.env[PROJ_ENV] = reg;

    const stageBase = mkdtempSync(join(tmpdir(), "three-dirs-stage-"));
    tmpRoots.push(stageBase);
    // driver:**不注入** prepareWorkspace / delivery ⇒ 走生产同款内建装配
    driver = createLiveWorkerDriver({
      db: t.db,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      workerId: "e2e-worker-three-dirs",
      wallSeconds: 30,
      heartbeatSeconds: 2,
      reserveCallsPerRun: 4,
      reviewerReserveCallsPerRun: 2,
      reviewAttempts: 1,
      stubInjection: {
        argv: [process.execPath, STUB],
        coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
        reviewerEnv: {
          STUB_MODE: "verdict",
          STUB_VERDICT: "PASS",
          STUB_FINDINGS: "三套目录 e2e 独立审查通过",
          STUB_DELAY_MS: "80",
        },
      },
      checkRunner: hostTestCheckRunner,
      evidenceChecks: [
        {
          kind: "deterministic_test",
          command: ["cat", "delivered.txt"],
          cwdWorkspace: true,
          expectOutputContains: "ok",
        },
      ],
      stageBaseDir: stageBase,
    });

    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 10,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    const handle = createRelayServer({
      db: t.db,
      auth,
      worker: driver,
      workerMode: "stub",
      host: "127.0.0.1",
      port: 0,
      staticDir: join(process.cwd(), "web"),
      defaultGoalBudgetModelCalls: 12,
    });
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    const loginBody = (await login.json()) as { csrfToken?: string };
    csrf = loginBody.csrfToken ?? "";
    expect(cookie).not.toBe("");
    expect(csrf).not.toBe("");

    // 真实 API 创建 Goal(绑定项目)—— 走 core planGoal + 12R 冻结事实 + 作用域口径
    const created = await fetch(base + "/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify({ rawInput: "在 demo 项目里加一个交付校验脚本", projectId: PROJECT_NAME }),
    });
    const createdBody = (await created.json()) as { goalId?: string; taskIds?: string[]; project?: unknown };
    expect(created.status).toBe(201);
    goalId = createdBody.goalId ?? "";
    taskId = createdBody.taskIds?.[0] ?? "";
    expect(goalId).not.toBe("");
    expect(taskId).not.toBe("");
  });

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env[PROJ_ENV];
    else process.env[PROJ_ENV] = savedEnv;
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    for (const r of tmpRoots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
    }
    await t.cleanup();
  });

  it("T1 作用域口径统一:绑定项目后 allowed_scope 恒为工作区挂载根", async () => {
    const rows = await t.db.execute(sql`SELECT id, state, allowed_scope FROM tasks WHERE id = ${taskId}`);
    const task = rows.rows[0]!;
    expect(task.allowed_scope).toEqual(["/workspace"]);
  });

  it("T2~T4 对话框目录=项目目录工作副本 + 零越界 + 真实交付到绑定登记的仓库", async () => {
    const report = await driver.tick();
    expect(report.status).toBe("PROGRESSED");
    const rows = await t.db.execute(
      sql`SELECT id, impact_scope, delivery_state, git_commit_sha, delivered_remote_head, changed_files FROM candidate_changesets WHERE task_id = ${taskId}`,
    );
    expect(rows.rows.length).toBe(1);
    const cs = rows.rows[0]!;
    changesetId = String(cs.id);
    const impact = cs.impact_scope as { inScope: string[]; violations: string[] };
    // T3:影响面核验零越界(旧口径下此处必为全量越界)
    expect(impact.violations).toEqual([]);
    expect(impact.inScope.length).toBeGreaterThan(0);
    // T4:真实交付(非文案)
    expect(cs.delivery_state).toBe("DELIVERED");
    expect(cs.delivered_remote_head).toBe(cs.git_commit_sha);
    const remoteHead = execFileSync("git", ["-C", remoteUrl, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).trim();
    expect(remoteHead).toBe(cs.git_commit_sha);
    // T2:交付树含项目目录的源码 + stub 新增文件(证明工作区确实由项目目录 seed 而来)
    const tree = execFileSync("git", ["-C", remoteUrl, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(tree).toContain("README.md");
    expect(tree).toContain("src.txt");
    expect(tree).toContain("delivered.txt");
  });

  it("T7 Diff Viewer 按冻结绑定解析项目(作用域不再用于反查)", async () => {
    // 回归守卫:作用域恒为工作区挂载根,若 Diff Viewer 仍按 allowed_scope 前缀反查项目,
    // 则会落到"未绑定已注册项目目录"分支(source 缺失)⇒ 本断言可抓该回归。
    const res = await fetch(base + "/api/changesets/" + changesetId + "/diff", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available?: boolean; source?: string; reason?: string };
    expect(body.source).toBe(projectDir);
    expect(String(body.reason ?? "")).not.toContain("未绑定已注册项目目录");
  });

  it("T5~T6 视图同源:三套目录事实与项目关联按冻结绑定", async () => {
    const st = await goalStatusView(t.db, goalId);
    expect(st).toBeTruthy();
    expect(st!.projectName).toBe(PROJECT_NAME);
    expect(st!.projectPath).toBe(projectDir);
    expect(st!.workspaceMount).toBe("/workspace");
    expect(st!.deliveryTarget).toBe(remoteUrl + "[main]");
    const pv = await projectsView(t.db);
    const demo = pv.projects.find((p) => p.name === PROJECT_NAME);
    expect(demo).toBeTruthy();
    expect(demo!.path).toBe(projectDir);
    expect(demo!.repo).toBe(remoteUrl);
    expect(demo!.goalCount).toBe(1);
    expect(demo!.recentGoals.some((g) => g.id === goalId)).toBe(true);
  });
});
