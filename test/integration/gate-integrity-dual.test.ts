// RELAY-GATE-INTEGRITY-04A:Gate 完整性双门 + 工作区安全边界(反例先行;反例证据
// p0-mvp/gate-integrity-04a/evidence/counterexample.log —— 修复前:
//   A. 配置功能性检查 ⇒ candidate_manifest_verify 完整性门被完全跳过,候选内容漂移照样 ACCEPTED;
//   B. workspaceDir 缺失 ⇒ process.cwd()(宿主仓库根)被用作检查工作区并真实挂载(mountinfo 实证)。
// R2 补测(反例证据 counterexample-r2.log,对 bd53f9a 实测):
//   C. 绕过编排直录 Gate ⇒ record/consume 双侧强制完整性证据(integrity_evidence_missing);
//   D. "/tmp" 非本 Run 工作区(内容相同的外来目录)⇒ 工作区归属绑定校验 FAIL-CLOSED
//      (workspace_provenance_mismatch;runs 行持久化 workspace_dir)。
// 修复后语义(合同§三/§四 + R2):
//   - 功能检查前必须复验候选与 candidate_sha 一致(功能测试不能代替完整性验证);
//   - 功能检查后重新复验,测试期间修改候选工作区 ⇒ 漂移检出,保守停机;
//   - manifestVerify 未注入/工作区缺失 ⇒ FAIL-CLOSED(不进 Reviewer,零模型);
//   - 检查已配置但缺工作区 ⇒ 不启动任何检查(禁止 process.cwd() 隐式回退);
//   - 代码变更候选 PASS 必须引用完整性证据(record/consume 双侧;直录不可绕过);
//   - 提供的工作区与本 Run 记录不一致 ⇒ FAIL-CLOSED(外来目录内容相同也不放行);
//   - docs-only 合法豁免不退化(无工作区时跳过可选检查,流程照常)。
// 全部使用隔离测试库(p01a_ schema)+ 临时工作区 + 受控桩;零模型调用;零远端写入。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { planGoal } from "../../src/core/goals.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import { recordEvidence } from "../../src/core/evidence.ts";
import { consumeGateVerdict, recordGateVerdict } from "../../src/core/gates.ts";
import { acquireVerificationLease } from "../../src/core/verify-lease.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { verifyCandidateManifest } from "../../src/runtime/workspace-manifest.ts";
import { validateCheckWorkspace } from "../../src/runtime/check-sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";
import type { CheckSpec } from "../../src/core/evidence.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("Gate 完整性双门 + 工作区安全边界(RELAY-GATE-INTEGRITY-04A)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("gate-integrity-dual");
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

  /** 纯函数 Reviewer 桩(恒 PASS;记录调用;先落 role=reviewer runs 行供 record 校验)。 */
  function reviewerPass(taskId: string) {
    const calls: ReviewRunInput[] = [];
    const fn = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
      calls.push(input);
      const reviewerRunId = `run-gid-reviewer-${taskId}-${calls.length}`;
      await t.db.execute(sql`
        INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail)
        VALUES (${reviewerRunId}, ${taskId}, ${input.attempt}, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `);
      return { ok: true, verdict: "PASS", findings: "stub PASS", reviewerRunId, rawOutput: "stub verdict=PASS" };
    };
    return { fn, calls };
  }

  /** 内建完整性复验(生产同源:重采工作区清单比对 candidate_sha)。 */
  const builtinManifestVerify = async (spec: {
    workspaceDir: string;
    candidateSha: string;
    changedFileCount: number;
  }) => verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount);

  const PASSING_CHECK = [
    { kind: "deterministic_test" as const, command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
  ];

  it("双门合法放行:功能检查前/后完整性复验均通过 ⇒ ACCEPTED(两条 phase 完整性证据留档)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-pass";
    const { result, goalId } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
    // 完整性门真实执行:pre+post 两条 candidate_manifest_verify 证据,均通过,phase 可区分
    const mv = await t.db.execute(sql`
      SELECT passed, env->>'phase' AS phase FROM gate_evidence
      WHERE task_id=${taskId} AND kind='candidate_manifest_verify' ORDER BY created_at
    `);
    expect(mv.rows.length).toBe(2);
    expect(String(mv.rows[0]!["phase"])).toBe("pre_checks");
    expect(String(mv.rows[1]!["phase"])).toBe("post_checks");
    for (const r of mv.rows) expect(r["passed"]).toBe(true);
    // 功能性证据与 Reviewer 证据照常
    const kinds = await t.db.execute(sql`SELECT kind FROM gate_evidence WHERE task_id=${taskId}`);
    const kindList = kinds.rows.map((r) => String(r["kind"]));
    expect(kindList).toContain("deterministic_test");
    expect(kindList).toContain("reviewer_output");
    expect(reviewer.calls.length).toBe(1);
  });

  it("双门·前置拒绝:功能检查前候选已漂移 ⇒ candidate_manifest_verify_failed 保守停机(Reviewer 未启动)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-pre-fail";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    // 采集前漂移:向候选工作区写入额外文件 ⇒ 清单 ≠ candidate_sha
    writeFileSync(join(result.sandboxSpec.workspaceDir, "DRIFT-BEFORE.txt"), "采集前漂移");
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("candidate_manifest_verify_failed");
    expect(reviewer.calls.length).toBe(0); // 不烧 Reviewer
    const mv = await t.db.execute(
      sql`SELECT passed FROM gate_evidence WHERE task_id=${taskId} AND kind='candidate_manifest_verify'`,
    );
    expect(mv.rows.length).toBe(1);
    expect(mv.rows[0]!["passed"]).toBe(false);
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
  });

  it("双门·漂移检出:功能检查期间修改候选工作区 ⇒ candidate_drift_after_checks 保守停机(§三.5/6)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-drift-after";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: hostTestCheckRunner,
        // 检查本身修改候选工作区(写入漂移文件)⇒ 前置复验通过、后置复验必须检出
        evidenceChecks: [
          {
            kind: "deterministic_test",
            command: ["node", "-e", "require('fs').writeFileSync('drift-during-check.txt','x')"],
            cwdWorkspace: true,
          },
        ],
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("candidate_drift_after_checks");
    expect(reviewer.calls.length).toBe(0); // 漂移 ⇒ 不进 Reviewer
    const mv = await t.db.execute(sql`
      SELECT passed, env->>'phase' AS phase FROM gate_evidence
      WHERE task_id=${taskId} AND kind='candidate_manifest_verify' ORDER BY created_at
    `);
    expect(mv.rows.length).toBe(2);
    expect(mv.rows[0]!["passed"]).toBe(true); // 前:一致
    expect(mv.rows[1]!["passed"]).toBe(false); // 后:漂移检出
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='CANDIDATE_DRIFT_AFTER_CHECKS'`,
    );
    expect(audit.rows.length).toBe(1);
  });

  it("功能检查失败 + 清单正确 ⇒ REQUIRED_EVIDENCE_FAILED(前置复验通过不掩盖功能失败)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-functional-fail";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "process.exit(3)"], cwdWorkspace: true },
        ],
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("evidence_failed:deterministic_test");
    expect(reviewer.calls.length).toBe(0);
    // 前置完整性复验已通过留档(双门并行,互不顶替)
    const mv = await t.db.execute(
      sql`SELECT passed, env->>'phase' AS phase FROM gate_evidence WHERE task_id=${taskId} AND kind='candidate_manifest_verify'`,
    );
    expect(mv.rows.length).toBe(1);
    expect(mv.rows[0]!["passed"]).toBe(true);
  });

  it("manifestVerify 未注入 + 功能检查 ⇒ integrity_verify_unavailable FAIL-CLOSED(功能测试不能顶替完整性验证)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-no-verifier";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: PASSING_CHECK,
        // 故意不注入 manifestVerify ⇒ 完整性无法验证 ⇒ FAIL-CLOSED
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("integrity_verify_unavailable");
    expect(reviewer.calls.length).toBe(0);
    // 零检查执行(检查前即拦截)
    const checks = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM gate_evidence WHERE task_id=${taskId} AND kind='deterministic_test'`,
    );
    expect(Number(checks.rows[0]!["n"])).toBe(0);
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_INTEGRITY_UNVERIFIABLE'`,
    );
    expect(audit.rows.length).toBe(1);
  });

  it("缺少工作区 ⇒ 不启动任何检查(禁止 process.cwd() 回退)+ workspace_missing FAIL-CLOSED(反例 B 修复)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-no-workspace";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const runnerCalls: string[] = [];
    const spyRunner = async (spec: CheckSpec, workspaceDir: string) => {
      runnerCalls.push(workspaceDir);
      return hostTestCheckRunner(spec, workspaceDir);
    };
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, actor: "t-gid" }, // 不传 workspaceDir
      {
        checkRunner: spyRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    expect(gate.reason).toBe("workspace_missing");
    expect(runnerCalls.length).toBe(0); // 不启动检查(反例 B:曾以 process.cwd() 执行)
    expect(reviewer.calls.length).toBe(0);
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_WORKSPACE_MISSING'`,
    );
    expect(audit.rows.length).toBe(1);
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
  });

  it("docs-only 合法豁免不退化:配置了检查但缺工作区 ⇒ 跳过检查(审计留痕),豁免路径照常 ACCEPTED", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-docs-no-ws";
    const { result, goalId } = await coderRun(taskId, "notes.md:说明文字");
    expect(result.outcome).toBe("SUCCEEDED");
    const runnerCalls: string[] = [];
    const spyRunner = async (spec: CheckSpec, workspaceDir: string) => {
      runnerCalls.push(workspaceDir);
      return hostTestCheckRunner(spec, workspaceDir);
    };
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, actor: "t-gid" }, // 缺工作区
      {
        checkRunner: spyRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(runnerCalls.length).toBe(0); // 绝不以 process.cwd() 挂载
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED"); // docs-only 豁免保留
    const audit = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_WORKSPACE_MISSING'`,
    );
    expect(audit.rows.length).toBe(1);
    void goalId;
  });

  it("docs-only + 检查 + 工作区齐备 ⇒ 检查照常执行(豁免路径不受双门影响)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-docs-with-ws";
    const { result, goalId } = await coderRun(taskId, "notes.md:说明文字");
    expect(result.outcome).toBe("SUCCEEDED");
    const runnerCalls: string[] = [];
    const spyRunner = async (spec: CheckSpec, workspaceDir: string) => {
      runnerCalls.push(workspaceDir);
      return hostTestCheckRunner(spec, workspaceDir);
    };
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      {
        taskId,
        attempt: 1,
        coderRunId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
        actor: "t-gid",
      },
      {
        checkRunner: spyRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0]).toBe(result.sandboxSpec.workspaceDir);
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
    void goalId;
  });

  // ---------- R2 补测(反例 C/D;counterexample-r2.log 对 bd53f9a 实证) ----------

  it("R2-C:绕过编排直录 PASS(仅功能证据、零完整性证据)⇒ record/consume 双侧拒绝 integrity_evidence_missing", async () => {
    const taskId = "t-gid-r2-direct-record";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const csRow = await t.db.execute(
      sql`SELECT candidate_sha, requirement_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
    );
    const candidateSha = String(csRow.rows[0]!["candidate_sha"]);
    const requirementSha = String(csRow.rows[0]!["requirement_sha"]);
    const reviewerRunId = `run-gid-r2-reviewer-${taskId}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail)
      VALUES (${reviewerRunId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    // 直录方仅采集功能性证据,不执行任何候选完整性复验(反例 C 的直录形态)
    const funcEv = await recordEvidence(t.db as unknown as Exec, {
      taskId,
      attempt: 1,
      candidateSha,
      kind: "deterministic_test",
      passed: true,
      rawOutput: "direct-record functional only",
      env: { mode: "worker-host", node: process.version, host: "test" },
      producedBy: "r2-direct",
    });
    // record 侧:代码变更候选 PASS 必须引用完整性证据(功能测试不能代替完整性验证)
    const rec = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, {
        taskId,
        verdict: "PASS",
        reviewer: "r2-direct",
        attempt: 1,
        candidateSha,
        requirementSha,
        testEnv: { mode: "worker-host", node: process.version, host: "test" },
        reviewerRunId,
        coderRunId: result.runId,
        evidenceIds: [funcEv.id],
      }),
    );
    expect(rec.ok, `record.reason=${rec.ok ? "-" : (rec as { reason: string }).reason}`).toBe(false);
    if (!rec.ok) expect(rec.reason).toBe("integrity_evidence_missing");
    // consume 侧(旧格式直录 PASS 绕过 record 校验的形态):仅功能证据 ⇒ 同规则拒绝
    await t.db.execute(sql`
      INSERT INTO task_gate_verdicts (id, task_id, commit_ref, verdict, reviewer, attempt, candidate_sha, requirement_sha, evidence_ids)
      VALUES ('gate-r2-direct', ${taskId}, NULL, 'PASS', 'r2-direct', 1, ${candidateSha}, ${requirementSha},
        ${JSON.stringify([funcEv.id])}::jsonb)
    `);
    const vl = await t.db.transaction(async (tx) =>
      acquireVerificationLease(tx as unknown as Exec, taskId, "r2-direct", 60),
    );
    if (!vl.ok) throw new Error(`verify lease: ${vl.reason}`);
    const consumed = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId,
        gateId: "gate-r2-direct",
        actor: "r2-direct",
        ownerId: vl.ownerId,
        fencingToken: vl.fencingToken,
      }),
    );
    expect(consumed.ok, `consume.reason=${consumed.ok ? "-" : (consumed as { reason: string }).reason}`).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe("integrity_evidence_missing");
    // 对照:补齐完整性证据后同一绑定 record+consume 照常放行(规则精确,不误伤)
    const mvEv = await recordEvidence(t.db as unknown as Exec, {
      taskId,
      attempt: 1,
      candidateSha,
      kind: "candidate_manifest_verify",
      passed: true,
      rawOutput: "verify=ok",
      env: { mode: "worker-host", node: process.version, host: "test" },
      producedBy: "r2-direct",
    });
    const rec2 = await t.db.transaction(async (tx) =>
      recordGateVerdict(tx as unknown as Exec, {
        taskId,
        verdict: "PASS",
        reviewer: "r2-direct",
        attempt: 1,
        candidateSha,
        requirementSha,
        testEnv: { mode: "worker-host", node: process.version, host: "test" },
        reviewerRunId,
        coderRunId: result.runId,
        evidenceIds: [funcEv.id, mvEv.id],
      }),
    );
    expect(rec2.ok, `record2.reason=${rec2.ok ? "-" : (rec2 as { reason: string }).reason}`).toBe(true);
    const consumed2 = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId,
        gateId: (rec2 as { id: string }).id,
        actor: "r2-direct",
        ownerId: vl.ownerId,
        fencingToken: vl.fencingToken,
      }),
    );
    expect(consumed2.ok).toBe(true);
    expect((consumed2 as { state: string }).state).toBe("ACCEPTED");
  });

  it("R2-D:非本 Run 工作区(内容相同的外来 /tmp 目录)⇒ workspace_provenance_mismatch FAIL-CLOSED(检查/Reviewer 零执行)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-r2-foreign-ws";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const csRow = await t.db.execute(
      sql`SELECT candidate_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
    );
    const candidateSha = String(csRow.rows[0]!["candidate_sha"]);
    // 外来目录:内容与本 Run 候选完全相同 ⇒ 既有层(边界校验+内容复验)全部放行(反例 D 实证)
    const foreign = mkdtempSync(join(tmpdir(), "relay-test-foreign-"));
    writeFileSync(join(foreign, "result.txt"), readFileSync(join(result.sandboxSpec.workspaceDir, "result.txt")));
    try {
      expect(validateCheckWorkspace(foreign).ok).toBe(true);
      expect(verifyCandidateManifest(foreign, candidateSha, 1).ok).toBe(true);
      const runnerCalls: string[] = [];
      const spyRunner = async (spec: CheckSpec, workspaceDir: string) => {
        runnerCalls.push(workspaceDir);
        return hostTestCheckRunner(spec, workspaceDir);
      };
      const reviewer = reviewerPass(taskId);
      const gate = await orchestrateGate(
        t.db,
        { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: foreign, actor: "t-gid" },
        {
          checkRunner: spyRunner,
          evidenceChecks: PASSING_CHECK,
          manifestVerify: builtinManifestVerify,
          reviewRun: reviewer.fn,
          reviewAttempts: 1,
        },
      );
      expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
      expect(gate.reason).toBe("workspace_provenance_mismatch");
      expect(runnerCalls.length).toBe(0); // 检查不在外来目录执行
      expect(reviewer.calls.length).toBe(0); // 不进 Reviewer
      const audit = await t.db.execute(
        sql`SELECT action FROM audit_events WHERE task_id=${taskId} AND action='GATE_WORKSPACE_PROVENANCE_MISMATCH'`,
      );
      expect(audit.rows.length).toBe(1);
      const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
      expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("R2-D3:无归属绑定记录(旧格式 runs 行)⇒ 归属校验不可执行,由既有双门/边界把关(登记残留,不虚构拦截)", {
    timeout: 90_000,
  }, async () => {
    const taskId = "t-gid-r2-no-binding";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    // 剥离 runs 行的 workspace_dir(模拟旧格式/无绑定记录的 run 行)
    await t.db.execute(sql`UPDATE runs SET detail = detail - 'workspace_dir' WHERE id=${result.runId}`);
    const reviewer = reviewerPass(taskId);
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir, actor: "t-gid" },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: PASSING_CHECK,
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer.fn,
        reviewAttempts: 1,
      },
    );
    // 无绑定记录 ⇒ 归属校验跳过(不虚构拦截),既有双门照常把关 ⇒ 放行(残留如实登记)
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
  });
});
