// P0-REWORK-2:最小 CLI 验收(US-04/V03 控制面;三入口同调 Core)。
// 覆盖:goal create/list/show 一致性、decision resolve(批准/拒绝)/defer、
//       pause 置入 + **PAUSED 不被 claimNextReady 领取(实证)** + resume、
//       越权 actor 拒绝、state_version 失配拒绝、doctor(凭据零明文)、
//       确定性退出码、控制面命令零模型 Run(runs 表零行)、API pause 端点同 Core、
//       bin 薄壳真实进程(strip-types 生产入口)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTestDb, taskState, type TestDb } from "../setup/testdb.ts";
import { runCli, EXIT } from "../../src/cli.ts";
import { planGoal } from "../../src/core/goals.ts";
import { createDecision } from "../../src/core/decisions.ts";
import { claimNextReady } from "../../src/core/supervisor.ts";
import { handleApi, type ApiDeps } from "../../src/server/api.ts";
import { AuthError, type Auth } from "../../src/server/auth.ts";
import type { Exec } from "../../src/core/db.ts";

function parseOut(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

describe("P0-REWORK-2:最小 CLI(US-04/V03)", { timeout: 120_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  beforeAll(async () => {
    t = await createTestDb("rework2-cli");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    await t.cleanup();
  });

  it("goal create → list → show:CLI 与 DB/API 视图一致,创建含预算账本", async () => {
    const created = parseOut((await runCli(["goal", "create", "--text", "REWORK2:一句需求", "--actor", "owner"])).out);
    expect(created["ok"]).toBe(true);
    const goalId = String(created["goalId"]);
    const taskId = (created["taskIds"] as string[])[0]!;
    // list 命中
    const list = parseOut((await runCli(["goal", "list"])).out) as {
      goals: Array<{ id: string; rawInput: string; state: string }>;
    };
    expect(list.goals.some((g) => g.id === goalId && g.rawInput === "REWORK2:一句需求")).toBe(true);
    // show 与 API 同一视图(goalDetailView)
    const showRes = await runCli(["goal", "show", goalId]);
    expect(showRes.code).toBe(EXIT.OK);
    const show = parseOut(showRes.out) as { goal: { goal: { id: string; rawInput: string }; tasks: unknown[] } };
    expect(show.goal.goal.rawInput).toBe("REWORK2:一句需求");
    expect(Array.isArray(show.goal.tasks)).toBe(true);
    // 预算账本行已建(FAIL-CLOSED 面)
    const ledger = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM budget_ledger WHERE scope_id=${goalId} AND kind='model_calls'`,
    );
    expect(Number(ledger.rows[0]!["n"])).toBe(1);
    expect(taskId).toMatch(/^task-/);
  });

  it("pause 置入 + PAUSED 不被 claimNextReady 领取(阻断实证)+ resume 恢复", async () => {
    const created = parseOut((await runCli(["goal", "create", "--text", "REWORK2:暂停语义", "--actor", "owner"])).out);
    const taskId = (created["taskIds"] as string[])[0]!;
    // 测试前提隔离:把既有 READY 任务置 BLOCKED,保证本例的 claim 观察只关乎本任务(不影响被测路径)
    await t.db.execute(
      sql`UPDATE tasks SET state='BLOCKED', state_version=state_version+1 WHERE id <> ${taskId} AND state='READY'`,
    );
    // v0:READY → PAUSED
    const pause = await runCli(["pause", taskId, "--expected-state-version", "0", "--actor", "owner"]);
    expect(pause.code).toBe(EXIT.OK);
    expect(parseOut(pause.out)).toMatchObject({ ok: true, fromState: "READY", toState: "PAUSED" });
    // 阻断实证:claim 只查 READY ⇒ PAUSED 任务不被领取(reason=no_ready_tasks,候选 SQL 计数 0)
    const claimPaused = await claimNextReady(t.db, "w1", 60);
    expect(claimPaused.ok).toBe(false);
    if (!claimPaused.ok) expect(claimPaused.reason).toBe("no_ready_tasks");
    // resume:v1 PAUSED → READY,随后可被领取(fencing 成立)
    const resume = await runCli(["task", "resume", taskId, "--expected-state-version", "1", "--actor", "owner"]);
    expect(resume.code).toBe(EXIT.OK);
    expect(parseOut(resume.out)).toMatchObject({ toState: "READY" });
    const claim = await claimNextReady(t.db, "w1", 60);
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.taskId).toBe(taskId);
    // 审计链:TASK_PAUSED + TASK_RESUMED(OPERATOR 权威)
    const audits = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE task_id=${taskId} AND action IN ('TASK_PAUSED','TASK_RESUMED') ORDER BY seq`);
    expect(audits.rows.map((r) => String(r["action"]))).toEqual(["TASK_PAUSED", "TASK_RESUMED"]);
  });

  it("state_version 失配与越权 actor 正确拒绝(exit 3)+ 审计留痕 + 状态零变更", async () => {
    const created = parseOut((await runCli(["goal", "create", "--text", "REWORK2:拒绝语义", "--actor", "owner"])).out);
    const taskId = (created["taskIds"] as string[])[0]!;
    // 旧版本(实际 0,给 99)
    const stale = await runCli(["pause", taskId, "--expected-state-version", "99", "--actor", "owner"]);
    expect(stale.code).toBe(EXIT.DENIED);
    expect(parseOut(stale.out)).toMatchObject({ ok: false, error: "state_version_mismatch" });
    // 越权 actor
    const intruder = await runCli(["pause", taskId, "--expected-state-version", "0", "--actor", "intruder"]);
    expect(intruder.code).toBe(EXIT.DENIED);
    expect(parseOut(intruder.out)).toMatchObject({ ok: false, error: "actor_not_authorized" });
    // 状态零变更 + 拒绝审计
    const row = await taskState(t.db, taskId);
    expect(String(row["state"])).toBe("READY");
    expect(Number(row["state_version"])).toBe(0);
    const rej = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id=${taskId} AND action='TASK_PAUSED_REJECTED'`,
    );
    expect(Number(rej.rows[0]!["n"])).toBe(2);
  });

  it("decision resolve 批准:NEEDS_DECISION → READY + 决策 RESOLVED_MANUAL", async () => {
    const goal = parseOut((await runCli(["goal", "create", "--text", "REWORK2:D3 批准", "--actor", "owner"])).out);
    const goalId = String(goal["goalId"]);
    const taskId = (goal["taskIds"] as string[])[0]!;
    await t.db.execute(sql`UPDATE tasks SET state='NEEDS_DECISION', state_version=state_version+1 WHERE id=${taskId}`);
    const dec = await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, { taskId, goalId, level: "D3", question: "是否交付到远端?" }),
    );
    expect(dec.ok).toBe(true);
    const decisionId = dec.ok ? dec.id : "";
    const resolved = await runCli([
      "decision",
      "resolve",
      decisionId,
      "--task",
      taskId,
      "--approve",
      "--expected-state-version",
      "1",
      "--actor",
      "owner",
    ]);
    expect(resolved.code).toBe(EXIT.OK);
    expect(parseOut(resolved.out)).toMatchObject({
      ok: true,
      fromState: "NEEDS_DECISION",
      toState: "READY",
      decisionResolved: true,
    });
    const row = await t.db.execute(sql`SELECT state, verdict, decided_by FROM decisions WHERE id=${decisionId}`);
    expect(String(row.rows[0]!["state"])).toBe("RESOLVED_MANUAL");
    expect(String(row.rows[0]!["decided_by"])).toBe("owner");
  });

  it("decision resolve 拒绝:→ FAILED + 决策 REJECTED;defer 只改截止时间不改状态", async () => {
    const goal = parseOut(
      (await runCli(["goal", "create", "--text", "REWORK2:D3 拒绝与推迟", "--actor", "owner"])).out,
    );
    const taskId = (goal["taskIds"] as string[])[0]!;
    await t.db.execute(sql`UPDATE tasks SET state='NEEDS_DECISION', state_version=state_version+1 WHERE id=${taskId}`);
    const dec = await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, { taskId, level: "D3", question: "REWORK2 defer 演练" }),
    );
    const decisionId = dec.ok ? dec.id : "";
    // defer:只改 deadline(状态仍 OPEN,任务仍 NEEDS_DECISION)
    const deferred = await runCli([
      "decision",
      "defer",
      decisionId,
      "--task",
      taskId,
      "--deadline",
      "2026-12-01T00:00:00Z",
      "--expected-state-version",
      "1",
      "--actor",
      "owner",
    ]);
    expect(deferred.code).toBe(EXIT.OK);
    const drow = await t.db.execute(sql`SELECT state, deadline FROM decisions WHERE id=${decisionId}`);
    expect(String(drow.rows[0]!["state"])).toBe("OPEN");
    expect(new Date(String(drow.rows[0]!["deadline"])).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    // reject:决策 REJECTED + 任务 FAILED
    const rejected = await runCli([
      "decision",
      "resolve",
      decisionId,
      "--task",
      taskId,
      "--reject",
      "--expected-state-version",
      "1",
      "--actor",
      "owner",
    ]);
    expect(rejected.code).toBe(EXIT.OK);
    expect(parseOut(rejected.out)).toMatchObject({ toState: "FAILED" });
    const drow2 = await t.db.execute(sql`SELECT state FROM decisions WHERE id=${decisionId}`);
    expect(String(drow2.rows[0]!["state"])).toBe("REJECTED");
    // 已裁决的决策不可再推迟
    const deferAgain = await runCli([
      "decision",
      "defer",
      decisionId,
      "--task",
      taskId,
      "--deadline",
      "2027-01-01T00:00:00Z",
      "--expected-state-version",
      "2",
      "--actor",
      "owner",
    ]);
    expect(deferAgain.code).toBe(EXIT.DENIED);
    expect(parseOut(deferAgain.out)).toMatchObject({ error: "decision_not_pending:REJECTED" });
  });

  it("doctor:迁移面/守卫/凭据零明文(存在时验权限位);未迁移环境退出码 5", async () => {
    const doc = parseOut((await runCli(["doctor"])).out) as {
      doctor: {
        db: { ok: boolean };
        githubCredential: { exists: boolean; mode: string; contentShown: boolean };
        pi: unknown;
        docker: { available: boolean };
      };
    };
    const raw = JSON.stringify(doc);
    expect(doc.doctor.db.ok).toBe(true);
    // 凭据文件是 VM80 宿主事实(CI runner 无):存在则验 0600,不存在仅验"如实报告不存在"
    if (existsSync(join(homedir(), ".relay", "credentials", "github-sandbox-pat"))) {
      expect(doc.doctor.githubCredential.exists).toBe(true);
      expect(doc.doctor.githubCredential.mode).toBe("600");
    } else {
      expect(doc.doctor.githubCredential.exists).toBe(false);
    }
    expect(doc.doctor.githubCredential.contentShown).toBe(false);
    // 零明文:输出不得包含任何 token 形态
    expect(raw).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]/);
    // pi/docker 项存在
    expect(doc.doctor).toHaveProperty("pi");
    expect(doc.doctor).toHaveProperty("docker");
    // 未迁移环境:同库空 schema ⇒ db.ok=false,退出码 5(环境不可用,非内部错误)
    const emptySchema = `${t.schemaName}_empty`;
    await t.adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${emptySchema}`);
    try {
      process.env.RELAY_DB_SCHEMA = emptySchema;
      const bad = await runCli(["doctor"]);
      expect(bad.code).toBe(EXIT.ENV);
    } finally {
      process.env.RELAY_DB_SCHEMA = t.schemaName;
      await t.adminPool.query(`DROP SCHEMA IF EXISTS ${emptySchema} CASCADE`);
    }
  });

  it("确定性退出码:usage=2 / not_found=4 / ok=0;控制面零模型 Run", async () => {
    expect((await runCli(["unknown-cmd"])).code).toBe(EXIT.USAGE);
    expect((await runCli(["goal", "show", "goal-nonexistent"])).code).toBe(EXIT.NOT_FOUND);
    expect((await runCli(["goal", "create"])).code).toBe(EXIT.USAGE); // 缺 --text
    const list = await runCli(["goal", "list"]);
    expect(list.code).toBe(EXIT.OK);
    // 控制面命令全程零模型 Run(runs 表零行;provider 未配置也不产生 Run 记录)
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs`);
    expect(Number(runs.rows[0]!["n"])).toBe(0);
  });

  it("API pause 端点与 CLI 同一 Core:正例 200/状态门 400/未认证 401", async () => {
    const created = parseOut((await runCli(["goal", "create", "--text", "REWORK2:API 对等", "--actor", "owner"])).out);
    const taskId = (created["taskIds"] as string[])[0]!;
    const authedDeps = {
      db: t.db,
      auth: {
        resolve: () => ({ id: "s1", role: "owner", csrf: "c", expiresAt: Date.now() + 60_000 }),
        verifySameOrigin: () => {},
        verifyCsrf: () => {},
        activeSessions: () => 1,
      } as unknown as Auth,
      worker: null,
      workerMode: "external" as const,
      defaultGoalBudgetModelCalls: 8,
    } as ApiDeps;
    const anonDeps = {
      ...authedDeps,
      auth: {
        resolve: () => {
          throw new AuthError("unknown_session", "未登录");
        },
        verifySameOrigin: () => {},
        verifyCsrf: () => {},
        activeSessions: () => 0,
      } as unknown as Auth,
    } as ApiDeps;
    const call = (
      deps: ApiDeps,
      method: string,
      path: string,
      body: Record<string, unknown> | null,
      headers: Record<string, string | undefined> = {},
    ) => handleApi(deps, { method, path, query: new URLSearchParams(), body, headers, ip: "127.0.0.1" });
    // 未认证 401
    const anon = await call(anonDeps, "POST", `/api/tasks/${taskId}/pause`, { expectedStateVersion: 0 });
    expect(anon.status).toBe(401);
    // 正例 200:READY → PAUSED(CLI 同一 pauseTask)
    const okRes = await call(
      authedDeps,
      "POST",
      `/api/tasks/${taskId}/pause`,
      { expectedStateVersion: 0 },
      { cookie: "relay_session=x", "x-relay-csrf": "c", origin: "null" },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body).toMatchObject({ ok: true, fromState: "READY", toState: "PAUSED" });
    // 重复同版本 pause ⇒ 400(状态门先于版本门:PAUSED 非 READY ⇒ pause_requires_ready:PAUSED)
    const conflict = await call(
      authedDeps,
      "POST",
      `/api/tasks/${taskId}/pause`,
      { expectedStateVersion: 0 },
      { cookie: "relay_session=x", "x-relay-csrf": "c", origin: "null" },
    );
    expect(conflict.status).toBe(400);
    expect((conflict.body as { error: string }).error).toBe("pause_requires_ready:PAUSED");
    // API 暂停后 CLI 恢复(状态版本由 API +1)
    const row = await taskState(t.db, taskId);
    const resume = await runCli([
      "task",
      "resume",
      taskId,
      "--expected-state-version",
      String(Number(row["state_version"])),
      "--actor",
      "owner",
    ]);
    expect(resume.code).toBe(EXIT.OK);
  });

  it("worker tick --stub --seed:CLI 单拍 run+Gate(P0-B 语义:CLI 生产默认无功能性机器检查 ⇒ 保守停机 NEEDS_DECISION,不烧 Reviewer)", async () => {
    const created = parseOut(
      (await runCli(["goal", "create", "--text", "REWORK2:CLI 单拍执行", "--actor", "owner"])).out,
    );
    const taskId = (created["taskIds"] as string[])[0]!;
    // 测试前提隔离:既有 READY 任务置 BLOCKED,保证本例任务被领取
    await t.db.execute(
      sql`UPDATE tasks SET state='BLOCKED', state_version=state_version+1 WHERE id <> ${taskId} AND state='READY'`,
    );
    const seed = markTemp(mkdtempSync(join(tmpdir(), "rework2-seed-")));
    writeFileSync(join(seed, "brief.txt"), "numbers: 12 30 45\n", "utf8");
    // Coder 桩 env(经 STUB_* 命名空间进 CLI;Reviewer 缺省 verdict PASS)
    process.env.STUB_MODE = "ok";
    process.env.STUB_WRITE_FILE = "result.txt:sum=87";
    try {
      const tick = await runCli(["worker", "tick", "--stub", "--seed", seed, "--worker-id", "cli-test-worker"]);
      expect(tick.code).toBe(EXIT.OK);
      const parsed = parseOut(tick.out) as {
        workerMode: string;
        tick: { status: string; gate?: { status: string; reason?: string }; run?: { outcome?: string } };
      };
      // 桩执行如实标注:workerMode=stub(不得冒充 live)
      expect(parsed.workerMode).toBe("stub");
      expect(parsed.tick.status).toBe("PROGRESSED");
      expect(parsed.tick.run?.outcome).toBe("SUCCEEDED");
      // P0-B(RELAY-SAFETY-CLOSE-02):代码变更候选 + CLI 默认无 evidenceChecks ⇒
      // 候选清单复验(完整性)通过后仍保守停机 —— 完整性 ≠ 行为正确,不烧 Reviewer 预算
      expect(parsed.tick.gate?.status).toBe("NEEDS_DECISION");
      expect(parsed.tick.gate?.reason).toBe("functional_evidence_unconfigured");
      // 落库事实:仅 coder run(Reviewer 未启动);候选 changeset;任务 NEEDS_DECISION(可经 ops 恢复)
      const runRow = await t.db.execute(
        sql`SELECT count(*)::int AS n FROM runs WHERE task_id=${taskId} AND outcome='SUCCEEDED'`,
      );
      expect(Number(runRow.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
      const reviewerRuns = await t.db.execute(sql`
        SELECT count(*)::int AS n FROM runs WHERE task_id=${taskId} AND detail->>'role'='reviewer'
      `);
      expect(Number(reviewerRuns.rows[0]!["n"])).toBe(0);
      const cs = await t.db.execute(sql`SELECT delivery_state FROM candidate_changesets WHERE task_id=${taskId}`);
      expect(cs.rows.length).toBe(1);
      const st = await taskState(t.db, taskId);
      expect(String(st["state"])).toBe("NEEDS_DECISION");
      // D3 决策行留痕(人工可恢复;永不自动批准)
      const dec = await t.db.execute(
        sql`SELECT count(*)::int AS n FROM decisions WHERE task_id=${taskId} AND state='OPEN'`,
      );
      expect(Number(dec.rows[0]!["n"])).toBe(1);
    } finally {
      delete process.env.STUB_MODE;
      delete process.env.STUB_WRITE_FILE;
      safeRm(seed, { roots: [seed], sentinel: RUN_SENTINEL });
    }
  });

  it("REVIEW Major-1 修复回归:RUNNING(活跃租约)任务不可被 pause——租约链不打断", async () => {
    const created = parseOut(
      (await runCli(["goal", "create", "--text", "REWORK2:RUNNING 不可 pause", "--actor", "owner"])).out,
    );
    const taskId = (created["taskIds"] as string[])[0]!;
    await t.db.execute(
      sql`UPDATE tasks SET state='BLOCKED', state_version=state_version+1 WHERE id <> ${taskId} AND state='READY'`,
    );
    // 领取进入租约链,推进到 RUNNING(模拟 worker 在飞执行)
    const claim = await claimNextReady(t.db, "w-running", 3600);
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.taskId).toBe(taskId);
    await t.db.execute(sql`UPDATE tasks SET state='RUNNING' WHERE id=${taskId}`);
    // 直接调 Core(REVIEW 实证路径):RUNNING ⇒ 拒绝,原因 pause_requires_ready
    const { pauseTask } = await import("../../src/core/ops.ts");
    const r = await t.db.transaction(async (tx) =>
      pauseTask(tx as unknown as Exec, taskId, { actor: "owner", expectedStateVersion: 1 }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("pause_requires_ready:RUNNING");
    // 任务保持 RUNNING(在飞执行未被打断),租约仍在
    const row = await taskState(t.db, taskId);
    expect(String(row["state"])).toBe("RUNNING");
    const lease = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM leases WHERE task_id=${taskId} AND lease_expires_at > now()`,
    );
    expect(Number(lease.rows[0]!["n"])).toBe(1);
    // CLI 口径同样拒绝(exit 3)
    const cliPause = await runCli(["pause", taskId, "--expected-state-version", "1", "--actor", "owner"]);
    expect(cliPause.code).toBe(EXIT.DENIED);
    const audits = await t.db.execute(
      sql`SELECT detail FROM audit_events WHERE task_id=${taskId} AND action='TASK_PAUSED_REJECTED' ORDER BY seq DESC LIMIT 1`,
    );
    expect(JSON.stringify(audits.rows[0]!["detail"])).toContain("pause_requires_ready:RUNNING");
  });

  it("REVIEW Major-2 修复回归:decision defer 无授权 actor 拒绝(Core 层门,截止时间不变)", async () => {
    const goal = parseOut((await runCli(["goal", "create", "--text", "REWORK2:defer 授权门", "--actor", "owner"])).out);
    const taskId = (goal["taskIds"] as string[])[0]!;
    await t.db.execute(sql`UPDATE tasks SET state='NEEDS_DECISION', state_version=state_version+1 WHERE id=${taskId}`);
    const dec = await t.db.transaction(async (tx) =>
      createDecision(tx as unknown as Exec, { taskId, level: "D3", question: "defer 授权门演练" }),
    );
    const decisionId = dec.ok ? dec.id : "";
    const before = await t.db.execute(sql`SELECT deadline FROM decisions WHERE id=${decisionId}`);
    // CLI 直调路径:intruder 应被 Core 层 operatorAllowed 拒绝(exit 3)
    const intruder = await runCli([
      "decision",
      "defer",
      decisionId,
      "--task",
      taskId,
      "--deadline",
      "2027-06-01T00:00:00Z",
      "--expected-state-version",
      "1",
      "--actor",
      "intruder",
    ]);
    expect(intruder.code).toBe(EXIT.DENIED);
    expect(parseOut(intruder.out)).toMatchObject({ ok: false, error: "actor_not_authorized" });
    const after = await t.db.execute(sql`SELECT deadline FROM decisions WHERE id=${decisionId}`);
    expect(String(after.rows[0]!["deadline"])).toBe(String(before.rows[0]!["deadline"]));
    const rej = await t.db.execute(
      sql`SELECT detail FROM audit_events WHERE task_id=${taskId} AND action='DECISION_DEFER_REJECTED' ORDER BY seq DESC LIMIT 1`,
    );
    expect(JSON.stringify(rej.rows[0]!["detail"])).toContain("actor_not_authorized");
  });

  it("REVIEW Minor 修复回归:worker tick 越权 actor 拒绝(与 API tick 同 operator 门)", async () => {
    const r = await runCli(["worker", "tick", "--actor", "intruder"]);
    expect(r.code).toBe(EXIT.DENIED);
    expect(parseOut(r.out)).toMatchObject({ ok: false, error: "actor_not_authorized" });
  });

  it("bin 薄壳真实进程:node bin/relay.mjs doctor 结构化输出与确定性退出码", async () => {
    const r = spawnSync(process.execPath, [new URL("../../bin/relay.mjs", import.meta.url).pathname, "doctor"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, RELAY_DB_SCHEMA: t.schemaName },
    });
    expect(r.status).toBe(EXIT.OK);
    const parsed = JSON.parse(r.stdout) as { doctor: { db: { ok: boolean } } };
    expect(parsed.doctor.db.ok).toBe(true);
    // 不带迁移 schema 的库 ⇒ exit 5(同一二进制,确定性)
    const bad = spawnSync(process.execPath, [new URL("../../bin/relay.mjs", import.meta.url).pathname, "doctor"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, RELAY_DB_SCHEMA: `${t.schemaName}_missing` },
    });
    expect(bad.status).toBe(EXIT.ENV);
  });
});
