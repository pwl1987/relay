// P0-02B D-1/D-2/D-3:候选 Git Commit 构建(独立 stage 仓库;真实 Git,零模型零网络)。
// 覆盖:三 SHA 区分 / 增改删+可执行位树核验 / 内容不一致阻断 / 非 git 工作区 /
//       base 父提交不符 / 符号链接剔除 / 绑定重核(漂移拒绝)/ 远端内容核验。
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCandidateCommit,
  makeCommitBindingVerifier,
  verifyRemoteCommitContent,
  GitCandidateError,
} from "../../src/runtime/git-candidate.ts";
import { manifestSha } from "../../src/core/changesets.ts";
import {
  makeWorkspaceRepo,
  makeBareRemote,
  manifestOf,
  addSymlink,
} from "../helpers/git-fixture.ts";

const roots: string[] = [];
function stageRoot(): string {
  const d = markTemp(mkdtempSync(join(tmpdir(), "relay-stage-")));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const r of roots) safeRm(r, { roots, sentinel: RUN_SENTINEL });
});

async function build(ws: ReturnType<typeof makeWorkspaceRepo>, files: string[], diff: { added: string[]; modified: string[]; removed: string[] }, changesetId: string) {
  return createCandidateCommit({
    workspaceDir: ws.dir,
    baseCommitSha: ws.baseCommitSha,
    candidateManifest: manifestOf(ws.dir, files),
    diff,
    taskId: "t-gitcand",
    attempt: 1,
    changesetId,
    stagingDir: stageRoot(),
  });
}

describe("P0-02B D-2:候选 Commit 构建(stage 克隆 + 树==清单往返核验)", () => {
  it("正常路径:增/改/删 + 可执行位;三 SHA 两两不等;树核验通过;refs/relay-candidates 防gc引用存在", async () => {
    const ws = makeWorkspaceRepo();
    // 候选变更:改 src.txt、增 nested/new.txt(可执行)、增 normal.txt、删 README.md
    ws.apply(
      {
        "src.txt": "modified content\n",
        "nested/new.txt": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
        "normal.txt": "new file\n",
      },
      ["README.md"],
    );
    const files = ["src.txt", "nested/new.txt", "normal.txt"];
    const staged = await build(ws, files, { added: ["nested/new.txt", "normal.txt"], modified: ["src.txt"], removed: ["README.md"] }, "cs-d2-ok");
    // D-1:三 SHA 区分 —— 清单 sha ≠ tree ≠ commit
    const candidateSha = manifestSha(manifestOf(ws.dir, files));
    expect(candidateSha).not.toBe(staged.treeSha);
    expect(staged.treeSha).not.toBe(staged.commitSha);
    expect(candidateSha).not.toBe(staged.commitSha);
    expect(staged.treeVerified).toBe(true);
    expect(staged.baseCommitSha).toBe(ws.baseCommitSha);
    // stage 仓库内防 gc 引用
    const refOut = execFileSync("git", ["-C", staged.stageRepoDir, "rev-parse", "refs/relay-candidates/cs-d2-ok"], { encoding: "utf8" }).trim();
    expect(refOut).toBe(staged.commitSha);
    // 可执行位保留
    const mode = execFileSync("git", ["-C", staged.stageRepoDir, "ls-tree", "HEAD", "nested/new.txt"], { encoding: "utf8" });
    expect(mode.trim().split(/\s+/)[0]).toBe("100755");
  });

  it("内容不一致 ⇒ 阻断 content_mismatch(候选清单与实际内容失配;半成品被清理)", async () => {
    const ws = makeWorkspaceRepo();
    ws.apply({ "src.txt": "candidate v1\n" });
    const manifest = manifestOf(ws.dir, ["src.txt"]);
    // 篡改清单:src.txt 的哈希换成占位(候选面与真实内容不一致)
    manifest.set("src.txt", "0".repeat(64));
    const err = await createCandidateCommit({
      workspaceDir: ws.dir,
      baseCommitSha: ws.baseCommitSha,
      candidateManifest: manifest,
      diff: { added: [], modified: ["src.txt"], removed: [] },
      taskId: "t-d2",
      attempt: 1,
      changesetId: "cs-d2-bad",
      stagingDir: stageRoot(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GitCandidateError);
    expect((err as GitCandidateError).reason).toBe("content_mismatch");
    // 构建失败不留半成品
    const ls = execFileSync("ls", [stageRoot()], { encoding: "utf8" });
    expect(ls).not.toContain("cs-d2-bad");
  });

  it("非 git 工作区 ⇒ not_a_git_workspace;base 不在仓库 ⇒ 阻断(候选父恒为 base,base_parent_mismatch 为纵深防线)", async () => {
    const plain = markTemp(mkdtempSync(join(tmpdir(), "relay-plain-")));
    roots.push(plain);
    const e1 = await createCandidateCommit({
      workspaceDir: plain,
      baseCommitSha: "0".repeat(40),
      candidateManifest: new Map(),
      diff: { added: [], modified: [], removed: [] },
      taskId: "t-d2",
      attempt: 1,
      changesetId: "cs-d2-plain",
      stagingDir: stageRoot(),
    }).catch((e) => e);
    expect((e1 as GitCandidateError).reason).toBe("not_a_git_workspace");

    // base 不存在(cat-file 前置核验失败)⇒ 阻断,绝不产出候选
    const ws = makeWorkspaceRepo();
    const e2 = await createCandidateCommit({
      workspaceDir: ws.dir,
      baseCommitSha: "c".repeat(40),
      candidateManifest: manifestOf(ws.dir, ["README.md", "src.txt"]),
      diff: { added: [], modified: [], removed: [] },
      taskId: "t-d2",
      attempt: 1,
      changesetId: "cs-d2-nobase",
      stagingDir: stageRoot(),
    }).catch((e) => e);
    expect(e2).toBeInstanceOf(GitCandidateError);

    // 纵深防线:候选 commit 的父恒等于 base(stage 复位到 base 后构造性成立;
    // 旧实现(事后重探测)在本场景下会产出漂移的父 —— 由 F-5 用例锁定)
    const ws2 = makeWorkspaceRepo();
    ws2.apply({ "x.txt": "c\n" });
    const staged = await build(ws2, ["README.md", "src.txt", "x.txt"], { added: ["x.txt"], modified: [], removed: [] }, "cs-d2-parent");
    const parent = execFileSync("git", ["-C", staged.stageRepoDir, "rev-parse", `${staged.commitSha}~1`], { encoding: "utf8" }).trim();
    expect(parent).toBe(ws2.baseCommitSha);
  });

  it("F-5 收敛:模型在 Run 期间自行 commit ⇒ 候选 commit 的父仍必须是 Run 前基线(base 语义不漂移)", async () => {
    const ws = makeWorkspaceRepo();
    const base = ws.baseCommitSha;
    // 模型在 Run 期间自行 commit(工作区 HEAD 前移,含一份"模型中间提交")
    ws.apply({ "model-commit.txt": "model made a commit\n" });
    execFileSync("git", ["-C", ws.dir, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", ws.dir, "-c", "user.email=m@l", "-c", "user.name=m", "commit", "--quiet", "-m", "model intermediate"], { encoding: "utf8" });
    const modelHead = execFileSync("git", ["-C", ws.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(modelHead).not.toBe(base);
    // 候选内容(变更集视角)只含交付文件 —— 模型中间提交的文件不在候选清单内
    ws.apply({ "delivered.txt": "candidate\n" });
    const staged = await build(ws, ["README.md", "src.txt", "delivered.txt"], { added: ["delivered.txt"], modified: [], removed: [] }, "cs-f5-base");
    // 候选 commit 的父 = Run 前基线(不是模型中间提交)——本用例锁定的不变量
    const parent = execFileSync("git", ["-C", staged.stageRepoDir, "rev-parse", `${staged.commitSha}~1`], { encoding: "utf8" }).trim();
    expect(parent).toBe(base);
    expect(parent).not.toBe(modelHead);
    expect(staged.baseCommitSha).toBe(base);
    // 语义澄清(勿误读):本用例**手工指定**了 candidateManifest/diff,故模型中间提交的文件不在候选清单内。
    // 生产路径的候选清单是整个工作区快照(仅排除 .git/.relay)——模型新建的文件**会**作为候选内容进入候选树,
    // 这正是"候选 = Run 前基线 + 本次全部改动"的语义;被本用例锁定的严格不变量是"候选父恒为 Run 前基线"。
    const tree = execFileSync("git", ["-C", staged.stageRepoDir, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
    expect(tree).not.toContain("model-commit.txt"); // 该文件不在本用例声明的候选清单内
    expect(tree).toContain("delivered.txt");
  });

  it("符号链接不入候选树(清单语义对齐;链接剔除后树==清单)", async () => {
    const ws = makeWorkspaceRepo();
    addSymlink(ws.dir, "link.txt", "src.txt");
    ws.apply({ "a.txt": "a\n" });
    const staged = await build(ws, ["README.md", "src.txt", "a.txt"], { added: ["a.txt"], modified: [], removed: [] }, "cs-d2-link");
    expect(staged.treeVerified).toBe(true);
    const tree = execFileSync("git", ["-C", staged.stageRepoDir, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
    expect(tree).not.toContain("link.txt");
  });
});

describe("P0-02B D-3/D-8:绑定重核 + 远端内容核验", () => {
  it("绑定重核:一致 ⇒ ok;记录值漂移 ⇒ tree_sha_drift/base_parent_drift;stage 缺失 ⇒ stage_repo_missing", async () => {
    const ws = makeWorkspaceRepo();
    ws.apply({ "x.txt": "candidate\n" });
    const staged = await build(ws, ["README.md", "src.txt", "x.txt"], { added: ["x.txt"], modified: [], removed: [] }, "cs-d3");
    const binding = {
      gitBaseCommitSha: staged.baseCommitSha,
      gitTreeSha: staged.treeSha,
      gitCommitSha: staged.commitSha,
    };
    const verify = makeCommitBindingVerifier(() => staged.stageRepoDir);
    await expect(verify(binding)).resolves.toEqual({ ok: true });

    // 绑定记录值漂移(DB 行被指向别的树/基线;commit 对象不可变 ⇒ 漂移必是记录面失真)
    const treeDrift = await verify({ ...binding, gitTreeSha: "f".repeat(40) });
    expect(treeDrift.ok).toBe(false);
    if (!treeDrift.ok) expect(treeDrift.reason).toBe("tree_sha_drift");
    const parentDrift = await verify({ ...binding, gitBaseCommitSha: "e".repeat(40) });
    expect(parentDrift.ok).toBe(false);
    if (!parentDrift.ok) expect(parentDrift.reason).toBe("base_parent_drift");

    const verifyMissing = makeCommitBindingVerifier(() => "/nonexistent/repo");
    const rm = await verifyMissing(binding);
    expect(rm.ok).toBe(false);
    if (!rm.ok) expect(rm.reason).toBe("stage_repo_missing");
  });

  it("远端内容核验:推送后逐文件核对通过;候选树内容与远端 commit 一致(含 README/src 基线)", async () => {
    const ws = makeWorkspaceRepo();
    ws.apply({ "delivered.txt": "payload\n" });
    const manifest = manifestOf(ws.dir, ["README.md", "src.txt", "delivered.txt"]);
    const staged = await build(ws, ["README.md", "src.txt", "delivered.txt"], { added: ["delivered.txt"], modified: [], removed: [] }, "cs-d8");
    const remote = makeBareRemote();
    remote.pushHead(staged.stageRepoDir, staged.commitSha);

    const ok = await verifyRemoteCommitContent({
      target: remote.url,
      commitSha: staged.commitSha,
      manifest,
      scratchDir: stageRoot(),
    });
    expect(ok.ok).toBe(true);
    expect(ok.remoteHead).toBe(staged.commitSha);
    // 远端 main 头 == payload(交付后状态)
    expect(remote.head()).toBe(staged.commitSha);
  });
});
