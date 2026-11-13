// RELAY-CONTROL-SAFETY-04 P1-C:人工接管与控制审计收敛。
// 反例(旧代码 p0-mvp/control-safety-04/evidence/counterexample.log):
//   C1 TASK_ABORT_REQUESTED 审计缺 runId/幂等键/版本/时间/实际结果/控制权状态
//   C5 同内容执行请求真并发双插(两连接交错 NOT EXISTS 双通过)。
// 修复后语义:
//   C1/C2 abort 回执区分 phase(run/delivery)与 controlState(停止确认前不声称获得控制权);
//   C3 ControlCommand 审计最小字段齐备;C4 审计失败=重试+可观察告警(不静默吞);
//   C5 检查+插入整体置于 pg_advisory_xact_lock 下 —— 数据库级串行化,可证明唯一。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import type { Exec, RelayDb } from "../../src/core/db.ts";
import { requestTaskAbort } from "../../src/core/ops.ts";
import { appendAuditSafe } from "../../src/server/worker.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb("control_audit");
});
afterAll(async () => {
  await t.cleanup();
});

async function seedTask(spec: { state: string }): Promise<{ taskId: string; goalId: string }> {
  const taskId = `t-ca-${randomUUID().slice(0, 8)}`;
  const goalId = `g-ca-${randomUUID().slice(0, 8)}`;
  await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'ca goal', 'ACTIVE')`);
  await t.db.execute(sql`
    INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands, gate_required, attempt, max_attempts)
    VALUES (${taskId}, ${goalId}, ${spec.state}, '["/workspace"]', '[]', true, 1, 3)`);
  return { taskId, goalId };
}

describe("P1-C C1/C2/C3:接管回执相位与 ControlCommand 审计字段", () => {
  it("在飞任务 abort ⇒ phase=run + controlState=stop_pending_confirmation(不声称已获控制权)", async () => {
    const { taskId } = await seedTask({ state: "RUNNING" });
    const runId = `run-ca-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, budget, sandbox, outcome)
      VALUES (${runId}, ${taskId}, 1, 'stub', 'stub/gm', '{}', 'host-fallback', 'RUNNING')`);
    const r = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(r.ok).toBe(true);
    expect(r.phase).toBe("run");
    expect(r.controlState).toBe("stop_pending_confirmation");
    // C3:审计最小字段(actor 顶层;detail 携带 runId/expectedVersion/幂等键/时间/实际结果/控制权状态)
    const audits = await t.db.execute(sql`
      SELECT actor, detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED' ORDER BY seq DESC LIMIT 1`);
    expect(String(audits.rows[0]!["actor"])).toBe("owner");
    const detail = audits.rows[0]!["detail"] as Record<string, unknown>;
    expect(detail["runId"]).toBe(runId);
    expect(detail["idempotencyKey"]).toBe(`abort:${taskId}`);
    expect(detail["expectedStateVersion"]).toBeNull(); // 未传版本 ⇒ null(字段在场)
    expect(typeof detail["requestTime"]).toBe("string");
    expect(detail["actualResult"]).toBe("requested");
    expect(detail["controlState"]).toBe("stop_pending_confirmation");
    expect(detail["phase"]).toBe("run");
  });

  it("版本不匹配 ⇒ 拒绝 + 审计 expected/actual(C3 竞争字段)", async () => {
    const { taskId } = await seedTask({ state: "RUNNING" });
    const r = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner", expectedStateVersion: 42 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("state_version_mismatch");
    const audits = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REJECTED' ORDER BY seq DESC LIMIT 1`);
    const detail = audits.rows[0]!["detail"] as Record<string, unknown>;
    expect(detail["expected"]).toBe(42);
    expect(detail["actual"]).toBe(0);
  });
});

describe("P1-C C4:STOP_CONFIRMED 类审计失败 ⇒ 重试 + 可观察告警(不静默吞)", () => {
  it("DB 持续失败 ⇒ 3 次重试后结构化 console.error 告警,返回 false", async () => {
    const failingDb = {
      transaction: async () => {
        throw new Error("db down (injected)");
      },
    } as unknown as RelayDb;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = await appendAuditSafe(failingDb, {
        actor: "w",
        authority: "WORKER",
        action: "TASK_ABORT_CONFIRMED",
        taskId: "t-c4",
        detail: { note: "audit failure injection" },
      });
      expect(ok).toBe(false);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const payload = String(errSpy.mock.calls[0]![0]);
      expect(payload).toContain("AUDIT_WRITE_FAILED");
      expect(payload).toContain("TASK_ABORT_CONFIRMED");
      expect(payload).toContain("需人工补记");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("瞬时失败后恢复 ⇒ 重试成功,无告警,返回 true", async () => {
    let calls = 0;
    const flakyDb = {
      transaction: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return undefined;
      },
    } as unknown as RelayDb;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = await appendAuditSafe(flakyDb, {
        actor: "w",
        authority: "WORKER",
        action: "TASK_ABORT_CONFIRMED",
        taskId: "t-c4b",
        detail: {},
      });
      expect(ok).toBe(true);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("P1-C C5:显式执行防重数据库级互斥(advisory xact lock 串行化)", () => {
  /** 与 src/server/api.ts 生产语句同源(锁与检查+插入同事务;串行化保护;pg 扩展协议
   *  不支持带参多语句 ⇒ 锁/插入两条查询,事务语义由 BEGIN/COMMIT 或 tx 承载)。 */
  const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))";
  const INSERT_SQL = `INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
       SELECT $1, 'USER', 'USER_MESSAGE', $2, true
       WHERE NOT EXISTS (
         SELECT 1 FROM goal_messages g2
         LEFT JOIN goal_message_consumptions c2 ON c2.message_id = g2.id
         LEFT JOIN tasks t2 ON t2.id = c2.task_id
         WHERE g2.goal_id = $1 AND g2.actor = 'USER' AND g2.execution_request = true
           AND g2.content = $2
           AND (c2.id IS NULL OR t2.state IS NULL OR t2.state NOT IN ('ACCEPTED','FAILED','CANCELLED'))
       ) RETURNING id`;
  const guardedInsert = async (client: pg.ClientBase, goal: string, cnt: string) => {
    await client.query(LOCK_SQL, [goal, cnt]);
    return client.query(INSERT_SQL, [goal, cnt]);
  };

  it("确定性交错:A 未提交持锁 ⇒ B 阻塞;A 提交后 B 见到已提交行 ⇒ 不再插入", async () => {
    const goalId = `g-c5-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'c5 goal', 'ACTIVE')`);
    const content = `执行请求 c5-${randomUUID().slice(0, 8)}`;
    const clientA = new pg.Client({ connectionString: t.url, options: `-c search_path=${t.schemaName},public` });
    const clientB = new pg.Client({ connectionString: t.url, options: `-c search_path=${t.schemaName},public` });
    await clientA.connect();
    await clientB.connect();
    try {
      await clientA.query("BEGIN");
      const a = await guardedInsert(clientA, goalId, content);
      expect(a.rows.length).toBe(1);
      // B 的锁请求阻塞(A 持锁未提交):400ms 内 B 不得返回 —— 串行化正在生效
      // (READ COMMITTED 下未提交行对其他连接不可见,故以"B 未返回"为阻塞证明)
      let bSettled = false;
      const bPromise = clientB
        .query("BEGIN")
        .then(() => guardedInsert(clientB, goalId, content))
        .finally(() => {
          bSettled = true;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(bSettled, "A 未提交时 B 必须仍被 advisory lock 阻塞").toBe(false);
      await clientA.query("COMMIT");
      const b = await bPromise;
      expect(b.rows.length).toBe(0); // B 见到 A 的已提交行 ⇒ 唯一性成立
      await clientB.query("COMMIT");
      const final = await t.db.execute(sql`SELECT count(*)::int AS n FROM goal_messages WHERE content = ${content}`);
      expect(Number(final.rows[0]!["n"])).toBe(1);
    } finally {
      await clientA.end().catch(() => {});
      await clientB.end().catch(() => {});
    }
  });

  it("真并发探针:8 连接并行同键插入 ⇒ 恰好 1 行(串行化后必唯一,非探针侥幸)", async () => {
    const goalId = `g-c5p-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'c5 probe', 'ACTIVE')`);
    const content = `执行请求 c5-probe-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${goalId}), hashtext(${content}))`);
          return tx.execute(sql`
            INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
            SELECT ${goalId}, 'USER', 'USER_MESSAGE', ${content}, true
            WHERE NOT EXISTS (
              SELECT 1 FROM goal_messages g2
              WHERE g2.goal_id = ${goalId} AND g2.actor = 'USER' AND g2.execution_request = true
                AND g2.content = ${content}
            ) RETURNING id`);
        }),
      ),
    );
    const inserted = results.filter((r) => r.rows.length === 1).length;
    expect(inserted).toBe(1);
    const count = await t.db.execute(sql`SELECT count(*)::int AS n FROM goal_messages WHERE content = ${content}`);
    expect(Number(count.rows[0]!["n"])).toBe(1);
  });
});
