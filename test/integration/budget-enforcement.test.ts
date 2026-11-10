// C-2 机器强制预算(真实 PG):
// FAIL-CLOSED(无账本行/无 limit 拒绝)、预留→核算记账、超限拒绝+审计、
// runner 集成:超限 ⇒ BUDGET_EXHAUSTED + 任务 BLOCKED + 零 stub 启动;usage 实测 token 入账。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { ensureLedgerRow, reserveBudget, settleBudget, ledgerSnapshot } from "../../src/core/budget.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("budget 账本原子语义", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c2-budget");
  });
  afterAll(() => t.cleanup());

  it("FAIL-CLOSED:model_calls 无账本行 ⇒ 预留拒绝(BUDGET_RESERVE_REJECTED 审计)", async () => {
    const r = await t.db.transaction(async (tx) =>
      reserveBudget(tx as unknown as Exec, { kind: "model_calls", amount: 1, scopeType: "goal", scopeId: "goal-none" }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("budget_not_configured");
    const audit = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action='BUDGET_RESERVE_REJECTED'`);
    expect(Number(audit.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
  });

  it("预留→核算:used 累计、reserved 释放;超限拒绝", async () => {
    const goalId = "goal-b1";
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await t.db.transaction(async (tx) =>
        reserveBudget(tx as unknown as Exec, { kind: "model_calls", amount: 1, scopeType: "goal", scopeId: goalId }),
      );
      expect(r.ok).toBe(true);
      const s = await t.db.transaction(async (tx) => settleBudget(tx as unknown as Exec, r.ledgerId!, { reservedAmount: 1, actualAmount: 1 }));
      void s;
    }
    let snap = (await ledgerSnapshot(t.db, "goal", goalId)).find((x) => x.kind === "model_calls");
    expect(snap!.used).toBe(3);
    expect(snap!.reserved).toBe(0);
    // 第 4 次:超限
    const r4 = await t.db.transaction(async (tx) =>
      reserveBudget(tx as unknown as Exec, { kind: "model_calls", amount: 1, scopeType: "goal", scopeId: goalId }),
    );
    expect(r4.ok).toBe(false);
    expect(r4.reason).toBe("budget_exhausted");
  });

  it("model_calls 行存在但 limit=NULL ⇒ 不作授权(FAIL-CLOSED)", async () => {
    const goalId = "goal-b2";
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: null });
    const r = await t.db.transaction(async (tx) =>
      reserveBudget(tx as unknown as Exec, { kind: "model_calls", amount: 1, scopeType: "goal", scopeId: goalId }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("budget_not_configured");
  });
});

describe("runner × 预算集成(任务级机器强制)", () => {
  let t: TestDb;
  const sandboxes: import("../../src/runtime/sandbox.ts").SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("c2-runner");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("超限:run=BUDGET_EXHAUSTED、任务 BLOCKED、零模型调用(stub 未启动)", async () => {
    const goalId = "goal-exh";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state, budget) VALUES (${goalId}, 'g', 'ACTIVE', '{"modelCalls":1}'::jsonb)`);
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: 1 });
    // 直接耗尽预算
    const r0 = await t.db.transaction(async (tx) =>
      reserveBudget(tx as unknown as Exec, { kind: "model_calls", amount: 1, scopeType: "goal", scopeId: goalId }),
    );
    expect(r0.ok).toBe(true);

    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES ('t-exh', ${goalId}, 'READY', '["/workspace"]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-exh", "worker-A", 60));
    assertOk(c);
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-exh",
      goal: "g",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 20,
      heartbeatSeconds: 2,
      budget: { goalId },
      argvOverride: [process.execPath, STUB], // 若被启动即失败(不应发生)
      envOverride: { STUB_MODE: "hang", STUB_DELAY_MS: "30000" },
    });
    expect(result.outcome).toBe("BUDGET_EXHAUSTED");
    expect(result.detail["reason"]).toBe("budget_exhausted");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-exh'`);
    expect(String(st.rows[0]!["state"])).toBe("BLOCKED");
    const run = await t.db.execute(sql`SELECT outcome FROM runs WHERE id=${result.runId}`);
    expect(String(run.rows[0]!["outcome"])).toBe("BUDGET_EXHAUSTED");
  });

  it("正常路径:usage 实测入账(STUB_USAGE);预留先于执行(used 在 run 结算后更新)", async () => {
    const goalId = "goal-ok";
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state, budget) VALUES (${goalId}, 'g', 'ACTIVE', '{"modelCalls":5}'::jsonb)`);
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "model_calls", limit: 5 });
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "tokens_in", limit: 100_000 });
    await ensureLedgerRow(t.db as unknown as Exec, { scopeType: "goal", scopeId: goalId, kind: "tokens_out", limit: 100_000 });
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES ('t-bok', ${goalId}, 'READY', '["/workspace"]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-bok", "worker-A", 60));
    assertOk(c);
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId: "t-bok",
      goal: "g",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 20,
      heartbeatSeconds: 2,
      budget: { goalId },
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "ok", STUB_USAGE: "1" },
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.detail["budget"]).toMatchObject({ actualCalls: 1, tokensIn: 1234, tokensOut: 567 });
    const snap = await ledgerSnapshot(t.db, "goal", goalId);
    expect(snap.find((x) => x.kind === "model_calls")).toMatchObject({ used: 1, reserved: 0 });
    expect(snap.find((x) => x.kind === "tokens_in")).toMatchObject({ used: 1234 });
    expect(snap.find((x) => x.kind === "tokens_out")).toMatchObject({ used: 567 });
  });
});
