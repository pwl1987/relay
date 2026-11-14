// RELAY-DEPLOY-REHEARSAL-08 D 项:功能性 Gate 发布演练(真实 docker 检查执行器;零 stub PASS 冒充)。
// 三场景(合同 D):未配置→保守停机 NEEDS_DECISION / 有效检查+真实通过→可继续 Gate(ACCEPTED)/
// 检查失败→保守阻断(evidence_failed)。检查一律经生产执行器 dockerCheckRunner
// (UID 10001/cap-drop ALL/只读根/--network none/一次性工作区挂载),配置取自
// deploy/evidence-checks.sample.json 经真实 resolveEvidenceChecks 校验(含非法配置拒绝)。
// 门:skipIf(!docker);编码器/Reviewer 用 stub pi 生成合成候选(候选合成 ≠ 检查 stub —— 检查真实执行)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { planGoal } from "../../src/core/goals.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox, type SandboxSpec, dockerAvailable } from "../../src/runtime/sandbox.ts";
import { runReviewerSession } from "../../src/runtime/reviewer.ts";
import { dockerCheckRunner } from "../../src/runtime/check-sandbox.ts";
import { verifyCandidateManifest } from "../../src/runtime/workspace-manifest.ts";
import { resolveEvidenceChecks } from "../../src/worker-entry.ts";
import { assertOk } from "../setup/assert.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };
const dockerOk = dockerAvailable();
console.log(`[d08-gate 门控] docker=${dockerOk}`);

/** deploy/evidence-checks.sample.json → 单行 env 值(生产 RELAY_EVIDENCE_CHECKS_JSON 形态)。 */
function sampleChecksEnvValue(): string {
  const raw = JSON.parse(
    execFileSync("cat", [join(import.meta.dirname, "../../deploy/evidence-checks.sample.json")], { encoding: "utf8" }),
  ) as unknown;
  return JSON.stringify(raw);
}

describe.skipIf(!dockerOk)("RELAY-DEPLOY-REHEARSAL-08:功能性 Gate 发布演练(真实 docker 检查)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];

  beforeAll(async () => {
    t = await createTestDb("d08-gate");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  async function coderRun(taskId: string, writeFile: string) {
    const goalId = `goal-${taskId}`;
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Parameters<typeof planGoal>[0], {
        id: goalId,
        rawInput: "在工作区生成指定文件",
        budget: { modelCalls: 12 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const c = await t.db.transaction(async (tx) =>
      claimTask(tx as unknown as Parameters<typeof claimTask>[0], taskId, "coder", 60),
    );
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

  function reviewerStub(verdict: string, goalId: string): (input: ReviewRunInput) => Promise<ReviewRunResult> {
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
        heartbeatFn: input.heartbeat,
        argvOverride: [process.execPath, STUB],
        envOverride: { STUB_MODE: "verdict", STUB_VERDICT: verdict, STUB_FINDINGS: `stub ${verdict}` },
      });
      if (r.sandboxSpec) sandboxes.push(r.sandboxSpec);
      return r;
    };
  }

  it("sample 配置经真实 resolveEvidenceChecks:合法通过;非法变异 fail-closed 拒绝", () => {
    const envValue = sampleChecksEnvValue();
    expect(envValue).not.toContain("\n"); // 单行 env 形态
    const checks = resolveEvidenceChecks(envValue);
    expect(checks).toHaveLength(1);
    expect(checks![0]).toMatchObject({ kind: "deterministic_test", cwdWorkspace: true, timeoutMs: 60000 });
    // 非法变异(每类 fail-closed)
    expect(() => resolveEvidenceChecks("{not-json")).toThrow(/非法 JSON/);
    expect(() => resolveEvidenceChecks("[]")).toThrow(/空数组/);
    expect(() => resolveEvidenceChecks('[{"kind":"unit_test","command":["true"]}]')).toThrow(/功能性证据/);
    expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":"ls"}]')).toThrow(/非空字符串数组/);
    expect(() =>
      resolveEvidenceChecks('[{"kind":"deterministic_test","command":["node","-e","1"],"timeoutMs":100}]'),
    ).toThrow(/1000~600000/);
  });

  it("真实 docker 检查执行器:合成候选通过(UID=10001/network=none)+漂移失败(零 stub 冒充)", {
    timeout: 120_000,
  }, async () => {
    const spec = resolveEvidenceChecks(sampleChecksEnvValue())![0]!;
    // 合成候选工作区(Run 工作区形态:tmpdir/relay-run-*/ws,深度≥3)
    // 与生产 runner 同口径(prepareRunDirs:mkdtemp 0700 ⇒ chmod o+rX,容器 UID 10001 可读)
    const wsRoot = mkdtempSync(join(tmpdir(), "relay-run-d08-"));
    chmodSync(wsRoot, 0o755);
    const ws = wsRoot + "/ws";
    mkdirSync(ws, { recursive: true });
    chmodSync(ws, 0o777);
    // VM80 umask=0007:writeFileSync 的 mode 会被 umask 过滤(other=0)⇒ 写后显式 chmod
    // (生产 docker 沙箱候选文件属主即 UID 10001,无此对齐需求;host-fallback 宿主
    // umask≥0077 时须 o+rX —— 环境约束登记 REPORT/D3)
    writeFileSync(join(ws, "relay-smoke.txt"), "ok");
    writeFileSync(join(ws, "src.txt"), "synthetic candidate\n");
    chmodSync(join(ws, "relay-smoke.txt"), 0o644);
    chmodSync(join(ws, "src.txt"), 0o644);
    const runner = dockerCheckRunner(); // 生产缺省执行器(真实 docker)
    const pass = await runner(spec, ws);
    expect(pass.passed, `rawOutput=${pass.rawOutput}`).toBe(true);
    expect(pass.rawOutput).toContain("sample deterministic check ok");
    expect(String(pass.env["user"])).toBe("10001"); // 非 root(UID 10001)
    expect(String(pass.env["network"])).toBe("none"); // 缺省禁网
    expect(String(pass.env["mode"])).toBe("docker");
    // 漂移/缺失:检查真实失败(保守阻断面)
    const driftRoot = mkdtempSync(join(tmpdir(), "relay-run-d08-"));
    chmodSync(driftRoot, 0o755);
    const drift = driftRoot + "/ws";
    mkdirSync(drift, { recursive: true });
    chmodSync(drift, 0o777);
    writeFileSync(join(drift, "src.txt"), "synthetic candidate\n"); // 无 relay-smoke.txt
    chmodSync(join(drift, "src.txt"), 0o644);
    const fail = await runner(spec, drift);
    expect(fail.passed).toBe(false);
    expect(fail.rawOutput).toMatch(/exit=[23]/);
  });

  it("Gate 发布演练三场景:未配置⇒NEEDS_DECISION / 真实检查通过⇒ACCEPTED / 检查失败⇒保守阻断", {
    timeout: 240_000,
  }, async () => {
    const sampleChecks = resolveEvidenceChecks(sampleChecksEnvValue())!;

    // 场景 1:未配置功能性机器检查 + 代码变更候选 ⇒ 保守停机(不烧 Reviewer)
    const t1 = "t-d08-gate-unconfigured";
    const r1 = await coderRun(t1, "result.txt:sum=87");
    expect(r1.result.outcome).toBe("SUCCEEDED");
    const g1 = await orchestrateGate(
      t.db,
      {
        taskId: t1,
        attempt: 1,
        coderRunId: r1.result.runId,
        workspaceDir: r1.result.sandboxSpec.workspaceDir,
        actor: "test-d08",
      },
      { reviewRun: reviewerStub("PASS", r1.goalId), reviewAttempts: 1 },
    );
    expect(g1.status, `gate.reason=${g1.reason}`).toBe("NEEDS_DECISION");
    expect(g1.reason).toBe("functional_evidence_unconfigured");

    // 场景 2:有效配置 + 真实 docker 检查通过 ⇒ 可继续 Gate(ACCEPTED;证据含真实功能性检查)
    const t2 = "t-d08-gate-pass";
    const r2 = await coderRun(t2, "relay-smoke.txt:ok");
    expect(r2.result.outcome).toBe("SUCCEEDED");
    // host-fallback 候选文件权限对齐(生产 docker 沙箱内文件属主即 UID 10001 无此需求;
    // 本机 umask=0007 ⇒ stub 写出 0660,容器检查器读不到 → 先 o+rX 对齐,不改变内容面)
    execFileSync("chmod", ["-R", "o+rX", r2.result.sandboxSpec.workspaceDir], { timeout: 30_000 });
    const g2 = await orchestrateGate(
      t.db,
      {
        taskId: t2,
        attempt: 1,
        coderRunId: r2.result.runId,
        workspaceDir: r2.result.sandboxSpec.workspaceDir,
        actor: "test-d08",
      },
      {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: dockerCheckRunner(),
        evidenceChecks: sampleChecks,
        reviewRun: reviewerStub("PASS", r2.goalId),
        reviewAttempts: 1,
      },
    );
    expect(g2.status, `gate.reason=${g2.reason}`).toBe("ACCEPTED");
    const ev2 = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id=${t2}`);
    const kinds2 = ev2.rows.map((r) => String(r["kind"]));
    expect(kinds2).toContain("deterministic_test"); // 真实执行(非 stub)留档
    for (const r of ev2.rows) expect(r["passed"]).toBe(true);

    // 场景 3:检查失败(真实 docker 执行器发现候选不含 relay-smoke.txt)⇒ 保守阻断,不进 Reviewer
    const t3 = "t-d08-gate-fail";
    const r3 = await coderRun(t3, "result.txt:sum=87");
    expect(r3.result.outcome).toBe("SUCCEEDED");
    const g3 = await orchestrateGate(
      t.db,
      {
        taskId: t3,
        attempt: 1,
        coderRunId: r3.result.runId,
        workspaceDir: r3.result.sandboxSpec.workspaceDir,
        actor: "test-d08",
      },
      {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: dockerCheckRunner(),
        evidenceChecks: sampleChecks,
        reviewRun: reviewerStub("PASS", r3.goalId),
        reviewAttempts: 1,
      },
    );
    expect(g3.status, `gate.reason=${g3.reason}`).toBe("NEEDS_DECISION");
    expect(g3.reason).toBe("evidence_failed:deterministic_test");
    const verdicts3 = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${t3}`);
    expect(Number(verdicts3.rows[0]!["n"])).toBe(0); // 无放行裁决
  });
});
