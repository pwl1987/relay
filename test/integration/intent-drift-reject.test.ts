// C3/V10 局部:远端漂移 —— expected 过期时执行器前置核对拒绝(CONFLICT),候选不覆盖外部新提交,无强推。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { reserveIntent, executeIntent } from "../../src/core/intents.ts";
import { createGitPushExecutor } from "../../src/core/executors/git-push.ts";
import type { Exec } from "../../src/core/db.ts";
import { commitPayload, createMockGit, remoteHeadSha, type MockGit } from "../helpers/fault-injection.ts";

const execFileP = promisify(execFile);

describe("C3 远端漂移拒绝", () => {
  let t: TestDb;
  let g: MockGit;
  let payloadSha: string;
  let intentId: string;

  beforeAll(async () => {
    t = await createTestDb("c3-drift");
    g = await createMockGit();
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-c3', 'READY')`);
    payloadSha = await commitPayload(g.workRepo, "c3.txt", "payload-c3\n", "payload c3");
    const r = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId: "t-c3",
        idempotencyKey: "c3-push",
        capability: "git_push",
        target: g.bareRemote,
        branch: "main",
        expectedRemoteSha: g.initialHead,
        payloadSha,
      }),
    );
    intentId = r.id;

    // 外部漂移:另一克隆在远端推进一个新提交(expected 已过期)
    const driftClone = `${g.root}/drift-clone`;
    await execFileP("git", ["clone", "-q", g.bareRemote, driftClone]);
    await execFileP("git", ["-C", driftClone, "config", "user.name", "drift"]);
    await execFileP("git", ["-C", driftClone, "config", "user.email", "drift@test.local"]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${driftClone}/external.txt`, "external commit\n");
    await execFileP("git", ["-C", driftClone, "add", "-A"]);
    await execFileP("git", ["-C", driftClone, "commit", "-m", "external drift"]);
    await execFileP("git", ["-C", driftClone, "push", "-q", "origin", "main"]);
  });
  afterAll(async () => {
    await t.cleanup();
    await g.cleanup();
  });

  it("expected 不匹配 ⇒ 前置 CONFLICT,拒绝无强推,payload 未落地", async () => {
    const executor = createGitPushExecutor({ sourceRepo: g.workRepo });
    const r = await t.db.transaction(async (tx) =>
      executeIntent(tx as unknown as Exec, executor, intentId),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.state).toBe("CONFLICT");
      expect(r.reason).toBe("remote_drift");
    }
    // payload 未覆盖外部新提交(拒绝发生在 push 之前)
    const head = await remoteHeadSha(g.workRepo, g.bareRemote);
    expect(head).not.toBe(payloadSha);
    expect(head).not.toBe(g.initialHead); // 远端确实已被外部推进
    // 审计:REJECT_NO_FORCE_PUSH
    const audit = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE intent_id=${intentId} AND action='EXECUTE_CONFLICT'
    `);
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0]!["detail"] as Record<string, unknown>)["decision"]).toBe("REJECT_NO_FORCE_PUSH");
    // 意图进入 CONFLICT(需要人工/重新对账,不得盲目重试)
    const st = await t.db.execute(sql`SELECT state FROM action_intents WHERE id=${intentId}`);
    expect(st.rows[0]!["state"]).toBe("CONFLICT");
  });
});
