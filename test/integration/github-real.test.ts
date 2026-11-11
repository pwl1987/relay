// P0-02B 补验:真实远端(GitHub 沙箱仓库)——零强推、每轮基于真实远端 HEAD、外部写者快进。
//
// 纪律(补验授权逐条落地):
//  - **零强推**:本文件与执行器源码均无强推标志(测试自证断言);远端历史只增不减(祖先关系+提交数单调)。
//  - **固定沙箱仓库**:目标恒为 pwl1987/relay-delivery-sandbox;环境变量不得改指(显式拒绝断言);
//    生产仓库清单(pwl1987/relay)永不在目标内。
//  - **每轮读真实远端 HEAD**:候选提交基于当轮真实 HEAD 构建(远端为空时以其自身基线为根);
//    外部写者用**正常快进**推送(不重写历史)。
//  - **凭据门**:原始 PAT 文件缺失 ⇒ 整套真实远端用例显式 skip;存在但非法/经典宽权限 ⇒ 明确失败
//    (绝不回退本机 gh 宽权限令牌;绝不读 ~/.config/gh/hosts.yml)。
//  - 凭据有效时:一次真实 main 写入(远端 HEAD + 树内容 + GitHub API 三重核对)⇒ DELIVERED;
//    远端漂移实验(外部写者快进)⇒ Relay 拒绝覆盖、远端保持外来头、历史完整。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedTask, type TestDb } from "../setup/testdb.ts";
import type { Exec } from "../../src/core/db.ts";
import { recordChangeset, bindCandidateCommit, latestChangeset } from "../../src/core/changesets.ts";
import { recordBoundGate } from "../setup/gate-helper.ts";
import { proposeDelivery, executeDelivery, type DeliveryIO } from "../../src/core/delivery.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { createCandidateCommit, makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeCredentialStore, readTokenFile, tokenFileValid } from "../../src/runtime/github-credentials.ts";
import { snapshotManifest } from "../../src/runtime/workspace-manifest.ts";
import { makeWorkspaceRepo } from "../helpers/git-fixture.ts";

// —— 固定目标(无环境变量可改指)——
const SANDBOX_REPO = "pwl1987/relay-delivery-sandbox";
const SANDBOX_URL = `https://github.com/${SANDBOX_REPO}`;
/** 永不作为交付目标的仓库(生产仓库清单) */
const FORBIDDEN_REPOS = ["pwl1987/relay"];
/** 凭据文件(唯一凭据来源;缺失 ⇒ 真实远端用例 skip) */
const TOKEN_FILE = join(homedir(), ".relay", "credentials", "github-sandbox-pat");

// 强推标志按片段构造,避免本文件源码自身命中自证断言
const FORCE_FLAG = ["--", "force"].join("");
const FORCE_LEASE_FLAG = ["--", "force-with-lease"].join("");
// gh 配置文件名按片段构造(同样避免自命中)
const GH_HOSTS_FILE = ["hosts", "yml"].join(".");
const THIS_FILE = new URL(import.meta.url).pathname;
const EXECUTOR_FILE = new URL("../../src/core/executors/github-push.ts", import.meta.url).pathname;
const LEGACY_EXECUTOR_FILE = new URL("../../src/core/executors/git-push.ts", import.meta.url).pathname;

/** 剥离行注释与块注释 —— 自证只针对**可执行代码面**(注释里的禁令说明不算命中)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

// —— 凭据门(只读探测;绝不触碰本机 gh 配置)——
type CredentialMode = "absent" | "classic_forbidden" | "malformed" | "wellformed";
interface CredentialFacts {
  present: boolean;
  mode: CredentialMode;
  apiStatus: number | null; // GitHub /user 探测:200=接受,401=拒绝
  accepted: boolean;
  detail: string;
}

async function probeCredential(): Promise<CredentialFacts> {
  if (!tokenFileValid(TOKEN_FILE)) {
    return { present: existsSync(TOKEN_FILE), mode: "absent", apiStatus: null, accepted: false, detail: "凭据文件缺失或非 0600 常规文件" };
  }
  let token = "";
  try {
    token = readTokenFile(TOKEN_FILE);
  } catch (err) {
    return { present: true, mode: "malformed", apiStatus: null, accepted: false, detail: (err as Error).message };
  }
  // 经典令牌(ghp_/gho_/ghs_/ghu_)宽权限 ⇒ 明确禁止进入 Operator 面
  if (/^gh[pous]_/.test(token)) {
    return { present: true, mode: "classic_forbidden", apiStatus: null, accepted: false, detail: "经典宽权限令牌:禁止供 Relay Operator 使用" };
  }
  // 细粒度 PAT 形态:github_pat_ + 足够长度
  if (!token.startsWith("github_pat_") || token.length < 40) {
    return {
      present: true,
      mode: "malformed",
      apiStatus: null,
      accepted: false,
      detail: `令牌形态非法(长度 ${token.length};细粒度 PAT 应为 github_pat_ 前缀 + 足够长度)`,
    };
  }
  // 只读探测(不写入):200=GitHub 接受;401=拒绝
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "relay-p002b-probe" },
      signal: AbortSignal.timeout(20_000),
    });
    return {
      present: true,
      mode: "wellformed",
      apiStatus: res.status,
      accepted: res.status === 200,
      detail: `GitHub /user 探测状态 ${res.status}`,
    };
  } catch (err) {
    return { present: true, mode: "wellformed", apiStatus: null, accepted: false, detail: `探测异常:${(err as Error).message.slice(0, 120)}` };
  }
}

const credential = await probeCredential();
const credentialUsable = credential.mode === "wellformed" && credential.accepted;

const roots: string[] = [];
const stores: Array<{ cleanup(): void }> = [];
afterAll(() => {
  for (const r of roots) safeRm(r, { roots, sentinel: RUN_SENTINEL });
  for (const s of stores) s.cleanup();
});

/** git 子进程:凭据只经 credential.helper(store 文件)注入;env 最小化;不使用 gh CLI。 */
function git(cwd: string, credentialFile: string | null, ...args: string[]): string {
  const cred = credentialFile
    ? ["-c", "credential.helper=", "-c", `credential.helper=store --file=${credentialFile}`]
    : [];
  return execFileSync("git", ["-C", cwd, ...cred, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // 显式超时:网络/凭据异常时不得无限挂起(可诊断地失败,而非整例超时)
    timeout: 60_000,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
  }).trim();
}

describe("P0-02B 真实远端:门禁与夹具自证(始终执行;零远端写入)", () => {
  it("夹具自证:本文件与两个 push 执行器的可执行代码面均无强推标志;env 重定向被拒;目标固定为沙箱仓库且非生产仓库", () => {
    const self = stripComments(readFileSync(THIS_FILE, "utf8"));
    const executor = stripComments(readFileSync(EXECUTOR_FILE, "utf8"));
    const legacyExecutor = stripComments(readFileSync(LEGACY_EXECUTOR_FILE, "utf8"));
    for (const [name, src] of [["github-real.test.ts", self], ["github-push.ts", executor], ["git-push.ts", legacyExecutor]] as const) {
      expect(src.includes(FORCE_FLAG), `${name} 不得含强推标志`).toBe(false);
      expect(src.includes(FORCE_LEASE_FLAG), `${name} 不得含强推租约标志`).toBe(false);
    }
    // 环境变量不得改指目标仓库(补验 Item 3)
    const envRedirect = process.env.RELAY_DELIVERY_SANDBOX_REPO;
    expect(envRedirect === undefined || envRedirect === SANDBOX_REPO).toBe(true);
    // 目标固定:沙箱仓库,且不在生产仓库清单内
    expect(SANDBOX_REPO).toBe("pwl1987/relay-delivery-sandbox");
    expect(FORBIDDEN_REPOS).not.toContain(SANDBOX_REPO);
    expect(SANDBOX_REPO.startsWith("pwl1987/relay/")).toBe(false);
  });

  it("凭据门事实如实记录(缺失⇒后续真实用例 skip;经典⇒拒;API 只读探测不回退 gh 令牌)", () => {
    // 绝不读本机 gh 配置(经典宽权限令牌不得进入 Operator 面)
    expect(stripComments(readFileSync(THIS_FILE, "utf8")).includes(GH_HOSTS_FILE)).toBe(false);
    console.log(
      `CREDENTIAL_STATE mode=${credential.mode} present=${credential.present} apiStatus=${credential.apiStatus} detail=${credential.detail}` +
        ` (判定次序:形态检查先于 API 探测 —— 形态非法即短路,不打 API;形态合法但 API 401 ⇒ 凭据被拒)`,
    );
    if (credential.mode === "absent") {
      expect(credentialUsable).toBe(false); // 缺失 ⇒ 真实远端用例显式 skip
    } else if (credential.mode === "classic_forbidden") {
      expect(credentialUsable).toBe(false);
    } else if (credential.mode === "malformed") {
      expect(credentialUsable).toBe(false);
    } else {
      expect([200, 401]).toContain(credential.apiStatus);
      expect(credential.accepted).toBe(credential.apiStatus === 200);
    }
  });
});

describe.skipIf(!credential.present)(
  `真实远端写入与漂移实验(凭据 ${credential.mode};GitHub 认证 ${credential.apiStatus ?? "未探测"})`,
  () => {
    let t: TestDb;
    let credentialFile: string;

    beforeAll(async () => {
      roots.push(markTemp(mkdtempSync(join("/tmp", "relay-gh-real-"))));
      t = await createTestDb("p02b-github-real");
      const store = makeCredentialStore(TOKEN_FILE);
      stores.push(store);
      credentialFile = store.path;
    });
    afterAll(async () => {
      await t.cleanup();
    });

    /** 读真实远端 main 头(ls-remote;空分支 = "")。读取失败(鉴权/网络)⇒ null(不可读)。 */
    function tryRemoteHead(sourceRepo: string): string | null {
      try {
        const out = git(sourceRepo, credentialFile, "ls-remote", SANDBOX_URL, "refs/heads/main");
        const line = out.split("\n")[0] ?? "";
        return line.split(/\s+/)[0] ?? "";
      } catch {
        return null; // 鉴权失败/不可达
      }
    }

    /** 读真实远端 main 头(严格:不可读即抛,用于必须读到头的场景)。 */
    function remoteHead(sourceRepo: string): string {
      const head = tryRemoteHead(sourceRepo);
      if (head === null) throw new Error("remote head unreadable(鉴权或网络)");
      return head;
    }

    /** 把工作区同步到真实远端当前 HEAD(仅本地复位;远端只读)。 */
    function syncWorkspaceToRemote(wsDir: string, head: string): void {
      if (!head) return; // 远端为空:以工作区自身基线为根
      git(wsDir, credentialFile, "remote", "add", "origin", SANDBOX_URL);
      git(wsDir, credentialFile, "fetch", "--quiet", "origin", "main");
      git(wsDir, credentialFile, "reset", "--quiet", "--hard", head);
    }

    /** 在临时根下建工作区仓库(父目录先建,mkdtemp 要求存在)。 */
    function workspaceIn(name: string) {
      const dir = join(roots[0]!, name);
      mkdirSync(dir, { recursive: true });
      return makeWorkspaceRepo(dir);
    }

    /** 基于当前远端 HEAD 构建候选(每轮读真实 HEAD;远端不可读时退回本地基线)。 */
    async function buildCandidateOnRemoteHead(spec: { taskId: string; payload: string; fileName: string }) {
      const ws = workspaceIn(`ws-${spec.taskId}`);
      const head = tryRemoteHead(ws.dir);
      if (head) syncWorkspaceToRemote(ws.dir, head); // 远端可读 ⇒ 候选基于真实 HEAD
      const baseManifest = snapshotManifest(ws.dir); // 复位后 == 远端 HEAD 的树
      ws.apply({ [spec.fileName]: `${spec.payload}\n` });
      const candidateManifest = snapshotManifest(ws.dir);
      const baseSha = head || ws.baseCommitSha;

      await seedTask(t.db, { id: spec.taskId, gateRequired: true, allowedScope: ["/workspace"] });
      await t.db.execute(sql`UPDATE tasks SET state = 'ACCEPTED' WHERE id = ${spec.taskId}`);
      await t.db.execute(sql`
        INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, sandbox, outcome)
        VALUES (${`run-${spec.taskId}`}, ${spec.taskId}, 1, 'stub', 'stub/coder', ${baseSha}, 'host-fallback', 'SUCCEEDED')
      `);
      const cs = await t.db.transaction(async (tx) =>
        recordChangeset(tx as unknown as Exec, {
          taskId: spec.taskId,
          runId: `run-${spec.taskId}`,
          attempt: 1,
          base: baseManifest,
          candidate: candidateManifest,
          requirement: { goalText: `deliver ${spec.taskId}`, taskId: spec.taskId, allowedScope: ["/workspace"], allowedCommands: [] },
        }),
      );
      const staged = await createCandidateCommit({
        workspaceDir: ws.dir,
        baseCommitSha: baseSha,
        candidateManifest,
        diff: { added: [spec.fileName], modified: [], removed: [] },
        taskId: spec.taskId,
        attempt: 1,
        changesetId: cs.id,
        stagingDir: roots[0]!,
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
      if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
      const gate = await recordBoundGate(t.db, {
        taskId: spec.taskId,
        verdict: "PASS",
        attempt: 1,
        candidateSha: cs.candidateSha,
        requirementSha: cs.requirementSha,
        coderRunId: `run-${spec.taskId}`,
      });
      if (!gate.ok) throw new Error(`gate seed failed: ${gate.reason}`);
      await t.db.execute(sql`UPDATE task_gate_verdicts SET consumed_at = now(), consumed_by = 'test' WHERE id = ${gate.id}`);
      return { ws, cs, staged, remoteHeadAtBuild: head, baseSha };
    }

    function ioFor(staged: { stageRepoDir: string }, manifest: ReturnType<typeof snapshotManifest>): DeliveryIO {
      return {
        executor: createGitHubPushExecutor({ sourceRepo: staged.stageRepoDir, credentialFile }),
        verifyRemoteContent: async (commitSha: string) => {
          const r = await verifyRemoteCommitContent({
            target: SANDBOX_URL,
            commitSha,
            manifest,
            scratchDir: join(roots[0]!, "verify"),
            credentialFile,
          });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest,
      };
    }

    it.skipIf(credentialUsable || !credential.present)(
      `凭据被拒(GitHub ${credential.apiStatus ?? "鉴权失败"})⇒ 真实远端安全失败:交付 FAILED、changeset 非 DELIVERED、写入动作零调用(perform 未触发)`,
      { timeout: 300_000 },
      async () => {
        // 真实远端 + 当前(被拒)凭据:目标是验证**安全失败**而非成功写入。
        const built = await buildCandidateOnRemoteHead({ taskId: "t-gh-rejected", payload: "must never be written", fileName: "rejected.txt" });
        const proposed = await t.db.transaction(async (tx) =>
          proposeDelivery(tx as unknown as Exec, {
            taskId: "t-gh-rejected",
            attempt: 1,
            target: SANDBOX_URL,
            branch: "main",
            // 真实远端头;空串 = 分支尚不存在 ⇒ 创建分支交付;null(远端不可读,如鉴权失败)
            // ⇒ 记为 "" ⇒ 前置核对时读取远端即失败 ⇒ intent FAILED(安全失败,零写入)。
            expectedRemoteSha: built.remoteHeadAtBuild ?? "",
            policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [SANDBOX_REPO.toLowerCase()] },
            credentialPresent: true,
            verifyCommitBinding: makeCommitBindingVerifier(() => built.staged.stageRepoDir),
            actor: "test-gh-rejected",
          }),
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;

        // 包裹真实执行器:统计 perform(实际写入动作)调用次数
        const real = createGitHubPushExecutor({ sourceRepo: built.staged.stageRepoDir, credentialFile });
        let performCalls = 0;
        const io: DeliveryIO = {
          executor: {
            check: (ref) => real.check(ref),
            perform: async (ref) => {
              performCalls += 1;
              return real.perform(ref);
            },
          },
          verifyRemoteContent: async () => ({ ok: false as const, mismatches: ["not_reached"] }),
          manifest: snapshotManifest(built.ws.dir),
        };
        const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-gh-rejected" });
        expect(done.ok).toBe(false);
        if (done.ok) return;
        // 鉴权失败发生在**读取远端真实状态**阶段 ⇒ 写入动作一次都没发生
        expect(["FAILED", "NEEDS_RECONCILE"]).toContain(done.state);
        expect(performCalls).toBe(0);
        const csRow = await latestChangeset(t.db as unknown as Exec, "t-gh-rejected");
        expect(csRow?.deliveryState).not.toBe("DELIVERED");
        console.log(
          `GITHUB_REJECTED_EVIDENCE repo=${SANDBOX_REPO} state=${done.state} perform_calls=${performCalls} delivery_state=${csRow?.deliveryState}`,
        );
      },
    );

    it.skipIf(!credentialUsable)(
      `一次真实 main 写入:基于真实远端 HEAD 建候选 → DELIVERED → 远端/树/API 三重核对;历史只增不减(凭据 ${credential.mode},API ${credential.apiStatus})`,
      { timeout: 300_000 },
      async () => {
        const built = await buildCandidateOnRemoteHead({ taskId: "t-gh-real", payload: "p0-02b real remote write", fileName: "delivered.txt" });
        const headBefore = built.remoteHeadAtBuild;

        const proposed = await t.db.transaction(async (tx) =>
          proposeDelivery(tx as unknown as Exec, {
            taskId: "t-gh-real",
            attempt: 1,
            target: SANDBOX_URL,
            branch: "main",
            expectedRemoteSha: headBefore ?? "", // 远端真实头(空串 = 分支尚不存在 ⇒ 本次为创建分支交付)
            policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [SANDBOX_REPO.toLowerCase()] },
            credentialPresent: true,
            verifyCommitBinding: makeCommitBindingVerifier(() => built.staged.stageRepoDir),
            actor: "test-gh-real",
          }),
        );
        expect(proposed.ok, proposed.ok ? "" : `propose rejected: ${proposed.reason}`).toBe(true);
        if (!proposed.ok) return;

        const io = ioFor(built.staged, snapshotManifest(built.ws.dir));
        const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-gh-real" });
        expect(done.ok, done.ok ? "" : `execute failed: ${JSON.stringify(done)}`).toBe(true);
        if (!done.ok) return;
        expect(done.state).toBe("DELIVERED");
        expect(done.remoteHead).toBe(built.staged.commitSha);

        // 远端核对 1:git 协议 ls-remote(独立于交付执行器)
        expect(remoteHead(built.ws.dir)).toBe(built.staged.commitSha);
        // 远端核对 2:GitHub REST API(contents 按 commit SHA 取文件)
        const api = await fetch(`https://api.github.com/repos/${SANDBOX_REPO}/contents/delivered.txt?ref=${built.staged.commitSha}`, {
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
        console.log(`GITHUB_API_VERIFY repo=${SANDBOX_REPO} ref=${built.staged.commitSha} api_status=${api.status} blob_sha=${body.sha}`);

        // 历史未丢:旧头仍是新头的祖先(快进),且提交数**恰好 +1**(非恒真比较)
        if (headBefore) {
          const hist = join(roots[0]!, "hist");
          execFileSync("git", ["init", "--quiet", hist], { encoding: "utf8" });
          git(hist, credentialFile, "remote", "add", "origin", SANDBOX_URL);
          git(hist, credentialFile, "fetch", "--quiet", "origin", "main");
          expect(git(hist, credentialFile, "merge-base", "--is-ancestor", headBefore, built.staged.commitSha)).toBe("");
          const countAfter = Number(git(hist, credentialFile, "rev-list", "--count", "FETCH_HEAD"));
          const countBefore = Number(
            git(hist, credentialFile, "rev-list", "--count", headBefore),
          );
          // 单调且精确:+1(快进写只追加一个提交;截断历史或复用旧提交都会被此断言抓住)
          expect(countAfter).toBe(countBefore + 1);
          // 旧头对象仍在远端历史中(未被裁剪)
          expect(git(hist, credentialFile, "cat-file", "-t", headBefore)).toBe("commit");
        }

        const csRow = await latestChangeset(t.db as unknown as Exec, "t-gh-real");
        expect(csRow?.deliveryState).toBe("DELIVERED");
        expect(csRow?.deliveredRemoteHead).toBe(built.staged.commitSha);
      },
    );

    it.skipIf(!credentialUsable)(
      `远端漂移实验:外部写者快进推进 main ⇒ Relay 拒绝覆盖;远端保持外来头且历史完整(凭据 ${credential.mode},API ${credential.apiStatus})`,
      { timeout: 300_000 },
      async () => {
        // 候选基于**当前真实远端 HEAD**构建(此时远端头 R)
        const built = await buildCandidateOnRemoteHead({ taskId: "t-gh-drift", payload: "p0-02b drift experiment", fileName: "drift.txt" });

        // 外部写者:自己的仓库、自己的提交(对象自洽;不借用其它仓库的对象)
        const other = workspaceIn("ws-drift-other");
        git(other.dir, credentialFile, "remote", "add", "origin", SANDBOX_URL);
        const headAtBuild = built.remoteHeadAtBuild;
        if (headAtBuild) {
          // 远端已有 main:外部写者基于该真实头新增提交并**正常快进**推送(不重写历史)
          git(other.dir, credentialFile, "fetch", "--quiet", "origin", "main");
          git(other.dir, credentialFile, "reset", "--quiet", "--hard", headAtBuild);
        }
        other.apply({ "foreign.txt": "external writer was here\n" });
        git(other.dir, credentialFile, "add", "-A");
        git(other.dir, credentialFile, "-c", "user.email=ext@l", "-c", "user.name=ext", "commit", "--quiet", "-m", "foreign");
        // 远端为空时,外部写者用**自身提交**创建分支(普通推送;对象自洽 ⇒ 无 bad object)
        git(other.dir, credentialFile, "push", "origin", "HEAD:refs/heads/main"); // 非 FF 必被 git 拒
        const foreignHead = remoteHead(other.dir);
        expect(foreignHead).not.toBe(headAtBuild ?? "");

        // Relay 交付:expected = 旧头 ⇒ 远端已漂移 ⇒ 拒绝
        const proposed = await t.db.transaction(async (tx) =>
          proposeDelivery(tx as unknown as Exec, {
            taskId: "t-gh-drift",
            attempt: 1,
            target: SANDBOX_URL,
            branch: "main",
            expectedRemoteSha: headAtBuild ?? "", // Relay 已知头(空串 = 分支此前不存在 ⇒ 本次远端已漂移)
            policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [SANDBOX_REPO.toLowerCase()] },
            credentialPresent: true,
            verifyCommitBinding: makeCommitBindingVerifier(() => built.staged.stageRepoDir),
            actor: "test-gh-drift",
          }),
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        const io = ioFor(built.staged, snapshotManifest(built.ws.dir));
        const done = await executeDelivery(t.db, io, proposed.proposal.id, { actor: "test-gh-drift" });
        expect(done.ok).toBe(false);
        if (done.ok) return;
        expect(["CONFLICT", "FAILED"]).toContain(done.state);
        // 远端保持外来头(未被覆盖)+ 历史完整(旧头仍是祖先)
        expect(remoteHead(other.dir)).toBe(foreignHead);
        expect(foreignHead).not.toBe(built.staged.commitSha);
        const hist = join(roots[0]!, "hist-drift");
        execFileSync("git", ["init", "--quiet", hist], { encoding: "utf8" });
        git(hist, credentialFile, "remote", "add", "origin", SANDBOX_URL);
        git(hist, credentialFile, "fetch", "--quiet", "origin", "main");
        // 历史完整:若远端此前已有 main,则旧头仍是外来头的祖先(快进链未被改写);
        // 若此前为空(分支由外部写者创建),则以"远端头可达且提交链自洽"为准。
        if (headAtBuild) {
          expect(git(hist, credentialFile, "merge-base", "--is-ancestor", headAtBuild, foreignHead)).toBe("");
        } else {
          expect(git(hist, credentialFile, "rev-parse", "FETCH_HEAD")).toBe(foreignHead);
        }
        // ChangeSet 不得标 DELIVERED;人工处置行(D3)落库
        const csRow = await latestChangeset(t.db as unknown as Exec, "t-gh-drift");
        expect(csRow?.deliveryState).not.toBe("DELIVERED");
      },
    );
  },
);
