// C2:push 前被杀 → reconcile 判定"副作用未发生" → 安全重试恰好一次。
// 附:reserve 的 idempotency_key 幂等(同 key 重复预留不产生第二行)。
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
  sleep,
  spawnHelper,
  waitFor,
  type MockGit,
} from "../helpers/fault-injection.ts";

const PRE_PUSH_PAUSE_MS = 8_000; // 受控注入钩子:EXECUTING 标记后、push 前停顿
const KILL_AT_MS = 1_000; // 确认 EXECUTING 后仍在停顿窗口内

describe("V05 执行前崩溃安全重试(C2)", () => {
  let t: TestDb;
  let g: MockGit;
  let payloadSha: string;
  let intentId: string;

  beforeAll(async () => {
    t = await createTestDb("v05-reexecute");
    g = await createMockGit();
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-c2', 'READY')`);
    payloadSha = await commitPayload(g.workRepo, "c2.txt", "payload-c2\n", "payload c2");
    const r = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId: "t-c2",
        idempotencyKey: "c2-push",
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

  it("执行前被杀 → ABSENT 判定 → 安全重推恰好一次", async () => {
    // 1) 子进程在 push 前停顿窗口内被杀(先确认已标记 EXECUTING,再注入)
    const child = spawnHelper("push-execute.ts", [intentId, String(PRE_PUSH_PAUSE_MS), "0"], {
      RELAY_DB_URL: t.url,
      RELAY_TEST_SCHEMA: t.schemaName,
      RELAY_SRC_REPO: g.workRepo,
    });
    await waitFor(`intent ${intentId} -> EXECUTING`, async () => {
      const r = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
      return r.rows[0]?.["state"] === "EXECUTING" ? "EXECUTING" : null;
    });
    await sleep(KILL_AT_MS); // 确保仍在 pre-push 停顿窗口内
    await kill9AndAssertDead(child);
    expect(await remoteHeadSha(g.workRepo, g.bareRemote)).toBe(g.initialHead); // 副作用未发生

    const mid = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
    expect(mid.rows[0]!["state"]).toBe("EXECUTING");

    // 2) Reconcile-first:目标仍为 expected ⇒ 未发生 ⇒ 可安全重试
    const executor = createGitPushExecutor({ sourceRepo: g.workRepo });
    const rec = await t.db.transaction(async (tx) =>
      reconcileIntent(tx as unknown as Exec, executor, intentId),
    );
    expect(rec.decision).toBe("SIDE_EFFECT_ABSENT_REEXECUTE_SAFE");
    const reserved = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
    expect(reserved.rows[0]!["state"]).toBe("RESERVED");

    // 3) 安全重推(前台执行,无注入)→ 恰好一次
    const ex = await t.db.transaction(async (tx) =>
      executeIntent(tx as unknown as Exec, executor, intentId),
    );
    expect(ex.ok).toBe(true);
    expect(await remoteHeadSha(g.workRepo, g.bareRemote)).toBe(payloadSha);

    // 4) 远端 main 为单一 ref(payload 恰好一次落地)
    const log = await import("node:child_process").then((m) =>
      m.execFileSync("git", ["-C", g.workRepo, "ls-remote", g.bareRemote, "refs/heads/main"], { encoding: "utf8" }),
    );
    expect(log.trim().split("\n")).toHaveLength(1);

    // 5) 审计含 ABSENT 判定
    const audit = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE intent_id=${intentId} AND action='RECONCILE'
      ORDER BY seq
    `);
    const decisions = audit.rows.map((r) => (r["detail"] as Record<string, unknown>)["decision"]);
    expect(decisions).toContain("SIDE_EFFECT_ABSENT_REEXECUTE_SAFE");
  });

  it("reserve 幂等:同 idempotency_key 重复预留不产生第二行", async () => {
    const again = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId: "t-c2",
        idempotencyKey: "c2-push",
        capability: "git_push",
        target: g.bareRemote,
        branch: "main",
        expectedRemoteSha: g.initialHead,
        payloadSha,
      }),
    );
    expect(again.created).toBe(false);
    expect(again.id).toBe(intentId);
    const rows = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM action_intents WHERE idempotency_key='c2-push'
    `);
    expect(Number(rows.rows[0]!["n"])).toBe(1);
  });
});
