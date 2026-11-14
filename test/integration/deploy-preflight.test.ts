// RELAY-DEPLOY-PREFLIGHT-05 隔离演练(p01a_ schema + 临时工作区/临时 env 文件 + 真实 Docker + 受控桩;
// 零模型/零远端写入/零生产触碰):
//  1) 正例:stub 探针 + 真实测试库 ⇒ 全 PASS ⇒ GO;样例模板经 resolveEvidenceChecks 结构合法;报告零凭据值泄漏;
//  2) 非法 env/check:五类非法 RELAY_EVIDENCE_CHECKS_JSON ⇒ preflight FAIL/NO-GO,且与 resolveEvidenceChecks
//     "启动即抛"同构(重启 = fail-closed crash-loop,不假放行);
//  3) 容器不可用:Docker 探针不可用 ⇒ sandbox_image/egress NOT_RUN(绝不假 PASS),docker_available FAIL;
//  4) 旧运行状态与恢复门:VERIFYING/RUNNING 与旧格式无绑定 Run ⇒ NO-GO(D3 处置);
//     Supervisor 回收(到期租约→NEEDS_RECONCILE→Reconcile→READY)恢复路径可用 ⇒ 复检只余 READY 排队不阻断;
//  5) 编排层归属失配/缺失(生产同源 orchestrateGate):外来目录 ⇒ workspace_provenance_mismatch 零执行;
//     无绑定记录 ⇒ 跳过校验由既有双门把关(登记残留 R2-D3 语义在演练中复现);
//  6) 真实 Docker(门控 dockerAvailable):样例模板命令在 node:24-bookworm-slim 沙箱真实执行通过
//     (镜像对既定命令支持实证,"存在配置"≠"执行通过"以执行留证);候选漂移检出;默认禁网 fail-closed
//     (DNS 探针"仅在禁网时成功"——若出口未禁,该探针自身失败)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { claimTask } from "../../src/core/lease.ts";
import { planGoal } from "../../src/core/goals.ts";
import { orchestrateGate, type ReviewRunInput, type ReviewRunResult } from "../../src/core/gate-orchestrator.ts";
import { reclaimExpiredLeases, reconcilePendingTasks } from "../../src/core/supervisor.ts";
import { resolveEvidenceChecks } from "../../src/worker-entry.ts";
import { dockerCheckRunner } from "../../src/runtime/check-sandbox.ts";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { manifestSha } from "../../src/core/changesets.ts";
import { snapshotManifest, verifyCandidateManifest } from "../../src/runtime/workspace-manifest.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { executeRun, type RunResult } from "../../src/runtime/runner.ts";
import { cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { assertOk } from "../setup/assert.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";
import type { CheckSpec } from "../../src/core/evidence.ts";
import type { Exec } from "../../src/core/db.ts";
import { runPreflight, computeVerdict, type PreflightProbes } from "../../deploy/preflight.ts";

const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };
const SAMPLE_CHECKS_PATH = join(process.cwd(), "deploy", "evidence-checks.sample.json");
const SECRET_PROBE = "preflight-secret-value-DO-NOT-LEAK";

function sampleChecksJson(): string {
  return readFileSync(SAMPLE_CHECKS_PATH, "utf8").trim();
}

/** 绿态 stub 探针工厂(可按用例覆写;DB 探针可接真实测试库或内存桩)。 */
function greenProbes(over: Partial<PreflightProbes> = {}): PreflightProbes {
  const nowIso = new Date().toISOString();
  return {
    nowIso: () => nowIso,
    gitHead: () => ({ ok: true, sha: "f".repeat(40), dirty: false, commitTimeIso: "2026-11-13T00:00:00Z" }),
    envFile: () => ({
      exists: true,
      mode: 0o600,
      keys: [
        "RELAY_DB_URL",
        "RELAY_DB_SCHEMA",
        "RELAY_PI_PROVIDER",
        "RELAY_PI_MODEL",
        "RELAY_PI_API_KEY",
        "RELAY_PI_BASE_URL",
        "RELAY_WEB_HOST",
        "RELAY_WEB_PORT",
        "RELAY_WEB_ALLOW_NON_LOOPBACK",
        "RELAY_OPERATORS",
        "RELAY_EVIDENCE_CHECKS_JSON",
      ],
      get: (name) =>
        name === "RELAY_EVIDENCE_CHECKS_JSON"
          ? sampleChecksJson()
          : name === "RELAY_PI_API_KEY"
            ? SECRET_PROBE
            : name === "RELAY_MAX_OUTPUT_TOKENS"
              ? undefined // 未配置=默认 8192(不可回 "x" 假值,否则误报非法)
              : "x",
    }),
    credFileMode: () => 0o600,
    units: () => [
      { name: "relay-web.service", active: true, sinceIso: "2026-11-14T00:00:00Z", pid: 101 },
      { name: "relay-worker.service", active: true, sinceIso: "2026-11-14T00:00:00Z", pid: 102 },
    ],
    listening: () => [{ addr: "10.30.5.80" }],
    docker: () => ({
      available: true,
      imageExists: () => true,
      networkExists: () => true,
      containerRunning: () => true,
    }),
    sql: async (query) => fakeGreenSql(query),
    ...over,
  };
}

/** 内存绿态 SQL 桩:按查询特征返回最小行(避免用例间 DB 状态串扰)。 */
function fakeGreenSql(query: string): Promise<{ ok: boolean; rows: string[][] }> {
  const q = query.toLowerCase();
  if (q.includes("select 1")) return Promise.resolve({ ok: true, rows: [["1"]] });
  if (q.includes("table_name from information_schema.tables")) {
    const tables = [
      "action_intents",
      "action_proposals",
      "audit_events",
      "budget_ledger",
      "candidate_changesets",
      "decisions",
      "discoveries",
      "gate_evidence",
      "goal_message_consumptions",
      "goal_messages",
      "goals",
      "leases",
      "runs",
      "sessions",
      "task_gate_verdicts",
      "tasks",
    ];
    return Promise.resolve({ ok: true, rows: tables.map((t) => [t]) });
  }
  if (q.includes("information_schema.columns") || q.includes("information_schema.tables where table_schema")) {
    // 迁移面单行四列:0006/0007/0008/0009 标志物全在
    return Promise.resolve({ ok: true, rows: [["1", "1", "1", "1"]] });
  }
  if (q.includes("group by state")) return Promise.resolve({ ok: true, rows: [] });
  if (q.includes("workspace_dir")) return Promise.resolve({ ok: true, rows: [] });
  return Promise.resolve({ ok: true, rows: [] });
}

/** 真实测试库 SQL 适配器(把 pg 结果转成 preflight 探针的 string[][] 形)。 */
function realSqlAdapter(t: TestDb): PreflightProbes["sql"] {
  return async (query: string) => {
    try {
      const res = (await t.db.execute(sql.raw(query))) as unknown as { rows: Record<string, unknown>[] };
      const rows = res.rows ?? [];
      return { ok: true, rows: rows.map((r) => Object.values(r).map((v) => String(v))) };
    } catch (err) {
      return { ok: false, rows: [], reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

function writeTempEnvFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-pf-env-"));
  const path = join(dir, "env");
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o600);
  return { dir, path };
}

describe("部署准入预检隔离演练(RELAY-DEPLOY-PREFLIGHT-05)", () => {
  let t: TestDb;
  const sandboxes: SandboxSpec[] = [];
  beforeAll(async () => {
    t = await createTestDb("deploy-preflight");
  });
  afterAll(async () => {
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("1) 正例:stub 探针+真实测试库 ⇒ 全 PASS ⇒ GO;样例模板合法;报告零凭据值泄漏", async () => {
    const env = writeTempEnvFile(
      [
        "RELAY_DB_URL=postgresql://postgres:MASKED@127.0.0.1:55433/relayp000",
        "RELAY_DB_SCHEMA=relay_console",
        "RELAY_PI_PROVIDER=magpie",
        "RELAY_PI_MODEL=stub/gm",
        `RELAY_PI_API_KEY=${SECRET_PROBE}`,
        "RELAY_PI_BASE_URL=http://127.0.0.1:1/v1",
        "RELAY_WEB_HOST=10.30.5.80",
        "RELAY_WEB_PORT=8787",
        "RELAY_WEB_ALLOW_NON_LOOPBACK=1",
        "RELAY_OPERATORS=owner",
        // env 文件为单行 KEY=VALUE 格式 ⇒ JSON 取值必须压平(与生产 ~/.relay/console/env 同格式)
        `RELAY_EVIDENCE_CHECKS_JSON=${JSON.stringify(JSON.parse(sampleChecksJson()))}`,
      ].join("\n"),
    );
    try {
      const report = await runPreflight(
        greenProbes({
          sql: realSqlAdapter(t),
          envFile: () => {
            const text = readFileSync(env.path, "utf8");
            const keys = text
              .split("\n")
              .filter((l) => l.includes("="))
              .map((l) => l.slice(0, l.indexOf("=")));
            const map = new Map(keys.map((k, i) => [k, text.split("\n")[i]!.slice(k.length + 1)]));
            return { exists: true, mode: 0o600, keys, get: (k) => map.get(k) };
          },
        }),
        { schema: t.schemaName, envPath: env.path },
      );
      expect(report.verdict, `结果=${JSON.stringify(report.results)}`).toBe("GO");
      const byId = new Map(report.results.map((r) => [r.id, r]));
      expect(byId.get("git_head")?.status).toBe("PASS");
      expect(byId.get("evidence_checks_config")?.status).toBe("PASS");
      expect(byId.get("db_schema_tables")?.status).toBe("PASS");
      expect(byId.get("db_migrations")?.status).toBe("PASS"); // 测试 schema 应用全部迁移
      expect(byId.get("db_inflight")?.status).toBe("PASS"); // 空 schema 无在途
      expect(byId.get("run_workspace_binding")?.status).toBe("PASS");
      // 脱敏:报告任何位置不得出现凭据值/连接串取值
      const dump = JSON.stringify(report);
      expect(dump.includes(SECRET_PROBE)).toBe(false);
      expect(dump.includes("MASKED")).toBe(false);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("2) 非法 env/check:五类非法配置 ⇒ preflight FAIL/NO-GO;resolveEvidenceChecks 启动即抛(重启 crash 同构)", async () => {
    const invalidVariants: Array<[string, string]> = [
      ["kind 非功能性", `[{"kind":"reviewer_output","command":["node","-e","1"]}]`],
      ["空数组", `[]`],
      ["timeout 越界", `[{"kind":"deterministic_test","command":["node","-e","1"],"timeoutMs":100}]`],
      ["空 argv", `[{"kind":"deterministic_test","command":[]}]`],
      ["非 JSON", `{not-json`],
    ];
    for (const [label, raw] of invalidVariants) {
      // 单一来源同构断言:worker 启动路径对同类配置启动即抛 ⇒ 重启将 fail-closed crash
      expect(() => resolveEvidenceChecks(raw), label).toThrow();
      const report = await runPreflight(
        greenProbes({
          envFile: () => ({
            exists: true,
            mode: 0o600,
            keys: [
              "RELAY_DB_URL",
              "RELAY_DB_SCHEMA",
              "RELAY_PI_PROVIDER",
              "RELAY_PI_MODEL",
              "RELAY_PI_API_KEY",
              "RELAY_PI_BASE_URL",
              "RELAY_WEB_HOST",
              "RELAY_WEB_PORT",
              "RELAY_WEB_ALLOW_NON_LOOPBACK",
              "RELAY_OPERATORS",
            ],
            get: (name) => (name === "RELAY_EVIDENCE_CHECKS_JSON" ? raw : "x"),
          }),
        }),
        { schema: t.schemaName },
      );
      const ev = report.results.find((r) => r.id === "evidence_checks_config");
      expect(ev?.status, `${label}:应为 FAIL`).toBe("FAIL");
      expect(report.verdict, `${label}:裁决应为 NO-GO`).toBe("NO-GO");
    }
  });

  it("3) 容器不可用:sandbox_image/egress_stack NOT_RUN(不假 PASS),docker_available FAIL ⇒ NO-GO", async () => {
    const report = await runPreflight(
      greenProbes({
        docker: () => ({
          available: false,
          imageExists: () => false,
          networkExists: () => false,
          containerRunning: () => false,
        }),
      }),
      { schema: t.schemaName },
    );
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get("docker_available")?.status).toBe("FAIL");
    expect(byId.get("sandbox_image")?.status).toBe("NOT_RUN");
    expect(byId.get("egress_stack")?.status).toBe("NOT_RUN");
    expect(report.verdict).toBe("NO-GO");
    expect(computeVerdict(report.results)).toBe(report.verdict);
  });

  it("4) 旧运行状态与恢复门:在途+旧格式无绑定 Run ⇒ NO-GO(D3);Supervisor 回收链恢复后复检只余 READY 排队", {
    timeout: 120_000,
  }, async () => {
    // taskA:真实 coder Run(stub)至 VERIFYING;额外植入一条旧格式(无 workspace_dir)非终态 Run 模拟历史行
    // (runs.outcome 非空约束 ⇒ 非终态=RUNNING;与 runner 初始插入同值)
    const taskA = "t-pf-recover-a";
    const { result } = await coderRun(taskA, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome, detail)
      VALUES ('run-pf-stale-unbound', ${taskA}, 1, 'pi-rpc', 'stub/gm', 'host-fallback', 'RUNNING', '{}'::jsonb)
    `);
    // taskB:仅领取(RUNNING + 活租约)
    const taskB = "t-pf-recover-b";
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: "goal-t-pf-recover-b",
        rawInput: "恢复门演练",
        budget: { modelCalls: 4 },
        tasks: [{ id: taskB, goalText: "恢复", priority: 2, allowedScope: ["/workspace"] }],
      }),
    );
    const claimB = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskB, "worker-pf", 60));
    assertOk(claimB);

    const realSql = realSqlAdapter(t);
    const pre = await runPreflight(greenProbes({ sql: realSql }), { schema: t.schemaName });
    const preById = new Map(pre.results.map((r) => [r.id, r]));
    expect(preById.get("db_inflight")?.status).toBe("FAIL"); // VERIFYING+RUNNING 在途
    expect(preById.get("run_workspace_binding")?.status).toBe("FAIL"); // 无绑定 Run 挂在 VERIFYING 任务上
    expect(pre.verdict).toBe("NO-GO");

    // 恢复门:租约到期 → 回收(→NEEDS_RECONCILE)→ Reconcile(无 EXECUTING 意图 ⇒ READY)
    await t.db.execute(sql`UPDATE leases SET lease_expires_at = now() - interval '1s'`);
    const reclaimed = await t.db.transaction(async (tx) => reclaimExpiredLeases(tx as unknown as Exec));
    expect(reclaimed.map((r) => r.taskId).sort()).toEqual([taskA, taskB].sort());
    await reconcilePendingTasks(t.db, {
      check: async () => {
        throw new Error("无 EXECUTING 意图,不应被调用");
      },
      perform: async () => {
        throw new Error("同上");
      },
    });
    const states = await t.db.execute(
      sql`SELECT state, count(*)::int AS n FROM tasks WHERE id IN (${taskA},${taskB}) GROUP BY state`,
    );
    for (const row of states.rows) expect(String(row["state"])).toBe("READY");

    // 复检:READY=排队不阻断;旧格式陈旧 Run 行如实计数说明(不补写、不隐瞒),绑定项转 PASS
    const post = await runPreflight(greenProbes({ sql: realSql }), { schema: t.schemaName });
    const postById = new Map(post.results.map((r) => [r.id, r]));
    expect(postById.get("db_inflight")?.status).toBe("PASS");
    expect(postById.get("db_inflight")?.detail).toContain("READY=2");
    expect(postById.get("run_workspace_binding")?.status).toBe("PASS");
    expect(postById.get("run_workspace_binding")?.detail).toContain("不自动补写");
    expect(post.verdict).toBe("GO");
  });

  it("5) 编排层归属失配/缺失(生产同源):外来目录 ⇒ workspace_provenance_mismatch 零执行;无绑定记录 ⇒ 跳过由双门把关", {
    timeout: 120_000,
  }, async () => {
    const taskId = "t-pf-provenance";
    const { result } = await coderRun(taskId, "result.txt:sum=87");
    expect(result.outcome).toBe("SUCCEEDED");
    const reviewer = reviewerPass(taskId);
    // 外来目录(内容与候选相同):既有边界校验+内容复验均放行 ⇒ 由 2.45 归属绑定拦截
    const foreign = mkdtempSync(join(tmpdir(), "relay-pf-foreign-"));
    writeFileSync(join(foreign, "result.txt"), readFileSync(join(result.sandboxSpec.workspaceDir, "result.txt")));
    try {
      const runnerCalls: string[] = [];
      const spyRunner = async (spec: CheckSpec, ws: string) => {
        runnerCalls.push(ws);
        return hostTestCheckRunner(spec, ws);
      };
      const gateForeign = await orchestrateGate(
        t.db,
        { taskId, attempt: 1, coderRunId: result.runId, workspaceDir: foreign, actor: "t-pf" },
        {
          checkRunner: spyRunner,
          evidenceChecks: PASSING_CHECK(),
          manifestVerify: builtinManifestVerify,
          reviewRun: reviewer.fn,
          reviewAttempts: 1,
        },
      );
      expect(gateForeign.status, `reason=${gateForeign.reason}`).toBe("NEEDS_DECISION");
      expect(gateForeign.reason).toBe("workspace_provenance_mismatch");
      expect(runnerCalls.length).toBe(0);
      expect(reviewer.calls.length).toBe(0);
      const audit = await t.db.execute(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE task_id=${taskId} AND action='GATE_WORKSPACE_PROVENANCE_MISMATCH'`,
      );
      expect(Number(audit.rows[0]!["n"])).toBe(1);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }

    // 旧格式无绑定记录:2.45 跳过归属校验(登记残留),既有双门+Reviewer 照常 ⇒ ACCEPTED
    // (独立任务:上一例失配保守停机后任务已终态 NEEDS_DECISION,不能重入 Gate)
    const taskB = "t-pf-provenance-unbound";
    const { result: resultB } = await coderRun(taskB, "result.txt:sum=87");
    expect(resultB.outcome).toBe("SUCCEEDED");
    await t.db.execute(sql`UPDATE runs SET detail = detail - 'workspace_dir' WHERE id=${resultB.runId}`);
    const reviewer2 = reviewerPass(taskB);
    const gateOk = await orchestrateGate(
      t.db,
      {
        taskId: taskB,
        attempt: 1,
        coderRunId: resultB.runId,
        workspaceDir: resultB.sandboxSpec.workspaceDir,
        actor: "t-pf",
      },
      {
        checkRunner: hostTestCheckRunner,
        evidenceChecks: PASSING_CHECK(),
        manifestVerify: builtinManifestVerify,
        reviewRun: reviewer2.fn,
        reviewAttempts: 1,
      },
    );
    expect(gateOk.status, `reason=${gateOk.reason}`).toBe("ACCEPTED");
    const state = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskB}`);
    expect(String(state.rows[0]!["state"])).toBe("ACCEPTED");
  });

  // 真实 Docker 门控:docker 不可用 ⇒ 整组显式 skip(不假 PASS;合同 C:容器不可用=NOT_RUN 语义)
  describe.skipIf(!dockerAvailable())("真实 Docker 沙箱演练(镜像对既定命令支持)", () => {
    it("6) 样例模板命令在检查沙箱执行通过;候选漂移检出;默认禁网 fail-closed", { timeout: 180_000 }, async () => {
      const parsed: unknown = JSON.parse(sampleChecksJson());
      const resolved = resolveEvidenceChecks(JSON.stringify(parsed));
      expect(resolved).not.toBeNull();
      expect(resolved!.length).toBe(1);
      expect(resolved![0]!.kind).toBe("deterministic_test");

      const ws = mkdtempSync(join(tmpdir(), "relay-pf-ws-"));
      chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs chmod o+rwX;容器 UID 10001 可读)
      try {
        const smoke = join(ws, "relay-smoke.txt");
        writeFileSync(smoke, "ok\n", "utf8");
        chmodSync(smoke, 0o644); // 宿主 umask 可能收紧(本机 007 ⇒ 0660);检查沙箱 UID 10001 需要 o+r
        const runner = dockerCheckRunner({});
        // ① 样例命令真实执行(node:24-bookworm-slim;镜像对既定命令支持实证)
        const outcome = await runner(resolved![0]!, ws);
        expect(outcome.passed, `raw=${outcome.rawOutput}`).toBe(true);
        expect(outcome.rawOutput).toContain("sample deterministic check ok");
        // ② 候选漂移:基线清单 → 修改工作区 → 复验必须失败(fail-closed,不因"执行通过"放行漂移)
        const baseSha = manifestSha(snapshotManifest(ws));
        writeFileSync(smoke, "ok\nDRIFT\n", "utf8");
        chmodSync(smoke, 0o644);
        const drift = verifyCandidateManifest(ws, baseSha, 1);
        expect(drift.ok).toBe(false);
        expect(drift.rawOutput).toContain("verify=mismatch");
        // ③ 默认禁网:DNS 探针"仅在禁网时成功"(若出口未禁 ⇒ lookup 成功 ⇒ exit 2 ⇒ 检查失败)
        const netProbe = await runner(
          {
            kind: "deterministic_test",
            command: ["node", "-e", "require('dns').lookup('example.org',e=>process.exit(e?0:2))"],
            cwdWorkspace: false,
            timeoutMs: 30000,
          },
          ws,
        );
        expect(netProbe.passed, `禁网探针 raw=${netProbe.rawOutput}`).toBe(true);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  // ── 复用夹具(与 gate-integrity-dual 同源,压缩版) ──

  const builtinManifestVerify = async (spec: {
    workspaceDir: string;
    candidateSha: string;
    changedFileCount: number;
  }) => verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount);

  function PASSING_CHECK(): CheckSpec[] {
    return [{ kind: "deterministic_test", command: ["node", "-e", "console.log('check ok')"], cwdWorkspace: true }];
  }

  async function coderRun(taskId: string, writeFile: string): Promise<{ result: RunResult; goalId: string }> {
    const goalId = `goal-${taskId}`;
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        id: goalId,
        rawInput: "在工作区生成指定文件",
        budget: { modelCalls: 12 },
        tasks: [{ id: taskId, goalText: "生成", priority: 2, allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
      }),
    );
    const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, taskId, "coder", 60));
    assertOk(c);
    const result = await executeRun(t.db, resolveVendoredPi(), {
      taskId,
      goal: "在工作区生成指定文件",
      allowedScope: ["/workspace"],
      attempt: c.attempt,
      ownerId: c.ownerId,
      fencingToken: c.fencingToken,
      model: MODEL,
      sandbox: "host-fallback",
      wallSeconds: 60,
      heartbeatSeconds: 2,
      budget: { goalId, reserveCallsPerRun: 4 },
      argvOverride: [process.execPath, STUB],
      envOverride: { STUB_MODE: "ok", STUB_WRITE_FILE: writeFile },
    });
    sandboxes.push(result.sandboxSpec);
    return { result, goalId };
  }

  function reviewerPass(taskId: string) {
    const calls: ReviewRunInput[] = [];
    const fn = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
      calls.push(input);
      const reviewerRunId = `run-pf-reviewer-${taskId}-${calls.length}`;
      await t.db.execute(sql`
        INSERT INTO runs (id, task_id, attempt, model_ref, sandbox, detail)
        VALUES (${reviewerRunId}, ${taskId}, ${input.attempt}, 'stub/gm', 'host-fallback', '{"role":"reviewer"}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `);
      return { ok: true, verdict: "PASS", findings: "stub PASS", reviewerRunId, rawOutput: "stub verdict=PASS" };
    };
    return { fn, calls };
  }
});
