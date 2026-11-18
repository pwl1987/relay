// HTTP API(P0-02C D-3):**所有状态转移只经 src/core**;本层不做业务裁决。
// 路由表(全部在 /api 前缀下):
//   POST   /api/session            登录(唯一免会话端点)
//   GET    /api/session            当前会话(未登录 ⇒ 401)
//   DELETE /api/session            登出
//   GET    /api/health             健康(DB/Worker/Provider 配置可见性)
//   GET    /api/capabilities       能力登记表(未实现能力显式标记)
//   GET    /api/dashboard          Dashboard 聚合
//   GET    /api/goals              Goal 列表
//   POST   /api/goals              创建 Goal(一句自然语言)
//   GET    /api/goals/:id          Goal 详情(理解/建议/任务/证据)
//   POST   /api/goals/:id/messages   follow-up 用户消息(WEB-UX-03C §0;追加+消费语义唯一入口 core.consumeGoalMessages)
//   GET    /api/goals/:id/feed       Goal Feed 增量投影(游标=消息 id;决策卡+状态快照整体替换)
//   GET    /api/goals/:id/status     Goal 状态轻量投影
//   POST   /api/goals/:id/result-acceptance  用户接受/拒绝结果(RESULT-TRUTH-16;append-only 审计事实,与 task ACCEPTED 分离)
//   GET    /api/workspace/sidebar    工作区左侧栏投影(WEB-UX-03C §3;项目分组/状态点/待决数)
//   POST   /api/goals/:id/discovery  模型驱动 Discovery(REWORK-1;operator 显式;预算账本)
//   GET    /api/decisions          Decision Inbox
//   POST   /api/decisions/:id/resolve  批准/拒绝(core.ops.resolveDecision)
//   POST   /api/decisions/:id/defer    推迟(仅改截止时间;状态不变)
//   POST   /api/tasks/:id/resume       恢复任务(core.ops.resumeTask)
//   POST   /api/tasks/:id/pause        暂停任务(core.ops.pauseTask;P0-REWORK-2 置入入口)
//   GET    /api/changesets/:id     ChangeSet/Evidence 详情
//   POST   /api/worker/tick        推进一拍 Goal Loop(core.goalLoopTick)
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { RelayDb, Exec } from "../core/db.ts";
import { planGoal, type GoalProjectBinding } from "../core/goals.ts";
import { consumeGoalMessages } from "../core/consumption.ts";
import { operatorAllowed, resolveDecision, resumeTask, pauseTask, requestTaskAbort } from "../core/ops.ts";
import { runGoalDiscovery } from "../core/discovery.ts";
import { resolveVendoredPi } from "../runtime/pi-version.ts";
import { ensureEgress } from "../runtime/egress.ts";
import { deferDecision } from "../core/decisions.ts";
import { appendAudit } from "../core/audit.ts";
import {
  dashboardView,
  dashboardExtrasView,
  goalListView,
  goalDetailView,
  goalFeedView,
  goalStatusView,
  workspaceSidebarView,
  decisionListView,
  changesetDetailView,
  changesetListView,
  projectsView,
  modelsUsageView,
  systemView,
  readProjectRegistry,
} from "./views.ts";
import { buildCapabilityRegistry } from "./capabilities.ts";
import { readGoalProjectBinding } from "./project-binding.ts";
import { redactSecrets, safeErrorMessage } from "./redact.ts";
import { AuthError, clearCookie, sessionCookie, type Auth, type Session } from "./auth.ts";
import type { WorkerDriver, WorkerMode } from "./worker.ts";

export interface ApiDeps {
  db: RelayDb;
  auth: Auth;
  /** worker 驱动;缺省 = external(本进程不代跑) */
  worker?: WorkerDriver | null;
  workerMode: WorkerMode;
  /** 新建 Goal 的默认模型调用预算(账本上限) */
  defaultGoalBudgetModelCalls: number;
  /** 允许的作用域根(默认 /workspace) */
  defaultAllowedScope?: string[];
}

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isWrite(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

function fail(status: number, code: string, message?: string): ApiResponse {
  return { status, body: { ok: false, error: code, ...(message ? { message } : {}) } };
}

function ok(body: Record<string, unknown>, status = 200): ApiResponse {
  return { status, body: { ok: true, ...body } };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 从请求头取会话 id(cookie)。 */
function sessionIdFrom(headers: Record<string, string | undefined>): string | undefined {
  const cookie = headers["cookie"];
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== "relay_session") continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}

async function audit(
  deps: ApiDeps,
  event: { actor: string; action: string; taskId?: string | undefined; detail?: Record<string, unknown> },
): Promise<void> {
  await deps.db
    .transaction(async (tx) =>
      appendAudit(tx as unknown as Exec, {
        actor: event.actor,
        authority: "OPERATOR",
        action: event.action,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        detail: event.detail ?? {},
      }),
    )
    .catch(() => {
      /* 审计失败不改变请求结果(状态已在事务内落库) */
    });
}

/** 派生默认计划(确定性;非模型规划):一句需求 ⇒ 一个任务 + 最小作用域。 */
export function deriveDefaultPlan(rawInput: string): {
  rawInput: string;
  tasks: Array<{
    goalText: string;
    allowedScope: string[];
    allowedCommands: string[];
    priority: number;
    maxAttempts: number;
  }>;
} {
  return {
    rawInput,
    tasks: [
      {
        goalText: rawInput,
        allowedScope: ["/workspace"],
        allowedCommands: ["echo"],
        priority: 0,
        maxAttempts: 3,
      },
    ],
  };
}

// ---- RELAY-GOAL-CREATE-IDEMPOTENCY-12/12R:Goal 创建幂等(Major-R2 ACK 丢失 + Major-P1 项目身份) ----
// 一个「用户明确创建」意图 = 一个高熵请求键(x-relay-idempotency-key,UUID 形态;客户端一次
// 意图生成一次,响应不确定的重试复用)。键 ⇒ 确定性派生 Goal 主键,复用 goals.id PK 唯一约束
// 做持久幂等:重试(网络回执丢失/并发重发/刷新后重发)同键同内容(操作者/项目身份一致)⇒
// 200 幂等重放返回同一 GoalId;同键异 payload/**项目身份**/操作者 ⇒ 409 fail-closed;非法键 ⇒ 400
// 零创建;**无键(旧客户端)行为不变**;不同键同文案 ⇒ 两个独立新需求(绝不按纯文本永久去重)。
// 持久性 = Goal 行本身(零新表/零 schema 变更);服务端零 process-local 状态 ⇒ 天然跨重启。
// 绝不重派生初始 Task/预算/消息/审计副作用(重放只读首次事务已落库事实)。
// 12R:项目身份权威 = 创建事务内 GOAL_PLANNED 审计冻结的 detail.project(注册表权威解析的
// projectId/path/repo/branch,未绑定显式 null)—— 注册表无 path 唯一约束,同目录≠同项目,
// 重放只认创建时点冻结事实(缺失/损坏=不可证 ⇒ 409),响应 project 亦回显冻结事实而非本次请求。
const GOAL_CREATE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 12R(Minor-K1)UUID 键规范化:trim + 小写。同一 UUID 的任意合法大小写表示 = 同一标识
 *  (RFC 4122 等价语义);边界空白不入键(HTTP 传输层本就剥 OWS,此处收敛为确定性单一口径)。
 *  历史兼容:规范化前以非小写形态消费过的键派生不同主键 ⇒ 见 legacyKeyGoalId 探测。 */
function normalizeCreateKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 请求键 ⇒ Goal 主键(SHA-256 前缀,UUID 形态;与既有 goal-<uuid> 约定同形)。
 *  确定性 ⇒ 同键重试落到同一 PK ⇒ INSERT 撞唯一约束即识别旧成功;SHA-256 碰撞 ⇒
 *  内容比对不一致 ⇒ 409 fail-closed(不会错误重放)。 */
function goalIdForCreateKey(key: string): string {
  const h = createHash("sha256").update(`relay:goal-create:v1:${key}`).digest("hex");
  return `goal-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 冻结的项目身份绑定形状校验(jsonb 反序列化面;缺失/损坏 = 身份不可证)。 */
function isProjectBindingShape(v: unknown): v is GoalProjectBinding {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b["name"] === "string" &&
    typeof b["path"] === "string" &&
    (b["repo"] === null || typeof b["repo"] === "string") &&
    (b["branch"] === null || typeof b["branch"] === "string")
  );
}

/** 12R(Major-P1)项目身份精确比对:创建时冻结事实 vs 本次请求解析事实,逐字段全等。
 *  frozen=null(创建时显式未绑定)仅与本次未绑定相等;字段缺失(undefined,12R 前旧事实)/
 *  形状损坏 ⇒ 不可证 ⇒ false(fail-closed 拒绝重放,绝不以目录字符串或本次请求元数据顶替)。 */
function projectBindingEqual(frozen: unknown, request: GoalProjectBinding | null): boolean {
  if (frozen === null) return request === null;
  if (!isProjectBindingShape(frozen)) return false;
  return (
    frozen.name === request?.name &&
    frozen.path === request?.path &&
    frozen.repo === request?.repo &&
    frozen.branch === request?.branch
  );
}

/** PG 唯一约束违反(并发同键:赢家事务已提交,本事务回滚后转重放/冲突判定)。
 *  drizzle 会把 pg 错误包成 `Failed query…`(原始 DatabaseError 在 Error.cause),两级都查。 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (e.code === "23505") return true;
  return typeof e.cause === "object" && e.cause !== null && (e.cause as { code?: unknown }).code === "23505";
}

/** 同键重试的幂等解析(只读,零写副作用):键从未成功创建 ⇒ null(走正常创建);
 *  已存在旧 Goal ⇒ 内容/操作者/项目身份逐项一致 ⇒ 200 重放(同 GoalId/初始 Task),
 *  任一不一致 ⇒ 409 fail-closed。
 *  - 项目身份(12R Major-P1):以创建事务内 GOAL_PLANNED 审计冻结的 detail.project 精确比对
 *    (projectId/path/repo/branch;未绑定=null)。审计行或 project 字段缺失/损坏 ⇒ 身份不可证
 *    ⇒ 409(拒绝而非默默跳过;兼容 12R 前创建的 Goal:宁可拒绝重放,绝不误归属/重复创建)。
 *  - 操作者:GOAL_PLANNED 审计 actor(与 Goal 同事务;行缺失视为不可证 ⇒ 该项跳过,如实保守)。
 *  - 初始 Task:首消息消费映射定位,缺失退 GOAL_PLANNED detail.tasks 兜底。
 *  - 12R 历史兼容探测:legacyKeyGoalId(规范化前的原形态派生)已有 Goal ⇒ 该键已被消费,
 *    绝不重复创建第二个 Goal;其冻结事实按定义不可证 ⇒ 一律 409(诚实拒绝,指引新键)。 */
async function resolveGoalCreateReplay(
  deps: ApiDeps,
  keyGoalId: string,
  rawInput: string,
  role: string,
  boundProject: { name: string; path: string; repo: string | null; branch: string | null } | null,
  legacyKeyGoalId?: string,
): Promise<ApiResponse | null> {
  if (legacyKeyGoalId && legacyKeyGoalId !== keyGoalId) {
    const lg = await deps.db.execute(sql`SELECT id FROM goals WHERE id = ${legacyKeyGoalId}`);
    if (lg.rows.length > 0)
      return fail(
        409,
        "goal_create_key_conflict",
        "同一请求标识已按旧版表示创建过;创建身份事实不可证,已拒绝(如需新需求请使用新键)",
      );
  }
  const g = await deps.db.execute(sql`SELECT id, raw_input FROM goals WHERE id = ${keyGoalId}`);
  if (g.rows.length === 0) return null; // 键未消费过 ⇒ 正常创建
  if (String(g.rows[0]!["raw_input"]) !== rawInput)
    return fail(409, "goal_create_key_conflict", "同一请求标识已用于创建其他内容;请修改内容后再试");
  const a = await deps.db.execute(
    sql`SELECT actor, detail FROM audit_events WHERE action = 'GOAL_PLANNED' AND detail->>'goalId' = ${keyGoalId} ORDER BY seq LIMIT 1`,
  );
  if (a.rows.length > 0 && String(a.rows[0]!["actor"]) !== role)
    return fail(409, "goal_create_key_conflict", "同一请求标识已由其他操作者使用;已拒绝");
  const detail = a.rows[0]?.["detail"] as { tasks?: string[]; project?: unknown } | undefined;
  const frozenProject = detail?.project;
  // 12R:项目身份 = 冻结事实精确比对(先于 scope 兜底比对;身份冲突绝不因目录相同而放行)。
  const requestBinding: GoalProjectBinding | null = boundProject
    ? { name: boundProject.name, path: boundProject.path, repo: boundProject.repo, branch: boundProject.branch }
    : null;
  if (!projectBindingEqual(frozenProject, requestBinding))
    return fail(409, "goal_create_key_conflict", "同一请求标识已绑定其他项目身份;已拒绝");
  // 作用域不再参与冲突判定:统一模型下 allowed_scope 是项目绑定的派生物(恒为工作区挂载根),
  // 项目身份权威 = 冻结事实(上方 projectBindingEqual 精确比对)。二者重复判定会误伤历史 Goal。
  const taskRows = await deps.db.execute(
    sql`SELECT task_id AS id FROM goal_message_consumptions WHERE goal_id = ${keyGoalId} ORDER BY id`,
  );
  const taskIds = taskRows.rows.map((r) => String(r["id"]));
  return ok(
    {
      goalId: keyGoalId,
      taskIds,
      // 回显创建时点冻结事实(比对已保证与本次请求一致;事实源=首次创建,非本次请求元数据)。
      project: isProjectBindingShape(frozenProject)
        ? {
            projectId: frozenProject.name,
            path: frozenProject.path,
            repo: frozenProject.repo,
            branch: frozenProject.branch,
          }
        : null,
      idempotentReplay: true,
    },
    200,
  );
}

export async function handleApi(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  const path = req.path;

  // ---- 登录(唯一免会话端点) ----
  if (path === "/api/session" && method === "POST") {
    const password = str(req.body?.["password"]);
    try {
      const { session } = await deps.auth.login(password, req.ip);
      await audit(deps, { actor: "web", action: "WEB_LOGIN", detail: { role: session.role } });
      return {
        status: 200,
        body: {
          ok: true,
          authenticated: true,
          role: session.role,
          csrfToken: session.csrf,
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        headers: { "set-cookie": sessionCookie(session.id, Math.floor((session.expiresAt - Date.now()) / 1000)) },
      };
    } catch (err) {
      if (err instanceof AuthError) {
        await audit(deps, { actor: "web", action: "WEB_LOGIN_FAILED", detail: { reason: err.code } });
        return fail(err.code === "locked_out" ? 429 : 401, err.code, err.message);
      }
      return fail(500, "login_error", safeErrorMessage(err));
    }
  }

  // ---- 会话解析 ----
  let session: Session;
  try {
    session = deps.auth.resolve(sessionIdFrom(req.headers));
  } catch (err) {
    if (err instanceof AuthError) {
      if (method === "GET" && path === "/api/session") return fail(401, "unauthenticated", "未登录");
      return fail(401, "unauthenticated", "未登录");
    }
    return fail(500, "session_error", safeErrorMessage(err));
  }

  // ---- 写操作:同源 + CSRF + operator 授权 ----
  if (isWrite(method)) {
    try {
      deps.auth.verifySameOrigin({
        origin: req.headers["origin"],
        host: req.headers["host"],
        secFetchSite: req.headers["sec-fetch-site"],
      });
      deps.auth.verifyCsrf(session, req.headers["x-relay-csrf"]);
    } catch (err) {
      if (err instanceof AuthError) {
        await audit(deps, { actor: session.role, action: "WEB_WRITE_REJECTED", detail: { path, reason: err.code } });
        return fail(
          err.code.startsWith("csrf") || err.code.includes("origin") || err.code.includes("cross_site") ? 403 : 400,
          err.code,
          err.message,
        );
      }
      return fail(500, "write_guard_error", safeErrorMessage(err));
    }
    if (!operatorAllowed(session.role)) {
      await audit(deps, {
        actor: session.role,
        action: "WEB_WRITE_REJECTED",
        detail: { path, reason: "actor_not_authorized" },
      });
      return fail(403, "actor_not_authorized", "当前身份无写权限");
    }
  }

  // ---- 路由 ----
  try {
    if (path === "/api/session" && method === "GET") {
      return ok({
        authenticated: true,
        role: session.role,
        csrfToken: session.csrf,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }
    if (path === "/api/session" && method === "DELETE") {
      deps.auth.logout(session.id);
      await audit(deps, { actor: session.role, action: "WEB_LOGOUT" });
      return { status: 200, body: { ok: true }, headers: { "set-cookie": clearCookie() } };
    }
    if (path === "/api/health" && method === "GET") {
      let dbOk = true;
      let dbError: string | null = null;
      try {
        await deps.db.execute(sql`SELECT 1`);
      } catch (err) {
        dbOk = false;
        dbError = safeErrorMessage(err);
      }
      const worker = deps.worker ?? null;
      return ok({
        db: { ok: dbOk, ...(dbError ? { error: dbError } : {}) },
        worker: {
          mode: deps.workerMode,
          lastTick: worker?.lastTick() ?? null,
          active: Boolean(worker),
        },
        provider: {
          // 本包不探测模型路由(0 次真实模型调用);只报告配置可见性。
          configured: Boolean(process.env.RELAY_PI_BASE_URL && process.env.RELAY_PI_MODEL),
          probed: false,
          note: "本包不探测模型路由;是否可用以运行时事实为准",
        },
        sessions: deps.auth.activeSessions(),
        serverTime: new Date().toISOString(),
      });
    }
    if (path === "/api/capabilities" && method === "GET") {
      return ok({ registry: buildCapabilityRegistry(deps.workerMode, new Date().toISOString()) });
    }
    if (path === "/api/dashboard" && method === "GET") {
      const worker = deps.worker ?? null;
      return ok({
        dashboard: await dashboardView(deps.db),
        extras: await dashboardExtrasView(deps.db),
        worker: {
          mode: deps.workerMode,
          lastTick: worker?.lastTick() ?? null,
          active: Boolean(worker),
        },
        providerModel: {
          configured: Boolean(
            process.env.RELAY_PI_PROVIDER && process.env.RELAY_PI_MODEL && process.env.RELAY_PI_BASE_URL,
          ),
          providerName: process.env.RELAY_PI_PROVIDER ?? null,
          modelName: process.env.RELAY_PI_MODEL ?? null,
          probed: false,
          note: "零探测;最近 model_ref 见 extras.lastModel(runs/discoveries 原始事实)。",
        },
      });
    }
    // OPERATOR-CONSOLE-00 P0-UI-2:Projects(注册文件驱动,零 schema 变更,只读)
    if (path === "/api/projects" && method === "GET") {
      return ok({ projects: await projectsView(deps.db) });
    }
    // OPERATOR-CONSOLE-00 P0-UI-5:Models/Usage(纯观察;零探测零凭据)
    if (path === "/api/models-usage" && method === "GET") {
      return ok({ usage: await modelsUsageView(deps.db) });
    }
    // OPERATOR-CONSOLE-00 P0-UI-6:System(HEAD/DB/Worker/GitHub/Provider/uptime/最近错误)
    if (path === "/api/system" && method === "GET") {
      const worker = deps.worker ?? null;
      const view = await systemView(deps.db, {
        mode: deps.workerMode,
        active: Boolean(worker),
        lastTick: worker?.lastTick() ?? null,
      });
      return ok({ system: view });
    }
    if (path === "/api/goals" && method === "GET") {
      return ok({ goals: await goalListView(deps.db) });
    }
    if (path === "/api/goals" && method === "POST") {
      const rawInput = str(req.body?.["rawInput"]).trim();
      if (!rawInput) return fail(400, "raw_input_required", "请填写一句目标描述");
      if (rawInput.length > 2000) return fail(400, "raw_input_too_long", "目标描述过长(上限 2000 字)");
      // WEB-UX-01 §4.5:浏览器只提交受控 projectId/projectName;server 按项目注册表解析
      // path/repo/branch/allowed scope。**绝不接受浏览器提交任意服务器绝对路径**(body 中的
      // path 字段一律忽略;授权路径唯一来源 = config/projects.json / RELAY_PROJECTS_FILE)。
      const projectId = typeof req.body?.["projectId"] === "string" ? str(req.body?.["projectId"]).trim() : "";
      let boundProject: { name: string; path: string; repo: string | null; branch: string | null } | null = null;
      if (projectId) {
        const entry = readProjectRegistry().projects.find((p) => p.name === projectId);
        if (!entry)
          return fail(
            400,
            "unknown_project",
            "未登记的项目:仅接受项目注册表内的 projectId(路径由服务端解析,不接受浏览器提交路径)",
          );
        boundProject = { name: entry.name, path: entry.path, repo: entry.repo ?? null, branch: entry.branch ?? null };
      }
      const plan = deriveDefaultPlan(rawInput);
      const budgetModelCalls = deps.defaultGoalBudgetModelCalls;
      // RELAY-GOAL-CREATE-IDEMPOTENCY-12/12R:幂等键解析(可选;旧客户端无键 ⇒ 行为完全不变)。
      // 12R(Minor-K1):同一 UUID 的任意合法表示(大小写/边界空白)规范化为单一口径再派生/校验。
      const rawCreateKey = req.headers["x-relay-idempotency-key"];
      const originalKey = typeof rawCreateKey === "string" ? rawCreateKey.trim() : "";
      const createKey = originalKey ? normalizeCreateKey(originalKey) : "";
      if (createKey && !GOAL_CREATE_KEY_RE.test(createKey))
        return fail(400, "idempotency_key_invalid", "请求标识格式非法(应为 UUID);请重试");
      const keyGoalId = createKey ? goalIdForCreateKey(createKey) : undefined;
      // 12R 历史兼容:规范化前的原形态派生(仅当表示有差异时非空;旧格式已消费 ⇒ 探测拒绝)。
      const legacyKeyGoalId = originalKey && createKey !== originalKey ? goalIdForCreateKey(originalKey) : undefined;
      // 期望作用域(统一模型):恒为工作区挂载根(容器 /workspace);项目身份由 GOAL_PLANNED
      // 冻结事实承载(12R),宿主项目路径不再冒充作用域 —— 否则影响面核验把全部变更判越界。
      const expectedScope = deps.defaultAllowedScope ?? plan.tasks[0]!.allowedScope;
      // 非并发重试面:同键已有旧成功 ⇒ 幂等重放/冲突(未创建过 ⇒ 返回 null 走正常创建)。
      if (keyGoalId) {
        const replay = await resolveGoalCreateReplay(
          deps,
          keyGoalId,
          plan.rawInput,
          session.role,
          boundProject,
          legacyKeyGoalId,
        );
        if (replay) return replay;
      }
      let created: { goalId: string; taskIds: string[] };
      try {
        created = await deps.db.transaction(async (tx) => {
          const r = await planGoal(tx as unknown as Exec, {
            ...(keyGoalId ? { id: keyGoalId } : {}),
            rawInput: plan.rawInput,
            budget: { modelCalls: budgetModelCalls },
            tasks: plan.tasks.map((t) => ({
              goalText: t.goalText,
              // 统一模型:allowed_scope 恒为工作区挂载根;项目身份由 GOAL_PLANNED 冻结事实承载(12R)。
              allowedScope: expectedScope,
              allowedCommands: t.allowedCommands,
              priority: t.priority,
              maxAttempts: t.maxAttempts,
            })),
            actor: session.role,
            // 12R(Major-P1):注册表权威解析的项目身份随 Goal 同事务冻结进 GOAL_PLANNED 审计
            //(幂等重放的身份权威;未绑定显式 null —— 绝不只依赖 allowed_scope 目录字符串)。
            projectBinding: boundProject
              ? {
                  name: boundProject.name,
                  path: boundProject.path,
                  repo: boundProject.repo,
                  branch: boundProject.branch,
                }
              : null,
          });
          // WEB-UX-03C §4/C1:创建需求即第一条会话消息(会话事实与 Feed 一致;确定性追加,零生命周期变更)。
          // 该消息同时登记消费映射 → 绑定首 Task(它就是首 Task 的来源;防止 loop 首拍重复派生同义 Task)。
          // 12:并入创建同一事务 —— Goal+初始 Task+预算+消息+消费原子可见,ACK 丢失重放读到的
          // 必是完整初始事实;失败整体回滚,绝不留半创建。
          const firstMsg = await tx.execute(sql`
            INSERT INTO goal_messages (goal_id, actor, kind, content)
            VALUES (${r.goalId}, 'USER', 'USER_MESSAGE', ${plan.rawInput})
            RETURNING id
          `);
          if (r.taskIds[0]) {
            await tx.execute(sql`
              INSERT INTO goal_message_consumptions (message_id, goal_id, task_id)
              VALUES (${Number(firstMsg.rows[0]!["id"])}, ${r.goalId}, ${r.taskIds[0]})
            `);
          }
          return r;
        });
      } catch (err) {
        // 12:并发同键 —— 赢家事务已提交 ⇒ 本事务 PK 冲突回滚(零部分状态)⇒ 转重放/冲突判定。
        if (keyGoalId && isUniqueViolation(err)) {
          const replay = await resolveGoalCreateReplay(
            deps,
            keyGoalId,
            plan.rawInput,
            session.role,
            boundProject,
            legacyKeyGoalId,
          );
          if (replay) return replay;
        }
        throw err;
      }
      await audit(deps, {
        actor: session.role,
        action: "WEB_GOAL_CREATED",
        taskId: created.taskIds[0],
        detail: boundProject
          ? {
              goalId: created.goalId,
              projectId: boundProject.name,
              // REVIEW Minor-2 消化:projectName 以注册表为权威(浏览器同名值仅提示,不入审计)
              projectName: boundProject.name,
              resolvedPath: boundProject.path,
              repo: boundProject.repo,
              branch: boundProject.branch,
              scopeSource: "registry",
            }
          : { goalId: created.goalId },
      });
      return ok(
        {
          goalId: created.goalId,
          taskIds: created.taskIds,
          project: boundProject
            ? {
                projectId: boundProject.name,
                path: boundProject.path,
                repo: boundProject.repo,
                branch: boundProject.branch,
              }
            : null,
        },
        201,
      );
    }
    const goalMatch = /^\/api\/goals\/([^/]+)$/.exec(path);
    if (goalMatch && method === "GET") {
      const goalId = decodeURIComponent(goalMatch[1]!);
      const detail = await goalDetailView(deps.db, goalId);
      if (!detail) return fail(404, "goal_not_found", "Goal 不存在");
      return ok({ goal: detail });
    }
    // RELAY-CONTROL-READY-03 P0-1(方案 A,用户 2026-11-13 裁决):follow-up 用户消息。
    // 单输入框保留;服务器端显式 intent(executionRequest 严格布尔,缺省=false=普通"发送")
    // 区分 交流/记录 与 交给 Relay 执行 —— **不经模型猜测、不依赖前端隐藏**(旧客户端缺省安全降级)。
    // goal_messages 只追加;普通消息 ⇒ 只记录(任何状态,永不派生);显式执行 ⇒ 经
    // core.consumeGoalMessages 校验(幂等/Goal 状态/在途/权限继承)后才派生受控 Task:
    // 空闲 ACTIVE ⇒ 立即派生;在途 ⇒ 排队到安全边界;终态/PAUSED ⇒ 只记录不重开
    //(SAFETY-CLOSE-02 P0-A 语义保留;PAUSED 绝对不自动重激活)。反馈三态=已记录/排队待执行/已创建任务。
    const msgMatch = /^\/api\/goals\/([^/]+)\/messages$/.exec(path);
    if (msgMatch && method === "POST") {
      const goalId = decodeURIComponent(msgMatch[1]!);
      const content = str(req.body?.["content"]).trim();
      if (!content) return fail(400, "content_required", "请填写要告诉 Relay 的内容");
      if (content.length > 2000) return fail(400, "content_too_long", "内容过长(上限 2000 字)");
      const goalRow = await deps.db.execute(sql`SELECT state FROM goals WHERE id = ${goalId}`);
      if (goalRow.rows.length === 0) return fail(404, "goal_not_found", "Goal 不存在");
      const goalState = String(goalRow.rows[0]!["state"]);
      const executionRequest = req.body?.["executionRequest"] === true;

      // 非 ACTIVE Goal(终态/暂停):一律只记录(含显式执行请求 —— 不重开不派生;消费层纵深防御)。
      if (goalState !== "ACTIVE") {
        const inserted = await deps.db.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
          VALUES (${goalId}, 'USER', 'USER_MESSAGE', ${content}, ${executionRequest})
          RETURNING id
        `);
        const messageId = Number(inserted.rows[0]!["id"]);
        const stateLabel = goalState === "PAUSED" ? "该需求会话已暂停" : "该需求已完结";
        const ackText = `已记录${executionRequest ? "执行请求" : "你的补充"}。${stateLabel},不会自动创建新执行任务;如需继续,请新建一个需求。`;
        await deps.db.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content)
          VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE', ${ackText})
        `);
        await audit(deps, {
          actor: session.role,
          action: "GOAL_MESSAGE_HELD",
          detail: { goalId, messageId, goalState, executionRequest, contentLength: content.length },
        });
        await audit(deps, {
          actor: session.role,
          action: "WEB_GOAL_MESSAGE",
          detail: {
            goalId,
            messageId,
            followUpTaskId: null,
            inFlight: false,
            held: true,
            executionRequest,
            goalState,
            contentLength: content.length,
          },
        });
        return ok(
          {
            messageId,
            followUpTaskId: null,
            inFlight: false,
            held: true,
            note: `已记录。${stateLabel},不会自动创建新执行任务;如需继续,请新建一个需求。`,
          },
          201,
        );
      }

      // 普通"发送"(无执行意图,含旧客户端缺省):只交流/记录,任何情况下零派生(方案 A 核心)。
      if (!executionRequest) {
        const inserted = await deps.db.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
          VALUES (${goalId}, 'USER', 'USER_MESSAGE', ${content}, false)
          RETURNING id
        `);
        const messageId = Number(inserted.rows[0]!["id"]);
        const ackText = "已记录。要开始执行,请使用「交给 Relay 执行」。";
        await deps.db.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content)
          VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE', ${ackText})
        `);
        await audit(deps, {
          actor: session.role,
          action: "WEB_GOAL_MESSAGE",
          detail: {
            goalId,
            messageId,
            followUpTaskId: null,
            inFlight: false,
            recorded: true,
            executionRequest: false,
            goalState,
            contentLength: content.length,
          },
        });
        return ok(
          {
            messageId,
            followUpTaskId: null,
            inFlight: false,
            recorded: true,
            note: ackText,
          },
          201,
        );
      }

      // 显式"交给 Relay 执行":原子幂等防重(check+insert)+ 数据库级互斥(P1-C C5)——
      // 同 Goal 相同内容的执行请求若"未消费(排队中)"或"已派生且其任务仍在非终态
      //(READY/…执行链)"⇒ 不再插入(重复点击/网络重发不重复创建;先前同内容任务已到终态
      // ⇒ 允许发起新一轮授权)。单语句 NOT EXISTS 在 READ COMMITTED 真并发下可双插
      //(反例实证:两连接交错均通过检查 ⇒ 双消息=重复授权面),故检查+插入整体置于
      // pg_advisory_xact_lock(hashtext(goal),hashtext(content)) 之下 —— 同键并发请求
      // 串行化,后到者必见先到者的已提交行 ⇒ 可证明的唯一性(非仅探针未复现)。
      const inserted = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${goalId}), hashtext(${content}))`);
        return tx.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content, execution_request)
          SELECT ${goalId}, 'USER', 'USER_MESSAGE', ${content}, true
          WHERE NOT EXISTS (
            SELECT 1 FROM goal_messages g2
            LEFT JOIN goal_message_consumptions c2 ON c2.message_id = g2.id
            LEFT JOIN tasks t2 ON t2.id = c2.task_id
            WHERE g2.goal_id = ${goalId} AND g2.actor = 'USER' AND g2.execution_request = true
              AND g2.content = ${content}
              AND (c2.id IS NULL OR t2.state IS NULL OR t2.state NOT IN ('ACCEPTED','FAILED','CANCELLED'))
          )
          RETURNING id
        `);
      });
      if (inserted.rows.length === 0) {
        const existing = await deps.db.execute(sql`
          SELECT gm.id AS id, c.task_id AS task_id, t.state AS task_state FROM goal_messages gm
          LEFT JOIN goal_message_consumptions c ON c.message_id = gm.id
          LEFT JOIN tasks t ON t.id = c.task_id
          WHERE gm.goal_id = ${goalId} AND gm.actor = 'USER' AND gm.execution_request = true
            AND gm.content = ${content}
          ORDER BY gm.id DESC LIMIT 1
        `);
        if (existing.rows.length === 0) {
          // 防御:防重 SELECT 未命中(极端并发窗口)⇒ 按普通记录返回,不猜测
          return ok(
            { messageId: null, followUpTaskId: null, duplicate: true, note: "已有相同执行请求待处理;未重复创建。" },
            201,
          );
        }
        const messageId = Number(existing.rows[0]!["id"]);
        const rawTaskId = existing.rows[0]!["task_id"];
        const mappedTaskId = rawTaskId === null || rawTaskId === undefined ? null : String(rawTaskId);
        await audit(deps, {
          actor: session.role,
          action: "WEB_GOAL_MESSAGE",
          detail: {
            goalId,
            messageId,
            followUpTaskId: mappedTaskId,
            duplicate: true,
            executionRequest: true,
            goalState,
            contentLength: content.length,
          },
        });
        return ok(
          {
            messageId,
            followUpTaskId: mappedTaskId,
            duplicate: true,
            note: mappedTaskId ? "已有相同执行请求,对应任务已创建;未重复创建。" : "已有相同执行请求待处理;未重复创建。",
          },
          201,
        );
      }
      const messageId = Number(inserted.rows[0]!["id"]);
      // 同步消费:空闲 ⇒ 立即派生;在途 ⇒ 排队(安全边界后由 goalLoopTick 前置步派生)。
      const consumption = await consumeGoalMessages(deps.db, goalId, { actor: session.role });
      const followUpTaskId = consumption.consumed ? (consumption.taskId ?? null) : null;
      const queuedExecute = !consumption.consumed && consumption.reason === "in_flight";
      await audit(deps, {
        actor: session.role,
        action: "WEB_GOAL_MESSAGE",
        detail: {
          goalId,
          messageId,
          followUpTaskId,
          inFlight: queuedExecute,
          queuedExecute,
          executionRequest: true,
          goalState,
          contentLength: content.length,
        },
      });
      if (queuedExecute) {
        const ackText = "已记录执行请求;当前执行仍在进行,结束后将自动创建执行任务。";
        await deps.db.execute(sql`
          INSERT INTO goal_messages (goal_id, actor, kind, content)
          VALUES (${goalId}, 'RELAY', 'RELAY_MESSAGE', ${ackText})
        `);
        return ok(
          {
            messageId,
            followUpTaskId: null,
            inFlight: true,
            queuedExecute: true,
            note: ackText,
          },
          201,
        );
      }
      return ok(
        {
          messageId,
          followUpTaskId,
          inFlight: false,
          note: followUpTaskId ? "已创建执行任务,即将进入受控执行。" : "已记录执行请求。",
        },
        201,
      );
    }
    const feedMatch = /^\/api\/goals\/([^/]+)\/feed$/.exec(path);
    if (feedMatch && method === "GET") {
      const goalId = decodeURIComponent(feedMatch[1]!);
      const afterRaw = req.query.get("after");
      const after = afterRaw === null || afterRaw === "" ? null : Number(afterRaw);
      if (after !== null && (!Number.isInteger(after) || after < 0)) {
        return fail(400, "after_invalid", "after 必须为非负整数(消息 id)");
      }
      const feed = await goalFeedView(deps.db, goalId, after);
      if (!feed) return fail(404, "goal_not_found", "Goal 不存在");
      return ok({ feed });
    }
    const statusMatch = /^\/api\/goals\/([^/]+)\/status$/.exec(path);
    if (statusMatch && method === "GET") {
      const goalId = decodeURIComponent(statusMatch[1]!);
      const status = await goalStatusView(deps.db, goalId);
      if (!status) return fail(404, "goal_not_found", "Goal 不存在");
      return ok({ status });
    }
    // RELAY-RESULT-TRUTH-16:用户验收结果 = 独立 append-only 审计事实(USER_RESULT_*)。
    // 绝不与内部 Gate 的 task ACCEPTED 混谈:本端点只追加审计行,不改 task/Gate 状态、
    // 不触发 Run、不派生后续任务(拒绝后由 UI 提供「新建后续任务」既有入口)。
    // 绑定 Goal(必须)+ changeset(可选,须属该 Goal,跨 Goal 绑定 400 fail-closed);
    // 拒绝必附简短原因(≤500 字);重复操作 = 追加同向事实(可解释历史,不互相覆盖)。
    // 载体 = 既有 audit_events(append-only 触发器;零 migration/零 schema)。
    // 审计写入是本端点**唯一产出** ⇒ 事务内直接 appendAudit,失败即请求失败
    //(不用 best-effort audit() 吞错版 —— 验收事实绝不静默丢失)。
    const acceptMatch = /^\/api\/goals\/([^/]+)\/result-acceptance$/.exec(path);
    if (acceptMatch && method === "POST") {
      const goalId = decodeURIComponent(acceptMatch[1]!);
      const goalRows = await deps.db.execute(sql`SELECT id FROM goals WHERE id = ${goalId}`);
      if (goalRows.rows.length === 0) return fail(404, "goal_not_found", "Goal 不存在");
      const decision = str(req.body?.["decision"]);
      if (decision !== "accept" && decision !== "reject")
        return fail(400, "decision_invalid", "decision 必须为 accept 或 reject");
      const reasonField: unknown = req.body === null || req.body === undefined ? undefined : req.body["reason"];
      const reasonRaw = typeof reasonField === "string" ? reasonField.trim() : "";
      if (decision === "reject" && (!reasonRaw || reasonRaw.length > 500))
        return fail(400, "reason_required", "拒绝必须附简短原因(1~500 字)");
      if (reasonRaw.length > 500) return fail(400, "reason_too_long", "说明最长 500 字");
      const csIdRaw = req.body?.["changesetId"];
      const changesetId = typeof csIdRaw === "string" && csIdRaw.trim() ? csIdRaw.trim() : null;
      if (changesetId) {
        const csRows = await deps.db.execute(sql`
          SELECT cc.id FROM candidate_changesets cc
          JOIN tasks t ON t.id = cc.task_id
          WHERE cc.id = ${changesetId} AND t.goal_id = ${goalId}
        `);
        if (csRows.rows.length === 0)
          return fail(400, "changeset_not_in_goal", "changesetId 不属于该 Goal(跨 Goal 绑定拒绝)");
      }
      // 接受/拒绝时点的交付事实快照(该 Goal 最新变更集 delivery_state;无变更集=null)
      const csState = await deps.db.execute(sql`
        SELECT delivery_state FROM candidate_changesets
        WHERE task_id IN (SELECT id FROM tasks WHERE goal_id = ${goalId})
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const deliveryState = csState.rows[0] ? str(csState.rows[0]!["delivery_state"]) : null;
      const action = decision === "accept" ? "USER_RESULT_ACCEPTED" : "USER_RESULT_REJECTED";
      const detail: Record<string, unknown> = { goalId, deliveryState };
      if (changesetId) detail["changesetId"] = changesetId;
      if (reasonRaw) detail["reason"] = reasonRaw;
      const seq = await deps.db.transaction(async (tx) =>
        appendAudit(tx as unknown as Exec, {
          actor: session.role,
          authority: "OWNER",
          action,
          detail,
        }),
      );
      return ok({ result: { decision, seq, changesetId, reason: reasonRaw || null, deliveryState } }, 201);
    }
    // WEB-UX-03C §3:工作区左侧栏投影(项目分组任务列表;纯读)。
    const workspaceSidebarMatch = /^\/api\/workspace\/sidebar$/.exec(path);
    if (workspaceSidebarMatch && method === "GET") {
      const sidebar = await workspaceSidebarView(deps.db);
      return ok({ sidebar });
    }
    // P0-REWORK-1:模型驱动 Discovery(operator 显式调用;预算经账本 FAIL-CLOSED;失败降级不伪造)
    const discoveryMatch = /^\/api\/goals\/([^/]+)\/discovery$/.exec(path);
    if (discoveryMatch && method === "POST") {
      const goalId = decodeURIComponent(discoveryMatch[1]!);
      // 安全修复:被调查目录不再接受浏览器/请求体提供的 projectDir(客户端可指向任意宿主路径,
      // 曾可借模型只读会话探测无授权目录)。唯一解析源 = Goal 创建时冻结的项目身份绑定
      // (注册表按名解析,绑定 path 兜底;与 Diff Viewer 同一规则)。无绑定/无路径 ⇒ FAIL-CLOSED。
      const binding = await readGoalProjectBinding(deps.db, goalId);
      const projectDir = binding
        ? (readProjectRegistry().projects.find((p) => p.name === binding.name)?.path ?? binding.path)
        : "";
      if (!projectDir)
        return fail(
          409,
          "project_not_bound",
          "Goal 无冻结项目绑定(或绑定无项目路径);Discovery 拒绝发起(不接受请求提供目录)",
        );
      const budgetCalls = int(req.body?.["budgetCalls"]) ?? 3;
      if (budgetCalls <= 0) return fail(400, "budget_calls_invalid", "budgetCalls 必须为正数");
      const provider = process.env.RELAY_PI_PROVIDER;
      const m = process.env.RELAY_PI_MODEL;
      const key = process.env.RELAY_PI_API_KEY;
      const baseUrl = process.env.RELAY_PI_BASE_URL;
      if (!provider || !m || !key || !baseUrl) {
        return fail(
          501,
          "provider_not_configured",
          "未配置 RELAY_PI_* ⇒ 不发起模型分析(FAIL-CLOSED);规则面继续可用并标注来源",
        );
      }
      // REVIEW Major-1 修复:docker 路径先建出口栈(与 worker 同款);失败如实 503,不静默
      const eg = await ensureEgress(baseUrl);
      if (!eg.ok) {
        return fail(503, "egress_rules_missing", `docker 隔离需要出口栈(ensureEgress):${eg.reason ?? "unknown"}`);
      }
      const result = await runGoalDiscovery(deps.db, resolveVendoredPi(), {
        goalId,
        model: { provider, model: m, apiKey: key, baseUrl },
        sandbox: "docker",
        egress: eg,
        projectDir,
        reserveCallsPerRun: budgetCalls,
        actor: session.role,
      });
      if (!result.ok) {
        const reason = result.reason ?? "discovery_failed";
        const status =
          reason === "goal_not_found" || reason === "goal_has_no_task" ? 404 : reason.includes("budget") ? 409 : 500;
        return fail(status, reason);
      }
      return ok(
        {
          source: result.source,
          discoveryId: result.discoveryId,
          report: result.report,
          note: "来源=模型(结构化报告持久化,可回放)",
        },
        201,
      );
    }
    if (path === "/api/decisions" && method === "GET") {
      return ok({ decisions: await decisionListView(deps.db) });
    }
    const resolveMatch = /^\/api\/decisions\/([^/]+)\/resolve$/.exec(path);
    if (resolveMatch && method === "POST") {
      const decisionId = decodeURIComponent(resolveMatch[1]!);
      const taskId = str(req.body?.["taskId"]);
      const approve = req.body?.["approve"] === true;
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      if (!taskId) return fail(400, "task_id_required", "缺少 taskId");
      if (expectedStateVersion === null)
        return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const result = await deps.db.transaction(async (tx) =>
        resolveDecision(tx as unknown as Exec, {
          decisionId,
          taskId,
          approve,
          actor: session.role,
          expectedStateVersion,
          verdict: { approved: approve, via: "web-console" },
        }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "decision_resolve_failed";
        const status =
          reason === "state_version_mismatch"
            ? 409
            : reason === "actor_not_authorized"
              ? 403
              : reason.includes("not_found")
                ? 404
                : 400;
        return fail(status, reason);
      }
      return ok({
        decisionId,
        taskId,
        fromState: result.fromState,
        toState: result.toState,
        decisionResolved: result.decisionResolved ?? false,
      });
    }
    const deferMatch = /^\/api\/decisions\/([^/]+)\/defer$/.exec(path);
    if (deferMatch && method === "POST") {
      const decisionId = decodeURIComponent(deferMatch[1]!);
      const taskId = str(req.body?.["taskId"]);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      const newDeadlineRaw = str(req.body?.["newDeadline"]);
      if (!taskId) return fail(400, "task_id_required", "缺少 taskId");
      if (expectedStateVersion === null)
        return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const newDeadline = new Date(newDeadlineRaw);
      if (!newDeadlineRaw || Number.isNaN(newDeadline.getTime()))
        return fail(400, "new_deadline_invalid", "推迟时间无效");
      const result = await deps.db.transaction(async (tx) =>
        deferDecision(tx as unknown as Exec, {
          decisionId,
          taskId,
          expectedStateVersion,
          newDeadline,
          actor: session.role,
        }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "defer_failed";
        const status = reason === "state_version_mismatch" ? 409 : reason.includes("not_found") ? 404 : 400;
        return fail(status, reason);
      }
      return ok({ decisionId, taskId, deferredTo: newDeadline.toISOString() });
    }
    const resumeMatch = /^\/api\/tasks\/([^/]+)\/resume$/.exec(path);
    if (resumeMatch && method === "POST") {
      const taskId = decodeURIComponent(resumeMatch[1]!);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      if (expectedStateVersion === null)
        return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const result = await deps.db.transaction(async (tx) =>
        resumeTask(tx as unknown as Exec, taskId, { actor: session.role, expectedStateVersion }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "resume_failed";
        const status =
          reason === "state_version_mismatch"
            ? 409
            : reason === "actor_not_authorized"
              ? 403
              : reason.includes("not_found")
                ? 404
                : 400;
        return fail(status, reason);
      }
      return ok({ taskId, fromState: result.fromState, toState: result.toState });
    }
    // P0-REWORK-2:暂停置入入口(REWORK-2 前 PAUSED 无任何置入途径)。同一 Core pauseTask;
    // 语义:仅 READY→PAUSED(阻断领取;租约链不打断);D3 不因 Pause/Resume 被绕过。
    const pauseMatch = /^\/api\/tasks\/([^/]+)\/pause$/.exec(path);
    if (pauseMatch && method === "POST") {
      const taskId = decodeURIComponent(pauseMatch[1]!);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      if (expectedStateVersion === null)
        return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const reason = typeof req.body?.["reason"] === "string" ? str(req.body?.["reason"]) : undefined;
      const result = await deps.db.transaction(async (tx) =>
        pauseTask(tx as unknown as Exec, taskId, {
          actor: session.role,
          expectedStateVersion,
          ...(reason ? { reason } : {}),
        }),
      );
      if (!result.ok) {
        const r = result.reason ?? "pause_failed";
        const status =
          r === "state_version_mismatch"
            ? 409
            : r === "actor_not_authorized"
              ? 403
              : r.includes("not_found")
                ? 404
                : 400;
        return fail(status, r);
      }
      return ok({ taskId, fromState: result.fromState, toState: result.toState });
    }
    // RELAY-CONTROL-READY-03 P1-3:紧急停止(abort 旗标)+ 人工接管(takeover=停止在飞 Run + 撤销写入资格)。
    // 回执三分:REQUESTED(RECEIVED)→ 旗标生效(APPLIED)→ run=CANCELLED+任务终态(STOP_CONFIRMED),
    // 均落审计;幂等(重复请求 alreadyRequested);仅在飞状态;恢复经既有 ops 路径(不新增第二通道)。
    const abortMatch = /^\/api\/tasks\/([^/]+)\/abort$/.exec(path);
    if (abortMatch && method === "POST") {
      const taskId = decodeURIComponent(abortMatch[1]!);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      const result = await deps.db.transaction(async (tx) =>
        requestTaskAbort(tx as unknown as Exec, taskId, {
          actor: session.role,
          ...(expectedStateVersion !== null ? { expectedStateVersion } : {}),
        }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "abort_failed";
        const status =
          reason === "state_version_mismatch"
            ? 409
            : reason === "actor_not_authorized"
              ? 403
              : reason.startsWith("abort_requires_in_flight") || reason.startsWith("state_terminal")
                ? 409
                : 400;
        return fail(status, reason);
      }
      // RELAY-CONTROL-SAFETY-04 P1-C C1/C2:回执显式区分相位与控制权状态 —— 停止确认前
      // 不构成"获得人工控制权";交付相位回执按真实交付态(Reviewer Major-1 分档:每个相位
      // 的陈述必须与远端事实一致,绝不声称"尚未发生外部写入"除非确属 not_started)。
      const isDeliveryPhase = result.phase === "delivery";
      return ok({
        taskId,
        alreadyRequested: result.alreadyRequested === true,
        fromState: result.fromState,
        phase: result.phase ?? "run",
        controlState: result.controlState ?? "stop_pending_confirmation",
        note: isDeliveryPhase
          ? result.controlState === "external_in_progress"
            ? "已登记交付停止请求;外部写入已在进行,不声称已停止——最终结果以远端核对为准(可能 NEEDS_RECONCILE)。"
            : result.controlState === "external_write_done"
              ? "外部提交已完成,停止请求无法撤销已发生的写入;交付收尾将照常核对(DELIVERED 或 NEEDS_RECONCILE)。"
              : result.controlState === "external_outcome_unknown"
                ? "交付执行已失败/冲突,外部副作用是否发生不能确定;停止请求已阻止后续外部写入,结果以核对/Reconcile 为准。"
                : result.controlState === "already_delivered"
                  ? "交付已完成,停止请求不撤销已发生的外部提交(如实告知)。"
                  : "已登记交付停止请求;外部写入尚未开始,边界检查将阻止其发生。"
          : "已请求紧急停止;执行端确认生效后任务进入 CANCELLED;停止确认前不构成获得人工控制权(STOP_CONFIRMED 以审计为准)。",
      });
    }
    const takeoverMatch = /^\/api\/tasks\/([^/]+)\/takeover$/.exec(path);
    if (takeoverMatch && method === "POST") {
      const taskId = decodeURIComponent(takeoverMatch[1]!);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      const result = await deps.db.transaction(async (tx) =>
        requestTaskAbort(tx as unknown as Exec, taskId, {
          actor: session.role,
          ...(expectedStateVersion !== null ? { expectedStateVersion } : {}),
        }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "takeover_failed";
        const status =
          reason === "state_version_mismatch"
            ? 409
            : reason === "actor_not_authorized"
              ? 403
              : reason.startsWith("abort_requires_in_flight") || reason.startsWith("state_terminal")
                ? 409
                : 400;
        return fail(status, reason);
      }
      await audit(deps, {
        actor: session.role,
        action: "TASK_TAKEOVER_REQUESTED",
        taskId,
        detail: {
          fromState: result.fromState,
          phase: result.phase ?? "run",
          controlState: result.controlState ?? "stop_pending_confirmation",
          // C1/C2:接管回执=请求已接收;旧 Run 停止确认/租约失效/副作用核对完成前,不声称获得控制权
          note: "人工接管请求已接收(停止在飞 Run/交付 + 撤销写入资格);控制权转移以 TASK_ABORT_CONFIRMED/STOP_CONFIRMED 审计为准,请求回执不构成接管成功;交还 AI 经方案 A 显式执行请求或既有 resume",
        },
      });
      const isDeliveryPhase = result.phase === "delivery";
      return ok({
        taskId,
        alreadyRequested: result.alreadyRequested === true,
        fromState: result.fromState,
        phase: result.phase ?? "run",
        controlState: result.controlState ?? "stop_pending_confirmation",
        note: isDeliveryPhase
          ? result.controlState === "external_in_progress"
            ? "接管请求已接收;交付外部写入已在进行,不声称接管完成——最终结果以远端核对为准。"
            : result.controlState === "external_write_done"
              ? "外部提交已完成,接管请求无法撤销已发生的写入;交付收尾将照常核对。"
              : result.controlState === "external_outcome_unknown"
                ? "交付执行已失败/冲突,外部副作用是否发生不能确定;接管请求已阻止后续外部写入,结果以核对/Reconcile 为准。"
                : result.controlState === "already_delivered"
                  ? "交付已完成;接管请求不撤销已发生的外部提交(如实告知)。"
                  : "接管请求已接收;交付外部写入尚未开始,边界检查将阻止其发生。"
          : "接管请求已接收(停止在飞执行并撤销其写入资格);控制权转移以 STOP_CONFIRMED 审计为准,当前状态=stop_pending_confirmation。",
      });
    }
    if (path === "/api/changesets" && method === "GET") {
      return ok({ changesets: await changesetListView(deps.db) });
    }
    const csMatch = /^\/api\/changesets\/([^/]+)$/.exec(path);
    if (csMatch && method === "GET") {
      const csId = decodeURIComponent(csMatch[1]!);
      const detail = await changesetDetailView(deps.db, csId);
      if (!detail) return fail(404, "changeset_not_found", "变更集不存在");
      return ok({ changeset: detail });
    }
    // WEB-UX-01 §4.8:只读 Diff Viewer 数据源(零写操作;零模型调用)。
    // 来源=本地已注册项目仓库的 `git diff base..commit`(须本地同时含两提交;交付写入远端后
    // 本地未 pull 则如实返回不可用原因,不伪造 diff)。
    const csDiffMatch = /^\/api\/changesets\/([^/]+)\/diff$/.exec(path);
    if (csDiffMatch && method === "GET") {
      const csId = decodeURIComponent(csDiffMatch[1]!);
      const detail = await changesetDetailView(deps.db, csId);
      if (!detail) return fail(404, "changeset_not_found", "变更集不存在");
      const c = detail.changeset;
      if (!c.gitBaseCommitSha || !c.gitCommitSha) {
        return ok({ available: false, reason: "无 git 提交绑定(候选未生成 commit),无可展示 diff" });
      }
      // 项目解析 = Goal 创建时冻结的项目身份绑定(统一模型);作用域恒为工作区挂载根,
      // 前缀匹配永不相交 ⇒ 只能按绑定查。仅当无冻结事实(历史变更集)时回退旧口径。
      const reg = readProjectRegistry().projects;
      const binding = detail.goal ? await readGoalProjectBinding(deps.db, detail.goal.id) : null;
      let projectPath = binding ? (reg.find((p) => p.name === binding.name)?.path ?? binding.path) : "";
      if (!projectPath && detail.task && detail.task.allowedScope.length) {
        const legacyScope = detail.task.allowedScope[0]!;
        // REVIEW Minor-1 消化:多项目路径存在前缀包含关系时取最长前缀(最具体)者,避免误配
        projectPath =
          reg
            .filter((p) => p.path === legacyScope || legacyScope.startsWith(p.path) || p.path.startsWith(legacyScope))
            .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? "";
      }
      if (!projectPath) {
        return ok({
          available: false,
          reason:
            "该变更集未绑定已注册项目目录(创建于项目绑定功能之前,或项目未登记);本地 diff 不可用,请直接在项目仓库核对提交 " +
            c.gitCommitSha.slice(0, 12),
        });
      }
      try {
        const raw = execFileSync("git", ["-C", projectPath, "diff", c.gitBaseCommitSha + ".." + c.gitCommitSha, "--"], {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const LIMIT = 200_000;
        return ok({ available: true, source: projectPath, truncated: raw.length > LIMIT, diff: raw.slice(0, LIMIT) });
      } catch {
        return ok({
          available: false,
          source: projectPath,
          reason: "本地仓库当前不包含 base/交付提交(交付写入远端;本地同步提交后可查看),不伪造 diff",
        });
      }
    }
    if (path === "/api/worker/tick" && method === "POST") {
      const worker = deps.worker;
      // R-8:external 模式 = 本进程明确不提供该能力 ⇒ 501(而非抛错后的 500)
      if (!worker || worker.mode === "external") {
        return fail(501, "worker_not_available", "本进程未挂载 worker 驱动(由独立 relay-worker 进程推进)");
      }
      const report = await worker.tick();
      await audit(deps, { actor: session.role, action: "WEB_WORKER_TICK", detail: { status: report.status } });
      return ok({ tick: report });
    }
    return fail(404, "route_not_found", `未知路由 ${method} ${path}`);
  } catch (err) {
    return fail(500, "internal_error", safeErrorMessage(err));
  }
}

/** 统一出口:脱敏 + JSON 头 + no-store。 */
export function finalizeResponse(res: ApiResponse): ApiResponse {
  return {
    status: res.status,
    body: redactSecrets(res.body),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(res.headers ?? {}),
    },
  };
}
