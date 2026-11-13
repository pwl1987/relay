// P0-02B 交付链(bare Git 先行,真实 PG;零模型零外网)。
// 链路:Gate PASS(已消费)→ Proposal(D-4)→ Policy(D-5)→ Intent 两阶段(D-6)→
//       Scoped Executor(D-7)→ 远端核对 DELIVERED(D-8)→ 幂等(D-9)→ Reconcile(D-10)。
// 反例 1/2/3/4/5/8/9 在此逐条专属断言;反例 6(绑定重核)在 git-candidate 与本文件;
// 反例 7(Reviewer 只读挂载)在 reviewer-readonly.test.ts。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, seedTask, type TestDb } from "../setup/testdb.ts";
import type { Exec } from "../../src/core/db.ts";
import {
  recordChangeset,
  bindCandidateCommit,
  latestChangeset,
  type WorkspaceManifest,
} from "../../src/core/changesets.ts";
import { recordBoundGate } from "../setup/gate-helper.ts";
import {
  proposeDelivery,
  executeDelivery,
  reconcileDelivery,
  deliveryIdempotencyKey,
  type DeliveryIO,
} from "../../src/core/delivery.ts";
import { reserveIntent } from "../../src/core/intents.ts";
import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicyConfig } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import {
  createCandidateCommit,
  makeCommitBindingVerifier,
  verifyRemoteCommitContent,
} from "../../src/runtime/git-candidate.ts";
import type { SandboxSpec } from "../../src/runtime/sandbox.ts";
import { manifestOf, makeWorkspaceRepo, makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";

const roots: string[] = [];
function tmpRoot(prefix: string): string {
  const d = markTemp(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(d);
  return d;
}
afterAll(async () => {
  for (const r of roots) safeRm(r, { roots, sentinel: RUN_SENTINEL });
});

describe("P0-02B 交付链(bare Git + 真 PG)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("p02b-delivery");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  const policyFor = (remote: BareRemoteFixture): DeliveryPolicyConfig => ({
    ...DEFAULT_DELIVERY_POLICY,
    allowedRepos: [remote.url.toLowerCase()],
  });

  /** 直接播种交付前置态:task ACCEPTED + 已消费绑定 PASS + 变更集(含候选 commit 绑定)+ 预置远端。 */
  async function seedDeliveryReady(spec: { taskId: string; consumedPass?: boolean; acceptTask?: boolean }) {
    const acceptTask = spec.acceptTask ?? true;
    const consumedPass = spec.consumedPass ?? true;
    await seedTask(t.db, { id: spec.taskId, gateRequired: true, allowedScope: ["/workspace"] });
    if (acceptTask) {
      await t.db.execute(sql`UPDATE tasks SET state = 'ACCEPTED' WHERE id = ${spec.taskId}`);
    }
    // 变更集外键前提:coder run 行(SUCCEEDED;候选只属于成功 Run)
    // input_commit_sha = Run 前基线 commit(P0-02B F-5:候选 base 必须与之一致)
    const ws = makeWorkspaceRepo(tmpRoot("relay-dl-ws-"));
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, sandbox, outcome)
      VALUES (${`run-c-${spec.taskId}`}, ${spec.taskId}, 1, 'stub', 'stub/coder',
        ${ws.baseCommitSha}, 'host-fallback', 'SUCCEEDED')
    `);
    ws.apply({ "delivered.txt": `payload for ${spec.taskId}\n` });
    const candidateManifest: WorkspaceManifest = manifestOf(ws.dir, ["README.md", "src.txt", "delivered.txt"]);
    const cs = await t.db.transaction(async (tx) =>
      recordChangeset(tx as unknown as Exec, {
        taskId: spec.taskId,
        runId: `run-c-${spec.taskId}`,
        attempt: 1,
        base: manifestOf(ws.dir, ["README.md", "src.txt"]),
        candidate: candidateManifest,
        requirement: {
          goalText: `deliver ${spec.taskId}`,
          taskId: spec.taskId,
          allowedScope: ["/workspace"],
          allowedCommands: [],
        },
      }),
    );
    // 远端预置:base commit 已在 main(真实仓库已有基线;expected = base)
    const remote = makeBareRemote(tmpRoot("relay-dl-remote-"));
    remote.pushHead(ws.dir, ws.baseCommitSha);
    // 候选 commit 构建 + 绑定(D-2)
    const staged = await createCandidateCommit({
      workspaceDir: ws.dir,
      baseCommitSha: ws.baseCommitSha,
      candidateManifest,
      diff: { added: ["delivered.txt"], modified: [], removed: [] },
      taskId: spec.taskId,
      attempt: 1,
      changesetId: cs.id,
      stagingDir: tmpRoot("relay-dl-stage-"),
    });
    const bound = await t.db.transaction(async (tx) =>
      bindCandidateCommit(tx as unknown as Exec, {
        changesetId: cs.id,
        taskId: spec.taskId,
        attempt: 1,
        baseCommitSha: staged.baseCommitSha,
        treeSha: staged.treeSha,
        commitSha: staged.commitSha,
        stageRepoDir: staged.stageRepoDir,
      }),
    );
    expect(bound.ok).toBe(true);
    // 已消费的绑定版 PASS(授权基础;直接播种消费事实,消费语义由 gate-binding 测试承载)
    if (consumedPass) {
      const gate = await recordBoundGate(t.db, {
        taskId: spec.taskId,
        verdict: "PASS",
        attempt: 1,
        candidateSha: cs.candidateSha,
        requirementSha: cs.requirementSha,
        coderRunId: `run-c-${spec.taskId}`,
      });
      if (!gate.ok) throw new Error(`gate seed failed: ${gate.reason}`);
      await t.db.execute(
        sql`UPDATE task_gate_verdicts SET consumed_at = now(), consumed_by = 'test-seed' WHERE id = ${gate.id}`,
      );
    }
    return { ws, remote, candidateManifest, changeset: cs, staged };
  }

  function deliveryIO(
    staged: { stageRepoDir: string },
    remote: BareRemoteFixture,
    manifest: WorkspaceManifest,
  ): DeliveryIO {
    return {
      executor: createGitHubPushExecutor({ sourceRepo: staged.stageRepoDir, credentialFile: null }),
      verifyRemoteContent: async (commitSha: string) => {
        try {
          const r = await verifyRemoteCommitContent({
            target: remote.url,
            commitSha,
            manifest,
            scratchDir: tmpRoot("relay-dl-verify-"),
          });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        } catch (err) {
          return { ok: false as const, mismatches: [`verify_failed:${(err as Error).message.slice(0, 120)}`] };
        }
      },
      manifest,
    };
  }

  async function propose(io0: {
    taskId: string;
    remote: BareRemoteFixture;
    staged: { stageRepoDir: string };
    policy?: DeliveryPolicyConfig;
    credentialPresent?: boolean;
  }) {
    return t.db.transaction(async (tx) =>
      proposeDelivery(tx as unknown as Exec, {
        taskId: io0.taskId,
        attempt: 1,
        target: io0.remote.url,
        branch: "main",
        expectedRemoteSha: io0.remote.head(),
        policy: io0.policy ?? policyFor(io0.remote),
        credentialPresent: io0.credentialPresent ?? true,
        verifyCommitBinding: makeCommitBindingVerifier(() => io0.staged.stageRepoDir),
        actor: "test-delivery",
      }),
    );
  }

  it("D-8 正链:Proposal→Intent→推送→远端核对 ⇒ DELIVERED;远端头==payload;审计齐备;三 SHA 区分", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-ok";
    const seeded = await seedDeliveryReady({ taskId });
    const proposed = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposal.state).toBe("POLICY_APPROVED");
    expect(proposed.proposal.gateVerdictId).toBeTruthy();

    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-delivery" });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.state).toBe("DELIVERED");
    expect(seeded.remote.head()).toBe(seeded.staged.commitSha);
    expect(done.remoteHead).toBe(seeded.staged.commitSha);
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
    const pRow = await t.db.execute(sql`SELECT state FROM action_proposals WHERE id = ${proposed.proposal.id}`);
    expect(String(pRow.rows[0]!["state"])).toBe("CONSUMED");
    const audits = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id = ${taskId} AND (action LIKE 'DELIVERY%' OR action LIKE 'PROPOSAL%' OR action = 'GIT_COMMIT_BOUND')`,
    );
    const actions = audits.rows.map((r) => String(r["action"]));
    expect(actions).toContain("DELIVERY_DELIVERED");
    expect(actions).toContain("GIT_COMMIT_BOUND");
    // D-1:三 SHA 两两不等(candidate_sha ≠ tree_sha ≠ commit_sha)
    expect(csRow?.gitCommitSha).not.toBe(csRow?.gitTreeSha);
    expect(csRow?.candidateSha).not.toBe(csRow?.gitTreeSha);
    expect(csRow?.candidateSha).not.toBe(csRow?.gitCommitSha);
  });

  it("反例1 未授权仓库写入必须拒绝:白名单外 target ⇒ repo_not_allowed,0 intent", { timeout: 60_000 }, async () => {
    const taskId = "t-dl-unauth";
    const seeded = await seedDeliveryReady({ taskId });
    const other = makeBareRemote(tmpRoot("relay-dl-remote2-"));
    const proposed = await t.db.transaction(async (tx) =>
      proposeDelivery(tx as unknown as Exec, {
        taskId,
        attempt: 1,
        target: other.url, // 白名单只含 seeded.remote
        branch: "main",
        expectedRemoteSha: other.head(),
        policy: policyFor(seeded.remote),
        credentialPresent: true,
        verifyCommitBinding: makeCommitBindingVerifier(() => seeded.staged.stageRepoDir),
      }),
    );
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.reason).toBe("repo_not_allowed");
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);
    const denied = await t.db.execute(sql`SELECT state FROM action_proposals WHERE task_id = ${taskId}`);
    expect(String(denied.rows[0]!["state"])).toBe("POLICY_DENIED");
  });

  it("反例2a Token 缺失 ⇒ credential_missing(0 intent);反例2b 远端 401 ⇒ intent FAILED,changeset 非 DELIVERED,远端未被触碰", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-noauth";
    const seeded = await seedDeliveryReady({ taskId });
    const proposed = await t.db.transaction(async (tx) =>
      proposeDelivery(tx as unknown as Exec, {
        taskId,
        attempt: 1,
        target: seeded.remote.url,
        branch: "main",
        expectedRemoteSha: seeded.remote.head(),
        policy: policyFor(seeded.remote),
        credentialPresent: false,
        verifyCommitBinding: makeCommitBindingVerifier(() => seeded.staged.stageRepoDir),
      }),
    );
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.reason).toBe("credential_missing");
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);

    // 2b) git 协议层鉴权失败(401;提示被 GIT_TERMINAL_PROMPT=0 阻断)⇒ executor 抛错 ⇒ 安全失败
    const taskId2 = "t-dl-401";
    const seeded2 = await seedDeliveryReady({ taskId: taskId2 });
    const srv: Server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="x"' });
      res.end("auth required");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const p2 = await propose({ taskId: taskId2, remote: seeded2.remote, staged: seeded2.staged });
      expect(p2.ok).toBe(true);
      if (!p2.ok) return;
      await t.db.execute(
        sql`UPDATE action_proposals SET target = ${`http://127.0.0.1:${port}/auth-fail.git`} WHERE id = ${p2.proposal.id}`,
      );
      const io = deliveryIO(seeded2.staged, seeded2.remote, seeded2.candidateManifest);
      const done = await executeDelivery(t.db, io, p2.proposal.id, { actor: "test-401" });
      expect(done.ok).toBe(false);
      if (done.ok) return;
      expect(done.state).toBe("FAILED");
      const csRow = await latestChangeset(t.db as unknown as Exec, taskId2);
      expect(csRow?.deliveryState).toBe("FAILED");
      expect(csRow?.deliveryState).not.toBe("DELIVERED");
      expect(seeded2.remote.head()).toBe(seeded2.ws.baseCommitSha);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("反例3 未经 Gate PASS 的候选不得推送:无已消费 PASS ⇒ no_gate_authorization;任务非 ACCEPTED ⇒ task_not_accepted", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-nogate";
    const seeded = await seedDeliveryReady({ taskId, consumedPass: false });
    const proposed = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.reason).toBe("no_gate_authorization");
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);

    const taskId2 = "t-dl-notacc";
    const seeded2 = await seedDeliveryReady({ taskId: taskId2, acceptTask: false });
    const proposed2 = await propose({ taskId: taskId2, remote: seeded2.remote, staged: seeded2.staged });
    expect(proposed2.ok).toBe(false);
    if (proposed2.ok) return;
    expect(proposed2.reason).toBe("task_not_accepted");
  });

  it("反例4 远端 HEAD 漂移必须拒绝:外部推进 main 后执行 ⇒ CONFLICT,无覆盖,D3 决策行", { timeout: 60_000 }, async () => {
    const taskId = "t-dl-drift";
    const seeded = await seedDeliveryReady({ taskId });
    const p = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // 另一位写者在远端推进 main(不经 Relay)
    const other = makeWorkspaceRepo(tmpRoot("relay-dl-other-"));
    other.apply({ "foreign.txt": "someone else's commit\n" });
    execFileSync("git", ["-C", other.dir, "remote", "add", "r", seeded.remote.url], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "fetch", "--quiet", "r"], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "reset", "--quiet", "--hard", seeded.remote.head()], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "add", "-A"], { encoding: "utf8" });
    execFileSync(
      "git",
      ["-C", other.dir, "-c", "user.email=f@l", "-c", "user.name=f", "commit", "--quiet", "-m", "foreign"],
      { encoding: "utf8" },
    );
    execFileSync("git", ["-C", other.dir, "push", "--quiet", "r", "HEAD:refs/heads/main"], { encoding: "utf8" });
    const foreignHead = seeded.remote.head();
    expect(foreignHead).not.toBe(seeded.ws.baseCommitSha);

    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    const done = await executeDelivery(t.db, io, p.proposal.id, { actor: "test-drift" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.state).toBe("CONFLICT");
    expect(seeded.remote.head()).toBe(foreignHead); // 拒绝覆盖:远端仍是外来提交
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("CONFLICT");
    const dec = await t.db.execute(
      sql`SELECT level, state FROM decisions WHERE task_id = ${taskId} AND state = 'OPEN'`,
    );
    expect(dec.rows.length).toBe(1);
    expect(String(dec.rows[0]!["level"])).toBe("D3");
    const intentState = await t.db.execute(sql`SELECT state FROM action_intents WHERE id = ${done.intentId}`);
    expect(String(intentState.rows[0]!["state"])).toBe("CONFLICT");
    // 任务保持 ACCEPTED(交付层失败不回滚 Gate 结论)
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("ACCEPTED");
  });

  it("反例5 push 成功但回执丢失:Reconcile 先查真实状态 ⇒ SIDE_EFFECT_CONFIRMED ⇒ DELIVERED,绝不重复推送", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-receipt";
    const seeded = await seedDeliveryReady({ taskId });
    const p = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    // 模拟崩溃窗口:reserve → EXECUTING → 副作用已发生(真实 push)→ 回执未写
    const key = deliveryIdempotencyKey(p.proposal);
    const reserved = await t.db.transaction(async (tx) =>
      reserveIntent(tx as unknown as Exec, {
        taskId,
        idempotencyKey: key,
        capability: "github.push",
        target: seeded.remote.url,
        branch: "main",
        expectedRemoteSha: seeded.ws.baseCommitSha,
        payloadSha: seeded.staged.commitSha,
      }),
    );
    await t.db.execute(sql`UPDATE action_intents SET state = 'EXECUTING' WHERE id = ${reserved.id}`);
    await io.executor.perform({
      id: reserved.id,
      taskId,
      capability: "github.push",
      target: seeded.remote.url,
      branch: "main",
      expectedRemoteSha: seeded.ws.baseCommitSha,
      payloadSha: seeded.staged.commitSha,
    });
    expect(seeded.remote.head()).toBe(seeded.staged.commitSha); // 副作用已在远端
    const countAfterPush = seeded.remote.commitCount();

    const rec = await reconcileDelivery(t.db, io, reserved.id, { actor: "test-reconcile" });
    expect(rec.decision).toBe("SIDE_EFFECT_CONFIRMED");
    expect(rec.state).toBe("DELIVERED");
    expect(seeded.remote.commitCount()).toBe(countAfterPush); // 绝不重复推送
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
    const intentState = await t.db.execute(sql`SELECT state FROM action_intents WHERE id = ${reserved.id}`);
    expect(String(intentState.rows[0]!["state"])).toBe("COMPLETED");
  });

  it("反例6 候选内容与实际 Git Commit 不一致 ⇒ 阻断(commit 绑定重核 tree_sha_drift;Proposal 拒绝)", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-tamper";
    const seeded = await seedDeliveryReady({ taskId });
    // 绑定记录漂移(内容承诺失真)⇒ Proposal 重核拒绝 ⇒ 必须重新验证
    await t.db.execute(sql`UPDATE candidate_changesets SET git_tree_sha = ${"f".repeat(40)} WHERE task_id = ${taskId}`);
    const proposed = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.reason).toBe("commit_binding_tree_sha_drift");
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);
  });

  it("反例8 重复触发交付请求:同 changeset 单 proposal;已 CONSUMED ⇒ no-op,单提交单 intent", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-idem";
    const seeded = await seedDeliveryReady({ taskId });
    const p1 = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    const p2 = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect(p2.proposal.id).toBe(p1.proposal.id); // UNIQUE(changeset_id) 幂等
    expect(p2.created).toBe(false);

    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    const d1 = await executeDelivery(t.db, io, p1.proposal.id);
    expect(d1.ok && d1.state === "DELIVERED").toBe(true);
    const countAfterFirst = seeded.remote.commitCount();
    const intentsAfterFirst = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`,
    );
    expect(Number(intentsAfterFirst.rows[0]!["n"])).toBe(1);

    const d2 = await executeDelivery(t.db, io, p1.proposal.id); // 重复触发:CONSUMED ⇒ 核对后 no-op
    expect(d2.ok && d2.state === "DELIVERED").toBe(true);
    expect(seeded.remote.commitCount()).toBe(countAfterFirst);
    const intentsAfterSecond = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`,
    );
    expect(Number(intentsAfterSecond.rows[0]!["n"])).toBe(1);

    // 记录面完整性:已 CONSUMED 的 proposal 重复 propose 不得翻转状态(幂等读回)
    const p3 = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p3.ok && p3.created === false).toBe(true);
    if (!p3.ok) return;
    expect(p3.proposal.id).toBe(p1.proposal.id);
    expect(p3.proposal.state).toBe("CONSUMED");
  });

  it("反例9 远端提交失败 ⇒ ChangeSet 不得标 DELIVERED(pre-receive 拒绝 ⇒ FAILED + 审计)", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-reject";
    const seeded = await seedDeliveryReady({ taskId });
    writeFileSync(join(seeded.remote.dir, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(join(seeded.remote.dir, "hooks", "pre-receive"), 0o755);
    const p = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    const done = await executeDelivery(t.db, io, p.proposal.id, { actor: "test-reject" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.state).toBe("FAILED");
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("FAILED");
    expect(csRow?.deliveryState).not.toBe("DELIVERED");
    expect(seeded.remote.head()).toBe(seeded.ws.baseCommitSha);
    const audits = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id = ${taskId} AND action = 'DELIVERY_FAILED'`,
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("写后内容核验抛错 ⇒ NEEDS_RECONCILE(不误标 DELIVERED);Reconcile 先查真实状态补 DELIVERED", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-verifythrow";
    const seeded = await seedDeliveryReady({ taskId });
    const p = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const io = deliveryIO(seeded.staged, seeded.remote, seeded.candidateManifest);
    // 注入核验实现抛错(模拟 push 成功后核验面瞬断)
    const throwing: DeliveryIO = {
      ...io,
      verifyRemoteContent: async () => {
        throw new Error("remote_fetch_failed: 模拟网络瞬断");
      },
    };
    const done = await executeDelivery(t.db, throwing, p.proposal.id, { actor: "test-throw" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.state).toBe("NEEDS_RECONCILE");
    // 远端副作用已发生(推送完成),但 changeset 绝不误标 DELIVERED
    expect(seeded.remote.head()).toBe(seeded.staged.commitSha);
    const csMid = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csMid?.deliveryState).not.toBe("DELIVERED");
    // 恢复:Reconcile 先查真实状态(intent 已 COMPLETED ⇒ already_completed 路径)⇒ 核对 ⇒ DELIVERED
    const rec = await reconcileDelivery(t.db, io, done.intentId!, { actor: "test-throw-reconcile" });
    expect(rec.state).toBe("DELIVERED");
    expect(seeded.remote.commitCount()).toBe(2); // base + 候选(无重复推送)
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
  });

  it("F-5 收敛反例:候选 base 与 runs.input_commit_sha 失配 ⇒ 提案拒绝 base_commit_mismatch(0 intent、不推送)", {
    timeout: 60_000,
  }, async () => {
    const taskId = "t-dl-basemismatch";
    const seeded = await seedDeliveryReady({ taskId });
    // 把 coder Run 的输入 commit 改成其它值(记录面失真)⇒ 候选 base 与之不一致
    await t.db.execute(sql`UPDATE runs SET input_commit_sha = ${"d".repeat(40)} WHERE task_id = ${taskId}`);
    const proposed = await propose({ taskId, remote: seeded.remote, staged: seeded.staged });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.reason).toBe("base_commit_mismatch");
    const intents = await t.db.execute(sql`SELECT count(*)::int AS n FROM action_intents WHERE task_id = ${taskId}`);
    expect(Number(intents.rows[0]!["n"])).toBe(0);
    // 远端零变化(未推送)
    expect(seeded.remote.head()).toBe(seeded.ws.baseCommitSha);
  });

  it("全链(goal-loop 接线):stub Run(git 工作区)→ 变更集+候选 commit → Reviewer PASS → ACCEPTED → 交付 DELIVERED → goal COMPLETED", {
    timeout: 120_000,
  }, async () => {
    const { planGoal } = await import("../../src/core/goals.ts");
    const { goalLoopTick } = await import("../../src/core/goal-loop.ts");
    const { executeRun } = await import("../../src/runtime/runner.ts");
    const { runReviewerSession } = await import("../../src/runtime/reviewer.ts");
    const { resolveVendoredPi } = await import("../../src/runtime/pi-version.ts");
    const { snapshotManifest } = await import("../../src/runtime/workspace-manifest.ts");
    const { cleanupSandbox } = await import("../../src/runtime/sandbox.ts");
    const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
    const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

    const goalId = "goal-dl-e2e";
    const taskId = "t-dl-e2e";
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "在工作区生成 delivered.txt 内容为 ok",
        budget: { modelCalls: 12 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const stageBase = tmpRoot("relay-dl-e2e-stage-");
    const remote = makeBareRemote(tmpRoot("relay-dl-e2e-remote-"));
    const sandboxes: SandboxSpec[] = [];
    // runTask 捕获交付事实(候选面/stage 仓库/期望头),propose/io 闭包消费
    let captured: {
      stageRepoDir: string;
      manifest: WorkspaceManifest;
      expectedRemoteSha: string;
      commitSha: string;
    } | null = null;

    const report = await goalLoopTick(t.db, {
      actor: "test-dl-e2e",
      workerId: "worker-e2e",
      ttlSeconds: 60,
      runTask: async (claim) => {
        const result = await executeRun(t.db, resolveVendoredPi(), {
          taskId,
          goal: "在工作区生成 delivered.txt 内容为 ok",
          allowedScope: ["/workspace"],
          attempt: claim.attempt,
          ownerId: claim.ownerId,
          fencingToken: claim.fencingToken,
          model: MODEL,
          sandbox: "host-fallback",
          wallSeconds: 60,
          heartbeatSeconds: 2,
          budget: { goalId, reserveCallsPerRun: 4 },
          argvOverride: [process.execPath, STUB],
          envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: "delivered.txt:ok" },
          // 工作区种子 = git 仓库(候选 commit 的 base;MANIFEST_EXCLUDE 已排除 .git)
          prepareWorkspace: (ws) => {
            execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { encoding: "utf8" });
            execFileSync("git", ["-C", ws, "config", "user.email", "seed@l"], { encoding: "utf8" });
            execFileSync("git", ["-C", ws, "config", "user.name", "seed"], { encoding: "utf8" });
            writeFileSync(join(ws, "README.md"), "# seed\n", "utf8");
            writeFileSync(join(ws, "base.txt"), "base\n", "utf8");
            execFileSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
            execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "base"], { encoding: "utf8" });
          },
          deliveryStaging: { baseDir: stageBase },
        });
        sandboxes.push(result.sandboxSpec);
        expect(result.outcome).toBe("SUCCEEDED");
        expect(result.candidateStageRepoDir).toBeTruthy();
        const commit = result.detail["candidateCommit"] as { commitSha: string; baseCommitSha: string };
        // 远端预置 base(模拟既有仓库;expected = base commit)
        remote.pushHead(result.sandboxSpec.workspaceDir, commit.baseCommitSha);
        captured = {
          stageRepoDir: result.candidateStageRepoDir!,
          manifest: snapshotManifest(result.sandboxSpec.workspaceDir), // 候选清单(工作区未清理)
          expectedRemoteSha: commit.baseCommitSha,
          commitSha: commit.commitSha,
        };
        return { outcome: result.outcome, taskId, runId: result.runId, workspaceDir: result.sandboxSpec.workspaceDir };
      },
      gate: {
        // RELAY-QUALITY-LOCAL-01:代码变更候选必须配机器检查(恒真检查满足门槛,不改变被测交付语义)
        evidenceChecks: [
          { kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true },
        ],
        reviewRun: async (input) =>
          runReviewerSession(t.db, resolveVendoredPi(), {
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
            envOverride: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "stub pass" },
          }),
        reviewAttempts: 1,
        backoffSeconds: 1,
      },
      delivery: {
        propose: async () => ({
          taskId,
          attempt: 1,
          target: remote.url,
          branch: "main",
          expectedRemoteSha: remote.head(),
          policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [remote.url.toLowerCase()] },
          credentialPresent: true,
          verifyCommitBinding: makeCommitBindingVerifier(() => captured?.stageRepoDir),
          actor: "test-dl-e2e",
        }),
        io: () => {
          if (!captured) throw new Error("delivery io before runTask capture");
          return {
            executor: createGitHubPushExecutor({ sourceRepo: captured.stageRepoDir, credentialFile: null }),
            verifyRemoteContent: async (commitSha: string) => {
              const r = await verifyRemoteCommitContent({
                target: remote.url,
                commitSha,
                manifest: captured!.manifest,
                scratchDir: tmpRoot("relay-dl-e2e-verify-"),
              });
              return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
            },
            manifest: captured.manifest,
          };
        },
      },
    });

    // 断言:gate ACCEPTED → 交付 DELIVERED → goal COMPLETED(同拍聚合)
    expect(report.gate?.status).toBe("ACCEPTED");
    expect(report.delivery?.propose.ok).toBe(true);
    expect(report.delivery?.execute).toMatchObject({ ok: true, state: "DELIVERED" });
    if (report.delivery?.execute && "remoteHead" in report.delivery.execute) {
      expect(report.delivery.execute.remoteHead).toBe(captured!.commitSha);
    }
    expect(remote.head()).toBe(captured!.commitSha);
    expect(remote.commitCount()).toBe(2); // base + 候选(无重复提交)
    const csRow = await latestChangeset(t.db as unknown as Exec, taskId);
    expect(csRow?.deliveryState).toBe("DELIVERED");
    // F-5 收敛:候选 base 必须等于 coder Run 记录的 input_commit_sha(Run 前基线)
    const runRow = await t.db.execute(sql`SELECT input_commit_sha FROM runs WHERE task_id = ${taskId}`);
    expect(String(runRow.rows[0]!["input_commit_sha"])).toBe(csRow?.gitBaseCommitSha);
    const goalRow = await t.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
    expect(String(goalRow.rows[0]!["state"])).toBe("COMPLETED");
    const stRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(stRow.rows[0]!["state"])).toBe("ACCEPTED");
    const audits = await t.db.execute(
      sql`SELECT action FROM audit_events WHERE task_id = ${taskId} AND action = 'DELIVERY_DELIVERED'`,
    );
    expect(audits.rows.length).toBe(1);
    for (const s of sandboxes) cleanupSandbox(s);
  });
});
