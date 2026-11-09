// Run 生命周期(Vitest + 真实 PG;stub RPC 进程驱动,进程与信号皆真实):
// 成功(settle+handoff→SUBMITTED→VERIFYING)、超时(wall 预算→TIMEOUT→FAILED)、
// 取消(cancelSignal→CANCELLED→CANCELLED)、断连(stub 退出→FAILED)。
// Run 成功 != ACCEPTED:VERIFYING→ACCEPTED 必须过 Gate(V08 延续)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun, latestSession, readToolAudit } from "../../src/runtime/runner.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const STUB_ARGV = [process.execPath, STUB];
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("Run 生命周期(stub RPC,真实进程)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("run-lifecycle");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  async function taskState(id: string): Promise<string> {
    const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${id}`);
    return String(r.rows[0]!["state"]);
  }

  async function seedTask(id: string, goal: string): Promise<void> {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope)
      VALUES (${id}, 'READY', ${goal}, ${JSON.stringify(["/workspace"])}::jsonb)
    `);
  }

  async function claimFor(taskId: string, owner: string) {
    const r = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, owner, 60));
    assertOk(r);
    return r;
  }

  interface RunArgs {
    taskId: string;
    goal: string;
    ownerId: string;
    fencingToken: number;
    attempt: number;
    stubMode: string;
    wallSeconds?: number;
    heartbeatSeconds?: number;
    cancelSignal?: { cancelled: boolean };
  }

  async function runStub(args: RunArgs) {
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: args.taskId,
      goal: args.goal,
      allowedScope: ["/workspace"],
      attempt: args.attempt,
      ownerId: args.ownerId,
      fencingToken: args.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: args.wallSeconds ?? 20,
      heartbeatSeconds: args.heartbeatSeconds ?? 2,
      argvOverride: STUB_ARGV,
      envOverride: { STUB_MODE: args.stubMode },
      cancelSignal: args.cancelSignal,
    });
    sandboxes.push(result.sandboxSpec);
    return result;
  }

  it("成功路径:settle+handoff→run=SUCCEEDED→任务 VERIFYING→Gate 后 ACCEPTED", async () => {
    await seedTask("t-run-ok", "stub 任务:整理工作区");
    const c = await claimFor("t-run-ok", "worker-1");
    const result = await runStub({
      taskId: "t-run-ok", goal: "stub 任务:整理工作区",
      ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt, stubMode: "ok",
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.handoff.found).toBe(true);
    if (result.handoff.found) expect(result.handoff.handoff.summary).toBe("stub 完成");

    // run 行与 session 行落库
    const run = await t.db.execute(sql`SELECT outcome, sandbox, model_ref, attempt, ended_at FROM runs WHERE id=${result.runId}`);
    expect(String(run.rows[0]!["outcome"])).toBe("SUCCEEDED");
    expect(String(run.rows[0]!["sandbox"])).toBe("host-fallback");
    expect(String(run.rows[0]!["model_ref"])).toBe("stub/stub/gm");
    expect(run.rows[0]!["ended_at"]).not.toBeNull();
    const sess = await t.db.execute(sql`SELECT resume_mode, context_digest, handoff_ref FROM sessions WHERE run_id=${result.runId}`);
    expect(String(sess.rows[0]!["resume_mode"])).toBe("fresh");
    expect(String(sess.rows[0]!["context_digest"])).toHaveLength(64);

    // 任务推进至 VERIFYING;Gate 后 ACCEPTED(V08 延续)
    expect(await taskState("t-run-ok")).toBe("VERIFYING");
    await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { taskId: "t-run-ok", verdict: "PASS", reviewer: "reviewer-1" }),
    );
    const adv = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-run-ok", c.ownerId, c.fencingToken, "VERIFYING", "ACCEPTED"),
    );
    expect(adv.ok).toBe(true);
    expect(await taskState("t-run-ok")).toBe("ACCEPTED");

    // 审计含 RUN_SUCCEEDED
    const audit = await t.db.execute(sql`SELECT action FROM audit_events WHERE task_id='t-run-ok' AND action LIKE 'RUN_%'`);
    expect(audit.rows.map((r) => String(r["action"]))).toContain("RUN_SUCCEEDED");
  });

  it("超时:wall 预算到点→run=TIMEOUT→任务 FAILED(attempt 已消耗)", async () => {
    await seedTask("t-run-timeout", "stub 任务:超时");
    const c = await claimFor("t-run-timeout", "worker-1");
    const result = await runStub({
      taskId: "t-run-timeout", goal: "stub 任务:超时",
      ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt,
      stubMode: "hang", wallSeconds: 2,
    });
    expect(result.outcome).toBe("TIMEOUT");
    const run = await t.db.execute(sql`SELECT outcome, budget FROM runs WHERE id=${result.runId}`);
    expect(String(run.rows[0]!["outcome"])).toBe("TIMEOUT");
    expect((run.rows[0]!["budget"] as Record<string, unknown>)["wallSeconds"]).toBe(2);
    expect(await taskState("t-run-timeout")).toBe("FAILED");
  });

  it("取消:cancelSignal→run=CANCELLED→任务 CANCELLED(终态锁定)", async () => {
    await seedTask("t-run-cancel", "stub 任务:取消");
    const c = await claimFor("t-run-cancel", "worker-1");
    const cancelSignal = { cancelled: false };
    setTimeout(() => {
      cancelSignal.cancelled = true;
    }, 400);
    const result = await runStub({
      taskId: "t-run-cancel", goal: "stub 任务:取消",
      ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt,
      stubMode: "hang", cancelSignal,
    });
    expect(result.outcome).toBe("CANCELLED");
    expect(await taskState("t-run-cancel")).toBe("CANCELLED");
  });

  it("断连:RPC 进程中途退出→run=FAILED(rpc_disconnect),任务留 RUNNING 待心跳/回收", async () => {
    await seedTask("t-run-disc", "stub 任务:断连");
    const c = await claimFor("t-run-disc", "worker-1");
    const result = await runStub({
      taskId: "t-run-disc", goal: "stub 任务:断连",
      ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt,
      stubMode: "exit-mid", heartbeatSeconds: 1,
    });
    expect(result.outcome).toBe("FAILED");
    expect(result.detail["reason"]).toBe("rpc_disconnect");
    // 断连非租约失效:任务停在 RUNNING(租约仍活),由心跳义务与 Supervisor 契约处置
    expect(await taskState("t-run-disc")).toBe("RUNNING");
  });

  it("无 handoff 的 settle 如实记录(SUCCEEDED 但 handoff.error=absent,不虚构)", async () => {
    await seedTask("t-run-noh", "stub 任务:无 handoff");
    const c = await claimFor("t-run-noh", "worker-1");
    const result = await runStub({
      taskId: "t-run-noh", goal: "stub 任务:无 handoff",
      ownerId: c.ownerId, fencingToken: c.fencingToken, attempt: c.attempt, stubMode: "no-handoff",
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.handoff.found).toBe(false);
    expect(result.detail["handoff"]).toMatchObject({ error: "absent" });
  });

  it("latestSession 返回最近会话(供恢复重建上下文)", async () => {
    const s = await latestSession(t.db, "t-run-ok");
    expect(s).not.toBeNull();
    expect(s!.resumeMode).toBe("fresh");
    expect(s!.handoff).toMatchObject({ status: "done" });
  });

  it("readToolAudit:审计文件不存在返回空(零工具调用如实呈现)", () => {
    const ghost: SandboxSpec = {
      runDir: "/tmp", mode: "host-fallback", homeDir: "/tmp",
      workspaceDir: "/tmp/definitely-not-there", extSourcePath: "", extMountPath: "",
    };
    expect(readToolAudit(ghost)).toEqual([]);
  });
});
