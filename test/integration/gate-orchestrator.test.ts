// P0-02A C-2/C-6:Gate 编排全链(stub 真实进程;合同三、条款 1/4 + C-2 上下文隔离)。
// 链路:coder Run(stub)→ 变更集 → 编排(验证租约→证据→Reviewer Run(stub)→绑定记录→消费)。
// 反例:Coder 自宣 PASS 围栏(fictitious)不进入裁决 —— Reviewer 独立 run 身份是唯一 PASS 来源;
// Reviewer BLOCK ⇒ NEEDS_DECISION(不自动 ACCEPTED);Review 失败有界 ⇒ NEEDS_DECISION(不烧模型)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { planGoal } from "../../src/core/goals.ts";
import { ensureLedgerRow, ledgerSnapshot } from "../../src/core/budget.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { runReviewerSession } from "../../src/runtime/reviewer.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("Gate 编排全链(stub;Reviewer 独立 + DONE≠PASS + BLOCK 不自动 ACCEPTED)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("c6-orchestrator");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  /** 建目标+账本+任务,coder Run(stub)至 VERIFYING;返回编排输入。 */
  async function coderRun(taskId: string, stubMode: string) {
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
    assertOk(c);
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
      envOverride: { STUB_MODE: stubMode, STUB_WRITE_FILE: "result.txt:sum=87" },
    });
    sandboxes.push(result.sandboxSpec);
    return { claim: c, result, goalId };
  }

  /** Reviewer stub 注入(独立 Run/沙箱;role=reviewer 行由 runReviewerSession 落库)。 */
  function reviewerStub(verdict: string | null, goalId?: string, workspaceOverride?: string): (input: ReviewRunInput) => Promise<ReviewRunResult> {
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
        // Reviewer 与 Coder 同一 goal 账本(机器预算统一;预留 2/Run)
        ...(goalId ? { budget: { goalId, reserveCallsPerRun: 2 } } : {}),
        // Reviewer 检查 Coder 候选工作区(独立 Run/上下文,共享候选面)
        ...(workspaceOverride ? { workspaceDirOverride: workspaceOverride } : {}),
        heartbeatFn: input.heartbeat,
        argvOverride: [process.execPath, STUB],
        envOverride:
          verdict === null
            ? { STUB_MODE: "garbage-review" }
            : { STUB_MODE: "verdict", STUB_VERDICT: verdict, STUB_FINDINGS: `stub ${verdict}` },
      });
      if (r.sandboxSpec) sandboxes.push(r.sandboxSpec);
      return r;
    };
  }

  it("全链 PASS:coder(stub)→ 证据(真实检查)→ Reviewer(stub PASS)→ ACCEPTED;Reviewer 与 Coder 为不同 Run", { timeout: 60_000 }, async () => {
    const taskId = "t-orch-pass";
    const { result, goalId } = await coderRun(taskId, "ok");
    // coder stub 不写文件 —— 让 Reviewer 检查的确定性检查走"文件存在性"路径:
    // 直接用 runner 工作区里的 .relay(排除)外无文件 ⇒ 检查改为 node -e 恒真 + 输出断言
    expect(result.outcome).toBe("SUCCEEDED");
    const stBefore = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(stBefore.rows[0]!["state"])).toBe("VERIFYING");
    // stub 已写真实文件副作用(coder 的候选内容)—— 证据检查对象是它
    expect(existsSync(join(result.sandboxSpec.workspaceDir, "result.txt"))).toBe(true);

    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir, actor: "test-orch" },
      {
        evidenceChecks: [
          // 真实确定性检查:候选文件内容核验(Worker 侧执行,非模型判定)
          { kind: "deterministic_test", command: ["node", "-e", "const fs=require('fs');const t=fs.readFileSync('result.txt','utf8');if(!t.includes('87'))process.exit(1);console.log('result ok: sum present')"], cwdWorkspace: true },
        ],
        reviewRun: reviewerStub("PASS", goalId, result.sandboxSpec.workspaceDir),
        reviewAttempts: 2,
      },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("ACCEPTED");
    expect(gate.evidenceIds.length).toBeGreaterThanOrEqual(2); // 确定性检查 + reviewer_output
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("ACCEPTED");
    // 独立性事实:裁决绑定的 reviewer_run 与 coder run 不同且 role=reviewer
    const gv = await t.db.execute(sql`
      SELECT v.reviewer_run_id, v.coder_run_id, r.detail->>'role' AS role
      FROM task_gate_verdicts v
      LEFT JOIN runs r ON r.id = v.reviewer_run_id
      WHERE v.task_id=${taskId} AND v.verdict='PASS'
    `);
    const row = gv.rows[0]!;
    expect(String(row["reviewer_run_id"])).not.toBe(result.runId);
    expect(String(row["coder_run_id"])).toBe(result.runId);
    expect(String(row["role"])).toBe("reviewer");
    // 预算:coder+reviewer 都经账本预留/核算
    const snap = (await ledgerSnapshot(t.db, "goal", goalId)).find((x) => x.kind === "model_calls")!;
    expect(snap.used).toBe(2); // coder 1 + reviewer 1(同账本核算)
    expect(snap.reserved).toBe(0);
    // 工作区存在性哨兵(排除误用)
    expect(existsSync(result.sandboxSpec.workspaceDir)).toBe(true);
  });

  it("REWORK 流:Reviewer REWORK ⇒ VERIFYING→REWORK→READY(带退避);旧 PASS 不残留", { timeout: 60_000 }, async () => {
    const taskId = "t-orch-rework";
    const { result } = await coderRun(taskId, "ok");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir },
      { reviewRun: reviewerStub("REWORK"), reviewAttempts: 1 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("REWORK");
    const st = await t.db.execute(sql`SELECT state, retry_not_before IS NOT NULL AS backed FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("READY");
    expect(st.rows[0]!["backed"]).toBe(true);
    const passes = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_gate_verdicts WHERE task_id=${taskId} AND verdict='PASS'`);
    expect(Number(passes.rows[0]!["n"])).toBe(0);
  });

  it("BLOCK 流:Reviewer BLOCK ⇒ NEEDS_DECISION + D3 决策行;绝不自动 ACCEPTED", { timeout: 60_000 }, async () => {
    const taskId = "t-orch-block";
    const { result } = await coderRun(taskId, "ok");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir },
      { reviewRun: reviewerStub("BLOCK"), reviewAttempts: 1 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    const dec = await t.db.execute(sql`SELECT level, state FROM decisions WHERE task_id=${taskId}`);
    expect(String(dec.rows[0]!["level"])).toBe("D3");
    expect(String(dec.rows[0]!["state"])).toBe("OPEN");
    // 租约已终止(离链不保留活跃租约)
    const lease = await t.db.execute(sql`SELECT lease_expires_at > now() AS live FROM leases WHERE task_id=${taskId}`);
    expect(lease.rows[0]!["live"]).toBe(false);
  });

  it("反例:Coder 自宣 PASS 围栏(fake-self-approve)不构成验收;Review 无围栏有界失败 ⇒ NEEDS_DECISION", { timeout: 90_000 }, async () => {
    const taskId = "t-orch-fakedone";
    const { result } = await coderRun(taskId, "fake-self-approve");
    expect(result.outcome).toBe("SUCCEEDED"); // coder 的 DONE 文本如实落库……
    expect(String(result.detail["handoff"] && (result.detail["handoff"] as { status?: string }).status)).toBe("done");
    // ……但 Gate 只认独立 Reviewer:无围栏 Review ×2(有界)⇒ 保守 NEEDS_DECISION
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir },
      { reviewRun: reviewerStub(null), reviewAttempts: 2 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // coder 的自宣围栏从未进入裁决表(无任何 PASS;reviewer_output 证据 passed=false)
    const verdicts = await t.db.execute(sql`SELECT verdict FROM task_gate_verdicts WHERE task_id=${taskId}`);
    expect(verdicts.rows.length).toBe(0);
    const ev = await t.db.execute(sql`SELECT passed FROM gate_evidence WHERE task_id=${taskId} AND kind='reviewer_output'`);
    expect(ev.rows.length).toBe(2); // 有界:恰好 2 次尝试
    for (const r of ev.rows) expect(r["passed"]).toBe(false);
  });

  it("Reviewer BLOCK 压过 Coder 自宣:fake-self-approve + Reviewer BLOCK ⇒ NEEDS_DECISION", { timeout: 60_000 }, async () => {
    const taskId = "t-orch-fakeblock";
    const { result } = await coderRun(taskId, "fake-self-approve");
    expect(result.outcome).toBe("SUCCEEDED");
    const gate = await orchestrateGate(
      t.db,
      { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir },
      { reviewRun: reviewerStub("BLOCK"), reviewAttempts: 1 },
    );
    expect(gate.status, `gate.reason=${gate.reason}`).toBe("NEEDS_DECISION");
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
  });
});
