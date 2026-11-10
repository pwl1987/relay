// P0-02C API Server 契约与安全反例(真实 PG + 真实 HTTP;零模型、零外网)。
// 覆盖合同反例 1/2/3/4/5/6 + 正链(登录→建 Goal→读详情→决策裁决→推进一拍→Dashboard)。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import type { WorkerDriver } from "../../src/server/worker.ts";
import type { AddressInfo } from "node:net";

const PASSWORD = "test-password-9f3c";
const OPERATORS_ENV = process.env.RELAY_OPERATORS;

describe("P0-02C:API Server(真 PG + 真 HTTP)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base: string;
  let auth: Auth;
  let cookie: string;
  let csrf: string;
  let tickCalls = 0;

  const driver: WorkerDriver = {
    mode: "stub",
    lastTick: () => ({ at: new Date().toISOString(), status: "IDLE", summary: {} }),
    tick: async () => {
      tickCalls += 1;
      return { status: "IDLE", goalStates: [] };
    },
  };

  beforeAll(async () => {
    t = await createTestDb("p02c-api");
    auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 600_000,
      operators: ["owner"],
      maxLoginFailures: 5,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    const handle = createRelayServer({
      db: t.db,
      auth,
      worker: driver,
      workerMode: "stub",
      host: "127.0.0.1",
      port: 0,
      staticDir: new URL("../../web", import.meta.url).pathname,
      defaultGoalBudgetModelCalls: 8,
    });
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await t.cleanup();
    if (OPERATORS_ENV === undefined) delete process.env.RELAY_OPERATORS;
    else process.env.RELAY_OPERATORS = OPERATORS_ENV;
  });

  beforeEach(() => {
    if (OPERATORS_ENV === undefined) delete process.env.RELAY_OPERATORS;
    else process.env.RELAY_OPERATORS = OPERATORS_ENV;
  });

  async function call(
    path: string,
    opts: { method?: string; body?: unknown; withCookie?: boolean; withCsrf?: boolean; csrfOverride?: string } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.withCookie !== false && cookie) headers["cookie"] = cookie;
    if (opts.withCsrf !== false) headers["x-relay-csrf"] = opts.csrfOverride ?? csrf;
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      redirect: "manual",
    });
    let body: any = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  async function login(password = PASSWORD): Promise<void> {
    const res = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    cookie = res.headers.get("set-cookie") ?? "";
    csrf = String(body.csrfToken);
  }

  it("正链:登录 → 创建 Goal → 读详情 → 推进一拍 → Dashboard", async () => {
    await login();
    const created = await call("/api/goals", { method: "POST", body: { rawInput: "感觉登录页不好用,想让登录更快" } });
    expect(created.status).toBe(201);
    const goalId = String(created.body.goalId);
    expect(goalId).toBeTruthy();

    const detail = await call(`/api/goals/${goalId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.goal.goal.rawInput).toContain("登录页");
    // 确定性分析:来源标注 + 模型分析标记为未实现
    expect(detail.body.goal.analysis.source).toBe("deterministic");
    expect(detail.body.goal.analysis.modelAnalysis.status).toBe("NOT_IMPLEMENTED");
    expect(Array.isArray(detail.body.goal.analysis.suggestions)).toBe(true);
    // 任务确实落库
    const rows = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE goal_id = ${goalId}`);
    expect(Number(rows.rows[0]!["n"])).toBe(1);

    const tick = await call("/api/worker/tick", { method: "POST", body: {} });
    expect(tick.status).toBe(200);
    expect(tickCalls).toBeGreaterThan(0);

    const dash = await call("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.dashboard.goals.some((g: any) => g.id === goalId)).toBe(true);
  });

  it("反例1 未认证:API 一律 401 且不含业务数据;业务页 302 到登录页", async () => {
    const saved = cookie;
    cookie = "";
    const dash = await call("/api/dashboard");
    expect(dash.status).toBe(401);
    expect(dash.body.dashboard).toBeUndefined();
    expect(dash.body.goals).toBeUndefined();
    const detail = await call("/api/goals/goal-x");
    expect(detail.status).toBe(401);
    const page = await fetch(`${base}/`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login.html");
    cookie = saved;
  });

  it("反例2 缺少/错误 CSRF ⇒ 403 且数据库状态零变更", async () => {
    await login();
    const created = await call("/api/goals", { method: "POST", body: { rawInput: "csrf 反例目标" } });
    const goalId = String(created.body.goalId);
    const before = await t.db.execute(sql`SELECT count(*)::int AS n FROM goals WHERE id = ${goalId}`);

    const noCsrf = await call("/api/goals", { method: "POST", body: { rawInput: "不该被创建" }, withCsrf: false });
    expect(noCsrf.status).toBe(403);
    const badCsrf = await call("/api/goals", { method: "POST", body: { rawInput: "不该被创建" }, csrfOverride: "f".repeat(64) });
    expect(badCsrf.status).toBe(403);

    const after = await t.db.execute(sql`SELECT count(*)::int AS n FROM goals WHERE id = ${goalId}`);
    expect(Number(after.rows[0]!["n"])).toBe(Number(before.rows[0]!["n"]));
    const leak = await t.db.execute(sql`SELECT count(*)::int AS n FROM goals WHERE raw_input = ${"不该被创建"}`);
    expect(Number(leak.rows[0]!["n"])).toBe(0);
  });

  it("反例3 非 operator 身份 ⇒ 403 且状态零变更", async () => {
    await login();
    const created = await call("/api/goals", { method: "POST", body: { rawInput: "operator 反例目标" } });
    const goalId = String(created.body.goalId);
    // core.ops.operatorAllowed 是唯一权威:把名单换成不含 owner 的值 ⇒ 写操作被拒。
    process.env.RELAY_OPERATORS = "someone-else";
    const denied = await call("/api/goals", { method: "POST", body: { rawInput: "不该被创建 2" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("actor_not_authorized");
    const leak = await t.db.execute(sql`SELECT count(*)::int AS n FROM goals WHERE raw_input = ${"不该被创建 2"}`);
    expect(Number(leak.rows[0]!["n"])).toBe(0);
    // 恢复名单后同一会话可写(证明拒绝来自授权判定而非会话损坏)
    process.env.RELAY_OPERATORS = "owner";
    const ok = await call("/api/goals", { method: "POST", body: { rawInput: "恢复后可写" } });
    expect(ok.status).toBe(201);
    void goalId;
  });

  it("反例4 expectedStateVersion 失配 ⇒ 409 且状态零变更", async () => {
    await login();
    // 直接播种:D3 决策 + NEEDS_DECISION 任务
    const taskId = "t-p02c-ver";
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, state_version, attempt, max_attempts, allowed_scope, allowed_commands, gate_required)
      VALUES (${taskId}, 'NEEDS_DECISION', 7, 1, 3, '["/workspace"]'::jsonb, '[]'::jsonb, true)
    `);
    const decId = "dec-p02c-ver";
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, level, question, state) VALUES (${decId}, ${taskId}, 'D3', '需要人工裁决', 'OPEN')
    `);
    const bad = await call(`/api/decisions/${decId}/resolve`, {
      method: "POST",
      body: { taskId, approve: true, expectedStateVersion: 6 },
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("state_version_mismatch");
    const st = await t.db.execute(sql`SELECT state, state_version FROM tasks WHERE id = ${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    expect(Number(st.rows[0]!["state_version"])).toBe(7);
    const d = await t.db.execute(sql`SELECT state FROM decisions WHERE id = ${decId}`);
    expect(String(d.rows[0]!["state"])).toBe("OPEN");

    const good = await call(`/api/decisions/${decId}/resolve`, {
      method: "POST",
      body: { taskId, approve: true, expectedStateVersion: 7 },
    });
    expect(good.status).toBe(200);
    const st2 = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(st2.rows[0]!["state"])).toBe("READY");
  });

  it("反例5 D3 超时绝不自动批准:仅标 EXPIRED_STILL_BLOCKED,任务仍 NEEDS_DECISION", async () => {
    await login();
    const taskId = "t-p02c-d3";
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, state_version, attempt, max_attempts, allowed_scope, allowed_commands, gate_required)
      VALUES (${taskId}, 'NEEDS_DECISION', 1, 1, 3, '["/workspace"]'::jsonb, '[]'::jsonb, true)
    `);
    const decId = "dec-p02c-d3";
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, level, question, state, deadline)
      VALUES (${decId}, ${taskId}, 'D3', '长期未审批的决策', 'OPEN', now() - interval '1 day')
    `);
    // 触发 core 的超时标记(与 goal-loop 同一路径)
    await t.db.execute(sql`UPDATE decisions SET deadline = now() - interval '1 day' WHERE id = ${decId}`);
    const { expireStaleDecisions } = await import("../../src/core/decisions.ts");
    const expired = await t.db.transaction(async (tx) => expireStaleDecisions(tx as unknown as any, "test"));
    expect(expired).toContain(decId);
    const d = await t.db.execute(sql`SELECT state, verdict, decided_by FROM decisions WHERE id = ${decId}`);
    expect(String(d.rows[0]!["state"])).toBe("EXPIRED_STILL_BLOCKED");
    expect(d.rows[0]!["verdict"]).toBeNull();
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
    // 界面层不提供自动批准入口:能力登记表显式声明
    const caps = await call("/api/capabilities");
    const entry = caps.body.registry.entries.find((e: any) => e.id === "decision.d3.auto_approve");
    expect(entry.status).toBe("NOT_IMPLEMENTED");
  });

  it("反例6 响应中的疑似凭据被脱敏(证据原文/审计 detail 出口)", async () => {
    await login();
    const taskId = "t-p02c-secret";
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, state_version, attempt, max_attempts, allowed_scope, allowed_commands, gate_required)
      VALUES (${taskId}, 'READY', 1, 1, 3, '["/workspace"]'::jsonb, '[]'::jsonb, true)
    `);
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await t.db.execute(sql`
      INSERT INTO gate_evidence (id, task_id, attempt, candidate_sha, kind, passed, raw_output, env, content_sha256, produced_by)
      VALUES ('ev-p02c-secret', ${taskId}, 1, '', 'deterministic_test', false,
        ${"push failed with token " + secret}, '{"mode":"host"}'::jsonb, 'deadbeef', 'test')
    `);
    const detail = await call("/api/dashboard");
    expect(JSON.stringify(detail.body)).not.toContain(secret);
  });

  it("推迟决策只改截止时间,状态不变(D3 不因推迟而放行)", async () => {
    await login();
    const taskId = "t-p02c-defer";
    await t.db.execute(sql`
      INSERT INTO tasks (id, state, state_version, attempt, max_attempts, allowed_scope, allowed_commands, gate_required)
      VALUES (${taskId}, 'NEEDS_DECISION', 2, 1, 3, '["/workspace"]'::jsonb, '[]'::jsonb, true)
    `);
    const decId = "dec-p02c-defer";
    await t.db.execute(sql`
      INSERT INTO decisions (id, task_id, level, question, state, deadline)
      VALUES (${decId}, ${taskId}, 'D3', '推迟测试', 'OPEN', now() + interval '1 hour')
    `);
    const before = await t.db.execute(sql`SELECT deadline, state FROM decisions WHERE id = ${decId}`);
    const res = await call(`/api/decisions/${decId}/defer`, {
      method: "POST",
      body: { taskId, expectedStateVersion: 2, newDeadline: new Date(Date.now() + 86400_000).toISOString() },
    });
    expect(res.status).toBe(200);
    const after = await t.db.execute(sql`SELECT deadline, state FROM decisions WHERE id = ${decId}`);
    expect(String(after.rows[0]!["state"])).toBe(String(before.rows[0]!["state"]));
    expect(String(after.rows[0]!["deadline"])).not.toBe(String(before.rows[0]!["deadline"]));
    const st = await t.db.execute(sql`SELECT state FROM tasks WHERE id = ${taskId}`);
    expect(String(st.rows[0]!["state"])).toBe("NEEDS_DECISION");
  });

  it("登出:DELETE + CSRF ⇒ 会话失效;旧会话再访问 ⇒ 401", async () => {
    await login();
    const out = await call("/api/session", { method: "DELETE" });
    expect(out.status).toBe(200);
    const after = await call("/api/dashboard");
    expect(after.status).toBe(401);
    await login();
  });

  it("静态资源与路径穿越防护", async () => {
    const ok = await fetch(`${base}/style.css`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/css");
    const traversal = await fetch(`${base}/../package.json`, { redirect: "manual" });
    expect([403, 404]).toContain(traversal.status);
    const missing = await fetch(`${base}/nope.html`);
    expect(missing.status).toBe(404);
  });

  // 限速测试放最后:它会按 clientKey(IP)锁定登录 60s,先跑会误伤后续 login()
  it("登录失败限速:连续错误口令后被锁定", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-" + i }),
      });
      expect(res.status).toBe(401);
    }
    const locked = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-again" }),
    });
    expect(locked.status).toBe(429);
  });
});
