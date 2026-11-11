// P0-02A C-1:Candidate ChangeSet——清单快照/对比/sha 绑定/影响面核验 + runner 集成(stub)。
// 语义:candidate_sha = 工作区清单内容 sha256(Worker 侧可信采集);requirement_sha = 需求快照;
// 变更集绑定 task/run/attempt;失败 Run 无候选。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { markRunDir, markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import {
  diffManifests,
  manifestSha,
  requirementSha,
  impactScope,
  recordChangeset,
  latestChangeset,
  sha256Hex,
  type WorkspaceManifest,
} from "../../src/core/changesets.ts";
import { snapshotManifest } from "../../src/runtime/workspace-manifest.ts";
import { createHash } from "node:crypto";
import { assertOk } from "../setup/assert.ts";
import type { Exec } from "../../src/core/db.ts";

function m(entries: Array<[string, string]>): WorkspaceManifest {
  return new Map(entries);
}

describe("Candidate ChangeSet(清单/对比/绑定)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("c1-changesets");
    await t.db.execute(sql`INSERT INTO tasks (id, state) VALUES ('t-cs', 'READY')`);
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome)
      VALUES ('run-cs-1', 't-cs', 1, 'stub', 'stub/gm', 'host-fallback', 'SUCCEEDED')
    `);
  });
  afterAll(() => t.cleanup());

  it("snapshotManifest:递归清单 + .relay 排除 + 符号链接跳过", () => {
    const root = join(tmpdir(), `relay-manifest-${process.pid}`);
    markRunDir(root, { kind: "manifest-test" });
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(join(root, ".relay"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "A");
    writeFileSync(join(root, "sub", "b.txt"), "B");
    writeFileSync(join(root, ".relay", "tool-audit.jsonl"), '{"x":1}');
    symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
    const man = snapshotManifest(root);
    expect(man.get("a.txt")).toBe(createHash("sha256").update("A").digest("hex"));
    expect(man.get("sub/b.txt")).toBe(createHash("sha256").update("B").digest("hex"));
    expect(man.has(".relay/tool-audit.jsonl")).toBe(false); // Worker 审计目录不算候选内容
    expect(man.has("link.txt")).toBe(false); // 不追随链接(防逃逸)
    safeRm(root, { roots: [root], sentinel: RUN_SENTINEL });
  });

  it("diff/manifestSha:增改删分类 + sha 与顺序无关且内容敏感", () => {
    const base = m([["keep.txt", "k"], ["mod.txt", "old"], ["del.txt", "d"]]);
    const cand = m([["keep.txt", "k"], ["mod.txt", "new"], ["add.txt", "a"]]);
    const diff = diffManifests(base, cand);
    expect(diff).toEqual({ added: ["add.txt"], modified: ["mod.txt"], removed: ["del.txt"] });
    // sha 与插入顺序无关
    expect(manifestSha(base)).toBe(manifestSha(m([["del.txt", "d"], ["mod.txt", "old"], ["keep.txt", "k"]])));
    // 内容敏感
    expect(manifestSha(base)).not.toBe(manifestSha(cand));
    expect(manifestSha(new Map())).toBe(sha256Hex("[]"));
  });

  it("requirementSha:goal 文本/约束变化即变化;impactScope:前缀边界核验", () => {
    const req = { goalText: "g", taskId: "t", allowedScope: ["/workspace"], allowedCommands: ["echo"] };
    expect(requirementSha(req)).toBe(requirementSha({ ...req, allowedCommands: ["echo"] }));
    expect(requirementSha(req)).not.toBe(requirementSha({ ...req, goalText: "g2" }));
    expect(requirementSha(req)).not.toBe(requirementSha({ ...req, allowedCommands: [] }));
    // 前缀边界:/workspace2 不算 /workspace 内
    const diff = { added: ["/workspace/f.txt", "/workspace2/evil.txt"], modified: [], removed: [] };
    const impact = impactScope(diff, ["/workspace"]);
    expect(impact.inScope).toEqual(["/workspace/f.txt"]);
    expect(impact.violations).toEqual(["/workspace2/evil.txt"]);
  });

  it("recordChangeset + latestChangeset:落库/审计/绑定往返", async () => {
    const base = m([["brief.txt", "seed"]]);
    const cand = m([["brief.txt", "seed"], ["result.txt", "r1"]]);
    const cs = await t.db.transaction(async (tx) =>
      recordChangeset(tx as unknown as Exec, {
        taskId: "t-cs",
        runId: "run-cs-1",
        attempt: 1,
        base,
        candidate: cand,
        requirement: { goalText: "求和", taskId: "t-cs", allowedScope: ["/workspace"], allowedCommands: ["echo"] },
      }),
    );
    expect(cs.diff.added).toEqual(["result.txt"]);
    expect(cs.violations).toEqual([]);
    const row = await latestChangeset(t.db as unknown as Exec, "t-cs");
    expect(row).not.toBeNull();
    expect(row!.candidateSha).toBe(cs.candidateSha);
    expect(row!.requirementSha).toBe(cs.requirementSha);
    expect(row!.runId).toBe("run-cs-1");
    expect(row!.changedFiles.added).toEqual(["result.txt"]);
    const audit = await t.db.execute(sql`SELECT action FROM audit_events WHERE task_id='t-cs' AND action='CHANGESET_RECORDED'`);
    expect(audit.rows.length).toBe(1);
  });
});
