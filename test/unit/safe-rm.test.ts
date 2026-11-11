// P0-总包阶段 D4:清理安全中央守卫回归(纯逻辑;不依赖"权限碰巧不足")。
// 危险路径逐一拒绝:/、/tmp、tmpdir、HOME 本体、仓库根及子树、roots 外、无哨兵、
// symlink 逃逸、相对路径;合法路径(本次创建+哨兵)放行;force 语义保持。
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { markRunDir, markTemp, safeRm, SafeRmRefusalError, REPO_ROOT, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";

const guarded: string[] = []; // 打过哨兵的目录:afterAll 走 safeRm(守卫自证)
const raw: string[] = [];     // 故意无哨兵的夹具:afterAll 仅原始清理(它们正是"守卫要拒"的对象)

describe("D4:safeRm 中央守卫", () => {
  afterAll(() => {
    for (const k of guarded) {
      if (existsSync(k)) safeRm(k, { roots: guarded, sentinel: RUN_SENTINEL });
    }
    for (const k of raw) rmSync(k, { recursive: true, force: true });
  });

  it("拒绝绝对禁止面:/、/tmp、tmpdir、HOME 本体(即使误声明进 roots)", () => {
    for (const target of ["/", "/tmp", tmpdir(), homedir()]) {
      expect(() => safeRm(target, { roots: [target], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    }
  });

  it("拒绝仓库根及其子树(tracked 内容不可删;sentinel 必填由类型层强制——省略即编译错误)", () => {
    expect(() => safeRm(REPO_ROOT, { roots: [REPO_ROOT], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    expect(() => safeRm(join(REPO_ROOT, "src"), { roots: [join(REPO_ROOT, "src")], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    expect(() => safeRm(join(REPO_ROOT, "test", "fixtures"), { roots: [REPO_ROOT], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
  });

  it("拒绝 roots 之外路径(含其他项目目录)与未声明 roots、相对路径", () => {
    const mine = markTemp(mkdtempSync(join(tmpdir(), "d4-mine-")));
    guarded.push(mine);
    const others = markTemp(mkdtempSync(join(tmpdir(), "d4-others-")));
    guarded.push(others);
    expect(() => safeRm(others, { roots: [mine], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    expect(() => safeRm(mine, { roots: [], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    expect(() => safeRm("some/relative/dir", { roots: [mine], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
  });

  it("拒绝无哨兵目标(目录非本运行创建/记录丢失;子目录同样拒)", () => {
    const unmarked = mkdtempSync(join(tmpdir(), "d4-unmarked-")); // 故意不打哨兵
    raw.push(unmarked);
    expect(() => safeRm(unmarked, { roots: [unmarked], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
    const sub = join(unmarked, "sub");
    mkdirSync(sub, { recursive: true });
    expect(() => safeRm(sub, { roots: [unmarked], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
  });

  it("拒绝 symlink 逃逸:目标 realpath 越出声明的 roots", () => {
    const mine = markTemp(mkdtempSync(join(tmpdir(), "d4-sym-")));
    guarded.push(mine);
    const victim = markTemp(mkdtempSync(join(tmpdir(), "d4-victim-")));
    guarded.push(victim);
    symlinkSync(victim, join(mine, "escape"));
    // 声明 root=mine,但目标 realpath=victim(不在 mine 内)⇒ 拒
    expect(() => safeRm(victim, { roots: [mine], sentinel: RUN_SENTINEL })).toThrow(SafeRmRefusalError);
  });

  it("放行:本次创建+哨兵的目录(子路径经父链哨兵放行;父目录不受波及)", () => {
    const mine = markTemp(mkdtempSync(join(tmpdir(), "d4-ok-")));
    const sub = join(mine, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.txt"), "x", "utf8");
    safeRm(sub, { roots: [mine], sentinel: RUN_SENTINEL });
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    safeRm(mine, { roots: [mine], sentinel: RUN_SENTINEL });
    expect(existsSync(mine)).toBe(false);
  });

  it("force 语义:目标不存在 ⇒ no-op;markRunDir 幂等创建哨兵", () => {
    const ghost = join(tmpdir(), `d4-ghost-${Date.now()}`);
    expect(safeRm(ghost, { roots: [ghost], sentinel: RUN_SENTINEL })).toEqual({ ok: true });
    markRunDir(ghost, { test: true });
    expect(existsSync(join(ghost, RUN_SENTINEL))).toBe(true);
    safeRm(ghost, { roots: [ghost], sentinel: RUN_SENTINEL });
    expect(existsSync(ghost)).toBe(false);
  });
});
