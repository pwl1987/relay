// RELAY-DEPLOY-PREFLIGHT-05:最小只读部署准入预检入口(零写入/零重启/零凭据值输出)。
// 产出:脱敏的 PASS/FAIL/NOT_RUN/UNKNOWN 逐项结果 + 失败原因 + 实际检查时间 + 引用 HEAD SHA
//       + 汇总裁决 GO / NO-GO / UNKNOWN。
// 边界(合同§边界):本工具只读 —— 不重启/停止/改写任何服务、不写 relay_console 数据、
//       不读环境变量取值(仅键名与结构合规性;镜像 tag/库名为非敏感取值可显示)、
//       不输出凭据/连接串/原始用户数据;DB 仅聚合计数。不得以本工具自身增权来通过检查。
// 用法:node deploy/preflight.ts [--json] [--env-file <path>] [--pg-container <name>]
// 退出码:0=GO,1=UNKNOWN,2=NO-GO。GO/UNKNOWN 仅代表"部署准入材料状态",
//        不代表生产可自动发布;生产切换必须由用户单独 D3 授权后按 Runbook 执行。
// 复用既有设施:校验规则取自 src/worker-entry.ts resolveEvidenceChecks(单一来源,无第二校验器);
//        psql 经 relay-p000-pg 容器执行(与 deploy/backup.sh 容器回退同源)。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEvidenceChecks } from "../src/worker-entry.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "../src/runtime/sandbox.ts";

export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";
export type Verdict = "GO" | "NO-GO" | "UNKNOWN";

/** 单个 systemd user 单元的一次只读快照(queryable=false ⇒ 无法查询,不得虚构运行态)。 */
export interface UnitStatus {
  name: string;
  /** systemd 查询是否得到回答;false ⇒ "无法查询",不得虚构 active=false("未运行")。 */
  queryable: boolean;
  active: boolean;
  sinceIso: string | null;
  pid: number | null;
  reason?: string;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightReport {
  startedAt: string;
  headSha: string | null;
  schema: string;
  results: CheckResult[];
  verdict: Verdict;
  note: string;
}

/** 探针端口(生产默认实现见 defaultProbes;测试注入受控桩)。 */
export interface PreflightProbes {
  nowIso(): string;
  gitHead(): {
    ok: boolean;
    sha?: string;
    dirty?: boolean;
    /** 被跟踪树状态是否可靠读取;false ⇒ 不得假 clean(06 A 项 fail-closed)。 */
    dirtyReadable?: boolean;
    commitTimeIso?: string;
    reason?: string;
  };
  envFile(): {
    exists: boolean;
    mode: number | null;
    keys: string[];
    get(name: string): string | undefined;
  };
  credFileMode(path: string): number | null;
  units(): UnitStatus[];
  listening(port: number): { addr: string }[];
  docker(): {
    available: boolean;
    imageExists(tag: string): boolean;
    networkExists(name: string): boolean;
    containerRunning(name: string): boolean;
  };
  sql(query: string): Promise<{ ok: boolean; rows: string[][]; reason?: string }>;
}

export interface PreflightOptions {
  schema?: string;
  envPath?: string;
  pgContainer?: string;
  sandboxImage?: string;
  egressNetwork?: string;
  egressProxyContainer?: string;
  webPort?: number;
  webUnit?: string;
  workerUnit?: string;
  requiredEnvKeys?: string[];
}

const EXPECTED_TABLES = [
  "action_intents", "action_proposals", "audit_events", "budget_ledger", "candidate_changesets",
  "decisions", "discoveries", "gate_evidence", "goal_message_consumptions", "goal_messages",
  "goals", "leases", "runs", "sessions", "task_gate_verdicts", "tasks",
] as const;

const DEFAULT_REQUIRED_ENV_KEYS = [
  "RELAY_DB_URL", "RELAY_DB_SCHEMA", "RELAY_PI_PROVIDER", "RELAY_PI_MODEL", "RELAY_PI_API_KEY",
  "RELAY_PI_BASE_URL", "RELAY_WEB_HOST", "RELAY_WEB_PORT", "RELAY_WEB_ALLOW_NON_LOOPBACK",
  "RELAY_OPERATORS",
] as const;

const BLOCKING_TASK_STATES = ["VERIFYING", "DELIVERING", "NEEDS_RECONCILE", "RUNNING"] as const;

/** 判定器(纯函数):任何 FAIL⇒NO-GO;否则任何 NOT_RUN/UNKNOWN⇒UNKNOWN;否则 GO。 */
export function computeVerdict(results: CheckResult[]): Verdict {
  if (results.some((r) => r.status === "FAIL")) return "NO-GO";
  if (results.some((r) => r.status === "NOT_RUN" || r.status === "UNKNOWN")) return "UNKNOWN";
  return "GO";
}

/** 单一入口:执行全部只读检查并汇总(不触任何写路径)。 */
export async function runPreflight(probes: PreflightProbes, opts: PreflightOptions = {}): Promise<PreflightReport> {
  const schema = opts.schema ?? "relay_console";
  const results: CheckResult[] = [];
  const push = (id: string, status: CheckStatus, detail: string) => results.push({ id, status, detail });
  const startedAt = probes.nowIso();

  // ── 1) git HEAD 与被跟踪树清洁度(部署必须来自确切提交;探针失败不得假 clean) ──
  const head = probes.gitHead();
  if (!head.ok) {
    push("git_head", "NOT_RUN", `未能读取 git HEAD:${head.reason ?? "?"}`);
  } else if (head.dirtyReadable === false) {
    push(
      "git_head",
      "NOT_RUN",
      `未能读取被跟踪树状态(${head.reason ?? "?"}):不能确认部署来自确切提交 ⇒ fail-closed 不假 clean`,
    );
  } else {
    push(
      "git_head",
      head.dirty ? "FAIL" : "PASS",
      `HEAD=${head.sha};被跟踪树${head.dirty ? "存在未提交修改(部署必须来自确切提交)" : "清洁"}`,
    );
  }

  // ── 2) systemd user 服务运行态 + 3) 进程代码版本差异 ──
  // 06 A 项(协调方 Major 反例修复):探针异常标"无法查询"而非虚构"未运行";要输出
  // process_vs_head=PASS 必须"全部目标服务与 HEAD 时间可靠读取且真实匹配",缺任何条件不 PASS
  // (空 stale 集合 ≠ 有读取依据;VM80 无 user bus 会话实证:05 版曾把两个真实运行的服务报
  // FAIL"未运行",同时报 process_vs_head=PASS"新代码已生效"——双重虚构)。
  const webUnit = opts.webUnit ?? "relay-web.service";
  const workerUnit = opts.workerUnit ?? "relay-worker.service";
  const units = probes.units();
  for (const want of [webUnit, workerUnit]) {
    const u = units.find((x) => x.name === want);
    if (!u) push("svc_" + want, "NOT_RUN", `未能读取服务状态:${want}(探针未返回该单元)`);
    else if (!u.queryable)
      push(
        "svc_" + want,
        "NOT_RUN",
        `无法查询 systemd user bus(${u.reason ?? "?"})⇒ 无法确认 ${want} 运行态;fail-closed,不虚构"未运行"(在 VM80 命令会话可显式 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus 且 XDG_RUNTIME_DIR=/run/user/$UID 后复检)`,
      );
    else if (!u.active)
      push("svc_" + want, "FAIL", `${want} 未运行或单元不存在(active=false;systemd 已作答;切换窗口应按 Runbook 显式停止,而非靠崩溃态)`);
    else push("svc_" + want, "PASS", `${want} 运行中(pid=${u.pid ?? "?"},since=${u.sinceIso ?? "?"})`);
  }
  const headTimeOk = head.ok && head.commitTimeIso !== undefined && !Number.isNaN(Date.parse(head.commitTimeIso));
  if (!headTimeOk) {
    push("process_vs_head", "NOT_RUN", "无法比对进程与 HEAD 版本(git HEAD/提交时间缺失或不可解析)");
  } else {
    const headTime = Date.parse(head.commitTimeIso!);
    const problems: string[] = [];
    for (const want of [webUnit, workerUnit]) {
      const u = units.find((x) => x.name === want);
      if (!u || !u.queryable) problems.push(`${want}:无法查询(${u?.reason ?? "探针未返回"})`);
      else if (!u.active) problems.push(`${want}:未运行(无进程可比对)`);
      else if (!u.sinceIso || Number.isNaN(Date.parse(u.sinceIso))) problems.push(`${want}:启动时间未能读取`);
    }
    // 同秒视为歧义(进程可能在提交完成前启动)⇒ 保守归入旧代码,不 PASS。
    const stale = units.filter(
      (u) => u.queryable && u.active && u.sinceIso !== null && !Number.isNaN(Date.parse(u.sinceIso)) && Date.parse(u.sinceIso) <= headTime,
    );
    if (problems.length > 0) {
      push(
        "process_vs_head",
        "UNKNOWN",
        `process_vs_head 不可判 PASS(缺读取依据,fail-closed;部署准入不得凭缺失证据声称新代码已生效):${problems.join(";")}`,
      );
    } else if (stale.length > 0) {
      push(
        "process_vs_head",
        "UNKNOWN",
        `进程启动时间早于/等于 HEAD 提交(${head.commitTimeIso})⇒ 运行中进程为旧代码,04A/R2/Gate 检查/工作区归属绑定等新语义线上未生效,以服务重启为界(${stale.map((s) => s.name).join("/")})`,
      );
    } else {
      push(
        "process_vs_head",
        "PASS",
        `全部目标服务运行中且启动时间均可靠读取并晚于 HEAD 提交(${head.commitTimeIso};新代码已在进程内生效)`,
      );
    }
  }

  // ── 4) 凭据文件权限(0600;存在性+权限,不读内容) ──
  const envPath = opts.envPath ?? join(homedir(), ".relay", "console", "env");
  const credMode = probes.credFileMode(join(homedir(), ".relay", "credentials", "web-password"));
  push(
    "cred_perms",
    credMode === 0o600 ? "PASS" : credMode === null ? "NOT_RUN" : "FAIL",
    `web-password 权限=${credMode === null ? "未能读取" : credMode.toString(8)}(要求 600);env 文件见 env_* 各项`,
  );

  // ── 5) 环境文件必需键名(仅键名,零值) + 6) RELAY_EVIDENCE_CHECKS_JSON 结构合规 ──
  const env = probes.envFile();
  if (!env.exists) {
    push("env_file", "FAIL", `环境文件不可读:${envPath}(两服务 EnvironmentFile 指向它;缺失=服务无法启动)`);
    push("env_required_keys", "NOT_RUN", "环境文件不可读,跳过键名核对");
    push("evidence_checks_config", "NOT_RUN", "环境文件不可读,跳过 RELAY_EVIDENCE_CHECKS_JSON 核对");
    push("max_output_tokens", "NOT_RUN", "环境文件不可读,跳过 RELAY_MAX_OUTPUT_TOKENS 核对");
  } else {
    const keys = env.keys;
    const required = opts.requiredEnvKeys ?? [...DEFAULT_REQUIRED_ENV_KEYS];
    const missing = required.filter((k) => !keys.includes(k));
    push(
      "env_file",
      "PASS",
      `环境文件可读(mode=${env.mode === null ? "?" : env.mode.toString(8)});键名(${keys.length}):${keys.join(",")}(取值零输出)`,
    );
    push(
      "env_required_keys",
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length === 0 ? `必需键齐备(${required.length} 项)` : `缺必需键:${missing.join(",")}`,
    );
    // RELAY_EVIDENCE_CHECKS_JSON:未配置 ⇒ 决策项(重启后 Gate 对代码变更候选保守停机
    // functional_evidence_unconfigured NEEDS_DECISION;fail-closed 安全但自动放行不可用);
    // 非法 ⇒ FAIL(重启将启动即抛=fail-closed crash);合法 ⇒ PASS。
    const rawChecks = env.get("RELAY_EVIDENCE_CHECKS_JSON");
    if (rawChecks === undefined || rawChecks === "") {
      push(
        "evidence_checks_config",
        "UNKNOWN",
        "RELAY_EVIDENCE_CHECKS_JSON 未配置 ⇒ 重启后代码变更候选 Gate 保守停机(functional_evidence_unconfigured→NEEDS_DECISION,fail-closed 安全);Gate 自动放行不可用 ⇒ 需 D3 决策:配置功能性检查(参考 deploy/evidence-checks.sample.json)或接受保守停机运行",
      );
    } else {
      try {
        const checks = resolveEvidenceChecks(rawChecks);
        const kinds = (checks ?? []).map((c) => c.kind);
        push(
          "evidence_checks_config",
          "PASS",
          `RELAY_EVIDENCE_CHECKS_JSON 结构合法:${(checks ?? []).length} 条功能性检查(kind=${kinds.join("/")};worker 启动校验同源 resolveEvidenceChecks 通过)`,
        );
      } catch (err) {
        push(
          "evidence_checks_config",
          "FAIL",
          `RELAY_EVIDENCE_CHECKS_JSON 非法 ⇒ 重启将启动即抛(fail-closed crash-loop):${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // RELAY_MAX_OUTPUT_TOKENS:未配置=默认 8192(运行时配置项,非法⇒启动即抛)。
    const rawMax = env.get("RELAY_MAX_OUTPUT_TOKENS");
    if (rawMax === undefined || rawMax === "") {
      push("max_output_tokens", "PASS", `RELAY_MAX_OUTPUT_TOKENS 未配置 ⇒ 采用默认 ${DEFAULT_MAX_OUTPUT_TOKENS}`);
    } else {
      try {
        const v = resolveMaxOutputTokens(rawMax);
        push("max_output_tokens", v === undefined ? "FAIL" : "PASS", v === undefined ? "RELAY_MAX_OUTPUT_TOKENS 非法⇒重启将启动即抛" : `RELAY_MAX_OUTPUT_TOKENS 合法(取值见决策记录,本工具不显示)`);
      } catch {
        push("max_output_tokens", "FAIL", "RELAY_MAX_OUTPUT_TOKENS 非法 ⇒ 重启将启动即抛(fail-closed)");
      }
    }
  }

  // ── 7) Web 绑定(LAN 单接口;禁 0.0.0.0/公网) ──
  const webPort = opts.webPort ?? 8787;
  const listeners = probes.listening(webPort);
  if (listeners.length === 0) {
    push("web_bind", "NOT_RUN", `未探测到 :${webPort} 监听(服务未运行或 ss 不可用)`);
  } else {
    const bad = listeners.filter((l) => ["0.0.0.0", "*", "::", "[::]"].includes(l.addr));
    push(
      "web_bind",
      bad.length > 0 ? "FAIL" : "PASS",
      `:${webPort} 监听地址=${listeners.map((l) => l.addr).join("/")}${bad.length > 0 ? "(含通配绑定,违反 LAN-only 边界)" : "(LAN 单接口,合规)"}`,
    );
  }

  // ── 8~10) Docker 可用性 / 检查沙箱镜像 / 出口约束栈 ──
  const docker = probes.docker();
  if (!docker.available) {
    push("docker_available", "FAIL", "Docker 不可用 ⇒ worker FAIL-CLOSED 不领取;检查沙箱不可执行");
    push("sandbox_image", "NOT_RUN", "Docker 不可用,跳过镜像核对");
    push("egress_stack", "NOT_RUN", "Docker 不可用,跳过出口栈核对");
  } else {
    push("docker_available", "PASS", "Docker 可用");
    const image = opts.sandboxImage ?? "node:24-bookworm-slim";
    push(
      "sandbox_image",
      docker.imageExists(image) ? "PASS" : "FAIL",
      docker.imageExists(image)
        ? `检查沙箱镜像 ${image} 本地存在(默认镜像;RELAY_SANDBOX_IMAGE 未覆盖时生效)`
        : `检查沙箱镜像 ${image} 本地缺失 ⇒ 检查/Run 容器创建将失败`,
    );
    const net = opts.egressNetwork ?? "relay-egress-net";
    const proxy = opts.egressProxyContainer ?? "relay-egress-fwd";
    const netOk = docker.networkExists(net);
    const proxyOk = docker.containerRunning(proxy);
    if (netOk && proxyOk) {
      push("egress_stack", "PASS", `出口约束栈在(network=${net},proxy=${proxy})`);
    } else if (!netOk && !proxyOk) {
      push(
        "egress_stack",
        "UNKNOWN",
        `出口约束栈当前不在(network 与 proxy 均缺失)⇒ 运行中 worker 已降级(下次容器创建将失败;测试套件 teardownEgress 会拆除共享栈);worker 重启后首拍 ensureEgress 幂等重建自愈 ⇒ 切换 Runbook 重启步骤后必须核对 "egress ready" 横幅`,
      );
    } else {
      push("egress_stack", "FAIL", `出口约束栈半残(network=${netOk ? "在" : "缺"},proxy=${proxyOk ? "在" : "缺"})⇒ 需人工核查再切换`);
    }
  }

  // ── 11~15) DB:可达/表结构/迁移面/在途任务/Run 归属绑定(全部聚合计数,零原始数据) ──
  const q = await probes.sql("SELECT 1");
  if (!q.ok) {
    push("db_reachable", "FAIL", `数据库不可达:${q.reason ?? "?"}`);
    push("db_schema_tables", "NOT_RUN", "数据库不可达,跳过表结构核对");
    push("db_inflight", "NOT_RUN", "数据库不可达,跳过在途任务核对");
    push("run_workspace_binding", "NOT_RUN", "数据库不可达,跳过 Run 归属绑定核对");
  } else {
    push("db_reachable", "PASS", "数据库可达(只读查询)");
    const tables = await probes.sql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`,
    );
    if (!tables.ok) {
      push("db_schema_tables", "NOT_RUN", `表结构查询失败:${tables.reason ?? "?"}`);
    } else {
      const have = new Set(tables.rows.map((r) => r[0]));
      const missingTables = EXPECTED_TABLES.filter((t) => !have.has(t));
      push(
        "db_schema_tables",
        missingTables.length === 0 ? "PASS" : "FAIL",
        missingTables.length === 0
          ? `schema=${schema} 表结构齐备(${EXPECTED_TABLES.length} 表)`
          : `schema=${schema} 缺表:${missingTables.join(",")}`,
      );
    }
    // 迁移面(0006/0007/0008/0009 落地标志;DEPLOY-03D 曾发现生产 schema 停在 0005 并精确补齐
    // 0006/0007;0008/0009 属其后交付,现网缺失 ⇒ 重启后新代码依赖的 abort 旗标/对话授权查询将报错):
    const mig = await probes.sql(
      `SELECT
         (SELECT count(*) FROM information_schema.tables WHERE table_schema='${schema}' AND table_name='goal_messages') AS g7a,
         (SELECT count(*) FROM information_schema.tables WHERE table_schema='${schema}' AND table_name='goal_message_consumptions') AS g7b,
         (SELECT count(*) FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='goal_messages' AND column_name='execution_request') AS g8,
         (SELECT count(*) FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='tasks' AND column_name='abort_requested_at') AS g9`,
    );
    if (!mig.ok) {
      push("db_migrations", "NOT_RUN", `迁移面查询失败:${mig.reason ?? "?"}`);
    } else {
      const row = mig.rows[0] ?? [];
      const missing: string[] = [];
      if ((row[0] ?? "0") === "0") missing.push("0006(goal_messages)");
      if ((row[1] ?? "0") === "0") missing.push("0007(goal_message_consumptions)");
      if ((row[2] ?? "0") === "0") missing.push("0008(goal_messages.execution_request)");
      if ((row[3] ?? "0") === "0") missing.push("0009(tasks.abort_requested_at)");
      push(
        "db_migrations",
        missing.length === 0 ? "PASS" : "FAIL",
        missing.length === 0
          ? "迁移面齐备(0006/0007/0008/0009 标志物在位)"
          : `迁移缺失:${missing.join(",")}(init-schema 对已存在 schema 跳过、applyMigrations 全量重放会撞表 ⇒ 增量补齐须按迁移文件逐条精确执行;迁移无自动化=既有登记项;补齐动作写生产 schema,必须经用户单独 D3 授权)`,
      );
    }
    const inflight = await probes.sql(`SELECT state, count(*) FROM ${schema}.tasks GROUP BY state`);
    if (!inflight.ok) {
      push("db_inflight", "NOT_RUN", `任务状态查询失败:${inflight.reason ?? "?"}`);
    } else {
      const byState = new Map<string, number>();
      for (const row of inflight.rows) byState.set(row[0] ?? "", Number(row[1] ?? 0));
      const blocking = BLOCKING_TASK_STATES.filter((s) => (byState.get(s) ?? 0) > 0);
      const summary = [...byState.entries()].sort().map(([s, n]) => `${s}=${n}`).join(" ") || "(空)";
      push(
        "db_inflight",
        blocking.length === 0 ? "PASS" : "FAIL",
        blocking.length === 0
          ? `无阻断切换的在途状态(${summary};READY=排队不阻断,重启后正常被领取)⇒ 无在途副作用/租约风险`
          : `存在阻断切换的在途状态:${blocking.map((s) => `${s}=${byState.get(s)}`).join(" ")}(总计 ${summary})⇒ 切换前必须按 Runbook 处置(停新领取/评估在途副作用与租约/经恢复门回收),禁止带在途状态切换`,
      );
    }
    // Run 归属绑定(04A-R2):coder Run 行缺 workspace_dir 绑定(键缺失或空串,与编排 2.45
    // 非空判据同口径)⇒ 编排 2.45 跳过校验(登记残留)。
    // 只有"缺绑定且其任务处于 VERIFYING/DELIVERING(可能重入 Gate)"才 ⇒ NO-GO(历史绑定不明,
    // D3 人工处置);终态行与回收后排队任务(RUNNING/READY)的历史 NULL 行为陈旧残留,如实计数说明
    // (新 attempt 会产生带绑定的新 Run 行;禁止自动补写归属)。
    const binding = await probes.sql(
      `SELECT (COALESCE(r.detail->>'workspace_dir','') <> '')::text AS bound, COALESCE(r.outcome,'NULL') AS outcome,
              COALESCE(t.state,'(无任务)') AS task_state, count(*)
       FROM ${schema}.runs r LEFT JOIN ${schema}.tasks t ON t.id = r.task_id
       WHERE r.runtime='pi-rpc' AND (r.detail->>'role') IS DISTINCT FROM 'reviewer'
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    );
    if (!binding.ok) {
      push("run_workspace_binding", "NOT_RUN", `Run 绑定查询失败:${binding.reason ?? "?"}`);
    } else {
      const unboundGateRelevant: string[] = [];
      const unboundOther: string[] = [];
      let bound = 0;
      for (const [b, outcome, taskState, n] of binding.rows) {
        const cnt = Number(n ?? 0);
        if (b === "true") {
          bound += cnt;
          continue;
        }
        const label = `outcome=${outcome},task=${taskState}×${cnt}`;
        if (taskState === "VERIFYING" || taskState === "DELIVERING") unboundGateRelevant.push(label);
        else unboundOther.push(label);
      }
      if (unboundGateRelevant.length > 0) {
        push(
          "run_workspace_binding",
          "FAIL",
          `存在缺 workspace_dir 绑定且可能重入 Gate 的 Run(任务在 VERIFYING/DELIVERING):${unboundGateRelevant.join(";")} ⇒ 历史绑定不明,D3 人工处置(禁止自动补写归属/跳过校验)`,
        );
      } else if (bound === 0 && unboundOther.length === 0) {
        push("run_workspace_binding", "PASS", "无 coder Run(空库)");
      } else {
        push(
          "run_workspace_binding",
          "PASS",
          `coder Run 归属绑定:有绑定=${bound},无绑定(终态/排队,不重入 Gate)=${unboundOther.length > 0 ? unboundOther.join(";") : 0}(旧格式行:编排 2.45 跳过归属校验=登记残留 R2-D3,由既有双门把关;不自动补写,不作隐瞒)`,
        );
      }
    }
  }

  const verdict = computeVerdict(results);
  return {
    startedAt,
    headSha: head.ok ? (head.sha ?? null) : null,
    schema,
    results,
    verdict,
    note: "GO/UNKNOWN 仅代表部署准入材料状态;生产切换必须由用户单独 D3 授权并按 deploy/README-deploy.md Runbook 执行;本工具零写入零重启。",
  };
}

// ── systemd 时间戳解析(纯函数,可测) ──
// systemd ExecMainStartTimestamp 形如 "Fri 2026-11-13 02:00:08 CST":带本地时区缩写。
// Node Date.parse 与 GNU date 都会把缩写"CST"误判为美中区 -6(05 Reviewer Major-1 实测
// 偏差 +14h,存在假 PASS 窗口)⇒ 剥离星期与缩写后按本机时区解析挂钟(systemd 本就以本地
// 墙钟打印;ECMAScript 规定无偏移 ISO 日期时间按本机时区解析,TZ=Shanghai/UTC/Chicago 三时区实证)。
export function parseSystemdSinceIso(raw: string): string | null {
  const wall = raw
    .trim()
    .replace(/^[A-Za-z]{3,9}\s+/, "")
    .replace(/\s+[A-Za-z]{2,5}$/, "")
    .trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(wall)) return null;
  const parsed = new Date(wall.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ── 生产默认探针(全部只读;测试不使用本实现) ──

function sh(cmd: string, args: string[], timeoutMs = 15_000): string {
  // 显式 pipe 全部 stdio:execFileSync 缺省会把 stderr 直通父进程(工具输出须零噪声零泄漏)
  return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function trySh(cmd: string, args: string[], timeoutMs = 15_000): { ok: boolean; out: string } {
  try {
    return { ok: true, out: sh(cmd, args, timeoutMs) };
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const firstLine = stderr.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { ok: false, out: firstLine || e.message || String(err) };
  }
}

export function defaultProbes(opts: PreflightOptions): PreflightProbes {
  const envPath = opts.envPath ?? join(homedir(), ".relay", "console", "env");
  const pgContainer = opts.pgContainer ?? "relay-p000-pg";
  let dbNameCache: string | null = null;
  const readEnv = (): { exists: boolean; mode: number | null; keys: string[]; get(name: string): string | undefined } => {
    try {
      const st = statSync(envPath);
      const text = readFileSync(envPath, "utf8");
      const keys: string[] = [];
      const map = new Map<string, string>();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const k = t.slice(0, eq);
        keys.push(k);
        map.set(k, t.slice(eq + 1));
      }
      return { exists: true, mode: Number(st.mode & 0o777), keys, get: (k) => map.get(k) };
    } catch {
      return { exists: false, mode: null, keys: [], get: () => undefined };
    }
  };
  return {
    nowIso: () => new Date().toISOString(),
    gitHead() {
      const sha = trySh("git", ["rev-parse", "HEAD"]);
      if (!sha.ok) return { ok: false, reason: sha.out };
      const commitTime = trySh("git", ["log", "-1", "--format=%cI", "HEAD"]);
      const dirty = trySh("git", ["status", "--porcelain", "--untracked-files=no"]);
      // 06 A 项:git status 探针失败 ⇒ dirtyReadable=false ⇒ 判定器 NOT_RUN(fail-closed,不假 clean)
      return {
        ok: true,
        sha: sha.out,
        ...(dirty.ok
          ? { dirty: dirty.out.length > 0, dirtyReadable: true }
          : { dirtyReadable: false, reason: dirty.out }),
        ...(commitTime.ok ? { commitTimeIso: commitTime.out } : {}),
      };
    },
    envFile: readEnv,
    credFileMode(path) {
      try {
        return Number(statSync(path).mode & 0o777);
      } catch {
        return null;
      }
    },
    units() {
      const out: UnitStatus[] = [];
      for (const unit of [opts.webUnit ?? "relay-web.service", opts.workerUnit ?? "relay-worker.service"]) {
        const r = trySh("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "ExecMainStartTimestamp", "-p", "MainPID", "--no-pager"]);
        // 06 A 项:查询失败(如无 user bus)⇒ queryable=false("无法查询"),不得虚构 active=false
        // (systemd 不可达 ≠ 服务未运行;bus 可用时"单元不存在"会以 rc=0+ActiveState=inactive 如实返回)。
        if (!r.ok) {
          out.push({ name: unit, queryable: false, active: false, sinceIso: null, pid: null, reason: r.out });
          continue;
        }
        const kv = new Map<string, string>();
        for (const line of r.out.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
        }
        const sinceIso = parseSystemdSinceIso(kv.get("ExecMainStartTimestamp") ?? "");
        out.push({
          name: unit,
          queryable: true,
          active: kv.get("ActiveState") === "active",
          sinceIso,
          pid: Number(kv.get("MainPID")) || null,
        });
      }
      return out;
    },
    listening(port) {
      const r = trySh("ss", ["-tln"]);
      if (!r.ok) return [];
      const out: { addr: string }[] = [];
      for (const line of r.out.split("\n")) {
        const cols = line.split(/\s+/);
        const local = cols[3] ?? "";
        const m = local.match(/^(.*):(\d+)$/);
        if (m && Number(m[2]) === port) out.push({ addr: m[1] ?? "" });
      }
      return out;
    },
    docker() {
      const info = trySh("docker", ["info", "--format", "ok"], 10_000);
      const available = info.ok;
      return {
        available,
        imageExists: (tag) => available && trySh("docker", ["images", "-q", tag], 10_000).out.length > 0,
        networkExists: (name) => available && trySh("docker", ["network", "inspect", name], 10_000).ok,
        containerRunning: (name) =>
          available && trySh("docker", ["ps", "--format", "{{.Names}}", "--filter", `name=^${name}$`], 10_000).out === name,
      };
    },
    async sql(query) {
      const env = readEnv();
      const url = env.get("RELAY_DB_URL") ?? "";
      if (!dbNameCache) {
        const tail = url.split("?")[0]?.split("/").pop() ?? "";
        dbNameCache = tail.length > 0 ? tail : null;
      }
      if (!dbNameCache) return { ok: false, rows: [], reason: "RELAY_DB_URL 缺失或库名不可解析(取值零输出)" };
      const r = trySh("docker", ["exec", pgContainer, "psql", "-U", "postgres", "-d", dbNameCache, "-At", "-F", "|", "-c", query], 30_000);
      if (!r.ok) return { ok: false, rows: [], reason: r.out.split("\n")[0] };
      return { ok: true, rows: r.out.length === 0 ? [] : r.out.split("\n").map((line) => line.split("|")) };
    },
  };
}

function renderText(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`[preflight] 部署准入只读预检 @ ${report.startedAt} HEAD=${report.headSha ?? "?"} schema=${report.schema}`);
  for (const r of report.results) lines.push(`  [${r.status}] ${r.id}: ${r.detail}`);
  lines.push(`[preflight] 裁决=${report.verdict}`);
  lines.push(`[preflight] ${report.note}`);
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && process.argv[1]!.endsWith("preflight.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const envFlag = args.indexOf("--env-file");
  const pgFlag = args.indexOf("--pg-container");
  const opts: PreflightOptions = {};
  if (envFlag >= 0 && args[envFlag + 1]) opts.envPath = args[envFlag + 1];
  if (pgFlag >= 0 && args[pgFlag + 1]) opts.pgContainer = args[pgFlag + 1]!;
  const report = await runPreflight(defaultProbes(opts), opts);
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
  process.exit(report.verdict === "GO" ? 0 : report.verdict === "UNKNOWN" ? 1 : 2);
}
