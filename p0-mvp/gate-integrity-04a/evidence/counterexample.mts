// RELAY-GATE-INTEGRITY-04A 反例留证脚本(对未修复代码运行:main 1764c61 + 合同 2648577;随包入库作为证据)。
// 两组反例:
//   A. 配置功能性检查(deterministic_test/api_behavior)时,manifestVerify(候选完整性硬门)被**完全跳过**
//      —— 候选内容与 candidate_sha 不一致(漂移)照样 ACCEPTED(功能性证据 + Reviewer PASS 即放行)。
//   B. workspaceDir 未提供时,orchestrateGate 以 process.cwd()(宿主仓库根)作为检查工作区
//      —— 传给执行器作为 Docker 挂载源(-v <仓库根>:/workspace,rw)。
// 全部使用无敏感信息测试变量、隔离测试库(p01a_ schema)、临时工作区;零真实远端写入;零模型调用。
// 运行:npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample.mts(仓库根)
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../../../test/setup/testdb.ts";
import { planGoal } from "../../../src/core/goals.ts";
import { claimTask } from "../../../src/core/lease.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../../src/core/gate-orchestrator.ts";
import { verifyCandidateManifest } from "../../../src/runtime/workspace-manifest.ts";
import { dockerCheckRunner } from "../../../src/runtime/check-sandbox.ts";
import { executeRun } from "../../../src/runtime/runner.ts";
import { resolveVendoredPi } from "../../../src/runtime/pi-version.ts";
import { cleanupSandbox, type SandboxSpec } from "../../../src/runtime/sandbox.ts";
import { hostTestCheckRunner } from "../../../test/helpers/check-runner.ts";
import type { Exec } from "../../../src/core/db.ts";
import { sql } from "drizzle-orm";

const evidence: string[] = [];
const line = (s: string) => {
  console.log(s);
  evidence.push(s);
};

const STUB = new URL("../../../test/helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

const t = await createTestDb("gate-integrity-cx");
const sandboxes: SandboxSpec[] = [];

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

// ============ 反例 A:配置功能性检查时 manifestVerify 被跳过 ============
{
  line("=== 反例 A:功能性检查(deterministic_test)已配置 ⇒ candidate_manifest_verify 完整性硬门被跳过 ===");
  const taskId = "t-cx-a-manifest-skip";
  const { result, goalId } = await coderRun(taskId);
  line(`A.setup: run=${result.runId} outcome=${result.outcome} workspace=${result.sandboxSpec.workspaceDir}`);

  // 人为制造候选内容漂移:run 结束后向候选工作区写入额外文件 ⇒ 工作区清单 ≠ candidate_sha
  // (若完整性门被调用,verifyCandidateManifest 必返回 ok:false ⇒ 修复后语义=拒绝)
  const ws = result.sandboxSpec.workspaceDir;
  writeFileSync(join(ws, "DRIFT-EXTRA-FILE.txt"), "候选内容漂移哨兵(运行后写入,不在 candidate_sha 内)");
  const csRow = await t.db.execute(
    sql`SELECT candidate_sha FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
  );
  const candidateSha = String(csRow.rows[0]!["candidate_sha"]);
  const realVerify = verifyCandidateManifest(ws, candidateSha, 1);
  line(`A.drift-setup: candidate_sha=${candidateSha.slice(0, 12)}… 写入漂移文件后真实复验 ok=${realVerify.ok}(预期 false=完整性必败)`);

  // 编排:功能性检查已配置(恒真)+ manifestVerify=真实复验(若被调用必失败)+ Reviewer 桩 PASS
  let manifestVerifyCalls = 0;
  const gate = await orchestrateGate(
    t.db,
    { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: ws, actor: "cx-a" },
    {
      checkRunner: hostTestCheckRunner,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
      ],
      manifestVerify: async (spec) => {
        manifestVerifyCalls++;
        return verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount);
      },
      reviewRun: reviewerPass("run-cx-a-reviewer", taskId),
      reviewAttempts: 1,
    },
  );
  line(`A.result: status=${gate.status} reason=${gate.reason ?? "-"}`);
  line(`A.manifestVerify-calls=${manifestVerifyCalls}(修复前预期 0=完整性门被跳过;修复后预期 ≥1)`);
  const evRows = await t.db.execute(
    sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${taskId} ORDER BY created_at`,
  );
  line(
    `A.evidence-kinds=[${evRows.rows.map((r) => `${String(r["kind"])}:${r["passed"] === true ? "PASS" : "FAIL"}`).join(", ")}]`,
  );
  const mvEvidence = evRows.rows.filter((r) => String(r["kind"]) === "candidate_manifest_verify");
  line(
    `A.defect-verdict: ${gate.status === "ACCEPTED" && manifestVerifyCalls === 0 && mvEvidence.length === 0 ? "成立(缺陷实证:候选内容漂移[真实复验必败] + 功能检查通过 + Reviewer PASS ⇒ ACCEPTED;完整性门零调用零证据 —— 功能测试与 Reviewer 顶替了完整性验证)" : "不成立(需人工核查)"}`,
  );
}

// ============ 反例 B:workspaceDir 未提供 ⇒ process.cwd()(宿主仓库根)作为 Docker 挂载源 ============
{
  line("");
  line("=== 反例 B:workspaceDir 未提供 ⇒ 检查工作区回退 process.cwd()(宿主仓库根)并作为 Docker 挂载源 ===");
  const taskId = "t-cx-b-cwd-fallback";
  const { result } = await coderRun(taskId);

  // B-1(执行器层实证):dockerCheckRunner 以 process.cwd() 为工作区 —— mountinfo 实证挂载绑定
  // (只读命令;容器非 root/cap-drop ALL/禁网;不写入宿主任何路径)
  const hostRepoPath = process.cwd();
  const hostInode = (await import("node:fs")).statSync(hostRepoPath).ino;
  const runner = dockerCheckRunner();
  const probe = await runner(
    {
      kind: "deterministic_test",
      command: [
        "sh",
        "-c",
        `cat /proc/self/mountinfo | grep ' ${"/workspace"} rw' ; stat -c 'WS_INODE=%i' /workspace`,
      ],
      cwdWorkspace: true,
      timeoutMs: 60_000,
    },
    hostRepoPath,
  );
  const mountLine = probe.rawOutput.split("\n").find((l) => l.includes("/home/") && l.includes(" /workspace rw"));
  const wsInodeLine = probe.rawOutput.split("\n").find((l) => l.startsWith("WS_INODE="));
  const mountProven = mountLine !== undefined && wsInodeLine !== undefined && Number(wsInodeLine.slice(9)) === hostInode;
  line(`B.docker-probe: passed=${probe.passed} env.mode=${probe.env.mode}`);
  line(`B.docker-probe mountinfo=${JSON.stringify(mountLine ?? null)}(挂载源=${hostRepoPath},rw)`);
  line(
    `B.docker-probe inode: 宿主仓库根=${hostInode} 容器/workspace=${wsInodeLine?.slice(9) ?? "n/a"} ⇒ 挂载绑定实证=${mountProven ? "YES(缺陷实证:宿主仓库根被绑定为 /workspace,rw)" : "no"}`,
  );
  line(
    "B.docker-probe note: 容器 UID 10001 因宿主目录权限(0750/0770)暂不可穿越读取 —— 挂载绑定本身已实证;" +
      "仓库权限放开或 UID 配置变更即完全暴露。如实记录,不夸大可利用性。",
  );

  // B-2(编排层实证):orchestrateGate 未提供 workspaceDir ⇒ 收集证据时把 process.cwd() 传给执行器
  const receivedWorkspaceDirs: string[] = [];
  const spyRunner = async (spec, workspaceDir) => {
    receivedWorkspaceDirs.push(workspaceDir);
    return hostTestCheckRunner(spec, workspaceDir);
  };
  const gate = await orchestrateGate(
    t.db,
    { taskId, attempt: 1, coderRunId: result.runId, actor: "cx-b" }, // ← 不传 workspaceDir
    {
      checkRunner: spyRunner,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
      ],
      reviewRun: reviewerPass("run-cx-b-reviewer", taskId),
      reviewAttempts: 1,
    },
  );
  const cwdPassed = receivedWorkspaceDirs.length > 0 && receivedWorkspaceDirs.every((d) => d === process.cwd());
  line(`B.orchestrator: status=${gate.status} reason=${gate.reason ?? "-"}`);
  line(
    `B.orchestrator-check-ran=${receivedWorkspaceDirs.length > 0 ? "YES(检查被启动)" : "no"} 传给执行器的工作区=${JSON.stringify(receivedWorkspaceDirs[0] ?? null)}`,
  );
  line(
    `B.defect-verdict: ${cwdPassed && receivedWorkspaceDirs[0] === process.cwd() && mountProven && gate.status === "ACCEPTED" ? "成立(缺陷实证:workspaceDir 缺失 ⇒ process.cwd()=宿主仓库根被用作候选检查工作区并被真实挂载[execution器层 mountinfo 实证];且 Gate 照常走到 ACCEPTED —— 检查验证的是仓库根而非候选内容)" : "不成立(需人工核查)"}`,
  );
  line("B.note: 宿主仓库根作为挂载源意味着候选检查在 Relay 项目根运行(可读写仓库文件、误用仓库状态作为候选面);" +
    "生产 LiveWorker 当前总是传 result.workspaceDir(防御纵深缺口,合同§四.2 要求消除隐式回退);B-1 的 Docker 实测证明该值会被真实挂载。");
}

// ============ 清理 ============
for (const s of sandboxes) cleanupSandbox(s);
await t.cleanup();
line("");
line("反例运行完成(对未修复代码;隔离 p01a_ schema 已清理;零真实远端写入/零模型调用)。");
