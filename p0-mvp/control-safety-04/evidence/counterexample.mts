// RELAY-CONTROL-SAFETY-04 反例留证脚本(对旧代码 9feeb3d 运行;随包入库作为证据)。
// 四组反例:P0-A 沙箱逃逸 ×4 / P0-B 停止交付竞争 ×2 / P1-C 审计缺字段 / C5 并发双插。
// 全部使用无敏感信息测试变量与临时目录;零真实远端写入(bare 仓库);零模型调用。
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";

// 相对导入(脚本位于仓库内;运行方式:npx tsx p0-mvp/control-safety-04/evidence/counterexample.mts)
const evidence: string[] = [];
const line = (s: string) => {
  console.log(s);
  evidence.push(s);
};

// ---------- P0-A:旧 runCheck 宿主执行面 ----------
const { runCheck } = await import(`../../../src/core/evidence.ts`);

// A1: 哨兵环境变量泄漏(候选检查读取 Worker 全量环境)
const sentinel = `cx-secret-${randomUUID().slice(0, 8)}`;
process.env.RELAY_CX_SENTINEL = sentinel;
{
  const ws = mkdtempSync(join(tmpdir(), "relay-cx-ws-"));
  const r = await runCheck(
    { kind: "deterministic_test", command: ["node", "-e", "console.log('LEAK=' + (process.env.RELAY_CX_SENTINEL ?? 'absent'))"], cwdWorkspace: true },
    ws,
  );
  line(`A1 env-leak: passed=${r.passed} env.mode=${r.env.mode} leak=${r.rawOutput.includes(sentinel) ? "YES(缺陷:候选读到 Worker 哨兵变量)" : "no"}`);
  line(`A1 rawOutput=${JSON.stringify(r.rawOutput.slice(0, 120))}`);
  rmSync(ws, { recursive: true, force: true });
}

// A2: cwdWorkspace=false 落宿主 cwd(宿主仓库根可见)
{
  const ws = mkdtempSync(join(tmpdir(), "relay-cx-ws-"));
  const r = await runCheck(
    { kind: "deterministic_test", command: ["node", "-e", "console.log('CWD=' + process.cwd())"], cwdWorkspace: false },
    ws,
  );
  const onHostRepo = r.rawOutput.includes(process.cwd());
  line(`A2 host-cwd: 实际cwd=${JSON.stringify((r.rawOutput.split("\n").find((l) => l.startsWith("CWD=")) ?? "").slice(0, 80))} 宿主仓库根=${onHostRepo ? "YES(缺陷)" : "no"} env.mode=${r.env.mode}`);
  rmSync(ws, { recursive: true, force: true });
}

// A3: 任意 argv 以宿主权限写工作区外哨兵路径
{
  const ws = mkdtempSync(join(tmpdir(), "relay-cx-ws-"));
  const outside = join(mkdtempSync(join(tmpdir(), "relay-cx-outside-")), "sentinel.txt");
  const r = await runCheck(
    { kind: "deterministic_test", command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(outside)}, 'host-write'); console.log('WROTE-OUTSIDE')`], cwdWorkspace: true },
    ws,
  );
  const landed = existsSync(outside) && readFileSync(outside, "utf8") === "host-write";
  line(`A3 outside-write: passed=${r.passed} 宿主哨兵文件落盘=${landed ? "YES(缺陷:候选检查可写宿主任意路径)" : "no"}`);
  if (landed) rmSync(outside, { force: true });
  rmSync(ws, { recursive: true, force: true });
}

// A4: 子进程创建孙进程后超时 —— execFile 只杀直接子进程,孙进程残留宿主
{
  const ws = mkdtempSync(join(tmpdir(), "relay-cx-ws-"));
  const pidFile = join(mkdtempSync(join(tmpdir(), "relay-cx-pid-")), "gp.pid");
  const cmd = `const {spawn}=require('child_process');const fs=require('fs');const gp=spawn('sleep',['300'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)}, String(gp.pid));gp.unref();setTimeout(()=>{},30000);`;
  const r = await runCheck(
    { kind: "deterministic_test", command: ["node", "-e", cmd], cwdWorkspace: true, timeoutMs: 1500 },
    ws,
  );
  await new Promise((res) => setTimeout(res, 800));
  let grandpidAlive = false;
  try {
    const pid = readFileSync(pidFile, "utf8").trim();
    process.kill(Number(pid), 0);
    grandpidAlive = true;
    process.kill(Number(pid), "SIGKILL");
  } catch {
    grandpidAlive = false;
  }
  line(`A4 timeout-residue: passed=${r.passed} timeoutMarker=${r.rawOutput.includes("TIMEOUT")} 孙进程宿主残留=${grandpidAlive ? "YES(缺陷:超时后孙进程仍活在宿主)" : "no"}`);
  rmSync(ws, { recursive: true, force: true });
}

// ---------- P0-B:停止/交付竞争(隔离 bare 仓库;零真实远端写入) ----------
const { createTestDb } = await import(`../../../test/setup/testdb.ts`);
const { requestTaskAbort } = await import(`../../../src/core/ops.ts`);
const { proposeDelivery, executeDelivery } = await import(`../../../src/core/delivery.ts`);
const { makeWorkspaceRepo, makeBareRemote } = await import(`../../../test/helpers/git-fixture.ts`);
const { createGitPushExecutor } = await import(`../../../src/core/executors/git-push.ts`);
const { verifyRemoteCommitContent, makeCommitBindingVerifier } = await import(`../../../src/runtime/git-candidate.ts`);
const { snapshotManifest } = await import(`../../../src/runtime/workspace-manifest.ts`);

const t = await createTestDb("relay_cx_04");
try {
  const goalId = `g-cx-${randomUUID().slice(0, 8)}`;
  const taskId = `t-cx-${randomUUID().slice(0, 8)}`;
  const runId = `run-cx-${randomUUID().slice(0, 8)}`;
  const ws = makeWorkspaceRepo();
  ws.apply({ "delivered.txt": "candidate-content\n" });
  execFileSync("git", ["-C", ws.dir, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", ws.dir, "commit", "--quiet", "-m", "candidate"], { encoding: "utf8" });
  const candidateSha = execFileSync("git", ["-C", ws.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseSha = ws.baseCommitSha;
  const treeSha = execFileSync("git", ["-C", ws.dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();

  await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'cx goal', 'ACTIVE')`);
  await t.db.execute(sql`
    INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands, gate_required, attempt, max_attempts)
    VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]', '[]', true, 1, 3)`);
  await t.db.execute(sql`
    INSERT INTO runs (id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, sandbox, outcome)
    VALUES (${runId}, ${taskId}, 1, 'stub', 'stub/gm', ${baseSha}, '{}', 'host-fallback', 'SUCCEEDED')`);
  const csId = `cs-cx-${randomUUID().slice(0, 8)}`;
  await t.db.execute(sql`
    INSERT INTO candidate_changesets (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha,
      changed_files, impact_scope, git_base_commit_sha, git_tree_sha, git_commit_sha, delivery_state)
    VALUES (${csId}, ${taskId}, ${runId}, 1, 'b', 'c', 'r',
      '{"modified":[],"added":[],"removed":[]}', '{"inScope":["delivered.txt"],"violations":[]}', ${baseSha}, ${treeSha}, ${candidateSha}, 'NONE')`);
  await t.db.execute(sql`
    INSERT INTO task_gate_verdicts (id, task_id, verdict, reviewer, attempt, candidate_sha, requirement_sha,
      test_env, reviewer_run_id, coder_run_id, evidence_ids, consumed_at)
    VALUES ('gv-cx', ${taskId}, 'PASS', 'cx', 1, 'c', 'r', '{}', 'rv-cx', ${runId}, '[]', now())`);

  // 交付目标 = 隔离 bare 仓库,预置 base commit(直接从工作区仓库按 SHA 推送)
  const remote2 = makeBareRemote();
  execFileSync("git", ["-C", ws.dir, "push", "--quiet", remote2.url, `${baseSha}:refs/heads/main`], { encoding: "utf8" });

  const manifest = snapshotManifest(ws.dir);
  const verifyCommitBinding = makeCommitBindingVerifier(() => ws.dir);
  const io = {
    executor: createGitPushExecutor({ sourceRepo: ws.dir }),
    verifyRemoteContent: async (commitSha: string) => {
      const r = await verifyRemoteCommitContent({ target: remote2.url, commitSha, manifest, scratchDir: mkdtempSync(join(tmpdir(), "relay-cx-verify-")) });
      return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
    },
    manifest,
  };

  // B1: ACCEPTED 终态请求 abort ⇒ 旧代码直接拒绝(交付阶段零停止入口)
  const b1 = await requestTaskAbort(t.db as never, taskId, { actor: "owner" });
  line(`B1 abort-on-ACCEPTED: ok=${b1.ok} reason=${b1.reason ?? "-"} ${!b1.ok && String(b1.reason).startsWith("state_terminal") ? "(缺陷:验收后交付阶段无法请求停止)" : "?"}`);

  const proposed = await proposeDelivery(t.db as never, {
    taskId, attempt: 1, target: remote2.url, branch: "main",
    expectedRemoteSha: remote2.head(),
    policy: { allowedRepos: [remote2.url.toLowerCase()], allowedBranches: ["main"], allowedCapability: "github.push", allowedHosts: [] },
    credentialPresent: true, verifyCommitBinding, actor: "cx",
  });
  line(`B2 propose: ok=${proposed.ok} state=${proposed.ok ? proposed.proposal.state : proposed.reason}`);

  if (proposed.ok) {
    await t.db.execute(sql`UPDATE tasks SET abort_requested_at = now() WHERE id = ${taskId}`);
    const res = await executeDelivery(t.db as never, io, proposed.proposal.id, { actor: "cx" });
    const pushed = remote2.head() === candidateSha;
    line(`B2 execute-with-abort-flag: state=${res.ok ? "DELIVERED" : res.state} reason=${res.ok ? "-" : res.reason} 远端已被写入=${pushed ? "YES(缺陷:旗标已置仍完成外部提交)" : "no"}`);
    execFileSync("git", ["-C", remote2.dir, "update-ref", "refs/heads/main", baseSha], { encoding: "utf8" });
  }
} finally {
  await t.cleanup();
}

// ---------- P1-C:ControlCommand 审计缺字段 + C5 并发双插 ----------
const t2 = await createTestDb("relay_cx_04_audit");
try {
  const taskId = `t-a-${randomUUID().slice(0, 8)}`;
  const goalId = `g-a-${randomUUID().slice(0, 8)}`;
  await t2.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${goalId}, 'audit cx', 'ACTIVE')`);
  await t2.db.execute(sql`
    INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands, gate_required, attempt, max_attempts)
    VALUES (${taskId}, ${goalId}, 'RUNNING', '["/workspace"]', '[]', true, 1, 3)`);
  await requestTaskAbort(t2.db as never, taskId, { actor: "owner" });
  const audits = await t2.db.execute(sql`
    SELECT action, detail FROM audit_events WHERE task_id = ${taskId} AND action = 'TASK_ABORT_REQUESTED' ORDER BY seq DESC LIMIT 1`);
  const detail = (audits.rows[0]!["detail"] ?? {}) as Record<string, unknown>;
  const missing = ["runId", "expectedStateVersion", "idempotencyKey", "requestTime", "actualResult", "controlState"].filter(
    (k) => !(k in detail),
  );
  line(`C1 control-audit-fields: 现有字段=${JSON.stringify(Object.keys(detail))} 缺失=${JSON.stringify(missing)} ${missing.length > 0 ? "(缺陷:ControlCommand 审计字段不全)" : "?"}`);

  // C5: 显式执行防重 —— 旧单语句 NOT EXISTS 无 DB 级互斥,确定性交错下双插
  const gmGoal = `g-m-${randomUUID().slice(0, 8)}`;
  await t2.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES (${gmGoal}, 'cx msg', 'ACTIVE')`);
  const content = `执行请求 cx-${randomUUID().slice(0, 8)}`;
  const clientA = new pg.Client({ connectionString: t2.url, options: `-c search_path=${t2.schemaName},public` });
  const clientB = new pg.Client({ connectionString: t2.url, options: `-c search_path=${t2.schemaName},public` });
  await clientA.connect();
  await clientB.connect();
  const oldInsert = (client: pg.Client, goal: string, cnt: string) =>
    client.query(
      `
      INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
      SELECT $1, 'USER', 'USER_MESSAGE', $2, true
      WHERE NOT EXISTS (
        SELECT 1 FROM goal_messages g2
        LEFT JOIN goal_message_consumptions c2 ON c2.message_id = g2.id
        LEFT JOIN tasks t2 ON t2.id = c2.task_id
        WHERE g2.goal_id = $1 AND g2.actor = 'USER' AND g2.execution_request = true
          AND g2.content = $2
          AND (c2.id IS NULL OR t2.state IS NULL OR t2.state NOT IN ('ACCEPTED','FAILED','CANCELLED'))
      ) RETURNING id`,
      [goal, cnt],
    );
  await clientA.query("BEGIN");
  await clientB.query("BEGIN");
  const a1 = await oldInsert(clientA, gmGoal, content);
  const b1r = await oldInsert(clientB, gmGoal, content); // A 未提交,B 的 NOT EXISTS 看不到 ⇒ 同样通过
  await clientA.query("COMMIT");
  await clientB.query("COMMIT");
  const dup = a1.rows.length === 1 && b1r.rows.length === 1;
  await clientA.end();
  await clientB.end();
  line(`C5 concurrent-dup-insert: A 插入=${a1.rows.length} B 插入=${b1r.rows.length} ${dup ? "(缺陷:同一内容真并发下双插=重复授权面)" : "?"}`);
} finally {
  await t2.cleanup();
}

writeFileSync(new URL("./counterexample.log", import.meta.url).pathname, evidence.join("\n") + "\n");
console.log("\n=== 反例脚本结束(对旧代码留证) ===");
