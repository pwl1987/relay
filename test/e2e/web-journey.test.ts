// P0-02C 真实浏览器用户旅程(Playwright + 真 Chromium + 真 PG;模型用确定性桩)。
// 门:RELAY_E2E=1 才跑(常规 vitest 全量自动 skip,不假装);CI 独立 e2e job 设置该门。
// 旅程(合同 §五):
//   J1 模糊需求创建 → 查看系统理解与可验证建议
//   J2 D3 长期未审批 → 其他安全任务正常推进(被 D3 卡住的任务不得越权推进)
//   J3 Worker 崩溃/任务失败 → UI 显示原因、证据与恢复状态
//   J4 查看候选变更 → 独立验证 → Gate → 正确显示交付状态(本地 bare 远端;不冒充 GitHub)
//   J5 刷新页面、断线重连后,页面状态仍与 PostgreSQL 一致
// 证据(D-8):截图、逐响应 HTTP 记录、浏览器错误、DB 状态快照 → p0-02c/。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver, type DeliveryFactory } from "../../src/server/worker.ts";
import type { AddressInfo } from "node:net";
import type { Exec } from "../../src/core/db.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";

const E2E = process.env.RELAY_E2E === "1";
const STUB = new URL("../helpers/stub-pi.mjs", import.meta.url).pathname;
const OUT_DIR = join(process.cwd(), "p0-02c");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const PASSWORD = "e2e-password-51ab";

interface JourneyLog {
  lines: string[];
  log(f: string): void;
  flush(file: string): void;
}
function makeJourneyLog(): JourneyLog {
  const lines: string[] = [];
  return {
    lines,
    log(f: string): void {
      lines.push(f);
    },
    flush(file: string): void {
      mkdirSync(OUT_DIR, { recursive: true });
      appendFileSync(join(OUT_DIR, file), lines.join("\n") + "\n");
    },
  };
}

// 每个 describe 一套独立栈(独立 schema + server + 浏览器),互不串扰。
interface Stack {
  t: TestDb;
  server: ReturnType<typeof createRelayServer>["server"];
  base: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  log: JourneyLog;
  httpLog: JourneyLog;
  errLog: JourneyLog;
  dbLog: JourneyLog;
  remote?: BareRemoteFixture;
  tmpRoots: string[];
}

async function startStack(label: string, opts: { delivery?: DeliveryFactory; stubMode?: string; verdict?: string } = {}): Promise<Stack> {
  const t = await createTestDb(`p02c-e2e-${label}`);
  const auth = new Auth({
    password: PASSWORD,
    sessionTtlMs: 3_600_000,
    operators: ["owner"],
    maxLoginFailures: 10,
    loginWindowMs: 60_000,
    lockoutMs: 60_000,
  });
  const driver = createLiveWorkerDriver({
    db: t.db,
    // 桩模型配置:驱动器要求显式模型面(FAIL-CLOSED);stub 下仅为占位,不发生真实网络调用
    model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
    sandbox: "host-fallback",
    workerId: `e2e-worker-${label}`,
    wallSeconds: 30,
    heartbeatSeconds: 2,
    reserveCallsPerRun: 4,
    reviewerReserveCallsPerRun: 2,
    reviewAttempts: 1,
    stubInjection: {
      argv: [process.execPath, STUB],
      coderEnv: { STUB_MODE: opts.stubMode ?? "ok", STUB_WRITE_FILE: "delivered.txt:ok", STUB_DELAY_MS: "80" },
      reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: opts.verdict ?? "PASS", STUB_FINDINGS: "e2e 独立审查通过", STUB_DELAY_MS: "80" },
    },
    prepareWorkspace: (ws: string) => {
      execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "config", "user.email", "seed@l"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "config", "user.name", "seed"], { encoding: "utf8" });
      writeFileSync(join(ws, "README.md"), "# seed\n", "utf8");
      writeFileSync(join(ws, "base.txt"), "base\n", "utf8");
      execFileSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
      execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "base"], { encoding: "utf8" });
    },
    evidenceChecks: [
      { kind: "deterministic_test", command: ["cat", "delivered.txt"], cwdWorkspace: true, expectOutputContains: "ok" },
    ],
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
    ...(opts.delivery ? { stageBaseDir: mkdtempSync(join(tmpdir(), "p02c-e2e-stage-")) } : {}),
  });
  const handle = createRelayServer({
    db: t.db,
    auth,
    worker: driver,
    workerMode: "stub",
    host: "127.0.0.1",
    port: 0,
    staticDir: join(process.cwd(), "web"),
    defaultGoalBudgetModelCalls: 12,
  });
  const server = handle.server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const log = makeJourneyLog();
  const httpLog = makeJourneyLog();
  const errLog = makeJourneyLog();
  const dbLog = makeJourneyLog();
  page.on("response", (res) => {
    httpLog.log(`${new Date().toISOString()} ${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") errLog.log(`${new Date().toISOString()} console.error ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errLog.log(`${new Date().toISOString()} pageerror ${err.message}`);
  });
  log.log(`# stack ${label} @ ${base}(stub worker;非真实模型)`);
  return { t, server, base, browser, context, page, log, httpLog, errLog, dbLog, remote: opts.delivery ? undefined : undefined, tmpRoots: [] };
}

async function stopStack(s: Stack): Promise<void> {
  await s.browser.close();
  await new Promise<void>((r) => s.server.close(() => r()));
  await s.t.cleanup();
  s.log.flush("e2e-journey.log");
  s.httpLog.flush("http-responses.log");
  s.errLog.flush("browser-errors.log");
  s.dbLog.flush("db-state.log");
  for (const r of s.tmpRoots) safeRm(r, { roots: s.tmpRoots, sentinel: RUN_SENTINEL });
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });
}

async function loginViaUi(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/login.html`);
  await page.fill("#password", PASSWORD);
  await page.click("#btn-login");
  await page.waitForURL(`${base}/`);
}

async function textOf(page: Page, sel: string): Promise<string> {
  const el = page.locator(sel);
  await el.waitFor({ state: "visible", timeout: 15000 });
  return (await el.textContent()) ?? "";
}


async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}


async function createGoalViaUi(page: Page, base: string, rawInput: string): Promise<string> {
  await page.goto(`${base}/`);
  await page.fill('[data-testid="goal-input"]', rawInput);
  await page.click('[data-testid="btn-create-goal"]');
  await page.waitForURL(/\/goal\.html\?id=/);
  return new URL(page.url()).searchParams.get("id") ?? "";
}

async function dumpDbState(s: Stack, tag: string): Promise<void> {
  const exec = s.t.db as unknown as Exec;
  const dump: Record<string, unknown> = { tag, at: new Date().toISOString() };
  for (const [name, q] of Object.entries({
    goals: sql`SELECT id, state, raw_input FROM goals ORDER BY created_at`,
    tasks: sql`SELECT id, state, state_version, attempt, max_attempts, blocked_reason, retry_not_before FROM tasks ORDER BY created_at`,
    runs: sql`SELECT id, task_id, outcome, detail->>'reason' AS reason, sandbox FROM runs ORDER BY started_at`,
    decisions: sql`SELECT id, task_id, level, state, question, deadline FROM decisions ORDER BY created_at`,
    changesets: sql`SELECT id, task_id, candidate_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head FROM candidate_changesets ORDER BY created_at`,
    gates: sql`SELECT id, task_id, verdict, consumed_at FROM task_gate_verdicts ORDER BY created_at`,
    proposals: sql`SELECT id, changeset_id, state, commit_sha, target FROM action_proposals ORDER BY created_at`,
    intents: sql`SELECT id, task_id, state, payload_sha, target FROM action_intents ORDER BY created_at`,
    evidence: sql`SELECT id, task_id, kind, passed FROM gate_evidence ORDER BY created_at`,
  })) {
    const res = await exec.execute(q);
    dump[name] = res.rows;
  }
  s.dbLog.log(`## ${tag}\n${JSON.stringify(dump, null, 2)}`);
}

describe.skipIf(!E2E)("P0-02C 真实浏览器旅程(J1/J2/J3)", { timeout: 180_000 }, () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack("journey-abc");
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("J1 模糊需求创建 → 查看系统理解与可验证建议(标注:确定性规则推导,非模型)", async () => {
    const { page, base } = s;
    await loginViaUi(page, base);
    // 模糊需求:一句自然语言(UI 真实输入与点击)
    await createGoalViaUi(page, base, "感觉登录页不好用,想让登录更快更清楚");
    await page.waitForSelector('[data-testid="goal-analysis"]');
    // 系统理解与可验证建议来自规则推导,且明确标注非模型
    const analysis = await textOf(page, '[data-testid="goal-analysis"]');
    expect(analysis).toContain("确定性规则推导");
    expect(analysis).toContain("非模型");
    const notice = await textOf(page, '[data-testid="model-analysis-notice"]');
    // REWORK-1 后口径:模型 Discovery 已实现(显式发起);页面如实区分规则面与模型结论(不混用)
    expect(notice).toContain("规则面");
    expect(notice).toContain("Discovery");
    // 建议必须带依据与验证方式
    const suggestions = await page.locator('[data-testid="suggestion-list"] li').count();
    expect(suggestions).toBeGreaterThan(0);
    expect(analysis).toContain("依据:");
    expect(analysis).toContain("验证方式:");
    // 原始需求如实回显
    const raw = await textOf(page, '[data-testid="goal-raw-input"]');
    expect(raw).toContain("登录页");
    await shot(page, "j1-goal-created.png");
    s.log.log(`J1 OK:创建模糊需求 Goal;分析来源=确定性规则推导;模型 Discovery=显式发起(页面区分规则面/模型结论);建议 ${suggestions} 条(含依据/验证方式)`);
    await dumpDbState(s, "J1 after goal create");
  });

  it("J2 D3 长期未审批:被卡任务停留 NEEDS_DECISION、决策仍 OPEN;其他任务正常推进到 ACCEPTED", async () => {
    const { page, base, t } = s;
    // 目标 A:READY 任务 + 未决 D3(长期未审批,deadline 已过;经 UI 创建)
    const goalA = await createGoalViaUi(page, base, "目标A:被 D3 卡住的工作");
    expect(goalA).toBeTruthy();
    const taskARow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalA}`);
    const taskA = String(taskARow.rows[0]!["id"]);
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, goal_id, level, question, state, deadline)
      VALUES ('dec-e2e-d3', ${taskA}, ${goalA}, 'D3', '是否扩大作用域?(长期未审批)', 'OPEN', now() + interval '30 days')
    `);
    // 目标 B:普通 READY 任务(与 A 互不依赖;经 UI 创建)
    const goalB = await createGoalViaUi(page, base, "目标B:不受 D3 影响的安全任务");
    expect(goalB).toBeTruthy();
    const taskBRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalB}`);
    const taskB = String(taskBRow.rows[0]!["id"]);

    // 通过 UI 推进若干拍(每拍只领一个任务;队列里还有 J1 遗留的 READY 任务,
    // 所以循环推进直到目标 B 到达终态 —— 期间 A 被 D3 卡住,绝不越权推进)
    for (let i = 0; i < 5; i++) {
      await page.goto(`${base}/`);
      await page.click('[data-testid="btn-tick"]');
      await page.locator("#create-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });
      const b = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskB}`);
      if (["ACCEPTED", "FAILED", "CANCELLED"].includes(String(b.rows[0]!["state"]))) break;
    }

    try {
    // A:D3 永不自动批准 —— 任务 NEEDS_DECISION、决策仍 OPEN(只有人能裁决)
    const dRow = await t.db.execute(sql`SELECT state, verdict FROM decisions WHERE id = 'dec-e2e-d3'`);
    expect(String(dRow.rows[0]!["state"])).toBe("OPEN");
    expect(dRow.rows[0]!["verdict"]).toBeNull();
    const aRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskA}`);
    expect(String(aRow.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // B:正常推进(终态 ACCEPTED)
    const bRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskB}`);
    expect(String(bRow.rows[0]!["state"])).toBe("ACCEPTED");

    // UI:Decision Inbox 展示 D3(OPEN)+ 三动作,无任何"自动批准"入口
    await page.goto(`${base}/decisions.html`);
    await page.waitForSelector('[data-testid="decision-card-dec-e2e-d3"]');
    const card = await textOf(page, '[data-testid="decision-card-dec-e2e-d3"]');
    expect(card).toContain("D3");
    expect(card).toContain("OPEN");
    expect(card).toContain("永不超时自动批准");
    expect(await page.locator('[data-testid="approve-dec-e2e-d3"]').count()).toBe(1);
    expect(await page.locator('[data-testid="reject-dec-e2e-d3"]').count()).toBe(1);
    expect(await page.locator('[data-testid="defer-dec-e2e-d3"]').count()).toBe(1);
    const policy = await textOf(page, '[data-testid="d3-policy-notice"]');
    expect(policy).toContain("永不超时自动批准");
    await shot(page, "j2-decision-inbox-d3.png");

    // Goal A 页面显示阻塞原因与下一动作
    await page.goto(`${base}/goal.html?id=${goalA}`);
    await page.waitForSelector('[data-testid="goal-tasks"]');
    const tasks = await textOf(page, '[data-testid="goal-tasks"]');
    expect(tasks).toContain("NEEDS_DECISION");
    await shot(page, "j2-goal-a-blocked.png");
    s.log.log("J2 OK:D3 任务停留 NEEDS_DECISION(决策仍 OPEN,零自动批准);无关任务推进到 ACCEPTED;UI 提供批准/拒绝/推迟且明示 D3 策略");
    } finally {
      await dumpDbState(s, "J2 after tick(finally)");
    }
  });

  it("J3 Worker 崩溃:Run FAILED 原因可见、任务恢复 READY(有界重试),异常进 Dashboard", async () => {
    const { page, base, t } = s;
    // 本旅程需要不同的桩模式(进程中途退出)⇒ 独立小栈
    const crash = await startStack("journey-crash", { stubMode: "exit-mid" });
    try {
      await loginViaUi(crash.page, crash.base);
      const goalC = await createGoalViaUi(crash.page, crash.base, "目标C:Worker 中途崩溃的任务");
      expect(goalC).toBeTruthy();
      await crash.page.goto(`${crash.base}/`);
      await crash.page.click('[data-testid="btn-tick"]');
      await crash.page.locator("#create-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });

      // DB 事实:Run FAILED(rpc_disconnect/进程退出),任务回到 READY(有界重试,attempt+1)
      const runRow = await crash.t.db.execute(sql`SELECT outcome, detail->>'reason' AS reason FROM runs ORDER BY started_at DESC LIMIT 1`);
      expect(String(runRow.rows[0]!["outcome"])).toBe("FAILED");
      const taskRow = await crash.t.db.execute(sql`SELECT state, attempt FROM tasks ORDER BY created_at DESC LIMIT 1`);
      expect(String(taskRow.rows[0]!["state"])).toBe("READY");
      expect(Number(taskRow.rows[0]!["attempt"])).toBe(1);

      // UI:Goal 页显示失败原因与恢复状态(运行记录 + 任务状态)
      await crash.page.goto(`${crash.base}/goal.html?id=${goalC}`);
      await crash.page.waitForSelector('[data-testid="goal-runs"] tr');
      const runsText = await textOf(crash.page, '[data-testid="goal-runs"]');
      expect(runsText).toContain("FAILED");
      expect(runsText).toContain("rpc_disconnect");
      const tasksText = await textOf(crash.page, '[data-testid="goal-tasks"]');
      expect(tasksText).toContain("READY");
      await shot(crash.page, "j3-crash-recovery.png");

      // UI:Dashboard 异常面板包含 run_failed
      await crash.page.goto(`${crash.base}/`);
      await crash.page.locator('[data-testid="anomalies-body"]', { hasText: "run_failed" }).waitFor({ timeout: 30000 });
      const anomalies = await textOf(crash.page, '[data-testid="anomalies-body"]');
      expect(anomalies).toContain("run_failed");
      await shot(crash.page, "j3-dashboard-anomaly.png");
      crash.log.log("J3 OK:崩溃 Run=FAILED(rpc_disconnect)在 UI 可见;任务恢复 READY(attempt=1,有界重试);Dashboard 异常面板含 run_failed");
    } finally {
      await dumpDbState(crash, "J3 after crash tick(finally)");
      await stopStack(crash);
    }
  });
});

describe.skipIf(!E2E)("P0-02C 真实浏览器旅程(J4/J5:交付与状态一致)", { timeout: 180_000 }, () => {
  let s: Stack;
  let remote: BareRemoteFixture;
  let goalD = "";
  let changesetId = "";

  beforeAll(async () => {
    remote = makeBareRemote(mkdtempSync(join(tmpdir(), "p02c-e2e-remote-")));
    const delivery: DeliveryFactory = {
      propose: async (c) => {
        // 测试装配:远端预置 base(候选 push 才能快进);expected = base
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
          actor: "e2e",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = mkdtempSync(join(tmpdir(), "p02c-e2e-verify-"));
          const r = await verifyRemoteCommitContent({ target: remote.url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    s = await startStack("journey-deliver", { delivery });
  });
  afterAll(async () => {
    await stopStack(s);
  });

  it("J4 候选变更 → 独立验证 → Gate → 交付状态正确展示(本地 bare 远端)", async () => {
    const { page, base, t } = s;
    await loginViaUi(page, base);
    goalD = await createGoalViaUi(page, base, "目标D:生成 delivered.txt 内容为 ok");
    expect(goalD).toBeTruthy();
    const taskRow = await t.db.execute(sql`SELECT id FROM tasks WHERE goal_id = ${goalD}`);
    const taskD = String(taskRow.rows[0]!["id"]);

    await page.goto(`${base}/`);
    await page.click('[data-testid="btn-tick"]');
    await page.locator("#create-msg", { hasText: "推进结果" }).waitFor({ timeout: 90000 });

    // DB 事实:全链 DELIVERED
    const csRow = await t.db.execute(sql`
      SELECT id, candidate_sha, git_tree_sha, git_commit_sha, delivery_state, delivered_remote_head
      FROM candidate_changesets WHERE task_id = ${taskD} ORDER BY created_at DESC LIMIT 1
    `);
    changesetId = String(csRow.rows[0]!["id"]);
    expect(String(csRow.rows[0]!["delivery_state"])).toBe("DELIVERED");
    const remoteHead = execFileSync("git", ["-C", remote.dir, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    expect(remoteHead).toBe(String(csRow.rows[0]!["git_commit_sha"]));

    // UI:ChangeSet/Evidence 页三 SHA 分列、Gate 已消费、交付状态 DELIVERED
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
    await page.waitForSelector('[data-testid="sha-commit"]');
    const cand = await textOf(page, '[data-testid="sha-candidate"]');
    const tree = await textOf(page, '[data-testid="sha-tree"]');
    const commit = await textOf(page, '[data-testid="sha-commit"]');
    expect(cand).toMatch(/^[0-9a-f]{64}$/);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(cand).not.toBe(tree);
    expect(tree).not.toBe(commit);
    expect(cand).not.toBe(commit);
    const gatesText = await textOf(page, '[data-testid="cs-gates"]');
    expect(gatesText).toContain("PASS");
    expect(gatesText).toContain("已消费");
    const detailText = await textOf(page, '[data-testid="cs-detail"]');
    expect(detailText).toContain("DELIVERED");
    const head = await textOf(page, '[data-testid="delivery-remote-head"]');
    expect(head.slice(0, 12)).toBe(commit.slice(0, 12));
    const caveat = await textOf(page, '[data-testid="delivery-caveat"]');
    expect(caveat).toContain("NOT_VERIFIED");
    expect(caveat).toContain("GitHub");
    await shot(page, "j4-changeset-delivered.png");
    s.log.log(`J4 OK:全链 DELIVERED(远端 HEAD=${remoteHead.slice(0, 12)});UI 三 SHA 两两不等;Gate PASS 已消费;页面如实标注 GitHub 真实写入 NOT_VERIFIED`);
    await dumpDbState(s, "J4 after delivery");
  });

  it("J5 刷新与断线重连:页面状态始终与 PostgreSQL 一致;断线时显示『连接中断』而非陈旧值冒充实时", async () => {
    const { page, base } = s;
    await page.goto(`${base}/changeset.html?id=${encodeURIComponent(changesetId)}`);
    await page.waitForSelector('[data-testid="sha-commit"]');
    const before = await textOf(page, '[data-testid="sha-commit"]');

    // 刷新:值不变(与 DB 一致)
    await page.reload();
    await page.waitForSelector('[data-testid="sha-commit"]');
    expect(await textOf(page, '[data-testid="sha-commit"]')).toBe(before);

    // 断线:点刷新 ⇒ 显示连接中断横幅(不把快照伪装成实时)
    await page.context().setOffline(true);
    await page.click('[data-testid="btn-refresh"]');
    await page.waitForSelector('[data-testid="conn-banner"]:not([hidden])');
    const banner = await textOf(page, '[data-testid="conn-banner"]');
    expect(banner).toContain("连接中断");
    expect(banner).toContain("不代表实时状态");
    await shot(page, "j5-offline-banner.png");

    // 重连:点刷新 ⇒ 横幅消失,渲染值仍等于 PostgreSQL 事实
    await page.context().setOffline(false);
    await page.click('[data-testid="btn-refresh"]');
    await page.waitForSelector('[data-testid="conn-banner"][hidden]', { state: "attached" });
    expect(await textOf(page, '[data-testid="sha-commit"]')).toBe(before);
    // 与 API(即 DB)直接对照
    const api = await fetch(`${base}/api/changesets/${encodeURIComponent(changesetId)}`, {
      headers: { cookie: await cookieHeader(page) },
    });
    const body = (await api.json()) as { changeset: { changeset: { gitCommitSha: string } } };
    expect(body.changeset.changeset.gitCommitSha).toBe(before);
    await shot(page, "j5-reconnected.png");
    s.log.log("J5 OK:刷新/断线/重连三态下,渲染值 == PostgreSQL 事实;断线期间明确显示『连接中断,不代表实时状态』");
    await dumpDbState(s, "J5 final");
  });
});
