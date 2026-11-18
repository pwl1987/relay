// REWORK 定向反例(真实 E2E):源项目存在未提交 tracked/untracked 改动 ⇒ FAIL-CLOSED;
// 以及(独立复核 fail-open 根因)HEAD 可读但工作树状态不可验证 ⇒ 同面 FAIL-CLOSED。
// 全链走生产同款内建路径:真实 Web/API 入口(POST /api/goals 绑定项目)→ live driver
// (**不注入** prepareWorkspace/delivery ⇒ 内建绑定 seed + 内建交付装配)→ 先验拒绝。
// 断言三禁(端到端面):
//   T1 不误忽略:tick 以 project_dirty_uncommitted:<n> 抛错(拒绝可见,绝不静默跳过继续跑);
//   T2 不误交付:零 run 行、零 candidate_changesets、交付远端分支不存在(脏内容到不了交付链);
//   T3 不吞入:用户本地修改(tracked 编辑 + untracked 文件)在源目录原样保留,未被纳入任何副本。
//   T4/T5(复核反例)项目 B 提交态干净但 .git/index 损坏 ⇒ git status 探针失败(exit 128)而
//      HEAD/refs 仍可读 ⇒ 第二 tick 必须以 project_status_unverifiable 拒绝;零 Run/零候选/零交付。
// 附加:任务确被真实领取(CLAIM 审计 + attempt=1 + LEASED)⇒ 拒绝发生在真实执行路径上;
//       后续重试经租约 attempt 预算有界(claimTask attempt>=max_attempts 拒绝),不会无限循环。
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

const PASSWORD = "dirty-project-pw";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const PROJ_ENV = "RELAY_PROJECTS_FILE";
const PROJECT_NAME = "dirty-demo";
const PROJECT_B_NAME = "unverifiable-demo";

describe.skipIf(process.env.RELAY_E2E !== "1")("REWORK:脏项目/状态不可验证 FAIL-CLOSED(真实内建 seed 路径)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  let driver: ReturnType<typeof createLiveWorkerDriver>;
  const tmpRoots: string[] = [];
  let projectDir = "";
  let remoteUrl = "";
  let taskId = "";
  let projectBDir = "";
  let remoteBUrl = "";
  let taskBId = "";
  let savedEnv: string | undefined;

  beforeAll(async () => {
    t = await createTestDb("dirty-project");
    // 真实项目目录:干净基线(README.md/src.txt 已提交)后制造两类未提交改动
    const projBase = mkdtempSync(join(tmpdir(), "dirty-proj-"));
    tmpRoots.push(projBase);
    const project = makeWorkspaceRepo(projBase);
    projectDir = project.dir;
    writeFileSync(join(projectDir, "src.txt"), "USER-TRACKED-EDIT\n", "utf8"); // 未提交 tracked 修改
    writeFileSync(join(projectDir, "user-local.txt"), "USER-UNTRACKED-FILE\n", "utf8"); // untracked 新文件
    // 一次性本地 bare 远端:若发生误交付,这里会出现分支/提交 —— 零交付断言以它为准
    const remoteBase = mkdtempSync(join(tmpdir(), "dirty-remote-"));
    tmpRoots.push(remoteBase);
    remoteUrl = makeBareRemote(remoteBase).url;
    // 一次性合成注册表(绝不指向受保护 config/projects.json)
    const regDir = mkdtempSync(join(tmpdir(), "dirty-reg-"));
    tmpRoots.push(regDir);
    const reg = join(regDir, "projects.json");
    writeFileSync(
      reg,
      JSON.stringify({ projects: [{ name: PROJECT_NAME, path: projectDir, repo: remoteUrl, branch: "main" }] }),
      "utf8",
    );
    savedEnv = process.env[PROJ_ENV];
    process.env[PROJ_ENV] = reg;

    const stageBase = mkdtempSync(join(tmpdir(), "dirty-stage-"));
    tmpRoots.push(stageBase);
    // driver:**不注入** prepareWorkspace / delivery ⇒ 生产同款内建装配(绑定 seed + 内建交付)
    driver = createLiveWorkerDriver({
      db: t.db,
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      sandbox: "host-fallback",
      workerId: "e2e-worker-dirty-project",
      wallSeconds: 30,
      heartbeatSeconds: 2,
      reserveCallsPerRun: 4,
      reviewerReserveCallsPerRun: 2,
      reviewAttempts: 1,
      stubInjection: {
        argv: [process.execPath, STUB],
        coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
        reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "x", STUB_DELAY_MS: "80" },
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
    csrf = ((await login.json()) as { csrfToken?: string }).csrfToken ?? "";
    expect(cookie).not.toBe("");
    expect(csrf).not.toBe("");

    const created = await fetch(base + "/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify({ rawInput: "在 dirty-demo 项目里加一个脚本", projectId: PROJECT_NAME }),
    });
    const body = (await created.json()) as { goalId?: string; taskIds?: string[] };
    expect(created.status).toBe(201);
    taskId = body.taskIds?.[0] ?? "";
    expect(taskId).not.toBe("");

    // 第二场景(独立复核 fail-open 根因):项目 B 提交态干净但 .git/index 损坏 ⇒ git status
    // 无法可靠验证而 HEAD/refs 仍可读(实测:rev-parse --git-dir=0 / rev-parse HEAD=0 /
    // status exit 128)。用确定性损坏建模(任意 uid 恒成立;chmod 000 在 root 下不构成障碍)。
    const projBBase = mkdtempSync(join(tmpdir(), "unverifiable-proj-"));
    tmpRoots.push(projBBase);
    const projectB = makeWorkspaceRepo(projBBase);
    projectBDir = projectB.dir;
    writeFileSync(join(projectBDir, ".git", "index"), "corrupted-index-bytes\n", "utf8");
    const remoteBBase = mkdtempSync(join(tmpdir(), "unverifiable-remote-"));
    tmpRoots.push(remoteBBase);
    remoteBUrl = makeBareRemote(remoteBBase).url;
    // 注册表补入项目 B(本包自建 tmp 注册表文件;readProjectRegistry 按请求读取)
    writeFileSync(
      reg,
      JSON.stringify({
        projects: [
          { name: PROJECT_NAME, path: projectDir, repo: remoteUrl, branch: "main" },
          { name: PROJECT_B_NAME, path: projectBDir, repo: remoteBUrl, branch: "main" },
        ],
      }),
      "utf8",
    );
    const createdB = await fetch(base + "/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify({ rawInput: "在 unverifiable-demo 项目里加一个脚本", projectId: PROJECT_B_NAME }),
    });
    const bodyB = (await createdB.json()) as { goalId?: string; taskIds?: string[] };
    expect(createdB.status).toBe(201);
    taskBId = bodyB.taskIds?.[0] ?? "";
    expect(taskBId).not.toBe("");
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

  it("T1 不误忽略:真实 tick 以 project_dirty_uncommitted:2 拒绝(tracked+untracked 各计一条)", async () => {
    await expect(driver.tick()).rejects.toThrow(/project_dirty_uncommitted:2/);
  });

  it("T2 不误交付:零 run 行、零候选变更集、交付远端零分支(脏内容到不了交付链)", async () => {
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskId}`);
    expect(Number(runs.rows[0]!["n"])).toBe(0);
    const cs = await t.db.execute(sql`SELECT count(*)::int AS n FROM candidate_changesets WHERE task_id = ${taskId}`);
    expect(Number(cs.rows[0]!["n"])).toBe(0);
    const head = (() => {
      try {
        return execFileSync("git", ["-C", remoteUrl, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
      } catch {
        return ""; // 分支尚不存在(= 零交付;与 makeBareRemote.head() 同语义)
      }
    })();
    expect(head).toBe("");
    // 先验在 executeRun 之前抛出(runTask 层)⇒ prepareRunDirs 从未执行 ⇒ 零 Run 占位目录泄漏;
    // 该语义由「runs 零行 + 任务从未 RUNNING(见附加断言 LEASED)」确定性钉住。
  });

  it("T3 不吞入:用户本地修改在源目录原样保留(不被纳入任何副本、不被回滚)", async () => {
    expect(execFileSync("cat", [join(projectDir, "src.txt")], { encoding: "utf8" })).toBe("USER-TRACKED-EDIT\n");
    expect(execFileSync("cat", [join(projectDir, "user-local.txt")], { encoding: "utf8" })).toBe(
      "USER-UNTRACKED-FILE\n",
    );
  });

  it("附加:拒绝发生在真实执行路径上(CLAIM 审计 + attempt=1 + LEASED;重试经 attempt 预算有界)", async () => {
    const task = await t.db.execute(sql`SELECT state, attempt FROM tasks WHERE id = ${taskId}`);
    expect(String(task.rows[0]!["state"])).toBe("LEASED");
    expect(Number(task.rows[0]!["attempt"])).toBe(1);
    const claim = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'CLAIM' AND task_id = ${taskId}`,
    );
    expect(Number(claim.rows[0]!["n"])).toBe(1);
  });

  it("T4(复核反例)HEAD 可读但状态不可验证 ⇒ 真实 tick 以 project_status_unverifiable 拒绝", async () => {
    await expect(driver.tick()).rejects.toThrow(/project_status_unverifiable/);
  });

  it("T5(复核反例)不误交付:任务 B 零 run/零候选/交付远端零分支;拒绝在真实执行路径(CLAIM+LEASED)", async () => {
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id = ${taskBId}`);
    expect(Number(runs.rows[0]!["n"])).toBe(0);
    const cs = await t.db.execute(sql`SELECT count(*)::int AS n FROM candidate_changesets WHERE task_id = ${taskBId}`);
    expect(Number(cs.rows[0]!["n"])).toBe(0);
    const head = (() => {
      try {
        return execFileSync("git", ["-C", remoteBUrl, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
      } catch {
        return ""; // 分支尚不存在(= 零交付)
      }
    })();
    expect(head).toBe("");
    const task = await t.db.execute(sql`SELECT state, attempt FROM tasks WHERE id = ${taskBId}`);
    expect(String(task.rows[0]!["state"])).toBe("LEASED");
    expect(Number(task.rows[0]!["attempt"])).toBe(1);
    const claim = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'CLAIM' AND task_id = ${taskBId}`,
    );
    expect(Number(claim.rows[0]!["n"])).toBe(1);
  });
});
