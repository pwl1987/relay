// V05/C1:外部写成功 + 回执丢失 —— executor 在"副作用已发生、COMPLETED 未写"窗口被 SIGKILL。
// 恢复必须先 Reconcile(查询目标真实状态),确认已生效则不重推;重复 reconcile 幂等(BLOCK 级)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { reserveIntent, executeIntent, reconcileIntent } from "../../src/core/intents.ts";
import { createGitPushExecutor } from "../../src/core/executors/git-push.ts";
import type { Exec } from "../../src/core/db.ts";
import {
  commitPayload,
  createMockGit,
  kill9AndAssertDead,
  remoteHeadSha,
  spawnHelper,
  waitFor,
  type MockGit,
} from "../helpers/fault-injection.ts";

const POST_PUSH_PAUSE_MS = 20_000; // 丢回执窗口:push 后停留 20s 供父进程注入 SIGKILL

describe("V05 丢回执恢复(C1)", () => {
  let t: TestDb;
  let g: MockGit;
  let payloadSha: string;
  let intentId: string;

  beforeAll(async () => {
    t = await createTestDb("v05-lost-receipt");
    g = await createMockGit();
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-c1', 'READY')`);
    payloadSha = await commitPayload(g.workRepo, "c1.txt", "payload-c1\n", "payload c1");
    const r = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId: "t-c1",
        idempotencyKey: "c1-push",
        capability: "git_push",
        target: g.bareRemote,
        branch: "main",
        expectedRemoteSha: g.initialHead,
        payloadSha,
      }),
    );
    intentId = r.id;
  });
  afterAll(async () => {
    await t.cleanup();
    await g.cleanup();
  });

  it("push 已发生、回执未写时被杀 → reconcile 确认 → 不重推 → 幂等", async () => {
    // 1) 子进程 executor 执行意图(push 后停留在丢回执窗口)
    const child = spawnHelper("push-execute.ts", [intentId, "0", String(POST_PUSH_PAUSE_MS)], {
      RELAY_DB_URL: t.url,
      RELAY_TEST_SCHEMA: t.schemaName,
      RELAY_SRC_REPO: g.workRepo,
    });
    // 2) 等待副作用确实已发生(远端头 == payload)
    await waitFor("remote head == payloadSha", async () => {
      const head = await remoteHeadSha(g.workRepo, g.bareRemote);
      return head === payloadSha ? head : null;
    });
    // 3) 在回执未写窗口注入 SIGKILL 并核验死亡
    await kill9AndAssertDead(child);

    const mid = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
    expect(mid.rows[0]!["state"]).toBe("EXECUTING"); // 回执确实丢失

    // 4) Reconcile-first:查目标真实状态 → 已生效 ⇒ 确认,不重做
    const executor = createGitPushExecutor({ sourceRepo: g.workRepo });
    const r1 = await t.db.transaction(async (tx) =>
      reconcileIntent(tx as unknown as Exec, executor, intentId),
    );
    expect(r1.decision).toBe("SIDE_EFFECT_CONFIRMED");
    const after = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
    expect(after.rows[0]!["state"]).toBe("COMPLETED");

    // 5) 远端恰好一份推进(无重复副作用):main 头 == payload
    expect(await remoteHeadSha(g.workRepo, g.bareRemote)).toBe(payloadSha);

    // 6) 重复 reconcile 幂等
    const r2 = await t.db.transaction(async (tx) =>
      reconcileIntent(tx as unknown as Exec, executor, intentId),
    );
    expect(r2.decision).toBe("already_completed");

    // 7) 审计:EXECUTE_START 有、EXECUTE_COMPLETED 无(回执丢失事实)、RECONCILE 确认
    const audit = await t.db.execute(sql`
      SELECT action FROM audit_events WHERE intent_id=${intentId} ORDER BY seq
    `);
    const actions = audit.rows.map((r) => String(r["action"]));
    expect(actions).toContain("EXECUTE_START");
    expect(actions).not.toContain("EXECUTE_COMPLETED");
    expect(actions.filter((a) => a === "RECONCILE")).toHaveLength(2);
    // executeIntent 未被重复调用(无第二次 push 尝试)
    expect(actions.filter((a) => a === "EXECUTE_START")).toHaveLength(1);
  });
});
