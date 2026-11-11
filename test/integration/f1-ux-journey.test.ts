// P0-总包阶段 D·Fixture F1:模糊 UX 需求真实业务全链(真模型;RELAY_F1_E2E=1 门)。
// 流程:一句"新增任务的页面不好用。"→ 真模型 Discovery(项目调查+推荐)→ 真模型 Coder
//       有限修改 → Gate(**Playwright 真浏览器确定性检查** = evidenceCheck;改进前必失败/改进后须通过)
//       → 独立 Reviewer → 本地 bare 交付(GitHub BLOCKED 不冒充)→ 证据落 p0-mvp/f1/。
// 预算声明(第三次声明;单次干净尝试):discovery 6 + coder 12 + reviewer 4(goal 账本 30;maxAttempts=1;magpie 零真实成本)。
// magpie 方差如实:失败诚实落 FAILED(隔离复跑一次定性;不伪造成功)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { planGoal } from "../../src/core/goals.ts";
import { runGoalDiscovery } from "../../src/core/discovery.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";
import { createLiveWorkerDriver, type DeliveryFactory, type CapturedDelivery } from "../../src/server/worker.ts";
import { prepareRunDirs, cleanupSandbox, type SandboxSpec } from "../../src/runtime/sandbox.ts";
import { ensureEgress } from "../../src/runtime/egress.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { REPO_ROOT, markRunDir, markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";

const FIXTURE = join(REPO_ROOT, "test/fixtures/f1-tasklist");
const CHECK = join(REPO_ROOT, "test/fixtures/f1-tasklist/check.mjs");
// 第四包②:证据写独立未跟踪目录(不再向已跟踪 p0-mvp/f1 追加;历史证据原样保留于原目录)
const EVIDENCE_DIR = join(REPO_ROOT, "test-evidence/f1");
const CHECK_TIMEOUT_MS = 180_000;

const gated = process.env.RELAY_F1_E2E === "1";
const STUB_PI = join(REPO_ROOT, "test/helpers/stub-pi.mjs");
// stub 写入的"真实改进"页面(满足 C1~C4;仅用于机制演示,显式标注 stub,不冒充模型)
const IMPROVED_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>新增任务</title></head>
<body>
  <h1>新增任务</h1>
  <form id="f">
    <div class="field"><label for="title">任务标题(必填)</label><input id="title" name="title"></div>
    <div class="field"><label for="owner">负责人</label><input id="owner" name="owner"></div>
    <div class="field"><label for="due">截止日</label><input id="due" name="due"></div>
    <p class="error" data-error style="display:none"></p>
    <button type="submit">保存</button>
  </form>
  <p id="ok" data-success style="display:none"></p>
  <script>
    document.getElementById("f").onsubmit = e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const err = document.querySelector("[data-error]");
      const ok = document.getElementById("ok");
      if (!d.title || !d.title.trim()) {
        err.textContent = "错误:任务标题为必填项。";
        err.style.display = "block";
        ok.style.display = "none";
        return;
      }
      err.style.display = "none";
      const a = JSON.parse(localStorage.getItem("tasks") || "[]");
      a.push(d);
      localStorage.setItem("tasks", JSON.stringify(a));
      ok.textContent = "已添加成功。查看任务列表";
      ok.style.display = "block";
    };
  </script>
</body>
</html>
`;
function envModel(): { provider: string; model: string; apiKey: string; baseUrl: string } | null {
  const provider = process.env.RELAY_PI_PROVIDER;
  const model = process.env.RELAY_PI_MODEL;
  const apiKey = process.env.RELAY_PI_API_KEY;
  const baseUrl = process.env.RELAY_PI_BASE_URL;
  if (!provider || !model || !apiKey || !baseUrl) return null;
  return { provider, model, apiKey, baseUrl };
}

describe.skipIf(!gated || envModel() === null)("Fixture F1:模糊 UX 需求 → 真模型全链交付(Playwright 机判)", { timeout: 900_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  let remote: BareRemoteFixture;
  let remoteBase = "";
  let stageBase = "";
  let egress: Awaited<ReturnType<typeof ensureEgress>> | null = null;
  const sandboxes: SandboxSpec[] = [];

  /** 复制 fixture 站点文件(不含 check.mjs —— 机判工具在候选面外)+ git main 基线(候选绑定需要)。 */
  function seedF1(workspaceDir: string): void {
    for (const f of readdirSync(FIXTURE)) {
      if (f === "check.mjs") continue; // 机判脚本不进候选面
      copyFileSync(join(FIXTURE, f), join(workspaceDir, f));
    }
    writeFileSync(join(workspaceDir, "brief.txt"), "用户反馈:新增任务的页面不好用。请调查并改进 new-task.html(保持现有字段与 localStorage 结构)。\n", "utf8");
    execFileSync("git", ["-C", workspaceDir, "init", "--initial-branch=main"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.email", "f1-seed@local"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.name", "f1-seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "commit", "--quiet", "-m", "f1 fixture base"], { stdio: "ignore" });
  }

  function evidence(name: string, content: string): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, name), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  beforeAll(async () => {
    t = await createTestDb("d-f1-ux");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
    remote = makeBareRemote(markTemp(mkdtempSync(join(tmpdir(), "d-f1-remote-"))));
    stageBase = markTemp(mkdtempSync(join(tmpdir(), "d-f1-stage-")));
    const eg = await ensureEgress(envModel()!.baseUrl);
    if (!eg.ok) throw new Error(`F1 需要 egress 栈(ensureEgress 失败:${eg.reason})`);
    egress = eg;
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("F1 全链:discovery → coder 修改 → Playwright 机判 Gate → Reviewer → 本地 bare DELIVERED", async () => {
    const model = envModel()!;
    const pi = resolveVendoredPi();

    // ---- 1) Goal(一句原话;预算账本 16)----
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec0, {
        id: "goal-f1-ux",
        rawInput: "新增任务的页面不好用。",
        budget: { modelCalls: 30 },
        tasks: [{ id: "t-f1-ux", goalText: "新增任务的页面不好用。", allowedScope: ["/workspace"], allowedCommands: ["node"], priority: 2, maxAttempts: 1 }],
      }),
    );

    // ---- 2) 真模型 Discovery(项目调查;预算 6)----
    const proj = markTemp(mkdtempSync(join(tmpdir(), "d-f1-proj-")));
    seedF1(proj);
    const disc = await runGoalDiscovery(t.db, pi, {
      goalId: "goal-f1-ux",
      model,
      sandbox: "host-fallback",
      projectDir: proj,
      reserveCallsPerRun: 6,
      wallSeconds: 300,
      actor: "owner",
    });
    evidence("discovery.json", JSON.stringify({ ok: disc.ok, source: disc.source, reason: disc.reason ?? null, report: disc.report ?? null }, null, 2));
    expect(disc.ok, `discovery 失败(如实):${disc.reason}`).toBe(true);
    expect(disc.report?.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(disc.report?.recommendation.action.length).toBeGreaterThan(3);

    // ---- 3) 全链 tick(真模型 Coder + Playwright evidenceCheck + Reviewer + 本地 bare 交付)----
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
          actor: "f1-worker",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = markTemp(mkdtempSync(join(tmpdir(), "d-f1-verify-")));
          const r = await verifyRemoteCommitContent({ target: remote.url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };

    // operator 采纳(US-03):把 Discovery 的可判定验收装配为有界任务文本(验收面不变:
    // 仍以 Playwright 机判为唯一通过依据;此步只是把"做什么"说清楚,不替模型写答案)
    const adoptedTaskText = [
      "调查 brief.txt 与 new-task.html/index.html,改进新增任务页面的可用性。",
      "必须实现(可判定验收,来自 Discovery):",
      ...(disc.report?.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`),
      "改进后逐项自查。只改 new-task.html 与 index.html,保持字段与 localStorage 结构不变。",
    ].join("\n");
    const driver = createLiveWorkerDriver({
      db: t.db,
      workerId: "f1-worker",
      sandbox: "docker",
      egress: egress!,
      model,
      stageBaseDir: stageBase,
      goalTextFor: async () => adoptedTaskText,
      prepareWorkspace: seedF1,
      evidenceChecks: [
        { kind: "deterministic_test", command: ["node", CHECK, "."], cwdWorkspace: true, timeoutMs: CHECK_TIMEOUT_MS },
      ],
      delivery,
      reserveCallsPerRun: 12,
      reviewerReserveCallsPerRun: 4,
      reviewAttempts: 1,
      wallSeconds: 600,
    });
    const report = await driver.tick();
    evidence("tick-summary.json", JSON.stringify({
      status: report.status,
      run: report.run ? { outcome: report.run.outcome, reason: report.run.reason ?? null } : null,
      gate: report.gate ? { status: report.gate.status, reason: (report.gate as { reason?: string }).reason ?? null } : null,
      delivery: report.delivery ?? null,
    }, null, 2));
    evidence("tick-full.json", JSON.stringify(report, null, 2));
    // 诊断全量:runs.detail(turns/recordTypes/stderrTail/toolAudit)
    try {
      const dbg = await t.db.execute(sql`SELECT id, outcome, detail FROM runs WHERE task_id='t-f1-ux' ORDER BY started_at`);
      evidence("runs-detail.json", JSON.stringify(dbg.rows, null, 2));
      const evs = await t.db.execute(sql`SELECT id, kind, passed, raw_output FROM gate_evidence WHERE task_id='t-f1-ux' ORDER BY created_at`);
      evidence("gate-evidence.json", JSON.stringify(evs.rows, null, 2));
    } catch { /* 诊断尽力 */ }
    expect(report.status, `F1 tick 失败(如实;run=${JSON.stringify(report.run)} gate=${JSON.stringify(report.gate)})`).toBe("PROGRESSED");
    expect(report.run?.outcome, `run.reason=${report.run?.reason}`).toBe("SUCCEEDED");
    expect(report.gate?.status, `gate.reason=${(report.gate as { reason?: string } | undefined)?.reason}`).toBe("ACCEPTED");
    expect(report.delivery?.execute).toMatchObject({ state: "DELIVERED" });

    // ---- 4) 独立核验:checkout 交付 commit,机判检查通过(改进后)----
    const cap = captured as unknown as CapturedDelivery;
    expect(cap?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const outDir = mkdtempSync(join(tmpdir(), "d-f1-out-"));
    execFileSync("git", ["clone", "--quiet", remote.url, outDir], { stdio: "ignore" });
    markRunDir(outDir, { kind: "f1-out" });
    const verify = execFileSync("node", [CHECK, "."], { cwd: outDir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
    evidence("final-check.json", verify);
    expect(JSON.parse(verify).ok).toBe(true);
    // diff 证据(改了什么)
    const diff = execFileSync("git", ["-C", outDir, "diff", "HEAD~1", "HEAD", "--", "new-task.html"], { encoding: "utf8" });
    evidence("final-diff.patch", diff || "(coder 以整文件重写呈现;diff 见 stage 仓)");
    // 远端历史只增不减 + 三 SHA 一致
    const cs = await t.db.execute(sql`SELECT git_commit_sha, git_tree_sha, delivered_remote_head, delivery_state FROM candidate_changesets WHERE task_id='t-f1-ux'`);
    expect(String(cs.rows[0]!["delivery_state"])).toBe("DELIVERED");
    expect(String(cs.rows[0]!["delivered_remote_head"])).toBe(cap!.commitSha);
    const remoteHead = execFileSync("git", ["-C", remote.dir, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    expect(remoteHead).toBe(cap!.commitSha);
  });
});


describe.skipIf(!gated)("Fixture F1(机制演示;stub coder 显式标注):机判 Gate 拒绝未改进/接受真改进 → 交付 → 独立复核", { timeout: 600_000 }, () => {
  let t: TestDb;
  let savedSchema: string | undefined;
  let remote: BareRemoteFixture;
  let stageBase = "";
  const sandboxes: SandboxSpec[] = [];

  function seedF1(workspaceDir: string): void {
    for (const f of readdirSync(FIXTURE)) {
      if (f === "check.mjs") continue;
      copyFileSync(join(FIXTURE, f), join(workspaceDir, f));
    }
    writeFileSync(join(workspaceDir, "brief.txt"), "用户反馈:新增任务的页面不好用。请调查并改进 new-task.html。\n", "utf8");
    execFileSync("git", ["-C", workspaceDir, "init", "--initial-branch=main"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.email", "f1-seed@local"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "config", "user.name", "f1-seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspaceDir, "commit", "--quiet", "-m", "f1 fixture base"], { stdio: "ignore" });
  }
  function evidence(name: string, content: string): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, name), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  beforeAll(async () => {
    t = await createTestDb("d-f1-ux-stub");
    savedSchema = process.env.RELAY_DB_SCHEMA;
    process.env.RELAY_DB_SCHEMA = t.schemaName;
    remote = makeBareRemote(markTemp(mkdtempSync(join(tmpdir(), "d-f1s-remote-"))));
    stageBase = markTemp(mkdtempSync(join(tmpdir(), "d-f1s-stage-")));
  });
  afterAll(async () => {
    process.env.RELAY_DB_SCHEMA = savedSchema;
    for (const s of sandboxes) cleanupSandbox(s);
    await t.cleanup();
  });

  it("stub coder 写入真实改进 → Playwright 机判通过 → Gate ACCEPTED → 本地 bare DELIVERED(报告全程显式标注 stub)", async () => {
    await t.db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec0, {
        id: "goal-f1-stub",
        rawInput: "新增任务的页面不好用。",
        budget: { modelCalls: 8 },
        tasks: [{ id: "t-f1-stub", goalText: "改进 new-task.html 可用性(标签/校验反馈/成功反馈/列表引导)", allowedScope: ["/workspace"], allowedCommands: [], priority: 2, maxAttempts: 1 }],
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
          actor: "f1-stub-worker",
        };
      },
      io: async (c) => ({
        executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
        verifyRemoteContent: async (commitSha: string) => {
          const scratch = markTemp(mkdtempSync(join(tmpdir(), "d-f1s-verify-")));
          const r = await verifyRemoteCommitContent({ target: remote.url, commitSha, manifest: c.manifest, scratchDir: scratch });
          return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
        },
        manifest: c.manifest,
      }),
    };
    const driver = createLiveWorkerDriver({
      db: t.db,
      workerId: "f1-stub-worker",
      // stub 注入:显式标注(报告/能力面均如实呈现 stub;不冒充真实模型执行)
      sandbox: "host-fallback",
      model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
      stageBaseDir: stageBase,
      stubInjection: {
        argv: [process.execPath, STUB_PI],
        coderEnv: { STUB_MODE: "ok", STUB_WRITE_FILE: `new-task.html:${IMPROVED_HTML}` },
        reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "stub 审查:候选实现机判通过" },
      },
      prepareWorkspace: seedF1,
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
    try {
      const evs = await t.db.execute(sql`SELECT id, kind, passed, raw_output FROM gate_evidence WHERE task_id='t-f1-stub' ORDER BY created_at`);
      evidence("stub-gate-evidence.json", JSON.stringify(evs.rows, null, 2));
      const dbg = await t.db.execute(sql`SELECT id, outcome, detail FROM runs WHERE task_id='t-f1-stub' ORDER BY started_at`);
      evidence("stub-runs-detail.json", JSON.stringify(dbg.rows, null, 2));
    } catch { /* 诊断尽力 */ }
    expect(report.status).toBe("PROGRESSED");
    expect(report.gate?.status).toBe("ACCEPTED");
    expect(report.delivery?.execute).toMatchObject({ state: "DELIVERED" });
    // 独立核验:checkout 交付,机判通过
    const cap = captured as unknown as CapturedDelivery;
    const outDir = mkdtempSync(join(tmpdir(), "d-f1s-out-")); // 先 clone(空目录),后打哨兵(D4 冲突教训)
    try {
      execFileSync("git", ["clone", remote.url, outDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      markRunDir(outDir, { kind: "f1-out" });
    } catch (e) {
      evidence("stub-clone-error.txt", String((e as { stderr?: Buffer; stdout?: Buffer; message?: string }).stderr ?? "") + "\n" + String((e as Error).message));
      throw e;
    }
    const verify = execFileSync("node", [CHECK, "."], { cwd: outDir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
    evidence("stub-final-check.json", verify);
    expect(JSON.parse(verify).ok).toBe(true);
  });
});

// 占位类型(避免额外 import;Exec0 = core Exec)
type Exec0 = import("../../src/core/db.ts").Exec;
