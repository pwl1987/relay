// Relay 最小 CLI(P0-REWORK-2;US-04/V03)。
// 定位:无浏览器/无 ChatGPT 环境的本地 operator 控制面。**三入口同调 Core 权威**:
//   - 读 = src/server/views.ts 同一视图函数(与 API/Web 返回一致);
//   - 写 = core.ops(operate 同口径:actor 授权 + expected state_version + 合法转移 + 审计);
//   - tick = src/server/worker.ts 同一驱动(createLiveWorkerDriver;FAIL-CLOSED 同 server live)。
// 禁止直接 SQL 改状态;禁止绕过 operatorAllowed;输出统一 JSON 并经 redactSecrets 脱敏。
// 确定性退出码:0 成功 / 1 内部错误 / 2 用法错误 / 3 业务拒绝 / 4 未找到 / 5 环境不可用。
import { sql } from "drizzle-orm";
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  connectDb,
  closeDb,
  type RelayDb,
  type Exec,
  type DbHandle,
} from "./core/db.ts";
import { planGoal } from "./core/goals.ts";
import { operatorAllowed, resolveDecision, resumeTask, pauseTask } from "./core/ops.ts";
import { deferDecision } from "./core/decisions.ts";
import { redactSecrets } from "./server/redact.ts";
import { goalListView, goalDetailView, decisionListView, dashboardView } from "./server/views.ts";
import { createLiveWorkerDriver, type WorkerDriver } from "./server/worker.ts";
import { resolveVendoredPi } from "./runtime/pi-version.ts";
import { dockerAvailable } from "./runtime/sandbox.ts";

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  DENIED: 3,
  NOT_FOUND: 4,
  ENV: 5,
} as const;

export interface CliResult {
  code: number;
  out: string;
}

interface Flags {
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        // 布尔旗标(--approve/--reject/--stub/--probe)与取值旗标(--text X)
        const knownBoolean = new Set(["approve", "reject", "stub", "probe", "help"]);
        const name = a.slice(2);
        if (knownBoolean.has(name)) flags.set(name, "true");
        else {
          const v = argv[i + 1];
          if (v === undefined) flags.set(name, "");
          else {
            flags.set(name, v);
            i++;
          }
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function print(payload: unknown): string {
  return JSON.stringify(redactSecrets(payload), null, 2);
}

function requireFlags(f: Flags, names: string[]): Map<string, string> | string {
  for (const n of names) {
    const v = f.flags.get(n);
    if (v === undefined || v === "") return `缺少必填参数 --${n}`;
  }
  return f.flags;
}

function intFlag(flags: Map<string, string>, name: string): number | null {
  const n = Number(flags.get(name));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function reasonToExit(reason: string): number {
  if (reason.includes("not_found") || reason === "decision_task_mismatch" || reason === "task_not_found") return EXIT.NOT_FOUND;
  if (reason === "actor_not_authorized" || reason.includes("state_version_mismatch") || reason.includes("illegal_transition") || reason.includes("state_terminal") || reason.includes("not_open") || reason.includes("not_pending")) return EXIT.DENIED;
  return EXIT.INTERNAL;
}

/** 写命令公共壳:连接 → 事务 → core → 映射退出码;连接在 finally 关闭。 */
async function withDb(fn: (db: RelayDb) => Promise<{ code: number; payload: unknown }>): Promise<CliResult> {
  let handle: DbHandle | null = null;
  try {
    handle = connectDb(process.env.RELAY_DB_URL, process.env.RELAY_DB_SCHEMA || undefined);
    const { code, payload } = await fn(handle.db);
    return { code, out: print(payload) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 连接失败(库不可达)属环境错误;其余为内部错误
    const code = /ECONNREFUSED|ETIMEDOUT|password authentication|does not exist/i.test(msg) ? EXIT.ENV : EXIT.INTERNAL;
    return { code, out: print({ ok: false, error: code === EXIT.ENV ? "env_unavailable" : "internal_error", message: msg }) };
  } finally {
    if (handle) await closeDb(handle).catch(() => {});
  }
}

// ---- 命令实现 ----

async function cmdGoalCreate(f: Flags): Promise<CliResult> {
  const req = requireFlags(f, ["text"]);
  if (typeof req === "string") return usage(req);
  const flags = req;
  const actor = flags.get("actor") ?? "owner";
  const modelCalls = flags.has("model-calls") ? Number(flags.get("model-calls")) : 8;
  if (!Number.isFinite(modelCalls) || modelCalls <= 0) return usage("--model-calls 必须为正数(FAIL-CLOSED:无预算不允许模型 Run)");
  const scope = (flags.get("scope") ?? "/workspace").split(",").map((s) => s.trim()).filter(Boolean);
  const commands = (flags.get("commands") ?? "echo").split(",").map((s) => s.trim()).filter(Boolean);
  return withDb(async (db) => {
    // 与 API 写口径一致:operator 面校验(API 由会话角色承载,CLI 由 --actor 承载)
    if (!operatorAllowed(actor)) {
      return { code: EXIT.DENIED, payload: { ok: false, error: "actor_not_authorized", actor } };
    }
    const created = await db.transaction(async (tx) =>
      planGoal(tx as unknown as Exec, {
        rawInput: flags.get("text")!,
        budget: { modelCalls },
        tasks: [{ goalText: flags.get("text")!, allowedScope: scope, allowedCommands: commands, priority: 0, maxAttempts: 3 }],
        actor,
      }),
    );
    return { code: EXIT.OK, payload: { ok: true, goalId: created.goalId, taskIds: created.taskIds, budget: { modelCalls } } };
  });
}

async function cmdGoalShow(f: Flags): Promise<CliResult> {
  const goalId = f.positional[0];
  if (!goalId) return usage("用法:relay goal show <goalId>");
  return withDb(async (db) => {
    const detail = await goalDetailView(db, goalId);
    if (!detail) return { code: EXIT.NOT_FOUND, payload: { ok: false, error: "goal_not_found", goalId } };
    return { code: EXIT.OK, payload: { ok: true, goal: detail } };
  });
}

async function cmdDecisionResolve(f: Flags): Promise<CliResult> {
  const decisionId = f.positional[0];
  if (!decisionId) return usage("用法:relay decision resolve <decisionId> --task <taskId> --approve|--reject --expected-state-version N");
  const req = requireFlags(f, ["task", "expected-state-version"]);
  if (typeof req === "string") return usage(req);
  const flags = req;
  const approve = flags.has("approve");
  const reject = flags.has("reject");
  if (approve === reject) return usage("必须且只能选择 --approve 或 --reject");
  const version = intFlag(flags, "expected-state-version");
  if (version === null) return usage("--expected-state-version 必须为整数");
  let verdict: Record<string, unknown> = { approved: approve, via: "cli" };
  const vj = flags.get("verdict-json");
  if (vj) {
    try {
      verdict = { ...verdict, ...(JSON.parse(vj) as Record<string, unknown>) };
    } catch {
      return usage("--verdict-json 必须是合法 JSON 对象");
    }
  }
  const actor = flags.get("actor") ?? "owner";
  return withDb(async (db) => {
    const result = await db.transaction(async (tx) =>
      resolveDecision(tx as unknown as Exec, {
        decisionId,
        taskId: flags.get("task")!,
        approve,
        actor,
        expectedStateVersion: version,
        verdict,
      }),
    );
    if (!result.ok) return { code: reasonToExit(result.reason ?? ""), payload: { ok: false, error: result.reason } };
    return { code: EXIT.OK, payload: { ok: true, decisionId, taskId: flags.get("task"), fromState: result.fromState, toState: result.toState, decisionResolved: result.decisionResolved ?? false } };
  });
}

async function cmdDecisionDefer(f: Flags): Promise<CliResult> {
  const decisionId = f.positional[0];
  if (!decisionId) return usage("用法:relay decision defer <decisionId> --task <taskId> --deadline <ISO8601> --expected-state-version N");
  const req = requireFlags(f, ["task", "deadline", "expected-state-version"]);
  if (typeof req === "string") return usage(req);
  const flags = req;
  const version = intFlag(flags, "expected-state-version");
  if (version === null) return usage("--expected-state-version 必须为整数");
  const deadline = new Date(flags.get("deadline")!);
  if (Number.isNaN(deadline.getTime())) return usage("--deadline 必须是合法 ISO8601 时间");
  const actor = flags.get("actor") ?? "owner";
  return withDb(async (db) => {
    const result = await db.transaction(async (tx) =>
      deferDecision(tx as unknown as Exec, {
        decisionId,
        taskId: flags.get("task")!,
        expectedStateVersion: version,
        newDeadline: deadline,
        actor,
      }),
    );
    if (!result.ok) return { code: reasonToExit(result.reason ?? ""), payload: { ok: false, error: result.reason } };
    return { code: EXIT.OK, payload: { ok: true, decisionId, taskId: flags.get("task"), deferredTo: deadline.toISOString() } };
  });
}

async function cmdTaskTransition(f: Flags, mode: "resume" | "pause", taskIdFromSub?: string): Promise<CliResult> {
  const taskId = taskIdFromSub ?? f.positional[0];
  const name = mode === "resume" ? "task resume" : "pause";
  if (!taskId) return usage(`用法:relay ${name} <taskId> --expected-state-version N [--actor owner] [--reason ...]`);
  const req = requireFlags(f, ["expected-state-version"]);
  if (typeof req === "string") return usage(req);
  const version = intFlag(req, "expected-state-version");
  if (version === null) return usage("--expected-state-version 必须为整数");
  const actor = req.get("actor") ?? "owner";
  return withDb(async (db) => {
    const result = mode === "resume"
      ? await db.transaction(async (tx) => resumeTask(tx as unknown as Exec, taskId, { actor, expectedStateVersion: version }))
      : await db.transaction(async (tx) =>
          pauseTask(tx as unknown as Exec, taskId, {
            actor,
            expectedStateVersion: version,
            ...(req.has("reason") ? { reason: req.get("reason")! } : {}),
          }),
        );
    if (!result.ok) return { code: reasonToExit(result.reason ?? ""), payload: { ok: false, error: result.reason } };
    return { code: EXIT.OK, payload: { ok: true, taskId, fromState: result.fromState, toState: result.toState } };
  });
}

async function cmdWorkerTick(f: Flags): Promise<CliResult> {
  return withDb(async (db) => {
    const workerId = f.flags.get("worker-id") ?? "relay-cli-worker";
    // --seed <dir>:工作区初始化(复制种子内容 + git main 基线),候选变更绑定需要 git base;
    // 无 seed 时执行仍可进行,但候选装配会如实失败(delivery_not_captured ⇒ D3 人工处置)。
    const seedDir = f.flags.get("seed");
    const prepareWorkspace = seedDir
      ? (ws: string): void => {
          execFileSync("cp", ["-a", `${seedDir}/.`, ws]);
          execFileSync("git", ["-C", ws, "init", "--initial-branch=main"], { stdio: "ignore" });
          execFileSync("git", ["-C", ws, "config", "user.email", "relay-cli@local"], { stdio: "ignore" });
          execFileSync("git", ["-C", ws, "config", "user.name", "relay-cli"], { stdio: "ignore" });
          execFileSync("git", ["-C", ws, "add", "-A"], { stdio: "ignore" });
          execFileSync("git", ["-C", ws, "commit", "--quiet", "-m", "cli seed base"], { stdio: "ignore" });
        }
      : undefined;
    // 与 server live 同构;--stub 仅为测试/演练注入口(显式旗标,报告如实标注 stub,不冒充真实模型)
    let driver: WorkerDriver;
    if (f.flags.has("stub")) {
      // --stub 无值(布尔旗标 parseArgs 置 "true")⇒ 默认仓库桩;--stub <path> 用指定桩
      const stubVal = f.flags.get("stub");
      const stubPath = !stubVal || stubVal === "true" ? join(process.cwd(), "test", "helpers", "stub-pi.mjs") : stubVal;
      // 角色命名空间:STUB_REVIEWER_* → Reviewer env(剥离前缀);其余 STUB_* → Coder env。
      // Reviewer 缺省 PASS(verdict 模式)——显式 env 可覆盖。
      const coderEnv: Record<string, string> = {};
      let reviewerEnv: Record<string, string> = { STUB_MODE: "verdict", STUB_VERDICT: "PASS", STUB_FINDINGS: "cli-stub PASS" };
      for (const [k, v] of Object.entries(process.env)) {
        if (!v) continue;
        if (k.startsWith("STUB_REVIEWER_")) {
          reviewerEnv = { ...reviewerEnv, [k.slice("STUB_REVIEWER_".length)]: v };
        } else if (k.startsWith("STUB_")) {
          coderEnv[k] = v;
        }
      }
      driver = createLiveWorkerDriver({
        db,
        workerId,
        sandbox: "host-fallback",
        ...(prepareWorkspace ? { prepareWorkspace } : {}),
        // 桩模式必须显式注入桩 model(否则 envModel() 缺失 ⇒ FAIL-CLOSED 先于桩生效);
        // argv 注入后该配置不产生任何真实网络调用(与测试夹具同源)。
        model: { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" },
        stubInjection: {
          argv: [process.execPath, stubPath],
          coderEnv,
          reviewerEnv,
        },
      });
    } else {
      driver = createLiveWorkerDriver({
        db,
        workerId,
        sandbox: "docker",
        ...(prepareWorkspace ? { prepareWorkspace } : {}),
        stageBaseDir: process.env.RELAY_WEB_STAGE_DIR ?? join(homedir(), ".relay", "stage"),
      });
    }
    const report = await driver.tick();
    return { code: EXIT.OK, payload: { ok: true, workerMode: driver.mode, tick: report } };
  });
}

async function cmdDoctor(f: Flags): Promise<CliResult> {
  return withDb(async (db) => {
    const checks: Record<string, unknown> = {};
    // 每项检查独立容错:doctor 是诊断面,部分环境(未迁移/无表)也要出完整报告,不整段崩。
    const safe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        checks[name] = await fn();
      } catch (err) {
        checks[name] = { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    };
    // 1) DB 与迁移面(13 表存在性 + append-only 守卫函数;只读,不改任何状态)
    await safe("db", async () => {
      const TABLES = ["goals", "tasks", "leases", "runs", "sessions", "candidate_changesets", "task_gate_verdicts", "action_proposals", "gate_evidence", "action_intents", "decisions", "budget_ledger", "audit_events"];
      const tRes = await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY(${sql.raw(`ARRAY[${TABLES.map((t) => `'${t}'`).join(",")}]`)})
      `);
      const present = new Set(tRes.rows.map((r) => String(r["table_name"])));
      const missing = TABLES.filter((t) => !present.has(t));
      const guard = await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'relay_forbid_audit_mutation' AND n.nspname = current_schema()
      `);
      return {
        ok: missing.length === 0 && Number(guard.rows[0]?.["n"]) === 1,
        schema: "current_schema()",
        tablesPresent: present.size,
        missing,
        auditAppendOnlyGuard: Number(guard.rows[0]?.["n"]) === 1,
        note: missing.length > 0 ? "当前 schema 缺少迁移面(未跑 applyMigrations?)——属环境未就绪,非代码缺陷" : undefined,
      };
    });
    // 2) 当前阻断面:任务状态分布 + 未决决策(不揭示内容)
    await safe("workface", async () => {
      const states = await db.execute(sql`SELECT state, count(*)::int AS n FROM tasks GROUP BY state ORDER BY state`);
      const open = await db.execute(sql`SELECT level, count(*)::int AS n FROM decisions WHERE state = 'OPEN' GROUP BY level ORDER BY level`);
      return {
        ok: true,
        taskStates: Object.fromEntries(states.rows.map((r) => [String(r["state"]), Number(r["n"])])),
        openDecisions: Object.fromEntries(open.rows.map((r) => [String(r["level"]), Number(r["n"])])),
        note: "PAUSED/BLOCKED/NEEDS_DECISION 不被领取;D3 永不自动批准",
      };
    });
    // 3) Provider 配置可见性(不探测、不打印值)
    checks.provider = {
      configured: Boolean(process.env.RELAY_PI_PROVIDER && process.env.RELAY_PI_MODEL && process.env.RELAY_PI_API_KEY && process.env.RELAY_PI_BASE_URL),
      vars: ["RELAY_PI_PROVIDER", "RELAY_PI_MODEL", "RELAY_PI_API_KEY", "RELAY_PI_BASE_URL"].map((k) => ({ name: k, set: Boolean(process.env[k]) })),
      probed: false,
    };
    // 4) Pi / Docker(只读检查)
    try {
      const pi = resolveVendoredPi();
      checks.pi = { ok: true, version: pi.version };
    } catch (err) {
      checks.pi = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    checks.docker = { available: dockerAvailable() };
    // 5) GitHub 凭据:仅存在性与权限位,零内容(不读文件、不打印明文)
    const credPath = join(homedir(), ".relay", "credentials", "github-sandbox-pat");
    try {
      const st = statSync(credPath);
      checks.githubCredential = { exists: true, path: credPath, mode: (st.mode & 0o777).toString(8), sizeBytes: st.size, contentShown: false };
    } catch {
      checks.githubCredential = { exists: false, path: credPath, contentShown: false };
    }
    // 6) 出口探测(默认关闭;--probe 才发起,结果仅参考不改变退出码)
    checks.egress = { probed: false, note: "只读诊断不探测网络;以 worker tick 的 FAIL-CLOSED 事实为准(--probe 可选探测)" };
    if (f.flags.has("probe")) {
      const started = Date.now();
      try {
        const res = await fetch("https://api.github.com/zen", { signal: AbortSignal.timeout(5000) });
        checks.egress = { probed: true, ok: res.ok, httpStatus: res.status, ms: Date.now() - started };
      } catch (err) {
        checks.egress = { probed: true, ok: false, message: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
      }
    }
    const dbOk = (checks.db as { ok?: boolean }).ok === true;
    return { code: dbOk ? EXIT.OK : EXIT.ENV, payload: { ok: true, doctor: checks, generatedAt: new Date().toISOString() } };
  });
}

function usage(message: string): CliResult {
  const help = [
    "Relay CLI(最小 operator 控制面;全部命令经 Core,零第二状态机)",
    "",
    "  relay goal create --text \"…\" [--model-calls 8] [--scope /workspace] [--commands echo] [--actor owner]",
    "  relay goal list | relay goal show <goalId>",
    "  relay decision list | relay decision resolve <id> --task <taskId> --approve|--reject --expected-state-version N [--verdict-json '{}']",
    "  relay decision defer <id> --task <taskId> --deadline <ISO8601> --expected-state-version N",
    "  relay task resume <taskId> --expected-state-version N",
    "  relay pause <taskId> --expected-state-version N [--reason …]",
    "  relay worker tick [--worker-id relay-cli-worker] [--stub] [--seed <dir>]",
    "  relay status | relay doctor [--probe]",
    "",
    "退出码:0 成功 / 1 内部错误 / 2 用法错误 / 3 业务拒绝 / 4 未找到 / 5 环境不可用",
  ].join("\n");
  return { code: EXIT.USAGE, out: `${message}\n\n${help}\n` };
}

/** 单命令分发(纯函数式入口;连接生命周期由各命令自管)。 */
export async function runCli(argv: string[]): Promise<CliResult> {
  const [cmd, sub, ...rest] = argv;
  const f = parseArgs(rest);
  if (!cmd || cmd === "help" || f.flags.has("help")) return usage("Relay CLI 用法:");
  if (cmd === "goal") {
    if (sub === "create") return cmdGoalCreate(f);
    if (sub === "list") return withDb(async (db) => ({ code: EXIT.OK, payload: { ok: true, goals: await goalListView(db) } }));
    if (sub === "show") return cmdGoalShow(f);
    return usage("用法:relay goal create|list|show …");
  }
  if (cmd === "decision") {
    if (sub === "list") return withDb(async (db) => ({ code: EXIT.OK, payload: { ok: true, decisions: await decisionListView(db) } }));
    if (sub === "resolve") return cmdDecisionResolve(f);
    if (sub === "defer") return cmdDecisionDefer(f);
    return usage("用法:relay decision list|resolve|defer …");
  }
  if (cmd === "task") {
    if (sub === "resume") return cmdTaskTransition(f, "resume");
    return usage("用法:relay task resume <taskId> …");
  }
  if (cmd === "worker") {
    if (sub === "tick") return cmdWorkerTick(f);
    return usage("用法:relay worker tick …");
  }
  if (cmd === "pause") return cmdTaskTransition(f, "pause", sub);
  if (cmd === "status") return withDb(async (db) => ({ code: EXIT.OK, payload: { ok: true, dashboard: await dashboardView(db) } }));
  if (cmd === "doctor") return cmdDoctor(f);
  return usage(`未知命令:${argv.join(" ")}`);
}

/** 进程入口:stdout 输出 JSON/帮助;退出码 = 命令结果。 */
export async function runCliMain(argv: string[]): Promise<void> {
  try {
    const { code, out } = await runCli(argv);
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    process.exitCode = code;
  } catch (err) {
    process.stdout.write(`${print({ ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = EXIT.INTERNAL;
  }
}

// 直跑入口仅限 `node src/cli.ts`;bin/relay.mjs 由薄壳显式调用,避免双重执行。
const isMain = process.argv[1] !== undefined && process.argv[1]!.endsWith("cli.ts");
if (isMain) {
  runCliMain(process.argv.slice(2)).catch((err: unknown) => {
    console.error(String(err));
    process.exitCode = EXIT.INTERNAL;
  });
}
