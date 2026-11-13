// P0-02A C-4:绑定版 Gate 记录/消费——反例逐条覆盖(合同三、条款 1/2/3/6):
//   - 旧 PASS 跨 attempt 必须拒绝(stale_attempt;状态层 countGatePass 同样不可见)
//   - Candidate SHA 变化后旧证据/旧 PASS 失效(stale_candidate)
//   - PASS 无证据/证据失败/证据篡改 ⇒ 拒绝(不得显示绿色)
//   - Reviewer 独立性:coder 自宣(同 run)拒绝;非 reviewer run 拒绝
//   - DONE 文本不产生裁决(无行即无 PASS);每份裁决至多消费一次
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { recordChangeset, type WorkspaceManifest } from "../../src/core/changesets.ts";
import { recordEvidence } from "../../src/core/evidence.ts";
import { acquireVerificationLease } from "../../src/core/verify-lease.ts";
import { recordGateVerdict, consumeGateVerdict, type RecordGateSpec } from "../../src/core/gates.ts";
import { seedReviewerRun } from "../setup/gate-helper.ts";
import { assertAdvanceFail } from "../setup/assert.ts";
import { assertOk } from "../setup/assert.ts";
import type { Exec } from "../../src/core/db.ts";

const BASE: WorkspaceManifest = new Map([["a.txt", "1"]]);
const CAND: WorkspaceManifest = new Map([["a.txt", "2"]]);
const REQ = { goalText: "g", taskId: "", allowedScope: ["/workspace"], allowedCommands: [] as string[] };

describe("绑定版 Gate(旧 PASS 不跨版本)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c4-binding");
  });
  afterAll(() => t.cleanup());

  /** 建 task→claim→VERIFYING→变更集→验证租约 的完整夹具;返回消费所需凭据与绑定。 */
  async function setupVerifying(taskId: string, attempt = 1, coderRunId = `run-${taskId}`) {
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope) VALUES (${taskId}, 'READY', 'g', '["/workspace"]'::jsonb)
    `);
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, `worker-${taskId}`, 60));
    assertOk(c);
    for (const [from, to] of [
      ["LEASED", "RUNNING"],
      ["RUNNING", "SUBMITTED"],
      ["SUBMITTED", "VERIFYING"],
    ] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, taskId, c.ownerId, c.fencingToken, from, to),
      );
      expect(r.ok).toBe(true);
    }
    await t.db.transaction(async (tx) =>
      (tx as unknown as Exec).execute(sql`
        INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome)
        VALUES (${coderRunId}, ${taskId}, ${attempt}, 'stub', 'stub/gm', 'host-fallback', 'SUCCEEDED')
      `),
    );
    const cs = await t.db.transaction(async (tx) =>
      recordChangeset(tx as unknown as Exec, {
        taskId,
        runId: coderRunId,
        attempt,
        base: BASE,
        candidate: CAND,
        requirement: { ...REQ, taskId, goalText: "g" },
      }),
    );
    const vl = await t.db.transaction(async (tx) =>
      acquireVerificationLease(tx as unknown as Exec, taskId, `verifier-${taskId}`, 60),
    );
    if (!vl.ok) throw new Error(`verify lease: ${vl.reason}`);
    const reviewerRunId = await seedReviewerRun(t.db, { taskId, attempt });
    // R2(INTEGRITY-04A 反例 C):预置完整性证据行 —— 代码变更候选 PASS 必须引用
    // candidate_manifest_verify(record/consume 双侧硬规则),与功能性证据同绑定。
    const mv = await recordEvidence(t.db as unknown as Exec, {
      taskId,
      attempt,
      candidateSha: cs.candidateSha,
      kind: "candidate_manifest_verify",
      passed: true,
      rawOutput: "verify=ok",
      env: { mode: "worker-host", node: process.version, host: "test" },
      producedBy: "verifier",
    });
    return { taskId, attempt, coderRunId, cs, verifier: vl, reviewerRunId, mv };
  }

  function passSpec(f: Awaited<ReturnType<typeof setupVerifying>>, evidenceIds: string[]): RecordGateSpec {
    return {
      taskId: f.taskId,
      verdict: "PASS",
      reviewer: "verifier",
      attempt: f.attempt,
      candidateSha: f.cs.candidateSha,
      requirementSha: f.cs.requirementSha,
      testEnv: { mode: "host-fallback", node: process.version, host: "test" },
      reviewerRunId: f.reviewerRunId,
      coderRunId: f.coderRunId,
      evidenceIds,
    };
  }

  it("happy path:PASS(绑定+证据)→ 消费 → ACCEPTED;二次消费拒绝", async () => {
    const f = await setupVerifying("t-ok");
    const ev = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: f.cs.candidateSha,
        kind: "deterministic_test",
        passed: true,
        rawOutput: "checks ok",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const rec = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, passSpec(f, [ev.id, f.mv.id])),
    );
    expect(rec.ok).toBe(true);
    const consumed = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId: f.taskId,
        gateId: (rec as { id: string }).id,
        actor: "verifier",
        ownerId: f.verifier.ownerId,
        fencingToken: f.verifier.fencingToken,
      }),
    );
    expect(consumed.ok).toBe(true);
    expect((consumed as { state: string }).state).toBe("ACCEPTED");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${f.taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("ACCEPTED");
    // 二次消费:already_consumed(双重裁决禁止)
    const again = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId: f.taskId,
        gateId: (rec as { id: string }).id,
        actor: "verifier",
        ownerId: f.verifier.ownerId,
        fencingToken: f.verifier.fencingToken,
      }),
    );
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toBe("already_consumed");
  });

  it("反例:同一 Task 新 attempt 使用旧 PASS ⇒ 消费拒绝(状态层同样不可见)", async () => {
    const f = await setupVerifying("t-stale-attempt");
    const ev = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: f.cs.candidateSha,
        kind: "deterministic_test",
        passed: true,
        rawOutput: "ok",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const rec = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, passSpec(f, [ev.id, f.mv.id])),
    );
    expect(rec.ok).toBe(true);
    const gateId = (rec as { id: string }).id;
    // 编排方崩溃前放弃裁决:VERIFYING→REWORK(离链释放租约)→ READY → 新 attempt 重验
    const abandon = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, f.taskId, f.verifier.ownerId, f.verifier.fencingToken, "VERIFYING", "REWORK"),
    );
    expect(abandon.ok).toBe(true);
    await t.db.execute(
      sql`UPDATE tasks SET state='READY', state_version=state_version+1 WHERE id=${f.taskId} AND state='REWORK'`,
    );
    const c2 = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, f.taskId, "worker-2", 60));
    assertOk(c2);
    expect(c2.attempt).toBe(2);
    // 新 attempt 下消费旧 PASS ⇒ stale_attempt
    const consume = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId: f.taskId,
        gateId,
        actor: "verifier",
        ownerId: c2.ownerId,
        fencingToken: c2.fencingToken,
      }),
    );
    expect(consume.ok).toBe(false);
    expect((consume as { reason: string }).reason).toMatch(/stale_attempt/);
    // 状态层 backstop(F-1 处置):新 attempt 推进到 VERIFYING 后,gated 转移对旧 PASS 不可见
    for (const [from, to] of [
      ["LEASED", "RUNNING"],
      ["RUNNING", "SUBMITTED"],
      ["SUBMITTED", "VERIFYING"],
    ] as const) {
      const r = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, f.taskId, c2.ownerId, c2.fencingToken, from, to),
      );
      expect(r.ok).toBe(true);
    }
    const gatedWithOldPass = await t.db.transaction(async (tx) =>
      advanceTask(tx as unknown as Exec, f.taskId, c2.ownerId, c2.fencingToken, "VERIFYING", "ACCEPTED"),
    );
    assertAdvanceFail(gatedWithOldPass);
    expect(gatedWithOldPass.reason).toBe("gate_not_passed"); // 唯一 PASS 绑定旧 attempt,countGatePass 不可见
  });

  it("反例:Candidate SHA 变化后旧证据与旧 PASS 全部失效", async () => {
    const f = await setupVerifying("t-sha-drift");
    const ev = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: f.cs.candidateSha,
        kind: "deterministic_test",
        passed: true,
        rawOutput: "ok",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const rec = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, passSpec(f, [ev.id, f.mv.id])),
    );
    expect(rec.ok).toBe(true);
    const gateId = (rec as { id: string }).id;
    // 候选漂移:同 attempt 新变更集(SHA 变化)
    await t.db.execute(
      sql`INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome) VALUES (${"run-drift"}, ${f.taskId}, ${f.attempt}, 'stub', 'stub/gm', 'host-fallback', 'SUCCEEDED')`,
    );
    await t.db.transaction(async (tx) =>
      recordChangeset(tx as unknown as Exec, {
        taskId: f.taskId,
        runId: "run-drift",
        attempt: f.attempt,
        base: BASE,
        candidate: new Map([["a.txt", "3"]]),
        requirement: { ...REQ, taskId: f.taskId, goalText: "g" },
      }),
    );
    const consume = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId: f.taskId,
        gateId,
        actor: "verifier",
        ownerId: f.verifier.ownerId,
        fencingToken: f.verifier.fencingToken,
      }),
    );
    expect(consume.ok).toBe(false);
    expect((consume as { reason: string }).reason).toMatch(/stale_candidate/);
    // 旧证据对新 SHA 亦失效(绑定失配)
    const evNew = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: "different-sha",
        kind: "deterministic_test",
        passed: true,
        rawOutput: "ok",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const rec2 = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { ...passSpec(f, [evNew.id]), candidateSha: "different-sha" }),
    );
    expect(rec2.ok).toBe(false);
    expect((rec2 as { reason: string }).reason).toBe("candidate_sha_mismatch");
  });

  it("反例:测试失败/证据篡改 ⇒ 不得绿色(PASS 拒绝)", async () => {
    const f = await setupVerifying("t-evidence");
    // 无证据 ⇒ evidence_missing(记录即拒)
    const noEv = await t.db.transaction(async (tx) => recordGateVerdict(tx as unknown as Exec, passSpec(f, [])));
    expect(noEv.ok).toBe(false);
    expect((noEv as { reason: string }).reason).toBe("evidence_missing");
    // 失败证据 ⇒ evidence_invalid:evidence_not_passed
    const failed = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: f.cs.candidateSha,
        kind: "deterministic_test",
        passed: false,
        rawOutput: "1 test failed",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const recFailed = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, passSpec(f, [failed.id])),
    );
    expect(recFailed.ok).toBe(false);
    expect((recFailed as { reason: string }).reason).toContain("evidence_not_passed");
    // 通过证据但事后篡改原文 ⇒ digest 失配,消费拒绝
    const ev = await t.db.transaction(async (tx) =>
      recordEvidence(tx as unknown as Exec, {
        taskId: f.taskId,
        attempt: f.attempt,
        candidateSha: f.cs.candidateSha,
        kind: "deterministic_test",
        passed: true,
        rawOutput: "all green",
        env: { mode: "worker-host", node: process.version, host: "test" },
        producedBy: "verifier",
      }),
    );
    const rec = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, passSpec(f, [ev.id, f.mv.id])),
    );
    expect(rec.ok).toBe(true);
    await t.db.execute(sql`UPDATE gate_evidence SET raw_output = 'tampered' WHERE id=${ev.id}`); // 模拟事后改写
    const consume = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId: f.taskId,
        gateId: (rec as { id: string }).id,
        actor: "verifier",
        ownerId: f.verifier.ownerId,
        fencingToken: f.verifier.fencingToken,
      }),
    );
    expect(consume.ok).toBe(false);
    expect((consume as { reason: string }).reason).toContain("evidence_digest_mismatch");
  });

  it("反例:Coder 虚构(同 run 自宣/非 reviewer run/DONE 文本)⇒ 全部拒绝", async () => {
    const f = await setupVerifying("t-fake");
    // 同 run 自宣(reviewer_run_id == coder run)⇒ 独立性拒绝
    const self = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { ...passSpec(f, []), reviewerRunId: f.coderRunId }),
    );
    expect(self.ok).toBe(false);
    expect((self as { reason: string }).reason).toBe("reviewer_independence_violation");
    // reviewer run 行不带 role=reviewer ⇒ 拒绝(coder run 冒充)
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome, detail)
      VALUES (${"run-pretend"}, ${f.taskId}, ${f.attempt}, 'stub', 'stub/gm', 'host-fallback', 'SUCCEEDED', '{}'::jsonb)
    `);
    const pretend = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { ...passSpec(f, []), reviewerRunId: "run-pretend" }),
    );
    expect(pretend.ok).toBe(false);
    expect((pretend as { reason: string }).reason).toBe("reviewer_run_not_reviewer");
    // 需求版本失配 ⇒ 记录即拒(requirement_sha_mismatch)
    const wrongReq = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, { ...passSpec(f, []), requirementSha: "old-requirement" }),
    );
    expect(wrongReq.ok).toBe(false);
    expect((wrongReq as { reason: string }).reason).toBe("requirement_sha_mismatch");
    // 全程无任何 PASS 落库:coder 的 DONE 文本(handoff)不产生裁决行 —— 状态层断言
    const passes = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${f.taskId} AND verdict='PASS'`,
    );
    expect(Number(passes.rows[0]!["n"])).toBe(0);
  });
});
