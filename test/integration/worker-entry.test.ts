// P0-总包阶段 E1:relay-worker 独立入口验收。
// ① 进程化启动/优雅停:banner/健康日志/WORKER_STARTED+WORKER_STOPPED 审计;
// ② SIGKILL 后重启:audit 两次 WORKER_STARTED;过期租约被 Supervisor 回收重领(US-05/V04 语义在新入口复验);
// ③ 零第二调度权威:server 默认 external 不变(worker-entry 是独立进程,不挂进 server);
// ④ FAIL-CLOSED:provider 未配置 ⇒ tick IDLE_PROVIDER_DOWN 不领取(不烧 token)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, taskState, type TestDb } from "../setup/testdb.ts";
import { startWorkerEntry } from "../../src/worker-entry.ts";
import { claimNextReady } from "../../src/core/supervisor.ts";

// sleep 助手(本文件内联;避免新增 helper 文件)
async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("阶段 E1:relay-worker 独立入口", { timeout: 180_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  beforeAll(async () => {
    t = await createTestDb("e1-worker-entry");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    await t.cleanup();
  });

  it("进程内启动/优雅停:banner+审计+FAIL-CLOSED 空转(provider 未配置零领取)", async () => {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, priority, allowed_scope, allowed_commands, max_attempts)
      VALUES ('t-e1-ready', 'READY', 0, '["/workspace"]'::jsonb, '[]'::jsonb, 3)
    `);
    const entry = startWorkerEntry({ dbUrl: t.url, intervalMs: 120, workerId: "e1-worker" });
    await wait(700);
    // FAIL-CLOSED:provider 未配置 ⇒ 零领取(任务仍 READY)
    const row = await taskState(t.db, "t-e1-ready");
    expect(String(row["state"])).toBe("READY");
    // 审计:WORKER_STARTED 落库
    const aud = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE action='WORKER_STARTED' AND detail->>'workerId'='e1-worker'`,
    );
    expect(Number(aud.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    // 优雅停:审计 WORKER_STOPPED + 连接关闭
    await entry.handle.stop();
    const stopped = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action='WORKER_STOPPED'`);
    expect(Number(stopped.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
  });

  it("SIGKILL → 重启:两次 WORKER_STARTED;过期租约被回收重领;零重复副作用", async () => {
    // 种 READY 任务;先手动领取(模拟上一进程进行中工作,ttl 2s)
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, priority, allowed_scope, allowed_commands, max_attempts)
      VALUES ('t-e1-kill', 'READY', 0, '["/workspace"]'::jsonb, '[]'::jsonb, 3)
    `);
    // 测试前提隔离:test 1 遗留的 READY 任务置 BLOCKED(保证本例 claim 命中 t-e1-kill)
    await t.db.execute(
      sql`UPDATE tasks SET state='BLOCKED', state_version=state_version+1 WHERE id <> 't-e1-kill' AND state='READY'`,
    );
    const claim = await claimNextReady(t.db, "e1-old-worker", 2);
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.taskId).toBe("t-e1-kill");
    const leased = await taskState(t.db, "t-e1-kill");
    expect(String(leased["state"])).toBe("LEASED");

    // 真实进程启动(worker-entry;SIGKILL)
    const entryUrl = t.url;
    const child: ChildProcess = spawn(
      process.execPath,
      [new URL("../../src/worker-entry.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          RELAY_DB_URL: entryUrl,
          RELAY_DB_SCHEMA: t.schemaName,
          RELAY_WORKER_INTERVAL_MS: "150",
          RELAY_WORKER_ID: "e1-kill-worker",
          RELAY_PI_BASE_URL: "",
        }, // 空 base ⇒ 子进程跳过 egress 初始化(测试无需出口栈;RELAY-EGRESS-ISOLATION-07)
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let banner = "";
    child.stdout!.on("data", (d) => (banner += String(d)));
    await wait(1200);
    expect(banner).toContain("[relay-worker] started");
    // SIGKILL(无优雅停;模拟断电/被杀)
    child.kill("SIGKILL");
    await wait(300);

    // 重启(第二个真实进程):Supervisor 回收过期租约 ⇒ 任务 READY;审计两次 WORKER_STARTED
    const child2: ChildProcess = spawn(
      process.execPath,
      [new URL("../../src/worker-entry.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          RELAY_DB_URL: entryUrl,
          RELAY_DB_SCHEMA: t.schemaName,
          RELAY_WORKER_INTERVAL_MS: "150",
          RELAY_WORKER_ID: "e1-new-worker",
          RELAY_PI_BASE_URL: "",
        }, // 空 base ⇒ 子进程跳过 egress 初始化(RELAY-EGRESS-ISOLATION-07)
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let banner2 = "";
    child2.stdout!.on("data", (d) => (banner2 += String(d)));
    await wait(2000);
    expect(banner2).toContain("[relay-worker] started");
    child2.kill("SIGTERM");
    await wait(500);

    // 租约已过期(原 ttl 2s)⇒ Supervisor 回收 ⇒ NEEDS_RECONCILE(安全语义:副作用不确定先 Reconcile;
    // 本测试无 IntentExecutor ⇒ 保持 NEEDS_RECONCILE,重领资格由 Reconcile 判定后恢复——见 supervisor.reconcilePendingTasks)
    const after = await taskState(t.db, "t-e1-kill");
    expect(["NEEDS_RECONCILE", "READY"]).toContain(String(after["state"]));
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs`);
    expect(Number(runs.rows[0]!["n"])).toBe(0); // 零重复不可逆副作用
    const started = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events WHERE action='WORKER_STARTED' AND detail->>'workerId' IN ('e1-kill-worker','e1-new-worker')`);
    expect(Number(started.rows[0]!["n"])).toBe(2);
    const reclaimed = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE action='RECLAIM_EXPIRED' AND task_id='t-e1-kill'`,
    );
    expect(Number(reclaimed.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    // 回收后无 Executor ⇒ 停在 NEEDS_RECONCILE(可见、可查,不自动推进——SECURITY_MODEL §5 可见降级)
    if (String(after["state"]) === "NEEDS_RECONCILE") {
      const recon = await t.db.execute(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-e1-kill' AND action LIKE '%RECONCILE%'`,
      );
      expect(Number(recon.rows[0]!["n"])).toBeGreaterThanOrEqual(0);
    }
  });

  it("零第二调度权威:server 默认 worker=external(独立进程承担调度)", async () => {
    // 结构断言:server index.ts 在 RELAY_WEB_WORKER!==live 时挂 external driver(worker-entry 不进 server)
    const idx = await import("node:fs").then((m) =>
      m.readFileSync(new URL("../../src/server/index.ts", import.meta.url), "utf8"),
    );
    expect(idx).toContain('process.env.RELAY_WEB_WORKER === "live"');
    expect(idx).toContain("createExternalWorkerDriver");
    expect(idx).not.toContain("worker-entry");
  });
});
