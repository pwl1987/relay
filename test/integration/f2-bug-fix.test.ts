// P0-总包阶段 D·Fixture F2:真实 Bug 修复全链(真模型;RELAY_F2_E2E=1 门)。
// 流程:真实边界缺陷 HTTP API(b=0 与非数字输入静默返回 null,应 400)→ 失败回归(基线机判
//       负对照,证据 p0-mvp/f2/baseline-check.json)→ 真模型 Coder 复现/定位/修复 → Gate
//       (**API 机判检查** = evidenceCheck:起真实服务 + 四项断言)→ 独立 Reviewer → 本地 bare
//       交付 → 独立核验(checkout 后对真实服务再验证)→ 证据落 p0-mvp/f2/。
// 预算声明(每轮):coder 6 + reviewer 4(goal 账本 10;magpie 零真实成本)。
// magpie 方差如实:失败诚实落 FAILED(隔离复跑一次定性;不伪造成功)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { createLiveWorkerDriver, type DeliveryFactory, type CapturedDelivery } from "../../src/server/worker.ts";
import { cleanupSandbox, type SandboxSpec, resolveMaxOutputTokens } from "../../src/runtime/sandbox.ts";
import { ensureEgress } from "../../src/runtime/egress.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { REPO_ROOT, markTemp, markRunDir, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { safeRm } from "../../src/runtime/safe-rm.ts";

const FIXTURE = join(REPO_ROOT, "test/fixtures/f2-api");
const CHECK = join(REPO_ROOT, "test/fixtures/f2-api/api-check.mjs");
// 第四包②:证据写独立未跟踪目录(不再向已跟踪 p0-mvp/f2 追加;历史证据原样保留于原目录)
const EVIDENCE_DIR = join(REPO_ROOT, "test-evidence/f2");
const CHECK_TIMEOUT_MS = 120_000;

const gated = process.env.RELAY_F2_E2E === "1";
const STUB_PI = join(REPO_ROOT, "test/helpers/stub-pi.mjs");
// stub 写入的修复版 server.mjs(满足 A1~A4;仅机制演示,显式标注 stub)
const FIXED_SERVER = `// F2 夹具:HTTP API(真实业务级边界缺陷)。
// POST /api/divide {a, b} → {result: a/b}
// 缺陷:b=0 时未做边界检查 —— 除零抛异常未捕获(uncaughtException ⇒ 500/进程崩)。
// 缺陷 2:a/b 非数字输入时结果 NaN 被序列化为 null(应 400)。
import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/divide") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch { parsed = {}; }
      const a = parsed.a;
      const b = parsed.b;
      // 回归修复:b=0 ⇒ 400 division_by_zero;非数字 ⇒ 400 invalid_input(原缺陷:静默 200 null)
      if (typeof a !== "number" || !Number.isFinite(a) || typeof b !== "number" || !Number.isFinite(b)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_input" }));
        return;
      }
      if (b === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "division_by_zero" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: a / b }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log(\`F2API_PORT=\${server.address().port}\`);
});
`;

function envModel(): { provider: string; model: string; apiKey: string; baseUrl: string; maxOutputTokens?: number } | null {
  const provider = process.env.RELAY_PI_PROVIDER;
  const model = process.env.RELAY_PI_MODEL;
  const apiKey = process.env.RELAY_PI_API_KEY;
  const baseUrl = process.env.RELAY_PI_BASE_URL;
  if (!provider || !model || !apiKey || !baseUrl) return null;
  // R2-REMEDIATION-01:RELAY_MAX_OUTPUT_TOKENS 可选(唯一实验变量);非法 ⇒ fail-closed 抛错
  const maxOutputTokens = resolveMaxOutputTokens(process.env.RELAY_MAX_OUTPUT_TOKENS);
  return maxOutputTokens === undefined
    ? { provider, model, apiKey, baseUrl }
    : { provider, model, apiKey, baseUrl, maxOutputTokens };
}

describe.skipIf(!gated || envModel() === null)("Fixture F2:真实 Bug → 真模型修复全链(API 机判)", { timeout: 900_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  let remote: BareRemoteFixture;
  let stageBase = "";
  let egress: Awaited<ReturnType<typeof ensureEgress>> | null = null;
  const sandboxes: SandboxSpec[] = [];
  const tmpRoots: string[] = [];

  /** 复制 fixture(不含 api-check.mjs —— 机判工具在候选面外)。 */
  function seedF2(workspaceDir: string): void {
    for (const f of readdirSync(FIXTURE)) {
      if (f === "api-check.mjs") continue;
      copyFileSync(join(FIXTURE, f), join(workspaceDir, f));
    }
    writeFileSync(
      join(workspaceDir, "brief.txt"),
      "真实缺陷:POST /api/divide 对 b=0 与非数字输入静默返回 200 {\"result\":null}。请修复:边界输入返回 400 {\"error\":\"division_by_zero\"} / {\"error\":\"invalid_input\"},正常路径与 health 不回归,并新增回归说明(README 或注释)。\n",
      "utf8",
    );
  }

  function evidence(name: string, content: string): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, name), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  beforeAll(async () => {
    t = await createTestDb("d-f2-bug");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
    remote = makeBareRemote(markTemp(mkdtempSync(join(tmpdir(), "d-f2-remote-"))));
    stageBase = markTemp(mkdtempSync(join(tmpdir(), "d-f2-stage-")));
    const eg = await ensureEgress(envModel()!.baseUrl);
    if (!eg.ok) throw new Error(`F2 需要 egress 栈(ensureEgress 失败:${eg.reason})`);
    egress = eg;
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    for (const s of sandboxes) cleanupSandbox(s);
    for (const r of tmpRoots) safeRm(r, { roots: tmpRoots, sentinel: RUN_SENTINEL });
    await t.cleanup();
  });

  it("F2 全链:基线负对照已实证 → coder 修复 → API 机判 Gate → Reviewer → 本地 bare DELIVERED → 独立 HTTP 复核", async () => {
    const model = envModel()!;
    const pi = resolveVendoredPi();
    const proj = markTemp(mkdtempSync(join(tmpdir(), "d-f2-proj-")));
    seedF2(proj);

    // ---- 1) Goal(预算账本 10)----
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec0, {
        id: "goal-f2-bug",
        rawInput: "修复 POST /api/divide 对 b=0 与非数字输入静默返回 null 的缺陷:边界输入返回 400,正常路径不回归。",
        budget: { modelCalls: 10 },
        tasks: [{ id: "t-f2-bug", goalText: "修复 divide 边界缺陷", allowedScope: ["/workspace"], allowedCommands: ["node"], priority: 2, maxAttempts: 2 }],
      }),
    );

    // ---- 2) 全链 tick(真模型 Coder + API 机判 evidenceCheck + Reviewer + 本地 bare)----
    let captured: CapturedDelivery | null = null;
    const delivery: DeliveryFactory = {
      propose: async (c) => {
        captured = c;
        remote.pushHead(c.stageRepoDir, c.baseCommitSha);
        return {
          taskId: c.taskId,
          attempt: c.attempt,
          target: remote.url,
          branch: "main",
          expectedRemoteSha: c.baseCommitSha,
          policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [remote.url.toLowerCase()] },
          credentialPresent: true,
          verifyCommitBinding: makeCommitBindingVerifier(() => c.stageRepoDir),
          actor: "f2-worker",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = markTemp(mkdtempSync(join(tmpdir(), "d-f2-verify-")));
          const r = await verifyRemoteCommitContent({ target: remote.url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };

    const driver = createLiveWorkerDriver({
      db: t.db,
      workerId: "f2-worker",
      sandbox: "docker",
      egress: egress!,
      model,
      stageBaseDir: stageBase,
      prepareWorkspace: seedF2,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", CHECK, "."], cwdWorkspace: true, timeoutMs: CHECK_TIMEOUT_MS },
      ],
      delivery,
      reserveCallsPerRun: 6,
      reviewerReserveCallsPerRun: 4,
      reviewAttempts: 1,
      wallSeconds: 420,
    });
    const report = await driver.tick();
    evidence("tick-summary.json", JSON.stringify({
      status: report.status,
      run: report.run ? { outcome: report.run.outcome, reason: report.run.reason ?? null } : null,
      gate: report.gate ? { status: report.gate.status, reason: (report.gate as { reason?: string }).reason ?? null } : null,
      delivery: report.delivery ?? null,
    }, null, 2));
    evidence("tick-full.json", JSON.stringify(report, null, 2));
    try {
      const dbg = await t.db.execute(sql`SELECT id, runtime, model_ref, outcome, detail, budget FROM runs WHERE task_id='t-f2-bug' ORDER BY started_at`);
      evidence("runs-detail.json", JSON.stringify(dbg.rows, null, 2));
      const evs = await t.db.execute(sql`SELECT id, kind, passed, raw_output FROM gate_evidence WHERE task_id='t-f2-bug' ORDER BY created_at`);
      evidence("gate-evidence.json", JSON.stringify(evs.rows, null, 2));
    } catch { /* 诊断尽力 */ }
    expect(report.status, `F2 tick 失败(如实;run=${JSON.stringify(report.run)} gate=${JSON.stringify(report.gate)})`).toBe("PROGRESSED");
    expect(report.run?.outcome, `run.reason=${report.run?.reason}`).toBe("SUCCEEDED");
    expect(report.gate?.status, `gate.reason=${(report.gate as { reason?: string } | undefined)?.reason}`).toBe("ACCEPTED");
    expect(report.delivery?.execute).toMatchObject({ state: "DELIVERED" });

    // ---- 3) 独立核验:checkout 交付 commit,起真实服务复跑机判(修复后)----
    const cap = captured as unknown as CapturedDelivery;
    expect(cap?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const outDir = mkdtempSync(join(tmpdir(), "d-f2-out-"));
    execFileSync("git", ["clone", "--quiet", remote.url, outDir], { stdio: "ignore" });
    markRunDir(outDir, { kind: "f2-out" });
    const verify = execFileSync("node", [CHECK, "."], { cwd: outDir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
    evidence("final-check.json", verify);
    const parsed = JSON.parse(verify) as { ok: boolean; checks: Array<{ id: string; ok: boolean; note: string }> };
    expect(parsed.ok).toBe(true);
    for (const id of ["A1-zero", "A2-nan", "A3-normal", "A4-health"]) {
      expect(parsed.checks.find((c) => c.id === id)?.ok, `${id} 应通过`).toBe(true);
    }
    // diff 证据
    const diff = execFileSync("git", ["-C", outDir, "diff", "HEAD~1", "HEAD", "--", "server.mjs"], { encoding: "utf8" });
    evidence("final-diff.patch", diff || "(coder 以整文件重写呈现)");
    // DB 事实一致
    const cs = await t.db.execute(sql`SELECT delivery_state, delivered_remote_head FROM candidate_changesets WHERE task_id='t-f2-bug'`);
    expect(String(cs.rows[0]!["delivery_state"])).toBe("DELIVERED");
    expect(String(cs.rows[0]!["delivered_remote_head"])).toBe(cap!.commitSha);
  });
});

type Exec0 = import("../../src/core/db.ts").Exec;

describe.skipIf(!gated)("Fixture F2(机制演示;stub coder 显式标注):API 机判 Gate 拒绝未修复/接受真修复 → 交付 → 独立 HTTP 复核", { timeout: 600_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  let remote: BareRemoteFixture;
  let stageBase = "";
  const sandboxes: SandboxSpec[] = [];
  const tmpRoots: string[] = [];

  function seedF2(workspaceDir: string): void {
    for (const f of readdirSync(FIXTURE)) {
      if (f === "api-check.mjs") continue;
      copyFileSync(join(FIXTURE, f), join(workspaceDir, f));
    }
    writeFileSync(join(workspaceDir, "brief.txt"), "真实缺陷:POST /api/divide 边界输入静默 200 null。请修复。\n", "utf8");
    execFileSync("git", ["-C", workspaceDir, "init", "--initial-branch=main"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.email", "f2-seed@local"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.name", "f2-seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "commit", "--quiet", "-m", "f2 fixture base"], { stdio: "ignore" });
  }
  function evidence(name: string, content: string): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, name), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  beforeAll(async () => {
    t = await createTestDb("d-f2-bug-stub");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
    remote = makeBareRemote(markTemp(mkdtempSync(join(tmpdir(), "d-f2s-remote-"))));
    stageBase = markTemp(mkdtempSync(join(tmpdir(), "d-f2s-stage-")));
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    for (const s of sandboxes) cleanupSandbox(s);
    for (const r of tmpRoots) safeRm(r, { roots: tmpRoots, sentinel: RUN_SENTINEL });
    await t.cleanup();
  });

  it("stub coder 写入真实修复 → API 机判四项通过 → Gate ACCEPTED → 本地 bare DELIVERED(全程显式标注 stub)", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec0, {
        id: "goal-f2-stub",
        rawInput: "修复 divide 边界缺陷",
        budget: { modelCalls: 8 },
        tasks: [{ id: "t-f2-stub", goalText: "修复 POST /api/divide 边界校验", allowedScope: ["/workspace"], allowedCommands: [], priority: 2, maxAttempts: 1 }],
      }),
    );
    let captured: CapturedDelivery | null = null;
    const delivery: DeliveryFactory = {
      propose: async (c) => {
        captured = c;
        remote.pushHead(c.stageRepoDir, c.baseCommitSha);
        return {
          taskId: c.taskId, attempt: c.attempt, target: remote.url, branch: "main",
          expectedRemoteSha: c.baseCommitSha,
          policy: { ...DEFAULT_DELIVERY_POLICY, allowedRepos: [remote.url.toLowerCase()] },
          credentialPresent: true,
          verifyCommitBinding: makeCommitBindingVerifier(() => c.stageRepoDir),
          actor: "f2-stub-worker",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = markTemp(mkdtempSync(join(tmpdir(), "d-f2s-verify-")));
          const r = await verifyRemoteCommitContent({ target: remote.url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    const driver = createLiveWorkerDriver({
      db: t.db,
      workerId: "f2-stub-worker",
      sandbox: "host-fallback",
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      stageBaseDir: stageBase,
      stubInjection: {
        argv: [process.execPath, STUB_PI],
        coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: `server.mjs:${FIXED_SERVER}` },
        reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "stub 审查:候选实现机判四项通过" },
      },
      prepareWorkspace: seedF2,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", CHECK, "."], cwdWorkspace: true, timeoutMs: CHECK_TIMEOUT_MS },
      ],
      delivery,
      reserveCallsPerRun: 4,
      reviewerReserveCallsPerRun: 2,
      reviewAttempts: 1,
      wallSeconds: 300,
    });
    const report = await driver.tick();
    evidence("stub-tick-summary.json", JSON.stringify({ status: report.status, workerMode: "stub(显式标注)", gate: report.gate, delivery: report.delivery }, null, 2));
    expect(report.status).toBe("PROGRESSED");
    expect(report.gate?.status).toBe("ACCEPTED");
    expect(report.delivery?.execute).toMatchObject({ state: "DELIVERED" });
    // 独立核验:checkout 交付,起真实服务复跑机判
    const cap = captured as unknown as CapturedDelivery;
    const outDir = mkdtempSync(join(tmpdir(), "d-f2s-out-"));
    execFileSync("git", ["clone", "--quiet", remote.url, outDir], { stdio: "ignore" });
    markRunDir(outDir, { kind: "f2-out" });
    tmpRoots.push(outDir);
    const verify = execFileSync("node", [CHECK, "."], { cwd: outDir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
    evidence("stub-final-check.json", verify);
    expect(JSON.parse(verify).ok).toBe(true);
  });
});
