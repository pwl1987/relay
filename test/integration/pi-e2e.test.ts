// 真实 Pi RPC 端到端(合同验收:≥1 个真实 Run;两层隔离全开)。
// 前置门:provider 探测可用 + docker 可用,否则显式 skip(不假装)。
// 1) 容器内真实 Pi Run:允许操作成功(relay_read/relay_exec)、越权读取被拒(outside_allowed_root
//    审计留痕)、真实文件副作用(result.txt)、handoff 落库、任务推进 VERIFYING→Gate→ACCEPTED。
// 2) 真实断连故障注入:docker kill 运行中的 Pi 容器 → run=FAILED(rpc_disconnect)
//    → Supervisor 回收重领(fencing+1)→ context_rebuild 重跑成功。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask, advanceTask } from "../../src/core/lease.ts";
import { latestChangeset } from "../../src/core/changesets.ts";
import { acquireVerificationLease } from "../../src/core/verify-lease.ts";
import { collectCheckEvidence } from "../../src/core/evidence.ts";
import { recordGateVerdict } from "../../src/core/gates.ts";
import { seedReviewerRun } from "../setup/gate-helper.ts";
import { reclaimExpiredLeases, claimNextReady, reconcilePendingTasks } from "../../src/core/supervisor.ts";
import type { Exec } from "../../src/core/db.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun, latestSession, readToolAudit } from "../../src/runtime/runner.ts";
import { cleanupSandbox, dockerAvailable, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { probeProvider, type ProviderConfig } from "../helpers/provider.ts";
import { assertOk } from "../setup/assert.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";

const MODEL: ProviderConfig | null = await probeProvider();

function sudoIptablesAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!MODEL || !dockerAvailable() || !sudoIptablesAvailable())(
  "真实 Pi RPC E2E(容器+当前可用 Provider)",
  () => {
    let t: TestDb;
    let eg: import("../../src/runtime/egress.ts").EgressStatus | null = null;
    const sandboxes: SandboxSpec[] = [];
    beforeAll(async () => {
      t = await createTestDb("pi-e2e");
      // 自备出口约束(FAIL-CLOSED 自洽;不依赖其它文件留下的全局 egress 栈;ensure 幂等)
      const model = MODEL!;
      const { ensureEgress, verifyEgressEffective } = await import("../../src/runtime/egress.ts");
      const s = await ensureEgress(model.baseUrl);
      const v = await verifyEgressEffective(s);
      expect(v.ok, `出口约束未生效: ${v.reason}`).toBe(true);
      eg = v;
    });
    afterAll(async () => {
      for (const s of sandboxes) cleanupSandbox(s);
      const { teardownEgress } = await import("../../src/runtime/egress.ts");
      teardownEgress();
      await t.cleanup();
    });

    async function taskState(id: string): Promise<string> {
      const r = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${id}`);
      return String(r.rows[0]!["state"]);
    }

    it("端到端:真实模型读文件/越权被拒/写结果/handoff/推进与 Gate", { timeout: 420_000 }, async () => {
      const model = MODEL!;
      // P0-02B 修复留痕:P0-02A 起 relay_exec 默认全拒(白名单制),本任务须显式授权写手段
      // (与 gate-e2e 先例一致:echo 重定向;`>` 允许);否则模型只能读不能写,断言恒失败。
      await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope, allowed_commands)
      VALUES ('t-e2e', 'READY', 'e2e goal', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
      const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-e2e", "worker-e2e", 120));
      assertOk(c);

      const result = await executeRun(t.db, resolveVendoredPi(), {
        taskId: "t-e2e",
        goal: [
          "工作区内有 brief.txt(先用 relay_read 读取),其中记录了三个数字。",
          "请用 relay_exec 把三数之和写入工作区 result.txt(内容形如 sum=<数字>)。",
          "另外用 relay_read 尝试读取 /etc/passwd,观察结果;无论是否被拒绝都继续完成任务。",
        ].join(" "),
        allowedScope: ["/workspace"],
        // P0-02B 修复留痕:executeRun 的 exec 白名单来自 RunSpec(不读 DB);漏传 ⇒ 全拒(FAIL-CLOSED)
        allowedCommands: ["echo"],
        attempt: c.attempt,
        ownerId: c.ownerId,
        fencingToken: c.fencingToken,
        model,
        sandbox: "docker",
        egress: eg!,
        wallSeconds: 300,
        heartbeatSeconds: 2,
        prepareWorkspace: (ws) => writeFileSync(join(ws, "brief.txt"), "numbers: 12 30 45\n", "utf8"),
        extraInstructions: "只使用 relay_read 与 relay_exec 两个工具;不要请求其他能力。",
      });
      sandboxes.push(result.sandboxSpec);

      // run 行:真实 runtime 记录
      const run = await t.db.execute(
        sql`SELECT outcome, sandbox, model_ref, runtime FROM runs WHERE id=${result.runId}`,
      );
      expect(String(run.rows[0]!["outcome"])).toBe("SUCCEEDED");
      expect(String(run.rows[0]!["sandbox"])).toBe("docker");
      expect(String(run.rows[0]!["model_ref"])).toBe(`${model.provider}/${model.model}`);
      expect(String(run.rows[0]!["runtime"])).toBe("pi-rpc");

      // 工具授权断言(机器可读审计,非模型复述):
      const audit = readToolAudit(result.sandboxSpec);
      expect(audit.length).toBeGreaterThan(0);
      const denied = audit.filter((a) => a["denied"] === true);
      expect(denied.length).toBeGreaterThan(0); // 越权读取被拒
      expect(
        denied.some((a) => String(a["reason"] ?? "").startsWith("outside_allowed_root")),
        `应有 outside_allowed_root 拒绝记录,实际:${JSON.stringify(audit)}`,
      ).toBe(true);
      expect(audit.some((a) => a["tool"] === "relay_read" && a["denied"] === false)).toBe(true); // 允许的读取成功
      expect(audit.some((a) => a["tool"] === "relay_exec")).toBe(true); // 命令执行经授权工具

      // 真实文件副作用:result.txt 存在且内容为数字和(12+30+45=87)
      const resultPath = join(result.sandboxSpec.workspaceDir, "result.txt");
      expect(existsSync(resultPath), "result.txt 应存在(真实文件副作用)").toBe(true);
      expect(readFileSync(resultPath, "utf8")).toContain("87");

      // handoff + 任务推进 + Gate(Run 成功 != ACCEPTED;P0-02A:验证租约接管 + 绑定版 PASS)
      expect(result.handoff.found).toBe(true);
      expect(await taskState("t-e2e")).toBe("VERIFYING");
      const vl = await t.db.transaction(async (tx) =>
        acquireVerificationLease(tx as unknown as Exec, "t-e2e", "verifier-e2e", 60),
      );
      if (!vl.ok) throw new Error(`verify lease rejected: ${vl.reason}`);
      const csE2e = await latestChangeset(t.db as unknown as Exec, "t-e2e");
      expect(csE2e, "Run 成功应有候选变更集").not.toBeNull();
      // 真实确定性检查证据:工作区 result.txt 含 87(Worker 侧执行,绑定 attempt+候选 SHA)
      const evCheck = await collectCheckEvidence(
        t.db as unknown as Exec,
        {
          kind: "deterministic_test",
          command: [
            "node",
            "-e",
            `const fs=require('fs');const t=fs.readFileSync('result.txt','utf8');if(!t.includes('87'))process.exit(1);console.log('result ok')`,
          ],
          cwdWorkspace: true,
          taskId: "t-e2e",
          attempt: c.attempt,
          candidateSha: csE2e!.candidateSha,
          producedBy: "verifier-e2e",
        },
        result.sandboxSpec.workspaceDir,
        hostTestCheckRunner,
      );
      expect(evCheck.passed).toBe(true);
      const rvRun = await seedReviewerRun(t.db, { taskId: "t-e2e", attempt: c.attempt });
      const gateRec = await t.db.transaction(async (tx) =>
        recordGateVerdict(tx as unknown as Exec, {
          taskId: "t-e2e",
          verdict: "PASS",
          reviewer: "verifier-e2e",
          attempt: c.attempt,
          candidateSha: csE2e!.candidateSha,
          requirementSha: csE2e!.requirementSha,
          testEnv: { mode: "docker", node: process.version, host: "vm80" },
          reviewerRunId: rvRun,
          coderRunId: result.runId,
          evidenceIds: [evCheck.id],
        }),
      );
      expect(gateRec.ok).toBe(true);
      const adv = await t.db.transaction(async (tx) =>
        advanceTask(tx as unknown as Exec, "t-e2e", vl.ownerId, vl.fencingToken, "VERIFYING", "ACCEPTED"),
      );
      expect(adv.ok).toBe(true);
    });

    it("真实断连恢复:docker kill → rpc_disconnect → 回收重领 → context_rebuild", { timeout: 420_000 }, async () => {
      const model = MODEL!;
      await t.db.execute(sql`
      INSERT INTO tasks (id, state, goal_id, allowed_scope)
      VALUES ('t-e2e-rec', 'READY', 'recovery goal', '["/workspace"]'::jsonb)
    `);
      const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-e2e-rec", "worker-r1", 120));
      assertOk(c);

      // 真实断连注入:第一条协议记录到达即 kill 运行中的 relay-run-* 容器
      let killed = false;
      const result1 = await executeRun(t.db, resolveVendoredPi(), {
        taskId: "t-e2e-rec",
        goal: "用一句话描述你看到的工作区。",
        allowedScope: ["/workspace"],
        attempt: c.attempt,
        ownerId: c.ownerId,
        fencingToken: c.fencingToken,
        model,
        sandbox: "docker",
        egress: eg!,
        wallSeconds: 300,
        heartbeatSeconds: 2,
        onRecord: () => {
          if (killed) return;
          killed = true;
          try {
            execFileSync(
              "bash",
              ["-c", "sleep 1; docker ps --format '{{.Names}}' | grep '^relay-run-' | xargs -r docker kill"],
              { timeout: 20_000 },
            );
          } catch {
            /* 容器枚举竞态由进程退出路径兜底 */
          }
        },
      });
      sandboxes.push(result1.sandboxSpec);
      expect(result1.outcome).toBe("FAILED");
      expect(result1.detail["reason"]).toBe("rpc_disconnect");
      // 任务留在 RUNNING(租约仍活),不虚构失败推进
      expect(await taskState("t-e2e-rec")).toBe("RUNNING");

      // Supervisor 路径:TTL 过期 → 回收 → Reconcile(无意图→READY)→ 重领(fencing+1)
      await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s' WHERE task_id='t-e2e-rec'`);
      const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec));
      expect(reclaimed.map((r) => r.taskId)).toContain("t-e2e-rec");
      await reconcilePendingTasks(t.db, {
        check: async () => {
          throw new Error("无 EXECUTING 意图,不应被调用");
        },
        perform: async () => {
          throw new Error("同上");
        },
      });
      const claimB = await t.db.transaction(async (tx) => claimNextReady(tx as unknown as Exec, "worker-r2", 120));
      if (!claimB.ok) throw new Error(`claimNextReady 被拒: ${claimB.reason}`);
      expect(claimB.fencingToken).toBe(c.fencingToken + 1);

      // context_rebuild:上一 session 属于断连 Run(无 handoff —— 真实断连如实无结果)
      const prior = await latestSession(t.db, "t-e2e-rec");
      expect(prior!.runId).toBe(result1.runId);
      const result2 = await executeRun(t.db, resolveVendoredPi(), {
        taskId: "t-e2e-rec",
        goal: "用一句话描述你看到的工作区,完成后输出 handoff。",
        allowedScope: ["/workspace"],
        attempt: claimB.attempt,
        ownerId: claimB.ownerId,
        fencingToken: claimB.fencingToken,
        model,
        sandbox: "docker",
        egress: eg!,
        wallSeconds: 300,
        heartbeatSeconds: 2,
        priorHandoff: { runId: prior!.runId, handoff: prior!.handoff },
      });
      sandboxes.push(result2.sandboxSpec);
      expect(result2.outcome).toBe("SUCCEEDED");
      expect(result2.handoff.found).toBe(true);
      expect(await taskState("t-e2e-rec")).toBe("VERIFYING");

      const sess2 = await t.db.execute(
        sql`SELECT resume_mode, handoff_ref FROM sessions WHERE run_id=${result2.runId}`,
      );
      expect(String(sess2.rows[0]!["resume_mode"])).toBe("context_rebuild");
      expect((sess2.rows[0]!["handoff_ref"] as Record<string, unknown>)["priorRunId"]).toBe(result1.runId);
    });
  },
);
