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
//   POST   /api/goals/:id/discovery  模型驱动 Discovery(REWORK-1;operator 显式;预算账本)
//   GET    /api/decisions          Decision Inbox
//   POST   /api/decisions/:id/resolve  批准/拒绝(core.ops.resolveDecision)
//   POST   /api/decisions/:id/defer    推迟(仅改截止时间;状态不变)
//   POST   /api/tasks/:id/resume       恢复任务(core.ops.resumeTask)
//   POST   /api/tasks/:id/pause        暂停任务(core.ops.pauseTask;P0-REWORK-2 置入入口)
//   GET    /api/changesets/:id     ChangeSet/Evidence 详情
//   POST   /api/worker/tick        推进一拍 Goal Loop(core.goalLoopTick)
import { sql } from "drizzle-orm";
import type { RelayDb, Exec } from "../core/db.ts";
import { planGoal } from "../core/goals.ts";
import { operatorAllowed, resolveDecision, resumeTask, pauseTask } from "../core/ops.ts";
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
  decisionListView,
  changesetDetailView,
  changesetListView,
  projectsView,
  modelsUsageView,
  systemView,
  readProjectRegistry,
} from "./views.ts";
import { buildCapabilityRegistry } from "./capabilities.ts";
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
  tasks: Array<{ goalText: string; allowedScope: string[]; allowedCommands: string[]; priority: number; maxAttempts: number }>;
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
        body: { ok: true, authenticated: true, role: session.role, csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() },
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
        return fail(err.code.startsWith("csrf") || err.code.includes("origin") || err.code.includes("cross_site") ? 403 : 400, err.code, err.message);
      }
      return fail(500, "write_guard_error", safeErrorMessage(err));
    }
    if (!operatorAllowed(session.role)) {
      await audit(deps, { actor: session.role, action: "WEB_WRITE_REJECTED", detail: { path, reason: "actor_not_authorized" } });
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
          configured: Boolean(process.env.RELAY_PI_PROVIDER && process.env.RELAY_PI_MODEL && process.env.RELAY_PI_BASE_URL),
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
        if (!entry) return fail(400, "unknown_project", "未登记的项目:仅接受项目注册表内的 projectId(路径由服务端解析,不接受浏览器提交路径)");
        boundProject = { name: entry.name, path: entry.path, repo: entry.repo ?? null, branch: entry.branch ?? null };
      }
      const plan = deriveDefaultPlan(rawInput);
      const budgetModelCalls = deps.defaultGoalBudgetModelCalls;
      const created = await deps.db.transaction(async (tx) =>
        planGoal(tx as unknown as Exec, {
          rawInput: plan.rawInput,
          budget: { modelCalls: budgetModelCalls },
          tasks: plan.tasks.map((t) => ({
            goalText: t.goalText,
            // §4.5:项目绑定 ⇒ Task allowed_scope 绑定注册表解析的项目目录;未绑定保持既有默认。
            allowedScope: boundProject ? [boundProject.path] : deps.defaultAllowedScope ?? t.allowedScope,
            allowedCommands: t.allowedCommands,
            priority: t.priority,
            maxAttempts: t.maxAttempts,
          })),
          actor: session.role,
        }),
      );
      await audit(deps, {
        actor: session.role,
        action: "WEB_GOAL_CREATED",
        taskId: created.taskIds[0],
        detail: boundProject
          ? {
              goalId: created.goalId,
              projectId: boundProject.name,
              projectName: str(req.body?.["projectName"]) || boundProject.name,
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
          project: boundProject ? { projectId: boundProject.name, path: boundProject.path, repo: boundProject.repo, branch: boundProject.branch } : null,
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
    // P0-REWORK-1:模型驱动 Discovery(operator 显式调用;预算经账本 FAIL-CLOSED;失败降级不伪造)
    const discoveryMatch = /^\/api\/goals\/([^/]+)\/discovery$/.exec(path);
    if (discoveryMatch && method === "POST") {
      const goalId = decodeURIComponent(discoveryMatch[1]!);
      const projectDir = str(req.body?.["projectDir"]).trim();
      if (!projectDir) return fail(400, "project_dir_required", "缺少 projectDir(被调查的项目目录)");
      const budgetCalls = int(req.body?.["budgetCalls"]) ?? 3;
      if (budgetCalls <= 0) return fail(400, "budget_calls_invalid", "budgetCalls 必须为正数");
      const provider = process.env.RELAY_PI_PROVIDER;
      const m = process.env.RELAY_PI_MODEL;
      const key = process.env.RELAY_PI_API_KEY;
      const baseUrl = process.env.RELAY_PI_BASE_URL;
      if (!provider || !m || !key || !baseUrl) {
        return fail(501, "provider_not_configured", "未配置 RELAY_PI_* ⇒ 不发起模型分析(FAIL-CLOSED);规则面继续可用并标注来源");
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
        const status = reason === "goal_not_found" || reason === "goal_has_no_task" ? 404 : reason.includes("budget") ? 409 : 500;
        return fail(status, reason);
      }
      return ok({ source: result.source, discoveryId: result.discoveryId, report: result.report, note: "来源=模型(结构化报告持久化,可回放)" }, 201);
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
      if (expectedStateVersion === null) return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
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
          reason === "state_version_mismatch" ? 409 : reason === "actor_not_authorized" ? 403 : reason.includes("not_found") ? 404 : 400;
        return fail(status, reason);
      }
      return ok({ decisionId, taskId, fromState: result.fromState, toState: result.toState, decisionResolved: result.decisionResolved ?? false });
    }
    const deferMatch = /^\/api\/decisions\/([^/]+)\/defer$/.exec(path);
    if (deferMatch && method === "POST") {
      const decisionId = decodeURIComponent(deferMatch[1]!);
      const taskId = str(req.body?.["taskId"]);
      const expectedStateVersion = int(req.body?.["expectedStateVersion"]);
      const newDeadlineRaw = str(req.body?.["newDeadline"]);
      if (!taskId) return fail(400, "task_id_required", "缺少 taskId");
      if (expectedStateVersion === null) return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const newDeadline = new Date(newDeadlineRaw);
      if (!newDeadlineRaw || Number.isNaN(newDeadline.getTime())) return fail(400, "new_deadline_invalid", "推迟时间无效");
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
      if (expectedStateVersion === null) return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const result = await deps.db.transaction(async (tx) =>
        resumeTask(tx as unknown as Exec, taskId, { actor: session.role, expectedStateVersion }),
      );
      if (!result.ok) {
        const reason = result.reason ?? "resume_failed";
        const status =
          reason === "state_version_mismatch" ? 409 : reason === "actor_not_authorized" ? 403 : reason.includes("not_found") ? 404 : 400;
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
      if (expectedStateVersion === null) return fail(400, "expected_state_version_required", "缺少 expectedStateVersion");
      const reason = typeof req.body?.["reason"] === "string" ? str(req.body?.["reason"]) : undefined;
      const result = await deps.db.transaction(async (tx) =>
        pauseTask(tx as unknown as Exec, taskId, { actor: session.role, expectedStateVersion, ...(reason ? { reason } : {}) }),
      );
      if (!result.ok) {
        const r = result.reason ?? "pause_failed";
        const status =
          r === "state_version_mismatch" ? 409 : r === "actor_not_authorized" ? 403 : r.includes("not_found") ? 404 : 400;
        return fail(status, r);
      }
      return ok({ taskId, fromState: result.fromState, toState: result.toState });
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
