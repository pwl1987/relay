// RELAY-CONTROL-SAFETY-04 P0-B:交付阶段停止控制闭环(竞争故障注入;隔离 bare 仓库+桩 Executor,
// 零真实远端写入;零模型调用)。
// 反例(旧代码 p0-mvp/control-safety-04/evidence/counterexample.log):
//   B1 ACCEPTED 请求 abort 被拒(交付阶段零停止入口)/ B2 旗标已置 propose 后仍完成外部提交。
// 修复后语义:ACCEPTED 且交付未完成 ⇒ requestTaskAbort 可用(phase=delivery);
//   停止边界=goalLoopTick propose 前(既有防线)+ executeDelivery 入口 + executeIntent perform 前
//   三处确定性检查;外部动作已在途 ⇒ 回执如实 external_in_progress(不虚假 STOP_CONFIRMED);
//   已发生的外部提交不可撤销(如实告知);副作用未知 ⇒ 既有 NEEDS_RECONCILE。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import type { Exec } from "../../src/core/db.ts";
import { requestTaskAbort, deliveryStopPhase } from "../../src/core/ops.ts";
import {
  proposeDelivery,
  executeDelivery,
  type DeliveryIO,
  type DeliveryExecutionResult,
} from "../../src/core/delivery.ts";
import { reserveIntent, executeIntent, type IntentExecutor, type IntentRef } from "../../src/core/intents.ts";
import { makeWorkspaceRepo, makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { snapshotManifest } from "../../src/runtime/workspace-manifest.ts";
import { latestChangeset } from "../../src/core/changesets.ts";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb("delivery_stop");
});
afterAll(async () => {
  await t.cleanup();
});

/** 播种"已验收+候选绑定+已消费 PASS"的交付前置态(与交付链授权面一致)。 */
async function seedAcceptedDelivery(spec: { taskId: string }): Promise<{
  ws: ReturnType<typeof makeWorkspaceRepo>;
  remote: BareRemoteFixture;
  candidateSha: string;
  baseSha: string;
  manifest: ReturnType<typeof snapshotManifest>;
}> {
  const goalId = `g-${randomUUID().slice(0, 8)}`;
  const taskId = spec.taskId;
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const ws = makeWorkspaceRepo();
  ws.apply({ "delivered.txt": "candidate-content\n" });
  execFileSync("git", ["-C", ws.dir, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", ws.dir, "commit", "--quiet", "-m", "candidate"], { encoding: "utf8" });
  const candidateSha = execFileSync("git", ["-C", ws.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseSha = ws.baseCommitSha;
  const treeSha = execFileSync("git", ["-C", ws.dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();

  await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'stop cx goal', 'ACTIVE')`);
  await t.db.execute(sql`
    INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands, gate_required, attempt, max_attempts)
    VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]', '[]', true, 1, 3)`);
  await t.db.execute(sql`
    INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, sandbox, outcome)
    VALUES (${runId}, ${taskId}, 1, 'stub', 'stub/gm', ${baseSha}, '{}', 'host-fallback', 'SUCCEEDED')`);
  const csId = `cs-${randomUUID().slice(0, 8)}`;
  await t.db.execute(sql`
    INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha,
      changed_files, impact_scope, git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state)
    VALUES (${csId}, ${taskId}, ${runId}, 1, 'b', 'c', 'r',
      '{"modified":[],"added":[],"removed":[]}', '{"inScope":["delivered.txt"],"violations":[]}',
      ${baseSha}, ${treeSha}, ${candidateSha}, 'NONE')`);
  await t.db.execute(sql`
    INSERT INTO task_gate_verdicts (id, task_id, verdict, reviewer, attempt, candidate_sha, requirement_sha,
      test_env, reviewer_run_id, coder_run_id, evidence_ids, consumed_at)
    VALUES (${"gv-" + randomUUID().slice(0, 8)}, ${taskId}, 'PASS', 'cx', 1, 'c', 'r', '{}', 'rv', ${runId}, '[]', now())`);

  // 目标 bare 远端预置 base(候选未推送)
  const remote = makeBareRemote();
  execFileSync("git", ["-C", ws.dir, "push", "--quiet", remote.url, `${baseSha}:refs/heads/main`], {
    encoding: "utf8",
  });
  return { ws, remote, candidateSha, baseSha, manifest: snapshotManifest(ws.dir) };
}

function makeIo(fixed: {
  ws: ReturnType<typeof makeWorkspaceRepo>;
  remote: BareRemoteFixture;
  manifest: ReturnType<typeof snapshotManifest>;
}): DeliveryIO {
  return {
    executor: {
      // 与 createGitPushExecutor 同语义的最小真实执行器(真 git push 到隔离 bare 远端)
      check: async (intent: { target: string; branch: string | null }) => {
        const r = execFileSync("git", ["ls-remote", intent.target, intent.branch ?? "main"], {
          encoding: "utf8",
        }).trim();
        return r.split("\t")[0] ?? "";
      },
      perform: async (intent: IntentRef) => {
        execFileSync("git", ["-C", fixed.ws.dir, "push", "--quiet", intent.target, `main:${intent.branch ?? "main"}`], {
          encoding: "utf8",
        });
      },
    },
    verifyRemoteContent: async (commitSha: string) => {
      const r = await verifyRemoteCommitContent({
        target: fixed.remote.url,
        commitSha,
        manifest: fixed.manifest,
        scratchDir: mkdtempSync(join(tmpdir(), "stop-verify-")),
      });
      return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
    },
    manifest: fixed.manifest,
  };
}

async function proposeOk(spec: {
  taskId: string;
  remote: BareRemoteFixture;
  ws: ReturnType<typeof makeWorkspaceRepo>;
  expectedRemoteSha: string;
}) {
  const proposed = await proposeDelivery(t.db as unknown as Exec, {
    taskId: spec.taskId,
    attempt: 1,
    target: spec.remote.url,
    branch: "main",
    expectedRemoteSha: spec.expectedRemoteSha,
    policy: {
      allowedRepos: [spec.remote.url.toLowerCase()],
      allowedBranches: ["main"],
      allowedCapability: "github.push",
      allowedHosts: [],
    },
    credentialPresent: true,
    verifyCommitBinding: makeCommitBindingVerifier(() => spec.ws.dir),
    actor: "stop-test",
  });
  expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
  return proposed.ok ? proposed.proposal : null;
}

describe("P0-B B3:停止请求先于外部动作 ⇒ 阻止提交(零外部写入)", () => {
  it("executeDelivery 入口边界:旗标已置 ⇒ STOPPED、零 intent、零外部写入、proposal 保持 POLICY_APPROVED", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    const proposal = await proposeOk({
      taskId,
      remote: seeded.remote,
      ws: seeded.ws,
      expectedRemoteSha: seeded.remote.head(),
    });
    // 模拟"Proposal 创建后、Executor 写入前"收到停止请求
    const req1 = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(req1.ok).toBe(true);
    expect(req1.phase).toBe("delivery");
    expect(req1.controlState).toBe("not_started");

    const res = await executeDelivery(t.db, makeIo(seeded), proposal!.id, { actor: "stop-test" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.state).toBe("STOPPED");
    expect(res.reason).toBe("abort_requested_before_external");
    // 零外部写入:远端 HEAD 仍 = base
    expect(seeded.remote.head()).toBe(seeded.baseSha);
    // 零 intent(入口边界先于 reserveIntent)
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);
    // proposal 保持 POLICY_APPROVED(不与 FAILED[可重试]混淆;恢复仅人工处置)
    const prow = await t.db.execute(sql`SELECT state FROM action_proposals WHERE id = ${proposal!.id}`);
    expect(String(prow.rows[0]!["state"])).toBe("POLICY_APPROVED");
    // 审计:DELIVERY_STOPPED_BEFORE_EXTERNAL
    const audits = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id = ${taskId} AND action = 'DELIVERY_STOPPED_BEFORE_EXTERNAL'`,
    );
    expect(Number(audits.rows[0]!["n"])).toBe(1);
  });

  it("executeIntent perform 前边界:旗标在预留后到达 ⇒ intent FAILED、executor.perform 零调用、审计 EXECUTE_STOPPED_BEFORE_PERFORM", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const goalId = `g-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'intent stop', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]')`);
    await t.db.execute(sql`UPDATE tasks SET abort_requested_at = now() WHERE id = ${taskId}`);
    const reserved = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId,
        idempotencyKey: `stop-intent-${randomUUID().slice(0, 8)}`,
        capability: "github.push",
        target: "/tmp/irrelevant-target",
        branch: "main",
        expectedRemoteSha: null,
        payloadSha: null,
      }),
    );
    let performCalls = 0;
    const executor: IntentExecutor = {
      check: async () => "",
      perform: async () => {
        performCalls += 1;
      },
    };
    const r = await executeIntent(t.db as unknown as Exec, executor, reserved.id, { actor: "stop-test" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state).toBe("FAILED");
    expect(r.reason).toBe("abort_requested_before_perform");
    expect(performCalls).toBe(0);
    const audits = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id = ${taskId} AND action = 'EXECUTE_STOPPED_BEFORE_PERFORM'`,
    );
    expect(Number(audits.rows[0]!["n"])).toBe(1);
    const irow = await t.db.execute(sql`SELECT state FROM action_intents WHERE id = ${reserved.id}`);
    expect(String(irow.rows[0]!["state"])).toBe("FAILED");
  });
});

describe("P0-B B4:外部动作已在途 ⇒ 诚实回执,不虚假 STOP_CONFIRMED", () => {
  it("DELIVERING + intent EXECUTING 期间停止请求 ⇒ controlState=external_in_progress;执行完成真实 DELIVERED;无虚假确认审计", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    const proposal = await proposeOk({
      taskId,
      remote: seeded.remote,
      ws: seeded.ws,
      expectedRemoteSha: seeded.remote.head(),
    });
    // perform 阻塞桩:进入 EXECUTING 后挂起,等停止请求登记后放行
    let releasePerform: () => void = () => {};
    const performStarted = new Promise<void>((res) => {
      releasePerform = res;
    });
    const blockingIo: DeliveryIO = {
      ...makeIo(seeded),
      executor: {
        // 动态读真实远端头:前置核对=base(未漂移);后核对=候选(推送已完成)
        check: async (intent) =>
          execFileSync("git", ["ls-remote", intent.target, intent.branch ?? "main"], { encoding: "utf8" })
            .trim()
            .split("\t")[0] ?? "",
        perform: async (intent) => {
          await performStarted;
          execFileSync(
            "git",
            ["-C", seeded.ws.dir, "push", "--quiet", intent.target, `main:${intent.branch ?? "main"}`],
            {
              encoding: "utf8",
            },
          );
        },
      },
    };
    const execPromise = executeDelivery(t.db, blockingIo, proposal!.id, { actor: "stop-test" });
    // 等待 intent 进入 EXECUTING(changeset 已 DELIVERING)
    for (let i = 0; i < 100; i++) {
      const phase = await deliveryStopPhase(t.db as unknown as Exec, taskId);
      if (phase === "external_in_progress") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // B4:停止请求必须返回真实相位,禁止声称已停止
    const req = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(req.ok).toBe(true);
    expect(req.phase).toBe("delivery");
    expect(req.controlState).toBe("external_in_progress");
    // 放行 perform(外部写入发生)
    releasePerform();
    const res = await execPromise;
    // 真实结果:外部提交已完成且核对通过 ⇒ DELIVERED(不虚报"已停止")
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toBe("DELIVERED");
    expect(seeded.remote.head()).toBe(seeded.candidateSha);
    // 审计面:TASK_ABORT_REQUESTED(phase=delivery)存在;无任何为交付阶段虚构的 STOP_CONFIRMED
    const reqAudits = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED'`,
    );
    expect(Number(reqAudits.rows[0]!["n"])).toBe(1);
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
  });

  it("外部写入已发生(DELIVERED)后重复点击停止 ⇒ alreadyRequested + controlState=already_delivered + 不撤销不重做", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    const proposal = await proposeOk({
      taskId,
      remote: seeded.remote,
      ws: seeded.ws,
      expectedRemoteSha: seeded.remote.head(),
    });
    // 旗标先置(边界会拦)⇒ 直接以 CONSUMED+DELIVERED 态模拟"推送成功后重复点击"
    const res = await executeDelivery(t.db, makeIo(seeded), proposal!.id, { actor: "stop-test" });
    expect(res.ok).toBe(true);
    // 交付已完成 ⇒ 请求按真实相位如实回复(already_delivered;B2/B4:不撤销已发生的外部提交)
    const req = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(req.ok).toBe(true);
    expect(req.phase).toBe("delivery");
    expect(req.controlState).toBe("already_delivered");
    // 无停止对象 ⇒ 不置旗(旗标保持 NULL);C3 命令回执审计如实(actualResult=no_op,零状态变更)
    const flag = await t.db.execute(sql`SELECT abort_requested_at FROM tasks WHERE id = ${taskId}`);
    expect(flag.rows[0]!["abort_requested_at"]).toBeNull();
    const audits = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED' ORDER BY seq DESC LIMIT 1`);
    const detail = (audits.rows[0]!["detail"] ?? {}) as Record<string, unknown>;
    expect(detail["actualResult"]).toBe("no_op");
    expect(detail["controlState"]).toBe("already_delivered");
    expect(String(detail["note"])).toContain("不撤销已发生的外部提交");
    // B2:已发生的外部提交不可撤销 —— 远端保持 DELIVERED 事实
    expect(seeded.remote.head()).toBe(seeded.candidateSha);
  });
});

describe("P0-B B7:确定性竞争处理(版本/幂等/相位)", () => {
  it("旧版本停止请求被拒(state_version_mismatch);幂等重复请求 alreadyRequested 不重复生效", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    await proposeOk({ taskId, remote: seeded.remote, ws: seeded.ws, expectedRemoteSha: seeded.remote.head() });
    const stRow = await t.db.execute(sql`SELECT state_version FROM tasks WHERE id = ${taskId}`);
    const staleVersion = Number(stRow.rows[0]!["state_version"]) - 1;
    const rej = await requestTaskAbort(t.db as unknown as Exec, taskId, {
      actor: "owner",
      expectedStateVersion: staleVersion,
    });
    expect(rej.ok).toBe(false);
    expect(rej.reason).toBe("state_version_mismatch");
    const flag1 = await t.db.execute(sql`SELECT abort_requested_at FROM tasks WHERE id = ${taskId}`);
    expect(flag1.rows[0]!["abort_requested_at"]).toBeNull();
    // 首次请求 + 幂等重复
    const ok1 = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(ok1.ok).toBe(true);
    expect(ok1.phase).toBe("delivery");
    const ok2 = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(ok2.ok).toBe(true);
    expect(ok2.alreadyRequested).toBe(true);
    const audits = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED'`,
    );
    expect(Number(audits.rows[0]!["n"])).toBe(1); // 幂等:生效审计仅一次
  });

  it("无交付的 ACCEPTED 终态 abort 仍被拒(state_terminal;语义不混)", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const goalId = `g-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'plain accepted', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]')`);
    const rej = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(rej.ok).toBe(false);
    expect(rej.reason).toBe("state_terminal:ACCEPTED");
  });

  it("deliveryStopPhase 相位判别:none/not_started/external_in_progress/external_write_done/external_outcome_unknown/already_delivered", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const goalId = `g-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'phase probe', 'ACTIVE')`);
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope) VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]')`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("none");
    const runId = `run-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, sandbox, outcome)
      VALUES (${runId}, ${taskId}, 1, 'stub', 'stub/gm', 'x', '{}', 'host-fallback', 'SUCCEEDED')`);
    const csId = `cs-${randomUUID().slice(0, 8)}`;
    await t.db.execute(sql`
      INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha,
        changed_files, impact_scope, delivery_state)
      VALUES (${csId}, ${taskId}, ${runId}, 1, 'b', 'c', 'r', '{"modified":[],"added":[],"removed":[]}',
        '{"inScope":[],"violations":[]}', 'PROPOSED')`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("not_started");
    await t.db.execute(
      sql`UPDATE candidate_changesets SET delivery_state='DELIVERING', delivery_intent_id='i-x' WHERE id=${csId}`,
    );
    await t.db.execute(sql`
      INSERT INTO action_intents (id, task_id, idempotency_key, capability, target, state)
      VALUES ('i-x', ${taskId}, 'k-x', 'github.push', '/tmp/x', 'RESERVED')`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("not_started");
    await t.db.execute(sql`UPDATE action_intents SET state='EXECUTING' WHERE id='i-x'`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("external_in_progress");
    // Reviewer Major-1 回归:perform 完成回执未落(intent COMPLETED)≠ 未开始 ⇒ external_write_done
    await t.db.execute(sql`UPDATE action_intents SET state='COMPLETED' WHERE id='i-x'`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("external_write_done");
    // 执行失败/冲突:副作用是否发生不确定 ⇒ external_outcome_unknown(Reconcile 语义)
    await t.db.execute(sql`UPDATE action_intents SET state='FAILED' WHERE id='i-x'`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("external_outcome_unknown");
    await t.db.execute(sql`UPDATE action_intents SET state='CONFLICT' WHERE id='i-x'`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("external_outcome_unknown");
    await t.db.execute(sql`UPDATE candidate_changesets SET delivery_state='DELIVERED' WHERE id=${csId}`);
    expect(await deliveryStopPhase(t.db as unknown as Exec, taskId)).toBe("already_delivered");
  });
});

describe("P0-B Major-1 修复回归:perform 完成回执未落窗口 ⇒ 诚实回执,交付收尾不受阻断", () => {
  it("DELIVERING + intent COMPLETED 停止请求 ⇒ controlState=external_write_done + 零'尚未发生'虚假陈述 + 不置旗 + 重执行完成 DELIVERED", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    const proposal = await proposeOk({
      taskId,
      remote: seeded.remote,
      ws: seeded.ws,
      expectedRemoteSha: seeded.remote.head(),
    });
    // 构造真实窗口:外部提交已发生(push 完成)、intent COMPLETED、changeset 仍 DELIVERING
    execFileSync("git", ["-C", seeded.ws.dir, "push", "--quiet", seeded.remote.url, "main:main"], { encoding: "utf8" });
    await t.db.execute(sql`
      INSERT INTO action_intents (id, task_id, idempotency_key, capability, target, branch, state)
      VALUES ('i-m1', ${taskId}, 'k-m1', 'github.push', ${seeded.remote.url}, 'main', 'COMPLETED')`);
    await t.db.execute(
      sql`UPDATE candidate_changesets SET delivery_state='DELIVERING', delivery_intent_id='i-m1' WHERE task_id=${taskId}`,
    );
    const req = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(req.ok).toBe(true);
    expect(req.phase).toBe("delivery");
    expect(req.controlState).toBe("external_write_done");
    // 虚假陈述面:该窗口审计绝不声称"尚未发生外部写入"(Reviewer Major-1 反例)
    const audits = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED' ORDER BY seq DESC LIMIT 1`);
    const note = String(((audits.rows[0]!["detail"] ?? {}) as Record<string, unknown>)["note"] ?? "");
    expect(note).not.toContain("尚未发生外部写入");
    expect(note).toContain("外部提交已发生");
    // 旗标未置 ⇒ 交付收尾不被阻断:重执行经 CONSUMED 恢复路径核对补记 DELIVERED
    const flag = await t.db.execute(sql`SELECT abort_requested_at FROM tasks WHERE id = ${taskId}`);
    expect(flag.rows[0]!["abort_requested_at"]).toBeNull();
    await t.db.execute(sql`UPDATE action_proposals SET state='CONSUMED' WHERE id=${proposal!.id}`);
    const res = await executeDelivery(t.db, makeIo(seeded), proposal!.id, { actor: "stop-test" });
    expect(res.ok).toBe(true);
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
  });

  it("DELIVERING + intent FAILED 停止请求 ⇒ controlState=external_outcome_unknown + 置旗(阻止后续外部写入)+ 如实审计", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    await proposeOk({ taskId, remote: seeded.remote, ws: seeded.ws, expectedRemoteSha: seeded.remote.head() });
    await t.db.execute(sql`
      INSERT INTO action_intents (id, task_id, idempotency_key, capability, target, branch, state)
      VALUES ('i-m1b', ${taskId}, 'k-m1b', 'github.push', ${seeded.remote.url}, 'main', 'FAILED')`);
    await t.db.execute(
      sql`UPDATE candidate_changesets SET delivery_state='DELIVERING', delivery_intent_id='i-m1b' WHERE task_id=${taskId}`,
    );
    const req = await requestTaskAbort(t.db as unknown as Exec, taskId, { actor: "owner" });
    expect(req.ok).toBe(true);
    expect(req.controlState).toBe("external_outcome_unknown");
    const note = await t.db.execute(sql`
      SELECT detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED' ORDER BY seq DESC LIMIT 1`);
    const detail = (note.rows[0]!["detail"] ?? {}) as Record<string, unknown>;
    expect(String(detail["note"])).toContain("不能确定");
    const flag = await t.db.execute(sql`SELECT abort_requested_at FROM tasks WHERE id = ${taskId}`);
    expect(flag.rows[0]!["abort_requested_at"]).not.toBeNull();
    // 置旗 ⇒ 重执行被入口边界拦截(操作者明确要求停止后续外部写入)
    const res = await executeDelivery(
      t.db,
      makeIo(seeded),
      (
        await t.db.execute(
          sql`SELECT id FROM action_proposals WHERE task_id=${taskId} ORDER BY updated_at DESC LIMIT 1`,
        )
      ).rows[0]!["id"] as string,
      { actor: "stop-test" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe("STOPPED");
  });
});

describe("P0-B B8+防线:既有取消链不回退", () => {
  it("推送成功但回执丢失 ⇒ 既有恢复路径不受停止语义影响(CONSUMED+未标 DELIVERED ⇒ 核对补记)", async () => {
    const taskId = `t-stop-${randomUUID().slice(0, 8)}`;
    const seeded = await seedAcceptedDelivery({ taskId });
    const proposal = await proposeOk({
      taskId,
      remote: seeded.remote,
      ws: seeded.ws,
      expectedRemoteSha: seeded.remote.head(),
    });
    // 直接推送(模拟副作用已发生)+ intent COMPLETED,但 changeset 未标 DELIVERED(回执丢失窗口)
    execFileSync("git", ["-C", seeded.ws.dir, "push", "--quiet", seeded.remote.url, "main:main"], { encoding: "utf8" });
    await t.db.execute(sql`
      INSERT INTO action_intents (id, task_id, idempotency_key, capability, target, branch, state)
      VALUES ('i-recovered', ${taskId}, 'k-recovered', 'github.push', ${seeded.remote.url}, 'main', 'COMPLETED')`);
    await t.db.execute(
      sql`UPDATE candidate_changesets SET delivery_state='DELIVERING', delivery_intent_id='i-recovered' WHERE task_id=${taskId}`,
    );
    // 既有 CONSUMED 恢复路径:重新 executeDelivery ⇒ 核对后补 DELIVERED(零重复推送)
    await t.db.execute(sql`UPDATE action_proposals SET state='CONSUMED' WHERE id=${proposal!.id}`);
    const res: DeliveryExecutionResult = await executeDelivery(t.db, makeIo(seeded), proposal!.id, {
      actor: "stop-test",
    });
    expect(res.ok).toBe(true);
    expect(seeded.remote.commitCount()).toBe(2); // base + 候选(无重复提交)
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
  });
});

void rmSync; // 临时目录由测试生命周期管理(保留 import 供后续用例)
