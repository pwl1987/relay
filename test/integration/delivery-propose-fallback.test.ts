// P0-ACCEPT REVIEW R-1 处置:交付装配失败兜底的专属断言(此前零测试覆盖;
// 写者曾声称"由 A-4 首跑实锤触发"——复核证伪:该首跑实际走的是 TIMEOUT/DELIVERED 路径,
// 兜底分支未被真实触发。本测试以确定注入直接命中兜底分支,补齐覆盖)。
// 全链:coder(stub)→ Gate(stub PASS)→ delivery.propose 注入抛错
//   ⇒ 断言:tick 不冒泡 / propose.ok=false(reason 含 propose_failed)/ decisions 落 D3 OPEN /
//      audit 落 DELIVERY_PROPOSE_FAILED / task 保持 ACCEPTED 不回滚。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { goalLoopTick } from "../../src/core/goal-loop.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun } from "../../src/runtime/runner.ts";
import { runReviewerSession } from "../../src/runtime/reviewer.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import type { ReviewRunInput, ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import type { Exec } from "../../src/core/db.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";
import { verifyCandidateManifest } from "../../src/runtime/workspace-manifest.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("P0-ACCEPT R-1:propose 装配失败 ⇒ D3 兜底(不冒泡/不回滚 ACCEPTED)", { timeout: 120_000 }, () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("p0acc-propose-fallback");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("gate ACCEPTED 后 propose 抛错 ⇒ D3 落记 + 审计 + tick 正常返回 + ACCEPTED 不回滚", async () => {
    const goalId = "goal-propose-fb";
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "propose 兜底演练",
        budget: { modelCalls: 12 },
        tasks: [
          {
            id: "t-propose-fb",
            goalText: "生成",
            priority: 2,
            allowedScope: ["/workspace"],
            allowedCommands: ["echo"],
          },
        ],
      }),
    );
    const pi = resolveVendoredPi();
    const reviewRun = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
      const r = await runReviewerSession(t.db, pi, {
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
        ...(input.workspaceDir ? { workspaceDirOverride: input.workspaceDir } : {}),
        heartbeatFn: input.heartbeat,
        argvOverride: [process.execPath, STUB],
        envOverride: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "stub PASS" },
      });
      if (r.sandboxSpec) sandboxes.push(r.sandboxSpec);
      return r;
    };

    const report = await goalLoopTick(t.db, {
      workerId: "propose-fb-worker",
      ttlSeconds: 60,
      runTask: async (claim) => {
        const result = await executeRun(t.db, pi, {
          taskId: claim.taskId,
          goal: "生成 result.txt",
          allowedScope: ["/workspace"],
          allowedCommands: ["echo"],
          attempt: claim.attempt,
          ownerId: claim.ownerId,
          fencingToken: claim.fencingToken,
          model: MODEL,
          sandbox: "host-fallback",
          wallSeconds: 60,
          heartbeatSeconds: 2,
          budget: { goalId, reserveCallsPerRun: 4 },
          argvOverride: [process.execPath, STUB],
          envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: "result.txt:sum=87" },
        });
        sandboxes.push(result.sandboxSpec);
        return {
          outcome: result.outcome,
          taskId: claim.taskId,
          runId: result.runId,
          workspaceDir: result.sandboxSpec.workspaceDir,
        };
      },
      gate: {
        manifestVerify: async (spec) =>
          verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount),
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          {
            kind: "deterministic_test",
            command: ["node", "-e", "console.log('ok')"],
            cwdWorkspace: true,
            timeoutMs: 10_000,
          },
        ],
        reviewRun,
        reviewAttempts: 1,
        verifierId: "propose-fb-verifier",
        verificationTtlSeconds: 60,
        testEnv: { mode: "host-fallback", node: process.version, host: "vm80", image: "stub" },
      },
      delivery: {
        // 注入:装配抛错(模拟候选未捕获/IO 异常 —— 兜底分支的直接命中)
        propose: async () => {
          throw new Error("delivery_not_captured:R-1 测试注入");
        },
        io: async () => {
          throw new Error("unreachable:propose 已抛");
        },
      },
    });

    // 1) tick 不冒泡:正常返回
    expect(report.status).toBe("PROGRESSED");
    // 2) gate 真 ACCEPTED(前置成立)
    expect(report.gate?.status).toBe("ACCEPTED");
    // 3) 兜底:propose.ok=false 且 reason 含 propose_failed;execute skipped
    expect(report.delivery?.propose.ok).toBe(false);
    expect(report.delivery?.propose.reason ?? "").toContain("propose_failed");
    expect(report.delivery?.propose.reason ?? "").toContain("delivery_not_captured");
    expect(report.delivery?.execute).toEqual({ skipped: "propose_failed" });

    // 4) decisions 落 D3 OPEN 行(人工处置,永不自动批准)
    const dec = await t.db.execute(sql`
      SELECT level, state, question FROM decisions WHERE task_id='t-propose-fb' ORDER BY created_at DESC LIMIT 1
    `);
    expect(String(dec.rows[0]!["level"])).toBe("D3");
    expect(String(dec.rows[0]!["state"])).toBe("OPEN");
    expect(String(dec.rows[0]!["question"])).toContain("delivery_propose_failed");

    // 5) audit 落 DELIVERY_PROPOSE_FAILED
    const aud = await t.db.execute(sql`
      SELECT action, authority FROM audit_events WHERE action='DELIVERY_PROPOSE_FAILED' AND task_id='t-propose-fb'
    `);
    expect(aud.rows.length).toBe(1);
    expect(String(aud.rows[0]!["authority"])).toBe("WORKER");

    // 6) Gate 质量结论不回滚:task 仍 ACCEPTED
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id='t-propose-fb'`);
    expect(String(st.rows[0]!["state"])).toBe("ACCEPTED");
  });
});
