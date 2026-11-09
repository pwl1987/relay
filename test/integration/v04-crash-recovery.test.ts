// V04/B3/B3b:Worker SIGKILL 崩溃恢复 —— 真实子进程 + 真实 SIGKILL + 死亡核验。
// 验证:状态不丢、TTL 窗口语义(B3b:窗口内旧 Token 仍权威=已知契约)、过期回收、
// fencing+1 重领、幽灵写入被拒、审计完整且 append-only。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { advanceTask } from "../../src/core/lease.ts";
import { supervisorTick } from "../../src/core/supervisor.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import type { Exec } from "../../src/core/db.ts";
import { assertAdvanceFail, assertAdvanceOk, assertOk } from "../setup/assert.ts";
import {
  kill9AndAssertDead,
  spawnHelper,
  sleep,
  waitTaskState,
  type HelperChild,
} from "../helpers/fault-injection.ts";

const TEST_TTL = 8; // 秒:兼顾 B3b 窗口内观测与合理测试时长
const dummyExecutor = { check: async () => "", perform: async () => {} };

describe("V04 SIGKILL 崩溃恢复", () => {
  let t: TestDb;
  let liveChild: HelperChild | null = null;

  // drizzle 将 PG 错误包装为 "Failed query: ...";真实原因在 cause 链中
  async function assertAppendOnlyBlocked(query: ReturnType<typeof sql>): Promise<void> {
    const err: unknown = await t.db.execute(query).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    const e = err as { message?: string; cause?: { message?: string } };
    const combined = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
    expect(combined).toMatch(/append-only/);
  }

  beforeAll(async () => {
    t = await createTestDb("v04-crash");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-v04', 'READY')`);
  });
  afterAll(async () => {
    // 清理可能仍存活的子进程(失败时不掩盖)
    if (liveChild?.pid) {
      try { process.kill(liveChild.pid, "SIGKILL"); } catch { /* 已死 */ }
    }
    await t.cleanup();
  });

  it("崩溃 → 窗口内权威 → 过期回收 → fencing+1 重领 → 幽灵被拒 → 审计完整", async () => {
    // 1) 真实子进程 worker 领取并进入 RUNNING(spawn 直接给出 node 进程 pid)
    const child = spawnHelper("hold-worker.ts", ["t-v04", "worker-A", String(TEST_TTL)], {
      RELAY_DB_URL: t.url,
      RELAY_TEST_SCHEMA: t.schemaName,
    });
    liveChild = child;
    await waitTaskState(t.db, "t-v04", "RUNNING");
    await kill9AndAssertDead(child); // SIGKILL + 死亡核验(P0-00 复核教训)
    liveChild = null;

    // 2) B3b 语义(已知契约,非缺陷):TTL 窗口内,已死 worker-A 的旧 Token 仍具权威。
    //    Supervisor 不做窗口内强收 ⇒ 唯一防双写边界 = TTL 过期。
    const ghostInWindow = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v04", "worker-A", 1, "RUNNING", "SUBMITTED"),
    );
    assertAdvanceOk(ghostInWindow);

    // 3) 等待租约过期,supervisor tick 回收 + Reconcile(无 EXECUTING 意图 ⇒ READY)+ 重领
    await sleep((TEST_TTL + 1.5) * 1000);
    const report = await supervisorTick(t.db, { workerId: "worker-B", ttlSeconds: 30, executor: dummyExecutor });
    expect(report.reclaimed.map((r) => r.taskId)).toEqual(["t-v04"]);
    expect(report.reclaimed[0]!.fromState).toBe("SUBMITTED");
    expect(report.reconciled.map((r) => r.taskId)).toEqual(["t-v04"]);
    expect(report.reconciled[0]!.toState).toBe("READY");
    expect(report.claimed).toMatchObject({ taskId: "t-v04", ownerId: "worker-B", fencingToken: 2 });

    // 4) worker-B 完成主链至 VERIFYING
    for (const [from, to] of [["LEASED", "RUNNING"], ["RUNNING", "SUBMITTED"], ["SUBMITTED", "VERIFYING"]] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, "t-v04", "worker-B", 2, from, to),
      );
      expect(r.ok).toBe(true);
    }

    // 5) 幽灵:worker-A 旧 Token(fencing=1)在窗口外/被接管后推进 → 拒绝
    const ghost = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v04", "worker-A", 1, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(ghost);
    expect(ghost.reason).toMatch(/owner_mismatch|fenced/);

    // 6) Gate PASS 后才能 ACCEPTED(V08 语义在本链路交叉验证)
    const noGate = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v04", "worker-B", 2, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(noGate);
    expect(noGate.reason).toBe("gate_not_passed");
    await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { taskId: "t-v04", verdict: "PASS", reviewer: "reviewer-1" }),
    );
    const accepted = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v04", "worker-B", 2, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceOk(accepted);
    expect(accepted.leaseReleased).toBe(true);

    // 7) 终态不可重复推进(双接受禁止)
    const double = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, "t-v04", "worker-B", 2, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(double);
    expect(double.reason).toBe("state_terminal:ACCEPTED");

    // 8) 审计历史完整(恢复链路每步留痕,含拒绝)
    const audit = await t.db.execute(sql`
      SELECT seq, action, actor, before_state, after_state FROM audit_events
      WHERE task_id='t-v04' ORDER BY seq
    `);
    const actions = audit.rows.map((r) => String(r["action"]));
    expect(actions).toEqual([
      "CLAIM",               // worker-A 领取
      "ADVANCE",             // worker-A LEASED->RUNNING
      "ADVANCE",             // B3b 窗口内幽灵 RUNNING->SUBMITTED(契约语义留痕)
      "RECLAIM_EXPIRED",     // supervisor 回收
      "RECONCILE_READY",     // 无待核意图 → READY
      "CLAIM",               // worker-B fencing=2 重领
      "ADVANCE", "ADVANCE", "ADVANCE", // LEASED->RUNNING->SUBMITTED->VERIFYING
      "ADVANCE_REJECTED",    // 幽灵被拒
      "ADVANCE_REJECTED",    // 无 Gate 被拒
      "GATE_PASS",
      "ADVANCE",             // VERIFYING->ACCEPTED
      "ADVANCE_REJECTED",    // 终态重复推进被拒
    ]);
    expect(actions.filter((a) => a === "CLAIM")).toHaveLength(2);
  });

  it("audit_events 结构性 append-only:UPDATE/DELETE 被 PG 触发器阻断", async () => {
    await assertAppendOnlyBlocked(sql`UPDATE audit_events SET action='TAMPERED' WHERE task_id='t-v04'`);
    await assertAppendOnlyBlocked(sql`DELETE FROM audit_events WHERE task_id='t-v04'`);
    const res = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_events WHERE task_id='t-v04' AND action='TAMPERED'
    `);
    expect(Number(res.rows[0]!["n"])).toBe(0);
  });
});
