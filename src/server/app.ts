// Relay 最小 API Server + 静态控制台(P0-02C)。
// 边界:
//  - 仅 Node 内建 http(D-1:零新运行时依赖);前端零构建(D-2),静态资源同一进程提供。
//  - 监听面默认 127.0.0.1(G-1):非回环地址必须显式 RELAY_WEB_ALLOW_NON_LOOPBACK=1,否则启动即拒。
//  - 业务页未登录 ⇒ 302 到 /login.html(页面本身不含业务数据;数据一律来自 /api)。
//  - 静态文件路径穿越防护:解析后必须仍在 web 根内。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { RelayDb, Exec } from "../core/db.ts";
import { Auth, type Session } from "./auth.ts";
import { handleApi, finalizeResponse, type ApiDeps } from "./api.ts";
import type { WorkerDriver, WorkerMode } from "./worker.ts";

export interface RelayServerOptions {
  db: RelayDb;
  auth: Auth;
  worker?: WorkerDriver | null;
  workerMode?: WorkerMode;
  host?: string;
  port?: number;
  staticDir?: string;
  defaultGoalBudgetModelCalls?: number;
  defaultAllowedScope?: string[];
}

export interface RelayServerHandle {
  server: ReturnType<typeof createServer>;
  host: string;
  port: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/** 业务页面(需会话);其余静态资源公开。 */
const PAGE_ROUTES = new Set(["/", "/goal.html", "/decisions.html", "/changeset.html", "/projects.html", "/models.html", "/system.html"]);

/** G-1 绑定面拒绝(可辨识错误类型,入口层据此落审计)。 */
export class BindRejectedError extends Error {
  host: string;
  constructor(host: string, message: string) {
    super(message);
    this.name = "BindRejectedError";
    this.host = host;
  }
}

/** G-1:非回环绑定必须显式放行(默认拒绝;不开放公网)。 */
export function ensureLoopbackBind(host: string): void {
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback && process.env.RELAY_WEB_ALLOW_NON_LOOPBACK !== "1") {
    throw new BindRejectedError(
      host,
      `refuse_non_loopback_bind:绑定 ${host} 需要显式 RELAY_WEB_ALLOW_NON_LOOPBACK=1(默认仅监听本地地址,Mac 通过 SSH 端口转发访问)`,
    );
  }
}

/** G-1:绑定拒绝落审计_events(尽力而为;库不可达时仍以 stderr+退出兜底)。 */
export async function auditBindRejected(db: RelayDb, host: string, reason: string): Promise<void> {
  try {
    const { appendAudit } = await import("../core/audit.ts");
    await db.transaction(async (tx) =>
      appendAudit(tx as unknown as Exec, {
        actor: "relay-web",
        authority: "OWNER",
        action: "WEB_BIND_REJECTED",
        detail: { host, reason, note: "非回环绑定未获显式放行 ⇒ 拒绝启动" },
      }),
    );
  } catch {
    /* 审计尽力而为;启动拒绝的主防线是退出 */
  }
}

function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        rejectPromise(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

export function createRelayServer(options: RelayServerOptions): RelayServerHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const staticDir = resolve(options.staticDir ?? join(process.cwd(), "web"));
  const workerMode: WorkerMode = options.workerMode ?? (options.worker ? options.worker.mode : "external");

  // G-1:非回环绑定必须显式放行(默认拒绝;不开放公网)。
  ensureLoopbackBind(host);

  const deps: ApiDeps = {
    db: options.db,
    auth: options.auth,
    worker: options.worker ?? null,
    workerMode,
    defaultGoalBudgetModelCalls: options.defaultGoalBudgetModelCalls ?? 8,
    ...(options.defaultAllowedScope ? { defaultAllowedScope: options.defaultAllowedScope } : {}),
  };

  const server = createServer((req, res) => {
    void handleRequest(deps, staticDir, req, res).catch((err: unknown) => {
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      } catch {
        /* 连接已断开 */
      }
      void err;
    });
  });

  return { server, host, port };
}

async function handleRequest(
  deps: ApiDeps,
  staticDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    let body: Record<string, unknown> | null = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        const raw = await readBody(req);
        if (raw.trim().length > 0) {
          const parsed = JSON.parse(raw) as unknown;
          body = (parsed && typeof parsed === "object" ? parsed : null) as Record<string, unknown> | null;
        }
      } catch {
        const out = finalizeResponse({ status: 400, body: { ok: false, error: "invalid_json_body" } });
        res.writeHead(out.status, out.headers);
        res.end(JSON.stringify(out.body));
        return;
      }
    }
    const apiRes = await handleApi(deps, {
      method,
      path,
      query: url.searchParams,
      body,
      headers: headerMap(req),
      ip: clientIp(req),
    });
    const out = finalizeResponse(apiRes);
    const headers = { ...(out.headers ?? {}) } as Record<string, string>;
    const setCookie = headers["set-cookie"];
    if (setCookie) delete headers["set-cookie"];
    res.writeHead(out.status, setCookie ? { ...headers, "set-cookie": setCookie } : headers);
    res.end(JSON.stringify(out.body));
    return;
  }

  // ---- 静态资源 ----
  let session: Session | null = null;
  try {
    session = deps.auth.resolve(readSessionCookie(req.headers["cookie"]));
  } catch {
    session = null;
  }
  if (PAGE_ROUTES.has(path) && !session) {
    res.writeHead(302, { location: "/login.html" });
    res.end();
    return;
  }

  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const target = resolve(join(staticDir, normalize(rel)));
  if (target !== staticDir && !target.startsWith(staticDir + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error("not_file");
    const content = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
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

export { Auth };
