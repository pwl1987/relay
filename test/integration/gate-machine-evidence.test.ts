// RELAY-QUALITY-LOCAL-01 阶段 D:Gate 最低机器证据反例测试(反例先行,证明风险后才修复)。
// RELAY-SAFETY-CLOSE-02 P0-B 增补:功能性证据区分 —— candidate_manifest_verify 只证明候选
// 完整性,不证明行为正确;代码变更候选的 PASS 必须含 ≥1 条功能性证据
// (deterministic_test/api_behavior);单凭 manifest 复验 + Reviewer PASS 不得 ACCEPTED
// (修复前反例证据:p0-mvp/safety-close-02/evidence/counterexample-manifest-reviewer-accepted.log)。
// 反例 A(修复前应为 ACCEPTED=漏洞实证):代码变更候选 + 零机器检查 + 仅 reviewer_output
//   ⇒ Reviewer 自评即可放行 —— 违反 ADR-0012 #7/CONTRACTS §5("只有 Reviewer 输出时不得
//   通过必需测试 Gate")。
// 反例 B(合法豁免,修复前后均 ACCEPTED):docs-only 候选 + 零机器检查 + Reviewer PASS
//   ⇒ 确定性 N/A 规则豁免(纯文档变更无机器测试可跑)。
// 修复后本文件断言翻转为 fail-closed 语义;修复前反例运行的原始输出(漏洞实证)存于
// p0-mvp/quality-local-01/evidence/counterexample-prefix-run.log 与
// p0-mvp/safety-close-02/evidence/counterexample-manifest-reviewer-accepted.log(均入库证据)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { planGoal } from "../../src/core/goals.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import { recordChangeset, sha256Hex } from "../../src/core/changesets.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { runReviewerSession } from "../../src/runtime/reviewer.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("Gate 最低机器证据(反例先行)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("d-machine-evidence");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  /** 建目标+账本+任务,coder Run(stub)至 VERIFYING;writeFile 控制候选内容面。 */
  async function coderRun(taskId: string, writeFile: string) {
    const goalId = `goal-${taskId}`;
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "在工作区生成指定文件",
        budget: { modelCalls: 12 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, "coder", 60));
    assertOk(c);
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId,
      goal: "在工作区生成指定文件",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 2,
      budget: { goalId, reserveCallsPerRun: 4 },
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: writeFile },
    });
    sandboxes.push(result.sandboxSpec);
    return { claim: c, result, goalId };
  }

  function reviewerStub(
    verdict: string,
    goalId: string,
    workspaceOverride?: string,
  ): (input: ReviewRunInput) => Promise<ReviewRunResult> {
    return async (input) => {
      const r = await runReviewerSession(t.db, resolveVendoredPi(), {
        taskId: input.taskId,
        attempt: input.attempt,
        goalText: input.goalText,
        changeset: input.changeset,
        evidenceSummaries: input.evidenceSummaries,
        model: MODEL,
        sandbox: "host-fallback",
        heartbeatSeconds: 2,
        wallSeconds: 30,
        budget: { goalId, reserveCallsPerRun: 2 },
        ...(workspaceOverride ? { workspaceDirOverride: workspaceOverride } : {}),
        heartbeatFn: input.heartbeat,
        argvOverride: [process.execPath, STUB],
        envOverride: { STUB_MODE: "verdict", STUB_VERDICT: verdict, STUB_FINDINGS: `stub ${verdict}` },
      });
      if (r.sandboxSpec) sandboxes.push(r.sandboxSpec);
      return r;
    };
  }

  it("反例 A(修复后):代码变更候选 + 零机器检查 + Reviewer 待命 ⇒ 保守停机 NEEDS_DECISION,不烧 Reviewer", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-code-only-reviewer";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      { reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir), reviewAttempts: 1 },
    );
    // 修复后:机器证据预检拦在 Reviewer 之前 —— 不放行、不烧模型预算
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("functional_evidence_unconfigured");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // 无 PASS 裁决、无 reviewer_output 证据(Reviewer 根本未启动)
    const verdicts = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId}`);
    expect(Number(verdicts.rows[0]!["n"])).toBe(0);
    const ev = await t.db.execute(sql`SELECT count(*)::int AS n FROM gate_evidence WHERE task_id=${taskId}`);
    expect(Number(ev.rows[0]!["n"])).toBe(0);
    // D3 决策行留痕(人工可恢复)
    const dec = await t.db.execute(sql`SELECT level, state FROM decisions WHERE task_id=${taskId}`);
    expect(String(dec.rows[0]!["level"])).toBe("D3");
    expect(String(dec.rows[0]!["state"])).toBe("OPEN");
  });

  it("反例 B:docs-only 候选 + 零机器检查 + Reviewer PASS ⇒ ACCEPTED(合法豁免,修复后保留)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-docs-only";
    const { result, goalId } = await coderRun(taskId, "notes.md:说明文字");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      { reviewRun: reviewerStub("PASS", goalId, result.sandboxSpec.workspaceDir), reviewAttempts: 1 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
  });

  it("纵深防御:直接调用 recordGateVerdict,代码变更候选仅 reviewer_output ⇒ 拒绝 functional_evidence_missing", async () => {
    const taskId = "t-dme-direct";
    const goalId = `goal-${taskId}`;
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "直接裁决反例",
        budget: { modelCalls: 4 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    // 造 coder run 行 + 代码变更变更集(result.txt)
    const runId = "run-dme-direct";
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail) VALUES (${runId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"coder"}'::jsonb)
    `);
    const candidate = new Map([["result.txt", sha256Hex("sum=87")]]);
    await recordChangeset(t.db as unknown as Exec, {
      taskId,
      runId,
      attempt: 1,
      base: new Map(),
      candidate,
      requirement: { goalText: "直接裁决反例", taskId, allowedScope: ["/workspace"], allowedCommands: ["echo"] },
    });
    // 造 reviewer run 行(role=reviewer)
    const reviewerRunId = "run-dme-reviewer";
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail) VALUES (${reviewerRunId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
    `);
    // 仅 reviewer_output 证据
    const csRow = await t.db.execute(
      sql`SELECT candidate_sha, requirement_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
    );
    const candidateSha = String(csRow.rows[0]!["candidate_sha"]);
    const requirementSha = String(csRow.rows[0]!["requirement_sha"]);
    const ev = await t.db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES ('ev-dme-1', ${taskId}, 1, ${candidateSha},
        'reviewer_output', true, 'stub pass', '{"mode":"reviewer"}'::jsonb, ${sha256Hex("stub pass")}, 'test')
      RETURNING id
    `);
    const rec = await recordGateVerdict(t.db as unknown as Exec, {
      taskId,
      verdict: "PASS",
      reviewer: "test",
      attempt: 1,
      candidateSha,
      requirementSha,
      testEnv: { mode: "worker", node: "test", host: "test" },
      reviewerRunId,
      coderRunId: runId,
      evidenceIds: [String(ev.rows[0]!["id"])],
    });
    // 修复前:ok:true(漏洞);修复后:拒绝 functional_evidence_missing
    expect(rec.ok).toBe(false);
    if (!rec.ok) expect(rec.reason).toBe("functional_evidence_missing");
  });

  it("纵深防御(P0-B):直录 PASS 仅含 candidate_manifest_verify + reviewer_output(无功能性证据)⇒ 拒绝 functional_evidence_missing", async () => {
    const taskId = "t-dme-manifest-only-direct";
    const goalId = `goal-${taskId}`;
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "完整性不等于功能",
        budget: { modelCalls: 4 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const runId = "run-dme-mv-direct";
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail) VALUES (${runId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"coder"}'::jsonb)
    `);
    const candidate = new Map([["result.txt", sha256Hex("sum=87")]]);
    await recordChangeset(t.db as unknown as Exec, {
      taskId,
      runId,
      attempt: 1,
      base: new Map(),
      candidate,
      requirement: { goalText: "完整性不等于功能", taskId, allowedScope: ["/workspace"], allowedCommands: ["echo"] },
    });
    const reviewerRunId = "run-dme-mv-reviewer";
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail) VALUES (${reviewerRunId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
    `);
    const csRow = await t.db.execute(
      sql`SELECT candidate_sha, requirement_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
    );
    const candidateSha = String(csRow.rows[0]!["candidate_sha"]);
    const requirementSha = String(csRow.rows[0]!["requirement_sha"]);
    // 完整性(通过)+ Reviewer(通过),但零功能性证据 ⇒ 修复前该组合即 ACCEPTED(P0-B 反例)
    const ev1 = await t.db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES ('ev-dme-mv', ${taskId}, 1, ${candidateSha},
        'candidate_manifest_verify', true, 'verify=ok', '{"mode":"worker"}'::jsonb, ${sha256Hex("verify=ok")}, 'test')
      RETURNING id
    `);
    const ev2 = await t.db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES ('ev-dme-ro', ${taskId}, 1, ${candidateSha},
        'reviewer_output', true, 'stub pass', '{"mode":"reviewer"}'::jsonb, ${sha256Hex("stub pass")}, 'test')
      RETURNING id
    `);
    const rec = await recordGateVerdict(t.db as unknown as Exec, {
      taskId,
      verdict: "PASS",
      reviewer: "test",
      attempt: 1,
      candidateSha,
      requirementSha,
      testEnv: { mode: "worker", node: "test", host: "test" },
      reviewerRunId,
      coderRunId: runId,
      evidenceIds: [String(ev1.rows[0]!["id"]), String(ev2.rows[0]!["id"])],
    });
    expect(rec.ok).toBe(false);
    if (!rec.ok) expect(rec.reason).toBe("functional_evidence_missing");
  });

  it("D6:gate_required=false + 代码变更 ⇒ 仍强制 Gate(豁免通道关闭;审计留 GATE_REQUIRED_OVERRIDE)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-gatereq-false-code";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    await t.db.execute(sql`UPDATE tasks SET gate_required = false WHERE id=${taskId}`);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      { reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir), reviewAttempts: 1 },
    );
    // 代码变更不得借 gate_required=false 逃逸:无机器检查 ⇒ 保守停机(与反例 A 同语义)
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_REQUIRED_OVERRIDE'`,
    );
    expect(audit.rows.length).toBe(1);
  });

  it("合法豁免保留:gate_required=false + docs-only 候选 ⇒ SKIPPED(纯文档任务不强制机器 Gate)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-gatereq-false-docs";
    const { result } = await coderRun(taskId, "notes.md:说明文字");
    expect(result.outcome).toBe("SUCCEEDED");
    await t.db.execute(sql`UPDATE tasks SET gate_required = false WHERE id=${taskId}`);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      { reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir), reviewAttempts: 1 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("SKIPPED");
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_SKIPPED'`,
    );
    expect(audit.rows.length).toBe(1);
  });

  it("P0-B 反例(修复前实证,修复后翻转):候选完整性通过 + Reviewer PASS 但无功能性证据 ⇒ NEEDS_DECISION(不烧 Reviewer;完整性证据留档)", {
    timeout: 90_000,
  }, async () => {
    // 修复前该组合 ACCEPTED(反例证据:counterexample-manifest-reviewer-accepted.log)——
    // 完整性(candidate_manifest_verify)只证明"交付内容与绑定面一致且非空",不证明行为正确。
    const taskId = "t-dme-manifest-verify";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      {
        manifestVerify: async (spec) => {
          const { verifyCandidateManifest } = await import("../../src/runtime/workspace-manifest.ts");
          return verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount);
        },
        reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir),
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("functional_evidence_unconfigured");
    // 完整性硬门仍执行并留档(通过);Reviewer 未启动(零 reviewer_output 证据)
    const ev = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${taskId}`);
    expect(ev.rows.length).toBe(1);
    expect(String(ev.rows[0]!["kind"])).toBe("candidate_manifest_verify");
    expect(ev.rows[0]!["passed"]).toBe(true);
    const verdicts = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId}`);
    expect(Number(verdicts.rows[0]!["n"])).toBe(0);
  });

  it("功能性证据合法放行:配置 deterministic_test(恒真)⇒ ACCEPTED,证据含功能性 + Reviewer", {
    timeout: 90_000,
  }, async () => {
    // 旧成功路径回归:功能性机器检查在 ⇒ Gate 语义完整(REWORK/BLOCK/PASS 全链不变)
    const taskId = "t-dme-functional-pass";
    const { result, goalId } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
        ],
        reviewRun: reviewerStub("PASS", goalId, result.sandboxSpec.workspaceDir),
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
    const kinds = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${taskId}`);
    const kindList = kinds.rows.map((r) => String(r["kind"]));
    expect(kindList).toContain("deterministic_test");
    expect(kindList).toContain("reviewer_output");
    for (const r of kinds.rows) expect(r["passed"]).toBe(true);
  });

  it("必需功能性检查失败 ⇒ 保守停机 evidence_failed(不进 Reviewer,零模型预算)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-functional-fail";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "process.exit(3)"], cwdWorkspace: true },
        ],
        reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir),
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("evidence_failed:deterministic_test");
    // 失败证据留档;Reviewer 未启动
    const ev = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${taskId}`);
    expect(ev.rows.length).toBe(1);
    expect(String(ev.rows[0]!["kind"])).toBe("deterministic_test");
    expect(ev.rows[0]!["passed"]).toBe(false);
    const verdicts = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId}`);
    expect(Number(verdicts.rows[0]!["n"])).toBe(0);
  });

  it("生产默认兜底拦截:manifestVerify 复验失败(候选不一致)⇒ NEEDS_DECISION,不进 Reviewer", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-dme-manifest-fail";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "test-dme",
      },
      {
        manifestVerify: async () => ({ ok: false, rawOutput: "verify=mismatch(模拟候选被改动)" }),
        reviewRun: reviewerStub("PASS", `goal-${taskId}`, result.sandboxSpec.workspaceDir),
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("candidate_manifest_verify_failed");
    // Reviewer 未启动(零 reviewer_output 证据),复验失败证据留档
    const ev = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${taskId}`);
    expect(ev.rows.length).toBe(1);
    expect(String(ev.rows[0]!["kind"])).toBe("candidate_manifest_verify");
    expect(ev.rows[0]!["passed"]).toBe(false);
  });
});
