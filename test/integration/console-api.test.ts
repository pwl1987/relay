// OPERATOR-CONSOLE-00 API 集成测试:真实 HTTP(createRelayServer)+ 真实会话 + 独立 schema。
// 零模型调用(external worker;不设任何 RELAY_*_E2E 门);覆盖 P0-UI 新端点与三个新页面路由。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { Auth } from "../../src/server/auth.ts";
import type { AddressInfo } from "node:net";

const PASSWORD = "console-api-password-7c31";

describe("OPERATOR-CONSOLE-00:控制台 API 与页面路由", () => {
  let t: TestDb;
  let base = "";
  let cookie = "";
  let csrf = "";
  const savedProvider: Array<[string, string | undefined]> = [
    ["RELAY_PI_PROVIDER", process.env.RELAY_PI_PROVIDER],
    ["RELAY_PI_MODEL", process.env.RELAY_PI_MODEL],
    ["RELAY_PI_API_KEY", process.env.RELAY_PI_API_KEY],
    ["RELAY_PI_BASE_URL", process.env.RELAY_PI_BASE_URL],
  ];

  async function api(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json", "x-relay-csrf": csrf } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: "manual",
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, body: json };
  }

  beforeAll(async () => {
    for (const [k] of savedProvider) delete process.env[k];
    t = await createTestDb("console-api");
    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 10,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    const handle = createRelayServer({
      db: t.db,
      auth,
      workerMode: "external",
      host: "127.0.0.1",
      port: 0,
      staticDir: join(process.cwd(), "web"),
      defaultGoalBudgetModelCalls: 8,
    });
    await new Promise<void>((resolve) => handle.server.listen(handle.port, handle.host, resolve));
    const addr = handle.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    // 登录取会话 cookie + csrf
    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0]!;
    const loginBody = (await login.json()) as { csrfToken?: string };
    csrf = loginBody.csrfToken ?? "";
    expect(csrf).not.toBe("");

    // 种子数据:一个 ACTIVE goal + 任务,验证聚合非空路径
    await t.db.execute(sql`INSERT INTO goals (id, raw_input, state) VALUES ('g-api','给系统加导出功能','ACTIVE')`);
    await t.db.execute(sql`INSERT INTO tasks (id, goal_id, state) VALUES ('t-api','g-api','READY')`);
  });

  afterAll(async () => {
    for (const [k, v] of savedProvider) if (v !== undefined) process.env[k] = v;
    await t.cleanup();
  });

  it("GET /api/dashboard 返回 extras+worker+providerModel(P0-UI-1)", async () => {
    const res = await api("GET", "/api/dashboard");
    expect(res.status).toBe(200);
    const d = res.body["dashboard"] as Record<string, unknown>;
    const extras = res.body["extras"] as Record<string, unknown>;
    expect(d["taskCounts"]).toBeTruthy();
    expect(extras["overall"]).toBeTruthy();
    expect(extras["taskGroups"]).toBeTruthy();
    expect(extras["deliverySummary"]).toBeTruthy();
    const cur = extras["currentGoal"] as Record<string, unknown> | null;
    expect(cur?.["id"]).toBe("g-api");
    const w = res.body["worker"] as Record<string, unknown>;
    expect(w["mode"]).toBe("external");
    const pm = res.body["providerModel"] as Record<string, unknown>;
    expect(pm["probed"]).toBe(false);
  });

  it("GET /api/projects:未配置注册文件 ⇒ configured=false + 引导说明(P0-UI-2)", async () => {
    const saved = process.env["RELAY_PROJECTS_FILE"];
    delete process.env["RELAY_PROJECTS_FILE"];
    try {
      const res = await api("GET", "/api/projects");
      expect(res.status).toBe(200);
      const p = res.body["projects"] as Record<string, unknown>;
      expect(p["configured"]).toBe(false);
      expect(Array.isArray(p["projects"])).toBe(true);
      expect(String(p["note"])).toContain("projects.json");
    } finally {
      if (saved !== undefined) process.env["RELAY_PROJECTS_FILE"] = saved;
    }
  });

  it("GET /api/models-usage:零探测零凭据;预算聚合可见(P0-UI-5)", async () => {
    const res = await api("GET", "/api/models-usage");
    expect(res.status).toBe(200);
    const u = res.body["usage"] as Record<string, unknown>;
    const provider = u["provider"] as Record<string, unknown>;
    expect(provider["probed"]).toBe(false);
    expect(provider["configured"]).toBe(false);
    expect((u["classification"] as Record<string, unknown>)["status"]).toBe("UNREGISTERED");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("apikey");
  });

  it("GET /api/system:HEAD/DB/Worker/GitHub/uptime/最近错误(P0-UI-6)", async () => {
    const res = await api("GET", "/api/system");
    expect(res.status).toBe(200);
    const s = res.body["system"] as Record<string, unknown>;
    const relay = s["relay"] as Record<string, unknown>;
    expect(String(relay["head"])).toMatch(/^[0-9a-f]{40}$/);
    expect((s["db"] as Record<string, unknown>)["ok"]).toBe(true);
    expect((s["worker"] as Record<string, unknown>)["mode"]).toBe("external");
    expect(typeof relay["uptimeSeconds"]).toBe("number");
    expect(Array.isArray(s["recentErrors"])).toBe(true);
  });

  it("GET /api/goals/:id 返回 progress(P0-UI-3);决策 guidance 经 /api/decisions(P0-UI-4)", async () => {
    const g = await api("GET", "/api/goals/g-api");
    expect(g.status).toBe(200);
    const goal = g.body["goal"] as Record<string, unknown>;
    expect((goal["progress"] as Record<string, unknown>)["phase"]).toBe("排队中");
    expect((goal["progress"] as Record<string, unknown>)["currentModelRef"]).toBeNull();

    // D3 决策:NEEDS_DECISION 任务 + OPEN 决策(带 fallback)
    await t.db.execute(sql`UPDATE tasks SET state='NEEDS_DECISION' WHERE id='t-api'`);
    await t.db.execute(sql`INSERT INTO decisions (id, task_id, goal_id, level, question, fallback)
      VALUES ('d-api','t-api','g-api','D3','是否批准交付?',
      '{"recommended":"批准交付","alternatives":["退回重做"],"risk":"低(本地 bare 可回滚)"}'::jsonb)`);
    const d = await api("GET", "/api/decisions");
    expect(d.status).toBe(200);
    const list = d.body["decisions"] as Array<Record<string, unknown>>;
    const target = list.find((x) => x["id"] === "d-api");
    expect(target).toBeTruthy();
    const guidance = target!["guidance"] as Record<string, unknown>;
    expect(guidance["recommended"]).toBe("批准交付");
    expect(guidance["alternatives"]).toEqual(["退回重做"]);
    expect(String(guidance["impactOfNoAction"])).toContain("不会自动批准");
  });

  it("页面路由:未登录 302 ⇒ 登录页;已登录 200(CSP self;三个新页面)", async () => {
    for (const p of ["/projects.html", "/models.html", "/system.html"]) {
      const anon = await fetch(base + p, { redirect: "manual" });
      expect(anon.status, p + " 未登录应 302").toBe(302);
      expect(anon.headers.get("location")).toBe("/login.html");
      const authed = await fetch(base + p, { headers: { cookie } });
      expect(authed.status, p + " 已登录应 200").toBe(200);
      expect(authed.headers.get("content-type")).toContain("text/html");
      expect(authed.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
    const anonApi = await fetch(base + "/api/system", { headers: { accept: "application/json" } });
    expect(anonApi.status).toBe(401);
  });
});
