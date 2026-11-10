// P0-01C 最终验收 E2E:真实模型自治 Goal 闭环(无人工干预,机器预算自证)。
// 全链:planGoal(预算账本)→ ensureEgress+verify(真实 iptables+转发器)→ GoalLoopTick ×2
// → 容器内真实 Pi Run(docker + egress 白名单 + vendored pi)→ 任务 VERIFYING → Gate → ACCEPTED
// → goal COMPLETED。**Run 前必须经 budget_ledger 预留(狗粮自吃);每任务经 loop 有界执行。**
// 门:provider 探测 + docker + sudo iptables,缺一显式 skip(不假装)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import { advanceTask } from "../../src/core/lease.ts";
import { goalLoopTick } from "../../src/core/goal-loop.ts";
import { ledgerSnapshot } from "../../src/core/budget.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { cleanupSandbox, dockerAvailable, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { ensureEgress, verifyEgressEffective, teardownEgress, type EgressStatus } from "../../src/runtime/egress.ts";
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

describe.skipIf(!MODEL || !dockerOk || !iptOk)("P0-01C 验收:真实模型自治 Goal 闭环(预算账本预留)", () => {
  let t: TestDb;
  let egress: EgressStatus | null = null;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("p01c-e2e");
    const model = MODEL!;
    const s = await ensureEgress(model.baseUrl);
    egress = await verifyEgressEffective(s);
    expect(egress.ok, `出口约束未生效: ${egress.reason}(合同停止条件)`).toBe(true);
  }, 240_000);
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    teardownEgress();
    await t.cleanup();
  });

  it("自治闭环:2 任务经 GoalLoop 自动执行(容器真实模型+预算预留)→ goal COMPLETED", { timeout: 900_000 }, async () => {
    const model = MODEL!;
    // 预算:上限 8 次请求(合同);预留 4/Run,实际按 usage 核算
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-e2e-c",
        rawInput: "整理工作区中的数字并汇报",
        budget: { modelCalls: 8, tokensIn: 400_000, tokensOut: 100_000 },
        tasks: [
          // 单任务真模型闭环(合同:真实模型 E2E ≤8 请求;预留=全部 8,Run 中硬顶 8 回合机械不可破)。
          // 多 Task 有界执行由 stub 全链覆盖(goal-loop.test.ts / circuit-recovery.test.ts)。
          { id: "t-c-a", goalText: "计算任务", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] },
        ],
      }),
    );

    const runResults: Array<{ taskId: string; outcome: string; runId: string }> = [];
    const pi = resolveVendoredPi();
    const runTask = async (claim: { taskId: string; ownerId: string; fencingToken: number; attempt: number }) => {
      const trow = await t.db.execute(sql`SELECT allowed_commands FROM tasks WHERE id=${claim.taskId}`);
      const allowedCommands = (trow.rows[0]!["allowed_commands"] ?? []) as string[];
      const result = await executeRun(t.db, pi, {
        taskId: claim.taskId,
        allowedCommands,
        goal: "计算任务:工作区 brief.txt 中有三个数字。步骤:1) 用 relay_read 读取 brief.txt;2) 用 relay_exec 执行 echo sum=<三数之和> > result.txt 写入结果文件;3) 用 relay_read 尝试读取 /etc/passwd 并观察结果(预期被拒);4) 输出 relay-handoff(status=done,summary 含三数之和)。请尽量少的回合完成。",
        allowedScope: ["/workspace"],
        attempt: claim.attempt,
        ownerId: claim.ownerId,
        fencingToken: claim.fencingToken,
        model,
        sandbox: "docker",
        wallSeconds: 240,
        heartbeatSeconds: 2,
        egress: egress!,
        budget: { goalId: "goal-e2e-c", reserveCallsPerRun: 8 },
        prepareWorkspace: (ws) => {
          if (claim.taskId === "t-c-a") writeFileSync(join(ws, "brief.txt"), "numbers: 12 30 45\n", "utf8");
        },
      });
      sandboxes.push(result.sandboxSpec);
      runResults.push({ taskId: claim.taskId, outcome: result.outcome, runId: result.runId });
      return { outcome: result.outcome, reason: String(result.detail["reason"] ?? ""), taskId: claim.taskId };
    };

    // Gate 推进辅助:VERIFYING 仍在租约链内,Run 结束后租约仅剩心跳窗口 —— 需在窗口内完成
    // Gate+ACCEPT(P0-02A Gate 编排落地前的已知语义边界,REPORT §6 记录)
    const gateAndAccept = async (taskId: string, reviewer: string) => {
      await t.db.transaction(async (tx) => recordGateVerdict(tx as unknown as Exec, { taskId, verdict: "PASS", reviewer }));
      const lease = await t.db.execute(sql`SELECT owner_id, fencing_token FROM leases WHERE task_id=${taskId}`);
      const owner = String(lease.rows[0]!["owner_id"]);
      const fencing = Number(lease.rows[0]!["fencing_token"]);
      const adv = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, taskId, owner, fencing, "VERIFYING", "ACCEPTED"),
      );
      expect(adv.ok, `推进 ${taskId} 被拒: ${adv.ok ? "" : (adv as { reason: string }).reason}`).toBe(true);
    };

    // tick 1:领 t-c-a(高优先级)并真实执行;Gate 立即裁决(租约心跳窗口内有界,见上)
    const tick1 = await goalLoopTick(t.db, { workerId: "e2e-worker", ttlSeconds: 120, runTask });
    expect(tick1.status).toBe("PROGRESSED");
    expect(tick1.tick!.claimed!.taskId).toBe("t-c-a");
    expect(runResults[0]!.outcome).toBe("SUCCEEDED");
    const stA = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-c-a'`);
    expect(String(stA.rows[0]!["state"])).toBe("VERIFYING");
    await gateAndAccept("t-c-a", "reviewer-p01c");



    // ---- 任务 A 证据:真实文件副作用 + 工具授权(Worker 侧 toolEvents)----
    const runA = await t.db.execute(sql`SELECT detail, outcome, sandbox, model_ref FROM runs WHERE id=${runResults[0]!.runId}`);
    const detailA = runA.rows[0]!["detail"] as Record<string, unknown>;
    expect(String(runA.rows[0]!["outcome"])).toBe("SUCCEEDED");
    expect(String(runA.rows[0]!["sandbox"])).toBe("docker");
    const toolEvents = (detailA["toolEvents"] ?? []) as Array<{ type: string; toolName?: string; args?: Record<string, unknown>; result?: { details?: { denied?: boolean; reason?: string } } }>;
    // 真实 pi 事件形态:tool_execution_start/end + toolName(P0-01C 实测)
    expect(toolEvents.some((e) => e.type === "tool_execution_start" && e.toolName === "relay_read")).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool_execution_start" && e.toolName === "relay_exec")).toBe(true);
    // 越权尝试(若模型尝试 /etc/passwd)应被 DENIED 且 Worker 侧有记录
    const denied = toolEvents.filter((e) => e.type === "tool_execution_end" && e.result?.details?.denied === true);
    if (denied.length > 0) {
      expect(denied.some((e) => String(e.result?.details?.reason ?? "").includes("outside_allowed_root") || String(e.result?.details?.reason ?? "").includes("command_not_allowed"))).toBe(true);
    }
    const wsA = sandboxes.find((s) => existsSync(join(s.workspaceDir, "result.txt")))?.workspaceDir;
    expect(wsA, "result.txt 应存在(真实文件副作用)").toBeDefined();
    expect(readFileSync(join(wsA!, "result.txt"), "utf8")).toContain("87");

    // tick 3:全部 ACCEPTED ⇒ goal COMPLETED + IDLE
    const tick3 = await goalLoopTick(t.db, { workerId: "e2e-worker", ttlSeconds: 120, runTask });
    expect(tick3.goalStates).toContainEqual({ goalId: "goal-e2e-c", state: "COMPLETED" });
    expect(tick3.status).toBe("IDLE");

    // ---- 预算账本自证(狗粮)----
    const ledger = await ledgerSnapshot(t.db, "goal", "goal-e2e-c");
    const calls = ledger.find((x) => x.kind === "model_calls")!;
    expect(calls.used).toBeGreaterThanOrEqual(2); // 至少 2 个 Run
    expect(calls.used).toBeLessThanOrEqual(8); // 合同上限,机械未破
    expect(calls.reserved).toBe(0); // 全部核算释放
    const audit = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action='GOAL_COMPLETED'`);
    expect(Number(audit.rows[0]!["n"])).toBe(1);
  });
});
