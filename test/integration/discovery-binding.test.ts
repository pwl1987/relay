// REWORK 安全修复定向反例:Discovery HTTP 端点不再接受浏览器/请求体提供的 projectDir。
// 被调查目录唯一解析源 = Goal 创建时冻结的项目身份绑定(注册表按名解析,绑定 path 兜底);
// 无绑定/无路径 ⇒ 409 FAIL-CLOSED。请求体里的 projectDir 字段必须零效果(伪造目录不得借
// 模型只读会话探测宿主任意路径)。provider 未配置(501)作为「绑定解析已通过」的观测量:
// 端点在绑定解析之后才检查 provider ⇒ 501 证明解析面放行且全程未触碰请求提供目录。
// 零模型、零 docker、零外部交付;一次性注册表/bare 仓库,用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { makeWorkspaceRepo } from "../helpers/git-fixture.ts";

const PASSWORD = "disc-binding-pw";
const PROJ_ENV = "RELAY_PROJECTS_FILE";
const PI_ENVS = ["RELAY_PI_PROVIDER", "RELAY_PI_MODEL", "RELAY_PI_API_KEY", "RELAY_PI_BASE_URL"];

describe("REWORK:Discovery 项目解析 = 冻结绑定(浏览器 projectDir 废止)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  const roots: string[] = [];
  let boundGoalId = "";
  let unboundGoalId = "";
  const savedPi: Array<[string, string | undefined]> = [];
  let savedRegistry: string | undefined;

  beforeAll(async () => {
    t = await createTestDb("disc-binding");
    const project = makeWorkspaceRepo(mkdtempSync(join(tmpdir(), "disc-binding-proj-")));
    roots.push(project.dir);
    const regDir = mkdtempSync(join(tmpdir(), "disc-binding-reg-"));
    roots.push(regDir);
    const reg = join(regDir, "projects.json");
    await (await import("node:fs")).promises.writeFile(
      reg,
      JSON.stringify({ projects: [{ name: "demo", path: project.dir, repo: "example/demo", branch: "main" }] }),
      "utf8",
    );
    savedRegistry = process.env[PROJ_ENV];
    process.env[PROJ_ENV] = reg;
    for (const k of PI_ENVS) savedPi.push([k, process.env[k]]);
    for (const k of PI_ENVS) delete process.env[k]; // provider 门 ⇒ 501 作绑定解析放行的观测量

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
      host: "127.0.0.1",
      port: 0,
      staticDir: join(process.cwd(), "web"),
      defaultGoalBudgetModelCalls: 12,
    });
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    csrf = ((await login.json()) as { csrfToken?: string }).csrfToken ?? "";
    expect(cookie).not.toBe("");
    expect(csrf).not.toBe("");

    const post = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(base + "/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const bound = await post({ rawInput: "在 demo 项目里调查一下接口设计", projectId: "demo" });
    expect(bound.status).toBe(201);
    boundGoalId = String(bound.body["goalId"]);
    expect(boundGoalId).not.toBe("");
    const unbound = await post({ rawInput: "无项目绑定的需求" });
    expect(unbound.status).toBe(201);
    unboundGoalId = String(unbound.body["goalId"]);
    expect(unboundGoalId).not.toBe("");
  });

  afterAll(async () => {
    for (const [k, v] of savedPi) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedRegistry === undefined) delete process.env[PROJ_ENV];
    else process.env[PROJ_ENV] = savedRegistry;
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
    }
    await t.cleanup();
  });

  async function discovery(
    goalId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + `/api/goals/${encodeURIComponent(goalId)}/discovery`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("绑定 Goal + 空 body ⇒ 501 provider_not_configured(绑定解析放行;无需请求提供目录)", async () => {
    const r = await discovery(boundGoalId, {});
    expect(r.status).toBe(501);
    expect(r.body["error"]).toBe("provider_not_configured");
  });

  it("反例:伪造 projectDir 字段 ⇒ 零效果(仍 501;绝不按请求目录发起)", async () => {
    const evil = join(tmpdir(), "evil-probe-not-a-project");
    const r = await discovery(boundGoalId, { projectDir: evil });
    expect(r.status).toBe(501);
    expect(r.body["error"]).toBe("provider_not_configured");
    // 端点全程未发起任何 Discovery(模型面/审计面双零)
    const n = await t.db.execute(sql`SELECT count(*)::int AS n FROM discoveries`);
    expect(Number(n.rows[0]!["n"])).toBe(0);
    const aud = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'DISCOVERY_%'`);
    expect(Number(aud.rows[0]!["n"])).toBe(0);
  });

  it("反例:未绑定 Goal + 伪造 projectDir ⇒ 409 project_not_bound(绑定缺失 FAIL-CLOSED)", async () => {
    const r = await discovery(unboundGoalId, { projectDir: "/tmp/evil-probe-unbound" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("project_not_bound");
  });

  it("反例:不存在的 Goal ⇒ 409 project_not_bound(无冻结事实即拒绝,不信任请求目录)", async () => {
    const r = await discovery("goal-not-exist-0001", { projectDir: "/tmp/evil-probe-404" });
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("project_not_bound");
  });
});
