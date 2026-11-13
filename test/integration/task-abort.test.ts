// RELAY-CONTROL-READY-03 P1-3:紧急停止与人工接管最小切片(反例先行思路:跨进程 abort 旗标 →
// worker 轮询 → runner cancelSignal → SIGTERM→SIGKILL → run=CANCELLED → 任务终态;全程真实进程)。
// 覆盖(合同要求):重复请求幂等/READY 拒绝混语义/终态拒绝/旧 fencing 推进拒绝/残余子进程死亡/
// REQUESTED-CONFIRMED 审计三分;零模型(stub)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { requestTaskAbort } from "../../src/core/ops.ts";
import { planGoal } from "../../src/core/goals.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { createLiveWorkerDriver } from "../../src/server/worker.ts";
import { handleApi, type ApiDeps } from "../../src/server/api.ts";
import type { Auth } from "../../src/server/auth.ts";
import type { Exec } from "../../src/core/db.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("RELAY-CONTROL-READY-03 P1-3:abort 旗标与接管(零模型;真实进程信号)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("control-ready-03-abort");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  async function seedReadyTask(taskId: string): Promise<void> {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: `goal-${taskId}`,
        rawInput: "abort 测试目标",
        budget: { modelCalls: 4 },
        tasks: [{ id: taskId, goalText: "执行", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
  }

  it("单元:READY 任务 abort ⇒ 拒绝(非在飞走 pause/decision 语义,不混);终态 ⇒ state_terminal;版本失配 ⇒ 409 语义", async () => {
    await seedReadyTask("t-abort-ready");
    const r = await t.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, "t-abort-ready", { actor: "owner" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("abort_requires_in_flight:READY");
    const audit = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-abort-ready' AND action='TASK_ABORT_REJECTED'`,
    );
    expect(Number(audit.rows[0]!["n"])).toBe(1);
    // 版本失配
    const r2 = await t.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, "t-abort-ready", { actor: "owner", expectedStateVersion: 99 }),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("state_version_mismatch");
  });

  it("单元:在飞(LEASED)abort ⇒ 旗标置位 + REQUESTED 审计;重复请求幂等(alreadyRequested,不重复审计)", async () => {
    await seedReadyTask("t-abort-leased");
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-abort-leased", "w-abort", 60));
    expect(c.ok).toBe(true);
    const r1 = await t.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, "t-abort-leased", { actor: "owner" }),
    );
    expect(r1.ok).toBe(true);
    expect(r1.alreadyRequested).toBeUndefined(); // 首次生效
    const flag = await t.db.execute(sql`SELECT abort_requested_at FROM tasks WHERE id='t-abort-leased'`);
    expect(flag.rows[0]!["abort_requested_at"]).not.toBeNull();
    const r2 = await t.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, "t-abort-leased", { actor: "owner" }),
    );
    expect(r2.ok).toBe(true);
    expect(r2.alreadyRequested).toBe(true); // 幂等:重复点击不重复生效
    const audits = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-abort-leased' AND action='TASK_ABORT_REQUESTED'`,
    );
    expect(Number(audits.rows[0]!["n"])).toBe(1); // 恰好一条 REQUESTED(幂等证明)
  });

  it("跨进程 abort 全链(真实进程):worker 轮询旗标 → cancelSignal → SIGTERM→SIGKILL → run=CANCELLED → 任务 CANCELLED;残余子进程死亡;REQUESTED+CONFIRMED 审计;旧 fencing 推进拒绝", {
    timeout: 120_000,
  }, async () => {
    await seedReadyTask("t-abort-chain");
    const pidFile = join(mkdtempSync(join(tmpdir(), "relay-abort-")), "stub.pid");
    const driver = createLiveWorkerDriver({
      db: t.db,
      model: MODEL,
      sandbox: "host-fallback",
      workerId: "w-abort-chain",
      wallSeconds: 60,
      heartbeatSeconds: 1,
      stubInjection: {
        argv: [process.execPath, STUB],
        coderEnv: { STUB_MODE: "hang", STUB_PID_FILE: pidFile },
        reviewerEnv: { STUB_MODE: "hang", STUB_PID_FILE: pidFile },
      },
      // 注:CANCELLED 不进 Gate(worker gate 仅在 run SUCCEEDED 后编排),无需注入 reviewRun
    });
    // 后台推进一拍(任务被领取并进入 RUNNING;hang stub 挂起)
    // 测试隔离:前置用例遗留的 READY 任务置 BLOCKED(同 cli.test 口径),保证本拍只领取目标任务
    await t.db.execute(sql`
      UPDATE tasks SET state='BLOCKED', state_version = state_version + 1
      WHERE id <> 't-abort-chain' AND state = 'READY'
    `);
    const tickPromise = driver.tick();
    tickPromise.catch((err: unknown) => console.log("[diag] tick rejected:", err));
    let running = false;
    for (let i = 0; i < 100; i++) {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-abort-chain'`);
      const st = String(r.rows[0]!["state"]);
      if (st === "RUNNING") {
        running = true;
        break;
      }
      if (["ACCEPTED", "FAILED", "CANCELLED", "REWORK", "BLOCKED", "NEEDS_DECISION"].includes(st)) {
        console.log("[diag] task left claimable early:", st, "iteration", i);
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    if (!running) {
      const d = await t.db.execute(sql`
        SELECT id, state, attempt, blocked_reason, abort_requested_at FROM tasks WHERE id LIKE 't-abort%' OR id LIKE 't-takeover%'
      `);
      console.log("[diag] final task rows:", JSON.stringify(d.rows));
      // 兜底清理:置旗终止任何被误领取的遗留任务(防 hang stub 超时残留)
      await t.db
        .execute(
          sql`UPDATE tasks SET abort_requested_at = now() WHERE state IN ('LEASED','RUNNING','SUBMITTED','VERIFYING') AND abort_requested_at IS NULL`,
        )
        .catch(() => {});
      const runs = await t.db.execute(
        sql`SELECT id, task_id, outcome, detail->>'reason' AS reason FROM runs ORDER BY started_at`,
      );
      console.log("[diag] runs:", JSON.stringify(runs.rows));
    }
    expect(running).toBe(true);
    // 等 stub 进程落盘 pid 并确认存活(残余子进程检查的基线)
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 100));
    console.log("[diag] pidFile exists:", existsSync(pidFile));
    expect(existsSync(pidFile)).toBe(true);
    const stubPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(processAlive(stubPid)).toBe(true);

    // 跨进程 abort:置旗(模拟 ops/API 在另一进程置位)
    const req = await t.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, "t-abort-chain", { actor: "owner" }),
    );
    expect(req.ok).toBe(true);

    const report = await tickPromise;
    expect(report.status).toBe("PROGRESSED");
    expect(report.run?.outcome).toBe("CANCELLED");
    // 任务终态(合法转移 RUNNING→CANCELLED;租约权威不变)
    const st = await t.db.execute(sql`SELECT state, abort_requested_at FROM tasks WHERE id='t-abort-chain'`);
    expect(String(st.rows[0]!["state"])).toBe("CANCELLED");
    expect(st.rows[0]!["abort_requested_at"]).not.toBeNull();
    // run 行:outcome=CANCELLED,reason=cancelled_by_caller
    const runRow = await t.db.execute(
      sql`SELECT outcome, detail->>'reason' AS reason FROM runs WHERE task_id='t-abort-chain' ORDER BY started_at DESC LIMIT 1`,
    );
    expect(String(runRow.rows[0]!["outcome"])).toBe("CANCELLED");
    expect(String(runRow.rows[0]!["reason"])).toBe("cancelled_by_caller");
    // 残余子进程死亡(SIGTERM→SIGKILL 后)
    let dead = false;
    for (let i = 0; i < 50; i++) {
      if (!processAlive(stubPid)) {
        dead = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(dead).toBe(true);
    // 审计三分:REQUESTED(RECEIVED)+ CONFIRMED(STOP_CONFIRMED);旧 fencing 推进拒绝
    const requested = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-abort-chain' AND action='TASK_ABORT_REQUESTED'`,
    );
    expect(Number(requested.rows[0]!["n"])).toBe(1);
    const confirmed = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-abort-chain' AND action='TASK_ABORT_CONFIRMED'`,
    );
    expect(Number(confirmed.rows[0]!["n"])).toBe(1);
    // 旧 fencing 推进拒绝(任务已终态;任何残留权威不得续写)
    const stale = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-abort-chain", "w-abort-chain", 1, "RUNNING", "SUBMITTED"),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toContain("state_terminal");
    // 清理 driver 沙箱
    driver as unknown as { sandboxes?: unknown[] };
  });

  it("API:abort 端点(幂等/READY 拒绝 409)与 takeover 端点(审计 + 幂等)", { timeout: 60_000 }, async () => {
    const deps = {
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
    const call = (method: string, p: string, body: Record<string, unknown>) =>
      handleApi(deps, {
        method,
        path: p,
        query: new URLSearchParams(),
        body,
        headers: { cookie: "relay_session=x", "x-relay-csrf": "c", origin: "null" },
        ip: "127.0.0.1",
      });
    // takeover on READY ⇒ 409 语义拒绝(仅在飞;READY 走 pause 路径)
    await seedReadyTask("t-takeover-ready");
    const bad = await call("POST", "/api/tasks/t-takeover-ready/takeover", {});
    expect(bad.status).toBe(409);
    expect((bad.body as { error: string }).error).toContain("abort_requires_in_flight");
    // RUNNING(模拟在飞)takeover ⇒ ok + 旗标 + TAKEOVER 审计;重复 ⇒ alreadyRequested
    await seedReadyTask("t-takeover-running");
    await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-takeover-running", "w-t", 60));
    await t.db.execute(sql`UPDATE tasks SET state='RUNNING' WHERE id='t-takeover-running'`);
    const ok1 = await call("POST", "/api/tasks/t-takeover-running/takeover", {});
    expect(ok1.status).toBe(200);
    expect((ok1.body as { alreadyRequested?: boolean }).alreadyRequested).toBe(false);
    const ok2 = await call("POST", "/api/tasks/t-takeover-running/abort", {});
    expect(ok2.status).toBe(200);
    expect((ok2.body as { alreadyRequested?: boolean }).alreadyRequested).toBe(true); // 幂等(同旗标)
    const takeoverAudit = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-takeover-running' AND action='TASK_TAKEOVER_REQUESTED'`,
    );
    expect(Number(takeoverAudit.rows[0]!["n"])).toBe(1);
  });
});

// ---------- F-1 修复回归(REVIEW-CONTROL-READY-03):VERIFYING 阶段 abort 必须真实闭环 ----------
import { orchestrateGate, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { goalLoopTick } from "../../src/core/goal-loop.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";
import { verifyCandidateManifest } from "../../src/runtime/workspace-manifest.ts";

const STUB_PI = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;

describe("RELAY-CONTROL-READY-03 F-1 修复:VERIFYING/Gate 阶段紧急停止真实闭环(零模型;反例先行)", () => {
  let t2: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t2 = await createTestDb("control-ready-03-f1");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t2.cleanup();
  });

  /** coder Run(stub ok)至 VERIFYING(runner 合法推进);候选=result.txt(代码变更)。 */
  async function coderRunToVerifying(
    taskId: string,
  ): Promise<{ runId: string; workspaceDir: string; attempt: number }> {
    const goalId = `goal-${taskId}`;
    await t2.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "F-1 反例目标",
        budget: { modelCalls: 8 },
        tasks: [{ id: taskId, goalText: "执行", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const c = await t2.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, "w-f1", 60));
    if (!c.ok) throw new Error(`claim failed: ${JSON.stringify(c)}`);
    const result = await executeRun(t2.db, resolveVendoredPi(), {
      taskId,
      goal: "F-1 反例目标",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 2,
      budget: { goalId, reserveCallsPerRun: 4 },
      argvOverride: [process.execPath, STUB_PI],
      envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: "result.txt:sum=87" },
    });
    if (result.outcome !== "SUCCEEDED") throw new Error(`run outcome=${result.outcome}`);
    sandboxes.push(result.sandboxSpec);
    return { runId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir, attempt: c.attempt };
  }

  it("前置拦截:VERIFYING abort 后 Gate 编排 ⇒ status=CANCELLED;Reviewer 零调用;任务 VERIFYING→CANCELLED;CONFIRMED 审计;零裁决行", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-f1-pre";
    const run = await coderRunToVerifying(taskId);
    const before = await t2.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(before.rows[0]!["state"])).toBe("VERIFYING"); // Run 成功后至 Gate 编排窗口(Reviewer 原反例场景)
    // 操作者(另一进程)请求紧急停止
    const req = await t2.db.transaction(async (tx) =>
      requestTaskAbort(tx as unknown as Exec, taskId, { actor: "owner" }),
    );
    expect(req.ok).toBe(true);
    let reviewerCalls = 0;
    const gate = await orchestrateGate(
      t2.db,
      { taskId, attempt: run.attempt, coderRunId: run.runId, workspaceDir: run.workspaceDir, actor: "test-f1" },
      {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "console.log('ok')"], cwdWorkspace: true },
        ],
        reviewRun: async () => {
          reviewerCalls += 1;
          throw new Error("reviewer_must_not_run_after_abort");
        },
        reviewAttempts: 1,
      },
    );
    expect(gate.status).toBe("CANCELLED");
    expect(gate.reason).toBe("abort_requested");
    expect(reviewerCalls).toBe(0); // Reviewer 零烧
    const st = await t2.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("CANCELLED");
    const verdicts = await t2.db.execute(
      sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId}`,
    );
    expect(Number(verdicts.rows[0]!["n"])).toBe(0);
    const confirmed = await t2.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id=${taskId} AND action='TASK_ABORT_CONFIRMED'`,
    );
    expect(Number(confirmed.rows[0]!["n"])).toBe(1);
  });

  it("后置拦截:Reviewer 期间置旗(旗标在编排内到达)⇒ 裁决不记录不消费,任务 CANCELLED;Reviewer 证据留档", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-f1-mid";
    const run = await coderRunToVerifying(taskId);
    const gate = await orchestrateGate(
      t2.db,
      { taskId, attempt: run.attempt, coderRunId: run.runId, workspaceDir: run.workspaceDir, actor: "test-f1" },
      {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "console.log('ok')"], cwdWorkspace: true },
        ],
        reviewRun: async (input): Promise<ReviewRunResult> => {
          // 模拟旗标在 Reviewer Run 之后、裁决记录之前到达(真实场景=另一进程 abort)
          await t2.db.transaction(async (tx) => requestTaskAbort(tx as unknown as Exec, taskId, { actor: "owner" }));
          return {
            ok: true,
            verdict: "PASS",
            findings: "stub pass",
            reviewerRunId: input.taskId + "-rv",
            rawOutput: "stub pass",
          };
        },
        reviewAttempts: 1,
      },
    );
    expect(gate.status).toBe("CANCELLED");
    const st = await t2.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("CANCELLED");
    const verdicts = await t2.db.execute(
      sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId}`,
    );
    expect(Number(verdicts.rows[0]!["n"])).toBe(0); // PASS 裁决不记录不消费(停止优先)
    const confirmed = await t2.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id=${taskId} AND action='TASK_ABORT_CONFIRMED'`,
    );
    expect(Number(confirmed.rows[0]!["n"])).toBe(1);
  });

  it("交付防线(goalLoop):Run 成功 → Reviewer 期间置旗 ⇒ Gate CANCELLED ⇒ 交付防线跳过(propose 零调用)", {
    timeout: 120_000,
  }, async () => {
    const taskId = "t-f1-delivery";
    const goalId = `goal-${taskId}`;
    await t2.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "F-1 反例目标",
        budget: { modelCalls: 8 },
        tasks: [{ id: taskId, goalText: "执行", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    let proposeCalls = 0;
    const report = await goalLoopTick(t2.db, {
      actor: "w-f1",
      workerId: "w-f1",
      runTask: async (claim) => {
        const result = await executeRun(t2.db, resolveVendoredPi(), {
          taskId,
          goal: "F-1 反例目标",
          allowedScope: ["/workspace"],
          attempt: claim.attempt,
          ownerId: claim.ownerId,
          fencingToken: claim.fencingToken,
          model: MODEL,
          sandbox: "host-fallback",
          wallSeconds: 60,
          heartbeatSeconds: 2,
          budget: { goalId, reserveCallsPerRun: 4 },
          argvOverride: [process.execPath, STUB_PI],
          envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: "result.txt:sum=87" },
        });
        sandboxes.push(result.sandboxSpec);
        if (result.outcome !== "SUCCEEDED") throw new Error(`outcome=${result.outcome}`);
        return { outcome: result.outcome, taskId, runId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir };
      },
      gate: {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "console.log('ok')"], cwdWorkspace: true },
        ],
        reviewRun: async (input): Promise<ReviewRunResult> => {
          // 模拟旗标在 Reviewer Run 之后、裁决记录之前到达(另一进程 abort)
          await t2.db.transaction(async (tx) => requestTaskAbort(tx as unknown as Exec, taskId, { actor: "owner" }));
          return {
            ok: true,
            verdict: "PASS",
            findings: "stub pass",
            reviewerRunId: input.taskId + "-rv",
            rawOutput: "stub pass",
          };
        },
        reviewAttempts: 1,
      },
      delivery: {
        propose: async () => {
          proposeCalls += 1;
          throw new Error("delivery_propose_must_not_run_after_abort");
        },
        io: async () => {
          throw new Error("delivery_io_must_not_run_after_abort");
        },
      },
    });
    expect(report.gate?.status).toBe("CANCELLED"); // 编排后置检查拦截(4.5)
    expect(report.delivery).toBeUndefined(); // Gate 非 ACCEPTED ⇒ 交付分支整体未进入
    expect(proposeCalls).toBe(0); // 紧急停止后零交付动作(零 GitHub 写入)
    const st = await t2.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("CANCELLED");
  });
});
