// P0-02B 真实远端写入(专用沙箱仓库;凭据门控 —— G-1 门禁不通过即 skip,不假装)。
// 前提:宿主 0600 原始 PAT 文件(细粒度,仅 pwl1987/relay-delivery-sandbox 的 Contents RW)。
//   路径:env RELAY_GITHUB_TOKEN_FILE 或缺省 ~/.relay/credentials/github-sandbox-pat
// 覆盖(合同第五节):一次真实 main 写入(远端核对含 GitHub REST API 独立路径)+
//   远端漂移实验(外部推进 main 后 Relay 拒绝覆盖)。
// 纪律:禁推 pwl1987/relay 主仓库;本测试只触 relay-delivery-sandbox;凭据零日志。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedTask, type TestDb } from "../setup/testdb.ts";
import type { Exec } from "../../src/core/db.ts";
import { recordChangeset, bindCandidateCommit, latestChangeset } from "../../src/core/changesets.ts";
import { recordBoundGate } from "../setup/gate-helper.ts";
import { proposeDelivery, executeDelivery } from "../../src/core/delivery.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { createCandidateCommit, makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeCredentialStore, readTokenFile, tokenFileValid } from "../../src/runtime/github-credentials.ts";
import { manifestOf, makeWorkspaceRepo } from "../helpers/git-fixture.ts";

const SANDBOX_REPO = process.env.RELAY_DELIVERY_SANDBOX_REPO ?? "pwl1987/relay-delivery-sandbox";
const SANDBOX_URL = `https://github.com/${SANDBOX_REPO}`;
const TOKEN_FILE = process.env.RELAY_GITHUB_TOKEN_FILE ?? join(homedir(), ".relay", "credentials", "github-sandbox-pat");

const tokenOk = tokenFileValid(TOKEN_FILE);

const roots: string[] = [];
const stores: Array<{ cleanup(): void }> = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  for (const s of stores) s.cleanup();
});

describe.skipIf(!tokenOk)("P0-02B 真实远端:GitHub 沙箱仓库 main 写入 + 漂移实验(细粒度 PAT)", () => {
  let t: TestDb;

  /** 播种交付前置态(确定性;模型零参与)并返回候选 commit 绑定。 */
  async function seedReady(spec: { taskId: string; payload: string }) {
    await seedTask(t.db, { id: spec.taskId, gateRequired: true, allowedScope: ["/workspace"] });
    await t.db.execute(sql`UPDATE tasks SET state = 'ACCEPTED' WHERE id = ${spec.taskId}`);
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome)
      VALUES (${`run-${spec.taskId}`}, ${spec.taskId}, 1, 'stub', 'stub/coder', 'host-fallback', 'SUCCEEDED')
    `);
    const ws = makeWorkspaceRepo(join(roots[0]!, `ws-${spec.taskId}`));
    ws.apply({ "delivered.txt": `${spec.payload}\n` });
    const manifest = manifestOf(ws.dir, ["README.md", "src.txt", "delivered.txt"]);
    const cs = await t.db.transaction(async (tx) =>
      recordChangeset(tx as unknown as Exec, {
        taskId: spec.taskId,
        runId: `run-${spec.taskId}`,
        attempt: 1,
        base: manifestOf(ws.dir, ["README.md", "src.txt"]),
        candidate: manifest,
        requirement: { goalText: `deliver ${spec.taskId}`, taskId: spec.taskId, allowedScope: ["/workspace"], allowedCommands: [] },
      }),
    );
    const staged = await createCandidateCommit({
      workspaceDir: ws.dir,
      baseCommitSha: ws.baseCommitSha,
      candidateManifest: manifest,
      diff: { added: ["delivered.txt"], modified: [], removed: [] },
      taskId: spec.taskId,
      attempt: 1,
      changesetId: cs.id,
      stagingDir: roots[0]!,
    });
    const bound = await t.db.transaction(async (tx) =>
      bindCandidateCommit(tx as unknown as Exec, {
        changesetId: cs.id, taskId: spec.taskId, attempt: 1,
        baseCommitSha: staged.baseCommitSha, treeSha: staged.treeSha, commitSha: staged.commitSha,
        stageRepoDir: staged.stageRepoDir,
      }),
    );
    if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
    const gate = await recordBoundGate(t.db, {
      taskId: spec.taskId, verdict: "PASS", attempt: 1,
      candidateSha: cs.candidateSha, requirementSha: cs.requirementSha, coderRunId: `run-${spec.taskId}`,
    });
    if (!gate.ok) throw new Error(`gate seed failed: ${gate.reason}`);
    await t.db.execute(sql`UPDATE task_gate_verdicts SET consumed_at = now(), consumed_by = 'test' WHERE id = ${gate.id}`);
    return { ws, cs, staged, manifest };
  }

  function ioFor(staged: { stageRepoDir: string }, manifest: ReturnType<typeof manifestOf>) {
    const store = makeCredentialStore(TOKEN_FILE);
    stores.push(store);
    const executor = createGitHubPushExecutor({ sourceRepo: staged.stageRepoDir, credentialFile: store.path });
    return {
      executor,
      verifyRemoteContent: async (commitSha: string) => {
        const r = await verifyRemoteCommitContent({
          target: SANDBOX_URL, commitSha, manifest, scratchDir: join(roots[0]!, "verify"),
          credentialFile: store.path,
        });
        return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
      },
      manifest,
    };
  }

  beforeAll(async () => {
    roots.push(mkdtempSync(join("/tmp", "relay-gh-real-")));
    t = await createTestDb("p02b-github-real");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("一次真实 main 写入:Intent 两阶段 → 推送 → 远端 HEAD+树核验 → DELIVERED;GitHub API 独立核对", { timeout: 300_000 }, async () => {
    const seeded = await seedReady({ taskId: "t-gh-real", payload: "p0-02b real remote write" });
    // 首次写入前的远端 main 头(实验前状态;仓库可能为空分支或已有基线)
    const preStore = makeCredentialStore(TOKEN_FILE);
    stores.push(preStore);
    const preExec = createGitHubPushExecutor({ sourceRepo: seeded.ws.dir, credentialFile: preStore.path });
    const preHead = await preExec.check({
      id: "pre", taskId: "t-gh-real", capability: "github.push", target: SANDBOX_URL,
      branch: "main", expectedRemoteSha: null, payloadSha: null,
    });
    // 若 main 存在且不等于 base(上次实验残留)⇒ 先把远端重置到 base(实验自清理;非 Relay 路径)
    if (preHead && preHead !== seeded.ws.baseCommitSha) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["-C", seeded.ws.dir, "push", "--force", SANDBOX_URL, `${seeded.ws.baseCommitSha}:refs/heads/main`], {
        encoding: "utf8", env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: "/nonexistent",
        },
      });
      // 注:此 force 是**实验夹具自清理**(把沙箱远端拉回 base 起点),非 Relay 交付链行为;
      // Relay 链路内的 force 禁令由执行器与 Policy 强制(本测试交付路径全程无 force)。
    }
    // 远端 base 就位(空仓库时推送 base)
    if (!preHead) {
      const { execFileSync } = await import("node:child_process");
      const store = makeCredentialStore(TOKEN_FILE);
      stores.push(store);
      execFileSync("git", ["-C", seeded.ws.dir, "-c", "credential.helper=", "-c", `credential.helper=store --file=${store.path}`, "push", SANDBOX_URL, `${seeded.ws.baseCommitSha}:refs/heads/main`], {
        encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
      });
    }

    const proposed = await t.db.transaction(async (tx) =>
      proposeDelivery(tx as unknown as Exec, {
        taskId: "t-gh-real",
        attempt: 1,
        target: SANDBOX_URL,
        branch: "main",
        expectedRemoteSha: seeded.ws.baseCommitSha,
        policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [SANDBOX_REPO.toLowerCase()] },
        credentialPresent: true,
        verifyCommitBinding: makeCommitBindingVerifier(() => seeded.staged.stageRepoDir),
        actor: "test-gh-real",
      }),
    );
    expect(proposed.ok, proposed.ok ? "" : `propose rejected: ${proposed.reason}`).toBe(true);
    if (!proposed.ok) return;

    const io = ioFor(seeded.staged, seeded.manifest);
    const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-gh-real" });
    expect(done.ok, done.ok ? "" : `execute failed: ${JSON.stringify(done)}`).toBe(true);
    if (!done.ok) return;
    expect(done.state).toBe("DELIVERED");
    expect(done.remoteHead).toBe(seeded.staged.commitSha);

    // 独立核对路径 1:git 协议远端内容核验(io.verifyRemoteContent 已在 DELIVERED 前通过)
    // 独立核对路径 2:GitHub REST API(contents API 按 commit SHA 取文件,凭据仅经 env 给 gh/api)
    const api = await fetch(`https://api.github.com/repos/${SANDBOX_REPO}/contents/delivered.txt?ref=${seeded.staged.commitSha}`, {
      headers: {
        authorization: `Bearer ${readTokenFile(TOKEN_FILE)}`,
        accept: "application/vnd.github+json",
        "user-agent": "relay-p002b-test",
      },
    });
    expect(api.ok, `GitHub API 状态 ${api.status}`).toBe(true);
    const body = (await api.json()) as { content?: string; encoding?: string; sha?: string };
    expect(body.encoding).toBe("base64");
    expect(Buffer.from(body.content ?? "", "base64").toString("utf8")).toContain("p0-02b real remote write");

    // 落库状态
    const csRow = await latestChangeset(t.db as unknown as Exec, "t-gh-real");
    expect(csRow?.deliveryState).toBe("DELIVERED");
    expect(csRow?.deliveredRemoteHead).toBe(seeded.staged.commitSha);
    expect(existsSync(seeded.staged.stageRepoDir)).toBe(true); // stage 留存供审计(ops 清理)
  });

  it("远端漂移实验:外部推进 main 后 Relay 交付 ⇒ CONFLICT 拒绝覆盖;远端保持外来头", { timeout: 300_000 }, async () => {
    const seeded = await seedReady({ taskId: "t-gh-drift", payload: "p0-02b drift experiment" });
    const { execFileSync } = await import("node:child_process");
    // 把远端 main 拉回 base(上一实验残留自清理;同上:夹具行为,非 Relay 链路)
    const storeFix = makeCredentialStore(TOKEN_FILE);
    stores.push(storeFix);
    execFileSync("git", ["-C", seeded.ws.dir, "-c", "credential.helper=", "-c", `credential.helper=store --file=${storeFix.path}`, "push", "--force", SANDBOX_URL, `${seeded.ws.baseCommitSha}:refs/heads/main`], {
      encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
    });
    // 外部写者推进 main(模拟并发写;内容为外来提交)
    const other = makeWorkspaceRepo(join(roots[0]!, "ws-drift-other"));
    other.apply({ "foreign.txt": "external writer was here\n" });
    execFileSync("git", ["-C", other.dir, "remote", "add", "r", SANDBOX_URL], { encoding: "utf8" });
    const fetchStore = makeCredentialStore(TOKEN_FILE);
    stores.push(fetchStore);
    execFileSync("git", ["-C", other.dir, "-c", "credential.helper=", "-c", `credential.helper=store --file=${fetchStore.path}`, "fetch", "r"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" } });
    execFileSync("git", ["-C", other.dir, "reset", "--quiet", "--hard", seeded.ws.baseCommitSha], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "-c", "user.email=ext@l", "-c", "user.name=ext", "commit", "--quiet", "-m", "foreign"], { encoding: "utf8" });
    execFileSync("git", ["-C", other.dir, "-c", "credential.helper=", "-c", `credential.helper=store --file=${fetchStore.path}`, "push", "r", "HEAD:refs/heads/main"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" } });

    const proposed = await t.db.transaction(async (tx) =>
      proposeDelivery(tx as unknown as Exec, {
        taskId: "t-gh-drift",
        attempt: 1,
        target: SANDBOX_URL,
        branch: "main",
        expectedRemoteSha: seeded.ws.baseCommitSha, // Relay 已知头(已漂移)
        policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [SANDBOX_REPO.toLowerCase()] },
        credentialPresent: true,
        verifyCommitBinding: makeCommitBindingVerifier(() => seeded.staged.stageRepoDir),
        actor: "test-gh-drift",
      }),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const io = ioFor(seeded.staged, seeded.manifest);
    const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-gh-drift" });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.state).toBe("CONFLICT");
    // 远端仍是外来提交(未覆盖);Relay 候选未标 DELIVERED
    const ext = createGitHubPushExecutor({ sourceRepo: other.dir, credentialFile: fetchStore.path });
    const remoteNow = await ext.check({
      id: "post", taskId: "t-gh-drift", capability: "github.push", target: SANDBOX_URL,
      branch: "main", expectedRemoteSha: null, payloadSha: null,
    });
    expect(remoteNow).not.toBe(seeded.staged.commitSha);
    const csRow = await latestChangeset(t.db as unknown as Exec, "t-gh-drift");
    expect(csRow?.deliveryState).toBe("CONFLICT");
    const dec = await t.db.execute(sql`SELECT count(*)::int AS n FROM decisions WHERE task_id = 't-gh-drift' AND state = 'OPEN' AND level = 'D3'`);
    expect(Number(dec.rows[0]!["n"])).toBe(1);
  });
});
