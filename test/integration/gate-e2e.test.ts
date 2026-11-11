// P0-02A 最终验收 E2E:真实模型 提交与独立验证 全闭环(无人工干预,机器预算自证)。
// 全链:planGoal(账本)→ ensureEgress(密钥隔离代理)+verify → GoalLoopTick
// → 容器内真实 Coder Run → 候选变更集 → 验证租约接管 → Worker 侧确定性证据
// → 独立 Reviewer Run(真实模型,容器,共享候选工作区,role=reviewer)
// → 绑定版 Gate 记录+消费 → ACCEPTED → goal COMPLETED。
// C-9:代理层 completions 计数 == coder+reviewer assistant 回合数(独立核验硬顶;
//      不一致 ⇒ 断言失败,不得宣称硬顶已证明)。预算:goal limit=8(coder 预留5+reviewer 预留3)。
// 门:provider 探测 + docker + sudo iptables + 显式模型门禁 RELAY_GATE_E2E=1(第四包遗留②:
// 基础设施门全开不等于授权跑真模型;缺一显式 skip,不假装)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { writeFileSync, existsSync, readFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { goalLoopTick } from "../../src/core/goal-loop.ts";
import type { ReviewRunInput } from "../../src/core/gate-orchestrator.ts";
import { ledgerSnapshot } from "../../src/core/budget.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { runReviewerSession } from "../../src/runtime/reviewer.ts";
import { cleanupSandbox, dockerAvailable, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  readEgressRequestCount,
  teardownEgress,
  type EgressStatus,
} from "../../src/runtime/egress.ts";
import { probeProvider, type ProviderConfig } from "../helpers/provider.ts";

function sudoIptablesAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const MODEL: ProviderConfig | null = await probeProvider();
const dockerOk = dockerAvailable();
const iptOk = sudoIptablesAvailable();

describe.skipIf(!MODEL || !dockerOk || !iptOk || process.env.RELAY_GATE_E2E !== "1")("P0-02A 验收:真实模型 提交+独立 Reviewer 全闭环(预算账本)", () => {
  let t: TestDb;
  let egress: EgressStatus | null = null;
  let keyFile: string;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("p02a-e2e");
    const model = MODEL!;
    // 密钥隔离模式(G-3):真实(本环境仍为假)key 只存宿主 0600 文件并只读挂载进代理;Run 容器只见占位
    keyFile = join(mkdtempSync(join(tmpdir(), "relay-fwd-key-")), "real-key");
    writeFileSync(keyFile, model.apiKey, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const s = await ensureEgress(model.baseUrl, { realKeyFile: keyFile });
    egress = await verifyEgressEffective(s);
    expect(egress.ok, `出口约束未生效: ${egress.reason}(合同停止条件)`).toBe(true);
    expect(egress.keyIsolation).toBe(true);
  }, 240_000);
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    teardownEgress();
    await t.cleanup();
  });

  it("自治闭环:Coder Run → 候选变更集 → 独立 Reviewer Run → 绑定 Gate → ACCEPTED → goal COMPLETED;completions 计数 == 回合数", { timeout: 900_000 }, async () => {
    const model = MODEL!;
    const goalId = "goal-e2e-a";
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "整理工作区中的数字并汇报",
        budget: { modelCalls: 8, tokensIn: 400_000, tokensOut: 100_000 },
        tasks: [
          { id: "t-gate-a", goalText: "计算任务", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] },
        ],
      }),
    );
    const countBefore = await readEgressRequestCount();
    expect(countBefore).not.toBeNull();

    const pi = resolveVendoredPi();
    const runTask = async (claim: { taskId: string; ownerId: string; fencingToken: number; attempt: number }) => {
      const trow = await t.db.execute(sql`SELECT allowed_commands FROM tasks WHERE id=${claim.taskId}`);
      const allowedCommands = (trow.rows[0]!["allowed_commands"] ?? []) as string[];
      const result = await executeRun(t.db, pi, {
        taskId: claim.taskId,
        allowedCommands,
        goal: "计算任务:工作区 brief.txt 中有三个数字。步骤:1) 用 relay_read 读取 brief.txt;2) 用 relay_exec 执行单条命令 `echo sum=<三数之和> > result.txt` 写入结果文件(只允许这一条命令,不要用 && / ; / 管道,不要追加 cat 校验,不要用 python3/ls);3) 输出 relay-handoff(status=done,summary 含三数之和)。请尽量少的回合完成。",
        allowedScope: ["/workspace"],
        attempt: claim.attempt,
        ownerId: claim.ownerId,
        fencingToken: claim.fencingToken,
        model,
        sandbox: "docker",
        wallSeconds: 240,
        heartbeatSeconds: 2,
        egress: egress!,
        budget: { goalId, reserveCallsPerRun: 4 }, // coder 4 回合(实测 3 回合收敛;提示收紧后)
        prepareWorkspace: (ws) => writeFileSync(join(ws, "brief.txt"), "numbers: 12 30 45\n", "utf8"),
      });
      sandboxes.push(result.sandboxSpec);
      return {
        outcome: result.outcome,
        reason: String(result.detail["reason"] ?? ""),
        taskId: claim.taskId,
        runId: result.runId,
        workspaceDir: result.sandboxSpec.workspaceDir,
      };
    };
    const reviewRun = async (input: ReviewRunInput) => {
      const r = await runReviewerSession(t.db, pi, {
        taskId: input.taskId,
        attempt: input.attempt,
        goalText: input.goalText,
        changeset: input.changeset,
        evidenceSummaries: input.evidenceSummaries,
        model,
        sandbox: "docker",
        egress: egress!,
        heartbeatSeconds: 5,
        wallSeconds: 240,
        budget: { goalId, reserveCallsPerRun: 4 }, // reviewer 与 coder 同一 goal 账本(4+4 ≤ 8;补验:reviewer 需读变更文件+至多 1 个上下文文件再裁决)
        heartbeatFn: input.heartbeat,
        // Reviewer 共享 Coder 候选工作区(独立 Run/上下文,同一候选面)
        ...(input.workspaceDir ? { workspaceDirOverride: input.workspaceDir } : {}),
      });
      if (r.sandboxSpec) sandboxes.push(r.sandboxSpec);
      return r;
    };

    const tick1 = await goalLoopTick(t.db, {
      workerId: "e2e-worker",
      ttlSeconds: 120,
      runTask,
      gate: {
        evidenceChecks: [
          // 确定性检查:候选文件内容核验(Worker 侧执行;退出码即 passed)
          { kind: "deterministic_test", command: ["node", "-e", "const fs=require('fs');const t=fs.readFileSync('result.txt','utf8');if(!t.includes('87'))process.exit(1);console.log('result ok: sum=87 present')"], cwdWorkspace: true, timeoutMs: 30_000 },
        ],
        reviewRun,
        reviewAttempts: 2,
        verifierId: "gate-orchestrator-e2e",
        verificationTtlSeconds: 120,
        testEnv: { mode: "docker", node: process.version, host: "vm80", image: "node:24-bookworm-slim" },
      },
    });
    expect(tick1.status).toBe("PROGRESSED");
    expect(tick1.tick!.claimed!.taskId).toBe("t-gate-a");
    expect(tick1.run!.outcome).toBe("SUCCEEDED");
    expect(tick1.gate, "Gate 编排应发生").toBeDefined();
    if (tick1.gate!.status !== "ACCEPTED") {
      // 失败诊断(E2E 可观测性;账本/run 明细直接落输出)
      const dbgLedger = await ledgerSnapshot(t.db, "goal", goalId);
      const dbgRuns = await t.db.execute(sql`SELECT id, outcome, detail->>'role' AS role, detail->>'reason' AS reason, detail->'budget' AS budget FROM runs WHERE task_id='t-gate-a' ORDER BY started_at`);
      console.log("[e2e-diag] ledger:", JSON.stringify(dbgLedger));
      console.log("[e2e-diag] runs:", JSON.stringify(dbgRuns.rows));
      const dbgEv = await t.db.execute(sql`SELECT kind, passed, raw_output FROM gate_evidence WHERE task_id='t-gate-a'`);
      for (const r of dbgEv.rows) console.log(`[e2e-diag] evidence[${r["kind"]}] passed=${r["passed"]} raw=${String(r["raw_output"]).slice(0, 600)}`);
      const dbgRev = await t.db.execute(sql`SELECT detail FROM runs WHERE task_id='t-gate-a' AND detail->>'role'='reviewer'`);
      for (const r of dbgRev.rows) {
        const d = r["detail"] as Record<string, unknown>;
        console.log(`[e2e-diag] reviewer-detail turns=${d["turns"]} rawLen=${d["rawLen"]} rawHead=${JSON.stringify(d["rawHead"])} recordTypes=${JSON.stringify(d["recordTypes"])} stderrTail=${JSON.stringify(d["stderrTail"])}`);
      }
    }
    expect(tick1.gate!.status, `gate.reason=${tick1.gate!.reason}`).toBe("ACCEPTED");

    // 任务终态 + 裁决绑定事实
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-gate-a'`);
    expect(String(st.rows[0]!["state"])).toBe("ACCEPTED");
    const gv = await t.db.execute(sql`
      SELECT v.reviewer_run_id, v.coder_run_id, v.attempt, v.candidate_sha, v.consumed_at IS NOT NULL AS consumed,
             rc.detail->>'role' AS reviewer_role
      FROM task_gate_verdicts v
      LEFT JOIN runs rc ON rc.id = v.reviewer_run_id
      WHERE v.task_id='t-gate-a' AND v.verdict='PASS'
    `);
    const g = gv.rows[0]!;
    expect(g["consumed"]).toBe(true);
    expect(String(g["reviewer_role"])).toBe("reviewer");
    expect(String(g["reviewer_run_id"])).not.toBe(String(g["coder_run_id"]));
    // 变更集:真实文件副作用入集
    const cs = await t.db.execute(sql`SELECT changed_files, candidate_sha FROM candidate_changesets WHERE task_id='t-gate-a' ORDER BY attempt DESC LIMIT 1`);
    const changed = cs.rows[0]!["changed_files"] as { added: string[] };
    expect(changed.added).toContain("result.txt");
    // 证据:确定性检查 + reviewer_output,均 passed 且绑定
    const ev = await t.db.execute(sql`SELECT kind, passed FROM gate_evidence WHERE task_id='t-gate-a'`);
    const kinds = ev.rows.map((r) => String(r["kind"]));
    expect(kinds).toContain("deterministic_test");
    expect(kinds).toContain("reviewer_output");
    for (const r of ev.rows) expect(r["passed"]).toBe(true);
    // 工作区真实副作用哨兵
    const ws = sandboxes.find((s) => existsSync(join(s.workspaceDir, "result.txt")))?.workspaceDir;
    expect(ws).toBeDefined();
    expect(readFileSync(join(ws!, "result.txt"), "utf8")).toContain("87");

    // tick1 的聚合已在 Gate 消费后把 goal 置 COMPLETED(全任务 ACCEPTED);
    // tick 2:无剩余工作 ⇒ IDLE(不烧模型)
    const goalRow = await t.db.execute(sql`SELECT state FROM goals WHERE id=${goalId}`);
    expect(String(goalRow.rows[0]!["state"])).toBe("COMPLETED");
    const tick2 = await goalLoopTick(t.db, { workerId: "e2e-worker", ttlSeconds: 120, runTask });
    expect(tick2.status).toBe("IDLE");

    // ---- 预算账本自证(狗粮;合同阶段 B ≤8)----
    const ledger = await ledgerSnapshot(t.db, "goal", goalId);
    const calls = ledger.find((x) => x.kind === "model_calls")!;
    expect(calls.used).toBeGreaterThanOrEqual(2);
    expect(calls.used).toBeLessThanOrEqual(8);
    expect(calls.reserved).toBe(0);

    // ---- C-9:回合计数 vs Provider 请求数独立核验 ----
    const countAfter = await readEgressRequestCount();
    expect(countAfter).not.toBeNull();
    const coderRuns = await t.db.execute(sql`SELECT detail FROM runs WHERE task_id='t-gate-a' AND (detail->>'role') IS NULL`);
    const reviewerRuns = await t.db.execute(sql`SELECT detail FROM runs WHERE task_id='t-gate-a' AND detail->>'role'='reviewer'`);
    const coderTurns = (coderRuns.rows[0]!["detail"] as { budget?: { actualCalls?: number } })?.budget?.actualCalls ?? 0;
    const reviewerTurns = reviewerRuns.rows.reduce((acc, r) => acc + Number((r["detail"] as { turns?: number })?.turns ?? 0), 0);
    const totalTurns = coderTurns + reviewerTurns;
    const completionsDelta = countAfter!.completions - countBefore!.completions;
    const requestsDelta = countAfter!.requests - countBefore!.requests;
    expect(completionsDelta, `completions=${completionsDelta} 应等于总回合数 turns=${totalTurns}(coder=${coderTurns}+reviewer=${reviewerTurns});不一致 ⇒ 硬顶宣称无效(C-9)`).toBe(totalTurns);
    expect(requestsDelta).toBeGreaterThanOrEqual(completionsDelta);
    console.log(`[C-9 核验] completions=${completionsDelta} == turns=${totalTurns}(coder=${coderTurns}, reviewer=${reviewerTurns});total requests=${requestsDelta};ledger used=${calls.used}/8`);

    // Gate 消费审计
    const audit = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action='GATE_CONSUMED' AND task_id='t-gate-a'`);
    expect(Number(audit.rows[0]!["n"])).toBe(1);
  });
});
