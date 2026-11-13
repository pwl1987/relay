// RELAY-GATE-INTEGRITY-04A-R2 反例留证脚本(对未修复代码运行:main bd53f9a + 合同 96db097;随包入库作为证据)。
// 两组反例(04A 修复面之外的残余风险,用户指令"重点补测"):
//   C. 绕过编排直录 Gate:recordGateVerdict(PASS, 代码变更候选, 仅功能性证据 —— 零完整性证据)
//      + consumeGateVerdict ⇒ ACCEPTED。record/consume 是"防绕过编排直录"的权威边界
//      (gates.ts 消费侧注释自证该设计意图),但当前只强制功能性证据 —— 完整性证据缺失
//      不得 ACCEPTED 的语义在该边界不成立,可被直接调用方绕过。
//   D. "/tmp" 非本 Run 工作区挂载:外来 /tmp 目录(内容与候选完全相同)通过全部既有层
//      (validateCheckWorkspace 属 tmpdir 范围之下 + verifyCandidateManifest 内容哈希一致)
//      ⇒ 编排层照常 ACCEPTED、检查在外来目录执行 —— input.workspaceDir 与 coderRun 行
//      无归属绑定(runs 行不持久化工作区路径),换挂任何内容相同的外来目录都能通过。
// 全部使用无敏感信息测试变量、隔离测试库(p01a_ schema)、临时工作区;零真实远端写入;零模型调用。
// 运行:npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample-r2.mts(仓库根)
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDb } from "../../../test/setup/testdb.ts";
import { planGoal } from "../../../src/core/goals.ts";
import { claimTask } from "../../../src/core/lease.ts";
import { acquireVerificationLease, expireVerificationLease } from "../../../src/core/verify-lease.ts";
import { recordEvidence } from "../../../src/core/evidence.ts";
import { recordGateVerdict, consumeGateVerdict } from "../../../src/core/gates.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../../src/core/gate-orchestrator.ts";
import { verifyCandidateManifest } from "../../../src/runtime/workspace-manifest.ts";
import { validateCheckWorkspace } from "../../../src/runtime/check-sandbox.ts";
import { executeRun } from "../../../src/runtime/runner.ts";
import { resolveVendoredPi } from "../../../src/runtime/pi-version.ts";
import { cleanupSandbox, type SandboxSpec } from "../../../src/runtime/sandbox.ts";
import { hostTestCheckRunner } from "../../../test/helpers/check-runner.ts";
import type { Exec } from "../../../src/core/db.ts";

const evidence: string[] = [];
const line = (s: string) => {
  console.log(s);
  evidence.push(s);
};

const STUB = new URL("../../../test/helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

const t = await createTestDb("gate-integrity-cx-r2");
const sandboxes: SandboxSpec[] = [];
const foreignDirs: string[] = [];

/** 建目标+账本+任务,coder Run(stub)至 VERIFYING;runner 自录变更集(candidate_sha=运行结束清单)。 */
async function coderRun(taskId: string) {
  const goalId = `goal-${taskId}`;
  await t.db.transaction(async (tx) =>
    planGoal(tx as unknown as Exec, {
      id: goalId,
      rawInput: "在工作区生成 result.txt 内容为 sum=87",
      budget: { modelCalls: 12 },
      tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
    }),
  );
  const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, "coder", 60));
  if (!c.ok) throw new Error("claim failed:" + c.reason);
  const result = await executeRun(t.db, resolveVendoredPi(), {
    taskId,
    goal: "在工作区生成 result.txt 内容为 sum=87",
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
    envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: "result.txt:sum=87" },
  });
  sandboxes.push(result.sandboxSpec);
  return { claim: c, result, goalId };
}

/** 纯函数 Reviewer 桩(独立身份;恒 PASS;零模型;先落 role=reviewer 的 runs 行供 record 校验)。 */
const reviewerPass = (reviewerRunId: string, taskId: string) => async (_input: ReviewRunInput): Promise<ReviewRunResult> => {
  await t.db.execute(sql`
    INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail)
    VALUES (${reviewerRunId}, ${taskId}, 1, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
  return {
    ok: true,
    verdict: "PASS",
    findings: "stub PASS",
    reviewerRunId,
    rawOutput: "stub verdict=PASS",
  };
};

const latestChangesetSha = async (taskId: string): Promise<{ candidateSha: string; requirementSha: string }> => {
  const csRow = await t.db.execute(
    sql`SELECT candidate_sha, requirement_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
  );
  return {
    candidateSha: String(csRow.rows[0]!["candidate_sha"]),
    requirementSha: String(csRow.rows[0]!["requirement_sha"]),
  };
};

// ============ 反例 C:绕过编排直录 Gate(仅功能性证据、零完整性证据)⇒ ACCEPTED ============
{
  line("=== 反例 C:recordGateVerdict 直录 PASS(代码变更候选,仅功能性证据,零完整性证据)+ consume ⇒ ACCEPTED ===");
  const taskId = "t-cx-c-direct-record";
  const { result } = await coderRun(taskId);
  line(`C.setup: run=${result.runId} outcome=${result.outcome} workspace=${result.sandboxSpec.workspaceDir}`);
  const { candidateSha, requirementSha } = await latestChangesetSha(taskId);

  // 直录方仅采集功能性证据(deterministic_test 通过),**不执行任何候选完整性复验**
  const funcEv = await recordEvidence(t.db as unknown as Exec, {
    taskId,
    attempt: 1,
    candidateSha,
    kind: "deterministic_test",
    passed: true,
    rawOutput: "direct-record deterministic check ok",
    env: { mode: "worker-host", node: process.version, host: "cx" },
    producedBy: "cx-direct",
  });
  const reviewerRunId = "run-cx-c-reviewer";
  await reviewerPass(reviewerRunId, taskId)({} as ReviewRunInput);

  const rec = await t.db.transaction(async (tx) =>
    recordGateVerdict(tx as unknown as Exec, {
      taskId,
      verdict: "PASS",
      reviewer: "cx-direct",
      attempt: 1,
      candidateSha,
      requirementSha,
      testEnv: { mode: "worker-host", node: process.version, host: "cx" },
      reviewerRunId,
      coderRunId: result.runId,
      evidenceIds: [funcEv.id],
    }),
  );
  line(`C.record: ok=${rec.ok}${rec.ok ? ` gateId=${rec.id}` : ` reason=${(rec as { reason: string }).reason}`}`);

  // 消费(验证租约权威;与生产同链路)
  const vl = await t.db.transaction(async (tx) =>
    acquireVerificationLease(tx as unknown as Exec, taskId, "cx-direct", 60),
  );
  let consumedState = "n/a";
  if (vl.ok && rec.ok) {
    const consumed = await t.db.transaction(async (tx) =>
      consumeGateVerdict(tx as unknown as Exec, {
        taskId,
        gateId: rec.id,
        actor: "cx-direct",
        ownerId: vl.ownerId,
        fencingToken: vl.fencingToken,
      }),
    );
    consumedState = consumed.ok ? String((consumed as { state: string }).state) : `rejected:${(consumed as { reason: string }).reason}`;
    await expireVerificationLease(t.db as unknown as Exec, taskId, "cx-direct").catch(() => {});
  }
  const evKinds = await t.db.execute(sql`SELECT kind FROM gate_evidence WHERE task_id=${taskId}`);
  const hasIntegrityEvidence = evKinds.rows.some((r) => String(r["kind"]) === "candidate_manifest_verify");
  line(`C.consume: state=${consumedState}(任务状态=${(await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`)).rows[0]!["state"]})`);
  line(`C.integrity-evidence: 任务证据中 candidate_manifest_verify 行数=${hasIntegrityEvidence ? "≥1" : "0"}`);
  const taskState = String(
    (await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`)).rows[0]!["state"],
  );
  line(
    `C.defect-verdict: ${rec.ok && taskState === "ACCEPTED" && !hasIntegrityEvidence ? "成立(缺陷实证:绕过编排直录\"仅功能证据\"PASS 被权威边界放行并消费至 ACCEPTED —— 全程零完整性证据,完整性失败/缺失不得 ACCEPTED 的语义在 record/consume 边界不成立)" : "不成立(需人工核查)"}`,
  );
}

// ============ 反例 D:"/tmp" 非本 Run 工作区挂载(内容相同的外来目录)⇒ 全部既有层通过 ============
{
  line("");
  line("=== 反例 D:外来 /tmp 目录(内容与候选相同)通过既有全部层 ⇒ 编排 ACCEPTED,检查在外来目录执行 ===");
  const taskId = "t-cx-d-foreign-ws";
  const { result } = await coderRun(taskId);
  const ownWs = result.sandboxSpec.workspaceDir;
  const { candidateSha } = await latestChangesetSha(taskId);
  line(`D.setup: run=${result.runId} outcome=${result.outcome} 本 Run 工作区=${ownWs}`);

  // 构造外来目录:内容与本 Run 候选完全相同(读取本 Run 工作区文件原文重写)
  const foreign = mkdtempSync(join(tmpdir(), "relay-foreign-ws-"));
  foreignDirs.push(foreign);
  writeFileSync(join(foreign, "result.txt"), readFileSync(join(ownWs, "result.txt")));
  // 层1:工作区边界校验(validateCheckWorkspace)是否放行外来目录
  const wsv = validateCheckWorkspace(foreign);
  line(`D.layer1-validateCheckWorkspace: ok=${wsv.ok} reason=${wsv.reason ?? "-"}(外来目录=${foreign})`);
  // 层2:候选完整性复验(内容哈希比对)是否放行外来目录
  const mv = verifyCandidateManifest(foreign, candidateSha, 1);
  line(
    `D.layer2-verifyCandidateManifest: ok=${mv.ok}(内容与候选完全相同 ⇒ manifest_sha 一致;完整性只绑定内容不绑定归属)`,
  );

  // 层3:编排层 —— 用外来目录跑完整 Gate(manifestVerify=生产同源真实复验;检查在外来目录执行)
  const receivedWorkspaceDirs: string[] = [];
  const spyRunner = async (spec: Parameters<typeof hostTestCheckRunner>[0], workspaceDir: string) => {
    receivedWorkspaceDirs.push(workspaceDir);
    return hostTestCheckRunner(spec, workspaceDir);
  };
  const gate = await orchestrateGate(
    t.db,
    { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: foreign, actor: "cx-d" },
    {
      checkRunner: spyRunner,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
      ],
      manifestVerify: async (spec) =>
        verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
      reviewRun: reviewerPass("run-cx-d-reviewer", taskId),
      reviewAttempts: 1,
    },
  );
  const ranInForeign = receivedWorkspaceDirs.length > 0 && receivedWorkspaceDirs.every((d) => d === foreign);
  line(`D.layer3-orchestrateGate: status=${gate.status} reason=${gate.reason ?? "-"}`);
  line(
    `D.checks-executed-in=${JSON.stringify(receivedWorkspaceDirs[0] ?? null)}(是否外来目录=${ranInForeign ? "YES(检查在外来目录执行)" : "no"};本 Run 工作区=${ownWs} 全程未被使用)`,
  );
  const mvRows = await t.db.execute(
    sql`SELECT kind, passed, env FROM gate_evidence WHERE task_id=${taskId} AND kind='candidate_manifest_verify'`,
  );
  line(
    `D.integrity-evidence: ${mvRows.rows.length} 条复验证据,均对外来目录出具(mount/复验对象=外来目录而非本 Run 工作区)`,
  );
  line(
    `D.defect-verdict: ${gate.status === "ACCEPTED" && wsv.ok && mv.ok && ranInForeign ? "成立(缺陷实证:非本 Run 的外来 /tmp 工作区通过工作区边界校验+内容级完整性复验+完整编排 ⇒ ACCEPTED;工作区与 Run 无归属绑定,换挂任何内容相同的外来目录均能通过 —— 检查/复验/交付绑定面可被指向非本 Run 目录)" : "不成立(需人工核查)"}`,
  );
  line("D.note: 归属绑定缺失=与反例 B 不同的独立残余(反例 B=缺工作区回退宿主 cwd,已修复;" +
    "本反例=显式提供了**错误归属**的工作区,既有层全部放行)。缓解面如实记录:verifyCandidateManifest 只绑定内容哈希," +
    "内容相同的外来目录语义等价,但生产语义要求检查/复验/交付绑定本 Run 工作区(prepareRunDirs 为每 Run 独立创建)。");
}

// ============ 清理 ============
for (const s of sandboxes) cleanupSandbox(s);
for (const d of foreignDirs) rmSync(d, { recursive: true, force: true });
await t.cleanup();
line("");
line("R2 反例运行完成(对未修复代码 bd53f9a;隔离 p01a_ schema 已清理;零真实远端写入/零模型调用)。");
