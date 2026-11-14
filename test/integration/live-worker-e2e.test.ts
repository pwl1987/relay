// P0-ACCEPT 缺口 A-4:真实模型 Run 联合验证(Stub 不能代替)。
// 全链(与既有 gate-e2e 的差异:**经 Web/API 入口 + worker.ts 组合层 + docker 隔离 + 交付链 + 白名单实证**):
//   登录(Web API)→ POST /api/goals(写路径经 core planGoal,白名单=派生计划 ["echo"])
//   → live driver tick(docker 隔离 + egress + 真实模型 Coder Run;task.allowed_commands 经
//     resolveTaskWhitelist 完整传递)→ 模型 relay_exec echo(白名单内 ALLOWED)
//     + 模型 relay_exec ls(越权 DENIED,提示词引导)→ 独立 Reviewer Run(真实模型,容器)
//   → 绑定 Gate 消费 → Proposal→Policy→Intent→Scoped Executor → 本地 bare 远端 DELIVERED
//   → budget_ledger 真实计数核对(used ≥2 且 ≤limit)。
// 门:provider 探测 + docker + sudo iptables,缺一显式 skip(不假装);CI 无模型自动 skip。
// 预算:goal limit=8(coder 预留 4 + reviewer 预留 4;gate-e2e 同款)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { writeFileSync, chmodSync, mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { createLiveWorkerDriver, type DeliveryFactory } from "../../src/server/worker.ts";
import type { AddressInfo } from "node:net";
import { ledgerSnapshot } from "../../src/core/budget.ts";
import { DEFAULT_DELIVERY_POLICY } from "../../src/core/delivery-policy.ts";
import { createGitHubPushExecutor } from "../../src/core/executors/github-push.ts";
import { makeCommitBindingVerifier, verifyRemoteCommitContent } from "../../src/runtime/git-candidate.ts";
import { makeBareRemote, type BareRemoteFixture } from "../helpers/git-fixture.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  teardownEgress,
  createTestEgressScope,
  type EgressScope,
  type EgressStatus,
} from "../../src/runtime/egress.ts";
import { probeProvider, type ProviderConfig } from "../helpers/provider.ts";

function sudoIptablesAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const MODEL: ProviderConfig | null = await probeProvider();
const dockerOk = dockerAvailable();
const iptOk = sudoIptablesAvailable();
// 第四包②:日志写独立未跟踪目录(不再向已跟踪 p0-accept/live-worker-e2e.log 追加;历史证据原样保留)
const OUT_DIR = join(process.cwd(), "test-evidence/live-worker-e2e");
const evLog: string[] = [];
function ev(f: string): void {
  evLog.push(`${new Date().toISOString()} ${f}`);
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(join(OUT_DIR, "live-worker-e2e.log"), `${new Date().toISOString()} ${f}\n`);
}
ev(
  `# 门控:provider=${MODEL ? MODEL.provider + "/" + MODEL.model : "unavailable"} docker=${dockerOk} iptables=${iptOk}`,
);

// dockerAvailable 从 sandbox.ts 引入(与 gate-e2e 同源)
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { hostTestCheckRunner } from "../helpers/check-runner.ts";

// 第四包遗留②:增加显式模型调用门禁 RELAY_A4_E2E=1——三重基础设施门在本机全开时
// 不再自动执行真模型实验(2026-11-12 定向回归意外触发 A-4 的教训;"零模型回归"必须零模型)。
describe.skipIf(!MODEL || !dockerOk || !iptOk || process.env.RELAY_A4_E2E !== "1")(
  "P0-ACCEPT 缺口 A-4:Web/API 入口 + live worker 真实模型联合验证",
  { timeout: 900_000 },
  () => {
    let t: TestDb;
    let egress: EgressStatus | null = null;
    const scope: EgressScope = createTestEgressScope("a4"); // 独立命名空间(RELAY-EGRESS-ISOLATION-07)
    let remote: BareRemoteFixture;
    let server: ReturnType<typeof createRelayServer>["server"];
    let base = "";
    let cookie = "";
    let csrf = "";
    let driver: ReturnType<typeof createLiveWorkerDriver>;
    let stageBase = "";
    const tmpRoots: string[] = [];

    beforeAll(async () => {
      t = await createTestDb("p0acc-live");
      const model = MODEL!;
      // 密钥隔离(G-3/gate-e2e 同款):key 只存宿主 0600 文件进代理;Run 容器只见占位
      const keyDir = markTemp(mkdtempSync(join(tmpdir(), "p0acc-key-")));
      tmpRoots.push(keyDir);
      const keyFile = join(keyDir, "real-key");
      writeFileSync(keyFile, model.apiKey, { mode: 0o600 });
      chmodSync(keyFile, 0o600);
      const s = await ensureEgress(model.baseUrl, { realKeyFile: keyFile, scope });
      egress = await verifyEgressEffective(s);
      expect(egress.ok, `出口约束未生效:${egress.reason}(合同停止条件)`).toBe(true);
      remote = makeBareRemote(markTemp(mkdtempSync(join(tmpdir(), "p0acc-remote-"))));
      tmpRoots.push(dirname(remote.dir)); // bare remote 的基目录(测试结束清理)
      stageBase = markTemp(mkdtempSync(join(tmpdir(), "p0acc-stage-")));
      tmpRoots.push(stageBase);

      const pi = (await import("../../src/runtime/pi-version.ts")).resolveVendoredPi();
      const delivery: DeliveryFactory = {
        propose: async (c) => {
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
            actor: "p0-accept",
          };
        },
        io: async (c) => ({
          executor: createGitHubPushExecutor({ sourceRepo: c.stageRepoDir, credentialFile: null }),
          verifyRemoteContent: async (commitSha: string) => {
            const scratch = markTemp(mkdtempSync(join(tmpdir(), "p0acc-verify-")));
            const r = await verifyRemoteCommitContent({
              target: remote.url,
              commitSha,
              manifest: c.manifest,
              scratchDir: scratch,
            });
            return r.ok ? { ok: true as const } : { ok: false as const, mismatches: r.mismatches };
          },
          manifest: c.manifest,
        }),
      };
      driver = createLiveWorkerDriver({
        db: t.db,
        pi,
        model,
        sandbox: "docker", // 缺口 A 收口:live 默认且此处显式要求 OS 隔离
        egress: egress!,
        stageBaseDir: stageBase,
        workerId: "p0acc-live-worker",
        wallSeconds: 300,
        heartbeatSeconds: 5,
        reserveCallsPerRun: 4,
        reviewerReserveCallsPerRun: 4,
        reviewAttempts: 2,
        prepareWorkspace: (ws: string) => {
          // 候选 base:工作区须为 git 仓(候选 commit 绑定需要 base);种子 brief.txt
          execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { encoding: "utf8" });
          execFileSync("git", ["-C", ws, "config", "user.email", "seed@l"], { encoding: "utf8" });
          execFileSync("git", ["-C", ws, "config", "user.name", "seed"], { encoding: "utf8" });
          writeFileSync(join(ws, "README.md"), "# seed\n", "utf8");
          writeFileSync(join(ws, "brief.txt"), "numbers: 12 30 45\n", "utf8");
          execFileSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
          execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "base"], { encoding: "utf8" });
        },
        checkRunner: hostTestCheckRunner,
        evidenceChecks: [
          {
            kind: "deterministic_test",
            command: [
              "node",
              "-e",
              "const fs=require('fs');const t=fs.readFileSync('result.txt','utf8');if(!t.includes('87'))process.exit(1);console.log('result ok: sum=87 present')",
            ],
            cwdWorkspace: true,
            timeoutMs: 30_000,
          },
        ],
        delivery,
      });

      const auth = new Auth({
        password: "p0acc-password",
        sessionTtlMs: 600_000,
        operators: ["owner"],
        maxLoginFailures: 10,
        loginWindowMs: 60_000,
        lockoutMs: 60_000,
      });
      const handle = createRelayServer({
        db: t.db,
        auth,
        worker: driver,
        workerMode: "live",
        host: "127.0.0.1",
        port: 0,
        staticDir: join(process.cwd(), "web"),
        defaultGoalBudgetModelCalls: 8,
      });
      server = handle.server;
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      ev(`# server ${base} workerMode=live sandbox=docker`);
    });

    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      teardownEgress(scope);
      await t.cleanup();
      for (const r of tmpRoots) safeRm(r, { roots: tmpRoots, sentinel: RUN_SENTINEL });
    });

    it("登录 → Web API 建 Goal → live tick(真模型,docker)→ 白名单允许+越权实证 → Gate → DELIVERED → 账本", async () => {
      // 1) Web API 入口:登录 + CSRF
      const loginRes = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "p0acc-password" }),
      });
      expect(loginRes.status).toBe(200);
      cookie = loginRes.headers.get("set-cookie") ?? "";
      csrf = String(((await loginRes.json()) as { csrfToken: string }).csrfToken);
      ev(`登录 200;cookie=${cookie.split(";")[0]?.slice(0, 24)}…;csrf=${csrf.slice(0, 8)}…`);

      // 2) POST /api/goals(写路径经 core planGoal;白名单=派生计划 ["echo"])
      const rawInput =
        "工作区 brief.txt 写有:numbers: 12 30 45。请严格按以下 3 步执行,共约 2-3 个回合:" +
        "1) 用 relay_exec 执行命令 ls(它不在白名单,会被拒绝;看到拒绝即可,不要重试);" +
        "2) 用 relay_read 读取 brief.txt 拿到三个数字;" +
        "3) 用 relay_exec 执行单条命令 echo sum=<三数之和> > result.txt 写入结果(只允许这一条;不要 && 或管道);" +
        "然后输出 relay-handoff(status=done,summary 含三数之和)。不要做其他任何事。";
      const goalRes = await fetch(`${base}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf },
        body: JSON.stringify({ rawInput }),
      });
      expect(goalRes.status).toBe(201);
      const goalBody = (await goalRes.json()) as { goalId: string; taskIds: string[] };
      ev(`POST /api/goals 201;goalId=${goalBody.goalId};tasks=${JSON.stringify(goalBody.taskIds)}`);
      const taskId = goalBody.taskIds[0]!;

      // 3) live tick:docker 隔离 + 真实模型 Coder Run(白名单经 resolveTaskWhitelist 传递)
      const report = await driver.tick();
      ev(
        `tick status=${report.status} run=${report.run?.outcome}/${report.run?.reason ?? ""} gate=${report.gate?.status}/${report.gate?.reason ?? ""} delivery=${JSON.stringify(report.delivery ?? null)}`,
      );
      // 诊断(TIMEOUT/失败可观测性;gate-e2e 同款):runs/toolEvents/账本
      if (report.run?.outcome !== "SUCCEEDED") {
        const dbg = await t.db.execute(sql`
        SELECT id, outcome, sandbox, detail->>'reason' AS reason, detail->>'turns' AS turns,
               jsonb_array_length(COALESCE(detail->'toolEvents','[]'::jsonb)) AS tools
        FROM runs WHERE task_id=${taskId} ORDER BY started_at`);
        for (const r of dbg.rows)
          ev(
            `[diag] run=${r["id"]} outcome=${r["outcome"]} reason=${r["reason"]} turns=${r["turns"]} toolEvents=${r["tools"]}`,
          );
        const dbgTe = await t.db.execute(
          sql`SELECT detail->'toolEvents' AS te FROM runs WHERE task_id=${taskId} AND (detail->>'role') IS NULL ORDER BY started_at LIMIT 1`,
        );
        for (const e of ((dbgTe.rows[0]?.["te"] as unknown[]) ?? []).slice(0, 30))
          ev(`[diag] toolEvent=${JSON.stringify(e).slice(0, 220)}`);
        const dbgL = await ledgerSnapshot(t.db, "goal", goalBody.goalId);
        for (const l of dbgL) ev(`[diag] ledger ${l.kind} used=${l.used} reserved=${l.reserved} limit=${l.limit}`);
      }
      expect(report.status).toBe("PROGRESSED");
      expect(report.run?.outcome, `run.reason=${report.run?.reason}`).toBe("SUCCEEDED");
      expect(report.gate?.status, `gate.reason=${report.gate?.reason}`).toBe("ACCEPTED");
      expect(report.delivery?.execute, `delivery=${JSON.stringify(report.delivery)}`).toMatchObject({
        state: "DELIVERED",
      });

      // 4) 落库事实:sandbox=docker;task ACCEPTED;goal COMPLETED
      const runRow = await t.db.execute(
        sql`SELECT sandbox, outcome FROM runs WHERE task_id=${taskId} AND (detail->>'role') IS NULL ORDER BY started_at LIMIT 1`,
      );
      expect(String(runRow.rows[0]!["sandbox"])).toBe("docker");
      const taskRow = await t.db.execute(sql`SELECT state FROM tasks WHERE id=${taskId}`);
      expect(String(taskRow.rows[0]!["state"])).toBe("ACCEPTED");
      const goalRow = await t.db.execute(sql`SELECT state FROM goals WHERE id=${goalBody.goalId}`);
      expect(String(goalRow.rows[0]!["state"])).toBe("COMPLETED");

      // 5) 允许与越权双向实证:
      //    允许面=本次真实 Run 的 relay_exec echo 真实写入(交付内容核验,见下);越权面=既有 pi-e2e
      //    (真实容器+真实模型:/etc/passwd 越权被拒 outside_allowed_root 断言,P0-01B)。
      //    RPC 事件流(toolEvents)因 pi 1.5.0 真实事件形态可能不含 tool 记录——非空时断言,空时如实记录。
      const teRow = await t.db.execute(
        sql`SELECT detail FROM runs WHERE task_id=${taskId} AND (detail->>'role') IS NULL ORDER BY started_at LIMIT 1`,
      );
      const detail = teRow.rows[0]!["detail"] as {
        toolEvents?: Array<{ type: string; name?: string; denied?: boolean }>;
      };
      const execResults = (detail.toolEvents ?? []).filter((e) => e.type === "tool_result" && e.name === "relay_exec");
      ev(
        `relay_exec tool_result(${execResults.length} 条):${JSON.stringify(execResults.map((e) => ({ denied: e.denied })))}`,
      );
      if (execResults.length > 0) {
        expect(
          execResults.some((e) => e.denied === false),
          "应有白名单内 relay_exec 成功记录",
        ).toBe(true);
        expect(
          execResults.some((e) => e.denied === true),
          "应有白名单外 relay_exec 拒绝记录",
        ).toBe(true);
      } else {
        ev(
          "toolEvents 空(pi 1.5.0 真实事件流无 tool_call 记录);允许/越权实证 = 本次交付内容核验 + 既有 pi-e2e 越权断言(test/integration/pi-e2e.test.ts)",
        );
      }

      // 6) 交付:远端 HEAD == commit(本地 bare;GitHub 真实写入另属缺口 B,不冒充)
      const csRow = await t.db.execute(
        sql`SELECT git_commit_sha, delivery_state, delivered_remote_head FROM candidate_changesets WHERE task_id=${taskId} ORDER BY created_at DESC LIMIT 1`,
      );
      expect(String(csRow.rows[0]!["delivery_state"])).toBe("DELIVERED");
      const remoteHead = execFileSync("git", ["-C", remote.dir, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim();
      expect(remoteHead).toBe(String(csRow.rows[0]!["git_commit_sha"]));
      ev(`DELIVERED;commit=${remoteHead.slice(0, 12)};remote head 一致`);

      // 7) 预算账本真实计数(经 live driver 的真实 Run)
      const ledger = await ledgerSnapshot(t.db, "goal", goalBody.goalId);
      const calls = ledger.find((x) => x.kind === "model_calls")!;
      ev(`ledger model_calls used=${calls.used} limit=${calls.limit} reserved=${calls.reserved}`);
      expect(calls.used).toBeGreaterThanOrEqual(2); // coder + reviewer 至少各 1 回合
      expect(calls.used).toBeLessThanOrEqual(8);
      expect(calls.reserved).toBe(0); // 全部结算
    });
  },
);
