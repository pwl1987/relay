// T003/RELAY-WEB-NOAUTH-18:RELAY_WEB_AUTH=none 免登录模式(真 PG + 真 HTTP)。
// 覆盖:开关值解析(fail-closed)/ 免登直入 /api 隐式会话 / CSRF 不误伤 / 登出 no-op / 口令登录诚实 401 /
//       警告行纯函数 / 缺省(口令模式)响应不含 authMode(回归锚)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { resolveWebAuthMode, webAuthBanner } from "../../src/server/index.ts";
import { resolveWebPassword } from "../../src/server/index.ts";
import type { AddressInfo } from "node:net";

describe("NOAUTH-18:开关解析(纯函数,无 IO)", () => {
  it("未设/空 ⇒ password;none ⇒ none;其他值 ⇒ 拒绝启动(fail-closed)", () => {
    expect(resolveWebAuthMode({})).toBe("password");
    expect(resolveWebAuthMode({ RELAY_WEB_AUTH: "" })).toBe("password");
    expect(resolveWebAuthMode({ RELAY_WEB_AUTH: "  " })).toBe("password");
    expect(resolveWebAuthMode({ RELAY_WEB_AUTH: "none" })).toBe("none");
    expect(() => resolveWebAuthMode({ RELAY_WEB_AUTH: "on" })).toThrow(/web_auth_mode_invalid/);
    expect(() => resolveWebAuthMode({ RELAY_WEB_AUTH: "NONE" })).toThrow(/web_auth_mode_invalid/);
    // 回归锚:口令解析函数本身不因本包改变语义(env 优先,trim 后返回;fail-closed 分支见下方缺省对照)
    expect(resolveWebPassword({ RELAY_WEB_PASSWORD: " x " })).toBe("x");
  });

  it("警告行:none+非回环 ⇒ 有;其余 ⇒ 无", () => {
    expect(webAuthBanner("none", "10.30.5.80")).toContain("免登录模式");
    expect(webAuthBanner("none", "0.0.0.0")).toContain("免登录模式");
    expect(webAuthBanner("none", "127.0.0.1")).toBeNull();
    expect(webAuthBanner("none", "::1")).toBeNull();
    expect(webAuthBanner("password", "0.0.0.0")).toBeNull();
  });
});

describe("NOAUTH-18:免登录模式(真 PG + 真 HTTP)", () => {
  let t: TestDb;
  let base: string;
  let close: () => Promise<void>;
  let csrf: string;

  const servers: Array<ReturnType<typeof createRelayServer>["server"]> = [];

  async function serve(auth: Auth): Promise<string> {
    const handle = createRelayServer({
      db: t.db,
      auth,
      workerMode: "stub",
      host: "127.0.0.1",
      port: 0,
      staticDir: new URL("../../web", import.meta.url).pathname,
    });
    servers.push(handle.server);
    await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", () => r()));
    const port = (handle.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  beforeAll(async () => {
    t = await createTestDb("noauth18");
    base = await serve(
      new Auth({
        password: "",
        sessionTtlMs: 600_000,
        operators: ["owner"],
        maxLoginFailures: 5,
        loginWindowMs: 60_000,
        lockoutMs: 60_000,
        passwordless: true,
      }),
    );
    const res = await fetch(`${base}/api/session`, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    csrf = String(((await res.json()) as { csrfToken: string }).csrfToken);
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await t.cleanup();
  });

  it("GET / 无 cookie ⇒ 302 /workspace(直入,不再被 login 拦)", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/workspace");
  });

  it("GET /api/session ⇒ 200 + authMode=none + role/csrfToken", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authMode).toBe("none");
    expect(body.role).toBe("owner");
    expect(String(body.csrfToken).length).toBeGreaterThan(0);
    expect(() => new Date(String(body.expiresAt)).toISOString()).not.toThrow(); // 隐式会话 expiresAt 必须有限
  });

  it("写方法:缺 csrf 头 ⇒ 403 csrf_missing;带正确 token ⇒ 过 CSRF 闸(CSRF 未被禁用)", async () => {
    const missing = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ rawInput: "noauth-18 缺csrf" }),
    });
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { error: string }).error).toBe("csrf_missing");

    const withToken = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-relay-csrf": csrf },
      body: JSON.stringify({ rawInput: "noauth-18 带csrf" }),
    });
    expect(withToken.status).not.toBe(403); // 过闸(201 创建成功;后续清理不做强求)
    expect(withToken.status).toBe(201);
  });

  it("跨站 Origin 仍被拒(纵深未拆):Origin=https://evil.example ⇒ 403", async () => {
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-relay-csrf": csrf,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ rawInput: "noauth-18 跨站" }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/session(带 csrf 头)⇒ 200 且登出 no-op(随后 GET 仍 200)", async () => {
    const del = await fetch(`${base}/api/session`, { method: "DELETE", headers: { "x-relay-csrf": csrf } });
    expect(del.status).toBe(200);
    const after = await fetch(`${base}/api/session`, { headers: { accept: "application/json" } });
    expect(after.status).toBe(200);
  });

  it("口令登录不提供:POST /api/session ⇒ 401 missing_credentials", async () => {
    const res = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "whatever" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_credentials");
  });

  it("缺省对照(口令模式,同库第二实例):GET /api/session 响应不含 authMode", async () => {
    const pwdBase = await serve(
      new Auth({
        password: "noauth18-ctl",
        sessionTtlMs: 600_000,
        operators: ["owner"],
        maxLoginFailures: 5,
        loginWindowMs: 60_000,
        lockoutMs: 60_000,
      }),
    );
    const anon = await fetch(`${pwdBase}/api/session`, { headers: { accept: "application/json" } });
    expect(anon.status).toBe(401); // 未登录仍 401(逐字现状)
    const loginRes = await fetch(`${pwdBase}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "noauth18-ctl" }),
    });
    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as Record<string, unknown>;
    expect(body.authMode).toBeUndefined(); // 登录响应字段逐字不变
  });
});
