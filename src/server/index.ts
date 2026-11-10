// Relay 最小 Web 控制台生产入口(P0-02C)。
// 启动顺序:口令就位(FAIL-CLOSED)→ DB 连接 → worker 驱动 → HTTP 监听(默认 127.0.0.1)。
// 不做的事:生产部署、公网暴露、真实 GitHub 写入编排(凭据与授权另包)。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectDb, closeDb } from "../core/db.ts";
import { Auth } from "./auth.ts";
import { createRelayServer } from "./app.ts";
import { createLiveWorkerDriver, createExternalWorkerDriver, type WorkerDriver } from "./worker.ts";

export const PASSWORD_FILE = join(homedir(), ".relay", "credentials", "web-password");

/** 解析口令:env 优先;否则 0600 文件;都没有 ⇒ 拒绝启动(FAIL-CLOSED)。 */
export function resolveWebPassword(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.RELAY_WEB_PASSWORD ?? "").trim();
  if (fromEnv.length > 0) return fromEnv;
  try {
    const st = statSync(PASSWORD_FILE);
    if (!st.isFile()) throw new Error("not_regular_file");
    if ((st.mode & 0o777) !== 0o600) throw new Error("mode_not_0600");
    const content = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (content.length === 0) throw new Error("empty_password");
    return content;
  } catch (err) {
    throw new Error(
      `web_password_unavailable:设置 RELAY_WEB_PASSWORD 或提供 0600 文件 ${PASSWORD_FILE}(原始错误:${(err as Error).message})`,
    );
  }
}

/** 操作员名单:与 core.ops.operatorAllowed 同源(env RELAY_OPERATORS)。 */
export function resolveOperators(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RELAY_OPERATORS ?? "owner")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function main(): Promise<void> {
  const password = resolveWebPassword();
  const operators = resolveOperators();
  const host = process.env.RELAY_WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.RELAY_WEB_PORT ?? "8787");

  const { pool, db } = connectDb(process.env.RELAY_DB_URL);
  const auth = new Auth({
    password,
    sessionTtlMs: Number(process.env.RELAY_WEB_SESSION_TTL_MS ?? String(8 * 3600_000)),
    operators: operators.length > 0 ? operators : ["owner"],
    maxLoginFailures: Number(process.env.RELAY_WEB_MAX_LOGIN_FAILURES ?? "5"),
    loginWindowMs: Number(process.env.RELAY_WEB_LOGIN_WINDOW_MS ?? String(10 * 60_000)),
    lockoutMs: Number(process.env.RELAY_WEB_LOCKOUT_MS ?? String(5 * 60_000)),
  });

  // worker:默认 external(本进程只读 + 授权操作);配置了模型与 stage 目录才挂真实驱动。
  let worker: WorkerDriver;
  if (process.env.RELAY_WEB_WORKER === "live") {
    worker = createLiveWorkerDriver({
      db,
      sandbox: process.env.RELAY_WEB_SANDBOX === "docker" ? "docker" : "host-fallback",
      stageBaseDir: process.env.RELAY_WEB_STAGE_DIR ?? join(homedir(), ".relay", "stage"),
    });
  } else {
    worker = createExternalWorkerDriver("由独立 relay-worker 进程推进");
  }

  const handle = createRelayServer({
    db,
    auth,
    worker,
    workerMode: worker.mode,
    host,
    port,
    staticDir: process.env.RELAY_WEB_STATIC_DIR ?? join(process.cwd(), "web"),
  });

  await new Promise<void>((resolvePromise) => {
    handle.server.listen(port, host, () => resolvePromise());
  });
  const addr = handle.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  // 启动横幅:绑定地址常驻可见(G-1)。
  console.log(
    `[relay-web] listening on http://${host}:${actualPort} (worker=${worker.mode};仅本地;Mac 请用 SSH 端口转发)`,
  );
  console.log(`[relay-web] operators=${operators.join(",")};口令来源=${process.env.RELAY_WEB_PASSWORD ? "env" : PASSWORD_FILE}`);

  const shutdown = async (): Promise<void> => {
    console.log("[relay-web] shutting down");
    await new Promise<void>((r) => handle.server.close(() => r()));
    await closeDb({ pool, db }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[relay-web] 启动失败:${(err as Error).message}`);
    process.exit(1);
  });
}
