// P0-ACCEPT 缺口 F:备份与恢复实证(真实 pg_dump + 隔离实例恢复 + 全实体核对)。
//  1) 备份:对填充了全部 13 表实体行的 schema 执行 pg_dump(宿主 pg_dump,退回 docker exec relay-p000-pg);
//  2) 恢复:起一次性隔离 PG16 容器(独立实例,非同实例重启),CREATE DATABASE 后导入备份;
//  3) 核对:13 表逐表行数 + 全行 JSON 摘要 md5 两库一致(实体零丢失/零漂移);
//  4) 外部 Git:恢复后 bare 远端 HEAD 仍 == candidate_changesets.git_commit_sha(外部事实不被恢复动作改变)。
// 不允许以"简单重启"代替:恢复目标是**新起的独立实例**。
// 门:docker(起隔离恢复实例)+ pg_dump;缺一显式 skip(不假装)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";

const TABLES = [
  "goals", "tasks", "leases", "runs", "sessions", "candidate_changesets",
  "task_gate_verdicts", "action_proposals", "gate_evidence", "action_intents",
  "decisions", "budget_ledger", "audit_events",
] as const;

function hostPgDumpAvailable(): boolean {
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
/** 宿主无 pg_dump 时退回测试 PG 容器内的 client(容器名/凭据与 scripts/test-db-up.sh 同源)。 */
function relayPgContainerDumpAvailable(): boolean {
  try {
    execFileSync("docker", ["exec", "relay-p000-pg", "pg_dump", "--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
const dumpOk = hostPgDumpAvailable() || relayPgContainerDumpAvailable();
const useContainerDump = !hostPgDumpAvailable() && relayPgContainerDumpAvailable();
const dockerOk = dockerAvailable();
console.log(`[缺口 F 门控] pg_dump=${hostPgDumpAvailable()} container_pg_dump=${relayPgContainerDumpAvailable()} docker=${dockerOk} 走容器导出=${useContainerDump}`);

describe.skipIf(!dumpOk || !dockerOk)("P0-ACCEPT 缺口 F:备份 → 隔离实例恢复 → 全实体核对", { timeout: 300_000 }, () => {
  let t: TestDb;
  let backupFile: string;
  let tmpRoot = "";
  let container = "p0acc-restore-pg";
  let restorePort = "";
  let remote: BareRemoteFixture;
  let dumpStdout = "";

  beforeAll(async () => {
    t = await createTestDb("p0acc-backup");
    tmpRoot = mkdtempSync(join(tmpdir(), "p0acc-backup-"));
    backupFile = join(tmpRoot, "relay-backup.sql");
    remote = makeBareRemote(mkdtempSync(join(tmpRoot, "remote-")));

    // ---- 填充全部实体(FK 顺序;内容含中文与 jsonb,验证保真)----
    await planGoal(t.db, {
      id: "goal-bak-1",
      rawInput: "备份恢复演练目标:中文保真 + jsonb 保真",
      budget: { modelCalls: 8, tokensIn: 1000, tokensOut: 500, wallSeconds: 600 },
      tasks: [{ id: "task-bak-1", goalText: "备份任务", allowedScope: ["/workspace"], allowedCommands: ["echo"], priority: 2, maxAttempts: 3 }],
    });
    await t.db.execute(sql`
      INSERT INTO leases (task_id, owner_id, fencing_token, lease_expires_at)
      VALUES ('task-bak-1', 'worker-bak', 1, now() + interval '1 hour')
    `);
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, model_ref, input_commit_sha, budget, sandbox, outcome, detail)
      VALUES ('run-bak-1', 'task-bak-1', 1, 'magpie/group/gm', '0123456789abcdef0123456789abcdef01234567',
        '{"reserveCallsPerRun":4}', 'docker', 'SUCCEEDED', '{"reason":"备份演练","toolEvents":[{"type":"tool_result","name":"relay_exec","denied":false}]}')
    `);
    await t.db.execute(sql`
      INSERT INTO sessions (id, run_id, checkpoint_ref, handoff_ref, context_digest, resume_mode)
      VALUES ('sess-bak-1', 'run-bak-1', NULL, '{"status":"done","summary":"演练"}', 'digest-bak', 'context_rebuild')
    `);
    await t.db.execute(sql`
      INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha,
        changed_files, impact_scope, git_base_commit_sha, git_tree_sha, git_commit_sha,
        delivery_state, delivery_intent_id, delivered_at, delivered_remote_head)
      VALUES ('cs-bak-1', 'task-bak-1', 'run-bak-1', 1,
        'aaaa', 'bbbb', 'req-sha-bak', '{"added":["result.txt"],"modified":[],"removed":[]}',
        '{"inScope":["result.txt"],"violations":[]}',
        '1111222233334444555566667777888899990000', 'tree-sha-bak-40-digits-aaaaaaaaaaaaaaa', 'COMMITSHA',
        'DELIVERED', 'intent-bak-1', now(), 'COMMITSHA')
    `);
    // 外部 Git:让 bare 远端 main 真实存在(种子 commit),changeset 的 commit 面用真实 sha
    const seedWs = join(tmpRoot, "seed-ws");
    mkdirSync(seedWs, { recursive: true });
    execFileSync("git", ["-C", seedWs, "init", "--initial-branch=main"], { encoding: "utf8" });
    execFileSync("git", ["-C", seedWs, "config", "user.email", "s@l"], { encoding: "utf8" });
    execFileSync("git", ["-C", seedWs, "config", "user.name", "s"], { encoding: "utf8" });
    writeFileSync(join(seedWs, "seed.txt"), "seed\n", "utf8");
    execFileSync("git", ["-C", seedWs, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", seedWs, "commit", "--quiet", "-m", "seed"], { encoding: "utf8" });
    execFileSync("git", ["-C", seedWs, "push", "--quiet", remote.dir, "main"], { encoding: "utf8" });
    const realSha = remote.head();
    expect(realSha).toMatch(/^[0-9a-f]{40}$/);
    await t.db.execute(sql`UPDATE candidate_changesets SET git_commit_sha=${realSha}, delivered_remote_head=${realSha} WHERE id='cs-bak-1'`);
    await t.db.execute(sql`
      INSERT INTO task_gate_verdicts (id, task_id, commit_ref, verdict, reviewer, attempt, candidate_sha,
        requirement_sha, test_env, reviewer_run_id, coder_run_id, evidence_ids, consumed_at, consumed_by)
      VALUES ('gate-bak-1', 'task-bak-1', NULL, 'PASS', 'reviewer-bak', 1, 'bbbb', 'req-sha-bak',
        '{"mode":"docker"}', 'run-bak-1', 'run-bak-1', '["ev-bak-1"]', now(), 'gate-orchestrator-bak')
    `);
    await t.db.execute(sql`
      INSERT INTO action_proposals (id, task_id, attempt, changeset_id, gate_verdict_id, capability, target,
        branch, expected_remote_sha, commit_sha, state, policy_detail)
      VALUES ('prop-bak-1', 'task-bak-1', 1, 'cs-bak-1', 'gate-bak-1', 'delivery.github.push', 'target-bak',
        'main', '0123456789abcdef0123456789abcdef01234567', 'commit-sha-bak', 'CONSUMED', '{"allowedRepos":["target-bak"]}')
    `);
    await t.db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES ('ev-bak-1', 'task-bak-1', 1, 'bbbb', 'deterministic_test', true, 'result ok: sum=87 present(保真:中文证据)',
        '{"host":"vm80"}', 'sha256-bak', 'worker-bak')
    `);
    await t.db.execute(sql`
      INSERT INTO action_intents (id, task_id, idempotency_key, capability, target, branch, expected_remote_sha,
        payload_sha, state, reconcile_rule, deadline)
      VALUES ('intent-bak-1', 'task-bak-1', 'idem-bak-1', 'delivery.github.push', 'target-bak', 'main',
        '0123456789abcdef0123456789abcdef01234567', 'payload-sha-bak', 'COMPLETED', 'CHECK_THEN_DECIDE', now() + interval '1 hour')
    `);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, fallback, deadline, state, verdict, decided_by, decided_at)
      VALUES ('dec-bak-1', 'task-bak-1', 'goal-bak-1', 'D3', '是否批准交付到远端?', NULL, now() + interval '1 day', 'RESOLVED_MANUAL',
        '{"approved":true}', 'owner', now())
    `);

    // ---- 备份:pg_dump 整个 schema(宿主工具,退回测试 PG 容器内 client;真实产物落盘)----
    if (useContainerDump) {
      const dumpOut = execFileSync("docker", ["exec", "relay-p000-pg", "pg_dump",
        "--schema=" + t.schemaName, "--no-owner", "--no-privileges", "-U", "postgres", "relayp000"],
        { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      writeFileSync(backupFile, dumpOut);
    } else {
      execFileSync("pg_dump", ["--schema=" + t.schemaName, "--no-owner", "--no-privileges", "--file", backupFile, t.url],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    }
    expect(existsSync(backupFile), "备份文件应存在").toBe(true);
    dumpStdout = execFileSync("wc", ["-c", backupFile], { encoding: "utf8" }).trim();
    console.log(`[缺口 F] pg_dump 完成:${dumpStdout}`);
  });

  afterAll(async () => {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 30_000 }); } catch {}
    await t.cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("隔离实例恢复 + 13 表全实体核对 + 外部 Git 状态不变", async () => {
    // ---- 隔离实例:一次性 PG 容器(随机宿主端口;镜像用本地已有版,代理故障时拉不了新镜像)----
    const image = process.env.RELAY_RESTORE_PG_IMAGE ?? "postgres:17-alpine";
    execFileSync("docker", ["run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=restore", "-e", "POSTGRES_DB=relay_restore",
      "-p", "127.0.0.1::5432", image], { stdio: "ignore", timeout: 120_000 });
    const portLine = execFileSync("docker", ["port", container, "5432"], { encoding: "utf8" }).trim();
    restorePort = portLine.split("\n")[0]!.split(":").pop()!;
    // 就绪等待(pg_isready 容器内自检)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        execFileSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore", timeout: 5_000 });
        ready = true;
        break;
      } catch { execFileSync("sleep", ["1"]); }
    }
    expect(ready, "隔离恢复实例应就绪").toBe(true);
    console.log(`[缺口 F] 隔离实例就绪:127.0.0.1:${restorePort}(relay_restore)`);

    // ---- 恢复:psql 导入备份 ----
    const dump = execFileSync("cat", [backupFile]);
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "relay_restore", "-v", "ON_ERROR_STOP=1", "-q"],
      { input: dump, timeout: 120_000 });
    console.log("[缺口 F] psql 恢复完成(ON_ERROR_STOP=1 零错误)");

    // ---- 核对:13 表行数 + 全行摘要一致 ----
    const snapshot = async (tag: string): Promise<Record<string, { rows: number; digest: string }>> => {
      const out: Record<string, { rows: number; digest: string }> = {};
      for (const tbl of TABLES) {
        const c = await t.db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(tbl)}`);
        const d = await t.db.execute(
          sql`SELECT md5(coalesce(json_agg(x)::text, '[]')) AS digest FROM (SELECT * FROM ${sql.identifier(tbl)} ORDER BY 1) x`,
        );
        out[`${tag}:${tbl}`] = { rows: Number(c.rows[0]!["n"]), digest: String(d.rows[0]!["digest"]) };
      }
      return out;
    };
    // 摘要 SQL 对隔离实例执行:经 psql -tA 输出(逐表)
    const restoreSnapshot: Record<string, { rows: number; digest: string }> = {};
    for (const tbl of TABLES) {
      const count = execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "relay_restore", "-tA", "-c",
        `SELECT count(*) FROM ${t.schemaName}.${tbl}`], { encoding: "utf8" }).trim();
      const digest = execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "relay_restore", "-tA", "-c",
        `SELECT md5(coalesce(json_agg(x)::text,'[]')) FROM (SELECT * FROM ${t.schemaName}.${tbl} ORDER BY 1) x`], { encoding: "utf8" }).trim();
      restoreSnapshot[tbl] = { rows: Number(count), digest };
    }
    const backupSnapshot = await snapshot("bak");
    for (const tbl of TABLES) {
      const b = backupSnapshot[`bak:${tbl}`]!;
      const r = restoreSnapshot[tbl]!;
      expect(r.rows, `${tbl} 行数应一致`).toBe(b.rows);
      expect(r.digest, `${tbl} 全行摘要应一致(实体零漂移)`).toBe(b.digest);
    }
    // 代表行内容抽查(中文/jsonb 保真)
    const g = execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "relay_restore", "-tA", "-c",
      `SELECT raw_input FROM ${t.schemaName}.goals WHERE id='goal-bak-1'`], { encoding: "utf8" }).trim();
    expect(g).toContain("中文保真");
    // ---- 外部 Git:恢复动作不改变外部事实 ----
    const cs = await t.db.execute(sql`SELECT git_commit_sha FROM candidate_changesets WHERE id='cs-bak-1'`);
    const remoteHead = execFileSync("git", ["-C", remote.dir, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    expect(remoteHead).toBe(String(cs.rows[0]!["git_commit_sha"]));
    console.log(`[缺口 F] 外部 Git HEAD 不变:${remoteHead.slice(0, 12)};13 表行数+摘要全部一致`);
  });
});
