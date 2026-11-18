// REWORK 定向反例:seedWorkspaceFromProject 废止 cp -a「含未提交改动全量保真」假设。
// 口径:项目目录 → 对话框目录 = 按注册 Git 项目当前 HEAD 的**隔离干净工作副本**
// (git fetch HEAD + reset --hard;只携带已提交内容;.git 存在 ⇒ 候选 commit 链可用)。
// 源项目存在未提交 tracked/untracked 改动 ⇒ FAIL-CLOSED(assertProjectSeedable 先验)。
// 三禁反例:①不误交付(脏状态进不了工作副本,即进不了交付链);
//           ②不误忽略(抛错即拒,绝不静默跳过继续用旧种子);
//           ③不吞入(用户本地修改在源目录原样保留,不被纳入任何副本/不被回滚)。
// 零 DB、零模型、零网络;临时目录用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProjectSeedable, seedWorkspaceFromProject } from "../../src/server/project-binding.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** 干净 Git 项目(两提交;README/src.txt 已提交;.gitignore 已提交且忽略 build/ 工件)。 */
function makeCleanProject(base: string, name: string): { dir: string; head: string } {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.email", "proj@localhost");
  git(dir, "config", "user.name", "Proj");
  writeFileSync(join(dir, ".gitignore"), "build/\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# 项目\n", "utf8");
  writeFileSync(join(dir, "src.txt"), "committed-content\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "c1");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "c2");
  return { dir, head: git(dir, "rev-parse", "HEAD").trim() };
}

describe("REWORK:seedWorkspaceFromProject = HEAD 干净副本 + 脏项目 FAIL-CLOSED(定向反例)", () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "seed-rework-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ws(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, ".relay"), { recursive: true }); // 与 runner.prepareRunDirs 同形:预置系统目录
    return dir;
  }

  it("正链(干净项目):副本 HEAD == 源 HEAD;零 remote 隔离;gitignore 工件不混入;.relay 保留", () => {
    const p = makeCleanProject(root, "clean");
    // gitignore 工件:源目录在场但不构成改动(与 git 同口径);副本不得携带
    mkdirSync(join(p.dir, "build"), { recursive: true });
    writeFileSync(join(p.dir, "build", "artifact.txt"), "junk\n", "utf8");
    expect(git(p.dir, "status", "--porcelain")).toBe("");
    const w = ws("ws-clean");
    seedWorkspaceFromProject(p.dir, w);
    expect(existsSync(join(w, ".git"))).toBe(true);
    expect(git(w, "rev-parse", "HEAD").trim()).toBe(p.head);
    expect(git(w, "status", "--porcelain")).toBe("");
    expect(git(w, "remote")).toBe(""); // 隔离:副本与源项目零持续关联(无 remote 可 fetch/push)
    expect(git(w, "log", "--oneline")).toContain("c2"); // HEAD 可达历史在副本中
    expect(existsSync(join(w, "src.txt"))).toBe(true);
    expect(existsSync(join(w, "build", "artifact.txt"))).toBe(false); // 干净副本:仅 HEAD 内容
    expect(existsSync(join(w, ".relay"))).toBe(true); // 预置系统目录不受 reset 影响
    // 源目录工件原样(只读面零触碰)
    expect(existsSync(join(p.dir, "build", "artifact.txt"))).toBe(true);
  });

  it("反例:detached HEAD 源(干净)⇒ 副本精确锚定该提交", () => {
    const p = makeCleanProject(root, "detached");
    git(p.dir, "checkout", "--quiet", "--detach", "HEAD~1");
    const detachedHead = git(p.dir, "rev-parse", "HEAD").trim();
    const w = ws("ws-detached");
    seedWorkspaceFromProject(p.dir, w);
    expect(git(w, "rev-parse", "HEAD").trim()).toBe(detachedHead);
    expect(git(w, "status", "--porcelain")).toBe("");
  });

  it("反例:未提交 tracked 修改 ⇒ FAIL-CLOSED;用户修改原样保留(不吞入);副本零种子(不误交付)", () => {
    const p = makeCleanProject(root, "dirty-tracked");
    writeFileSync(join(p.dir, "src.txt"), "USER-LOCAL-EDIT\n", "utf8");
    const w = ws("ws-dirty-tracked");
    expect(() => seedWorkspaceFromProject(p.dir, w)).toThrow(/project_dirty_uncommitted:1/);
    // 三禁之②不误忽略:抛错即拒,绝不静默继续
    // 三禁之③不吞入:用户本地修改在源目录原样保留
    expect(existsSync(join(p.dir, "src.txt"))).toBe(true);
    expect(execFileSync("cat", [join(p.dir, "src.txt")], { encoding: "utf8" })).toBe("USER-LOCAL-EDIT\n");
    // 三禁之①不误交付:脏状态从未进入工作副本(先验在 git init 之前抛出)
    expect(existsSync(join(w, ".git"))).toBe(false);
    expect(existsSync(join(w, "src.txt"))).toBe(false);
  });

  it("反例:untracked 文件 ⇒ FAIL-CLOSED;文件原样保留在源目录(不吞入、不误忽略)", () => {
    const p = makeCleanProject(root, "dirty-untracked");
    writeFileSync(join(p.dir, "user-local.txt"), "USER-UNTRACKED\n", "utf8");
    const w = ws("ws-dirty-untracked");
    expect(() => seedWorkspaceFromProject(p.dir, w)).toThrow(/project_dirty_uncommitted:1/);
    expect(execFileSync("cat", [join(p.dir, "user-local.txt")], { encoding: "utf8" })).toBe("USER-UNTRACKED\n");
    expect(existsSync(join(w, ".git"))).toBe(false);
    expect(existsSync(join(w, "user-local.txt"))).toBe(false);
  });

  it("反例:已暂存未提交(git add)⇒ FAIL-CLOSED(porcelain 计入暂存面)", () => {
    const p = makeCleanProject(root, "dirty-staged");
    writeFileSync(join(p.dir, "src.txt"), "STAGED-EDIT\n", "utf8");
    git(p.dir, "add", "src.txt");
    const w = ws("ws-dirty-staged");
    expect(() => seedWorkspaceFromProject(p.dir, w)).toThrow(/project_dirty_uncommitted/);
    expect(existsSync(join(w, ".git"))).toBe(false);
  });

  it("反例(独立复核 fail-open 根因):HEAD 可读但工作树状态不可验证 ⇒ 拒绝(绝不误判 clean)", () => {
    const p = makeCleanProject(root, "status-unverifiable");
    // 独立复核指认类:.git/index 不可读 ⇒ git status 无法可靠验证,而 HEAD/refs 探针仍成功
    // (实测:rev-parse --git-dir=0 / rev-parse HEAD=0 / status exit 128)。旧实现把 status 探针
    // 失败吞成空串 ⇒ 误判 clean 放行(fail-open)。此处用确定性损坏(垃圾字节)建模该类:
    // chmod 000 在 root 下不构成读取障碍,损坏对任意 uid 恒成立。必须拒绝(FAIL-CLOSED),
    // 错误 reason 固定前缀,不回显 git stderr/用户文件名。
    writeFileSync(join(p.dir, ".git", "index"), "corrupted-index-bytes\n", "utf8");
    const w = ws("ws-status-unverifiable");
    expect(() => assertProjectSeedable(p.dir)).toThrow(/project_status_unverifiable/);
    expect(() => seedWorkspaceFromProject(p.dir, w)).toThrow(/project_status_unverifiable/);
    expect(existsSync(join(w, ".git"))).toBe(false); // 零种子:不可验证状态进不了工作副本
  });

  it("反例:先验与种子同一判据 —— assertProjectSeedable 返回 HEAD sha;脏项目同名拒绝", () => {
    const p = makeCleanProject(root, "assert-clean");
    expect(assertProjectSeedable(p.dir)).toBe(p.head);
    writeFileSync(join(p.dir, "x.txt"), "dirty\n", "utf8");
    expect(() => assertProjectSeedable(p.dir)).toThrow(/project_dirty_uncommitted:1/);
  });

  it("反例:非 Git 目录 ⇒ project_not_a_git_repo;git init 无提交 ⇒ project_no_commits;目录缺失 ⇒ project_path_not_a_directory", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "f.txt"), "x\n", "utf8");
    expect(() => seedWorkspaceFromProject(plain, ws("ws-plain"))).toThrow(/project_not_a_git_repo/);
    const unborn = join(root, "unborn");
    mkdirSync(unborn, { recursive: true });
    git(unborn, "init", "--quiet", "--initial-branch=main");
    expect(() => seedWorkspaceFromProject(unborn, ws("ws-unborn"))).toThrow(/project_no_commits/);
    expect(() => seedWorkspaceFromProject(join(root, "missing"), ws("ws-missing"))).toThrow(
      /project_path_not_a_directory/,
    );
  });

  it("反例:dirty 拒绝面错误信息只含计数,不回显用户文件名(错误面可能进审计/决策卡)", () => {
    const p = makeCleanProject(root, "no-filename-leak");
    writeFileSync(join(p.dir, "secret-file-name.txt"), "v\n", "utf8");
    let msg = "";
    try {
      seedWorkspaceFromProject(p.dir, ws("ws-leak"));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("project_dirty_uncommitted:1");
    expect(msg).not.toContain("secret-file-name");
  });
});
