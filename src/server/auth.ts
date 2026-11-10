// 会话认证与 CSRF(P0-02C G-2/G-3)。
// 模型:单操作者、单租户、自托管 —— 一个口令 ⇒ 一个角色 ⇒ core 的 operatorAllowed 判定。
// 铁律:
//  - 口令只在内存中参与 scrypt 派生比对,**永不**写入日志/响应/审计 detail;
//  - 会话 id 与 CSRF token 均为 32B 随机(不可猜);会话服务端存储(无状态 token 不可撤销);
//  - Cookie 仅承载会话 id(HttpOnly ⇒ JS 不可读;SameSite=Strict ⇒ 跨站不携带);
//  - CSRF:写方法必须带 x-relay-csrf 头且与会话值 timingSafeEqual 相等(双提交+服务端绑定);
//    另校验 Origin / Sec-Fetch-Site(同源),作为纵深;
//  - 登录失败限速 + 锁定(防口令爆破);比较一律 timingSafeEqual(不早退)。
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "relay_session";
export const CSRF_HEADER = "x-relay-csrf";
const KEY_LEN = 32;

export interface Session {
  id: string;
  role: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthConfig {
  /** 明文口令(启动时读入;仅驻留内存) */
  password: string;
  /** 会话有效期(毫秒) */
  sessionTtlMs: number;
  /** 允许的角色(= core 的 RELAY_OPERATORS 名单成员) */
  operators: string[];
  /** 单 IP 允许的失败次数(窗口内) */
  maxLoginFailures: number;
  /** 失败计数窗口(毫秒) */
  loginWindowMs: number;
  /** 锁定时长(毫秒) */
  lockoutMs: number;
}

export type AuthFailure =
  | "missing_credentials"
  | "locked_out"
  | "bad_password"
  | "unknown_session"
  | "expired_session"
  | "csrf_missing"
  | "csrf_mismatch"
  | "origin_mismatch"
  | "forbidden_cross_site";

export class AuthError extends Error {
  /** 失败码(机器可判定;不给客户端除 code/message 外的细节) */
  code: AuthFailure;
  constructor(code: AuthFailure, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

interface AttemptState {
  fails: number;
  windowStart: number;
  lockedUntil: number;
}

function randomToken(): string {
  return randomBytes(KEY_LEN).toString("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // 长度不同:仍做一次等长比较以免用耗时区分长度(随后恒 false)。
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export class Auth {
  private readonly salt = randomBytes(16);
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly sessionsByRole = new Map<string, number>();

  constructor(private readonly config: AuthConfig) {}

  get operators(): readonly string[] {
    return this.config.operators;
  }

  /** 口令派生(scrypt;每次登录现算,内存中不缓存明文)。 */
  private derive(password: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(password, this.salt, KEY_LEN, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }

  private isLocked(clientKey: string): boolean {
    const st = this.attempts.get(clientKey);
    if (!st) return false;
    if (st.lockedUntil > Date.now()) return true;
    if (st.lockedUntil !== 0 && st.lockedUntil <= Date.now()) {
      this.attempts.delete(clientKey);
    }
    return false;
  }

  private recordFailure(clientKey: string): void {
    const now = Date.now();
    const st = this.attempts.get(clientKey);
    if (!st || now - st.windowStart > this.config.loginWindowMs) {
      this.attempts.set(clientKey, { fails: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    st.fails += 1;
    if (st.fails >= this.config.maxLoginFailures) {
      st.lockedUntil = now + this.config.lockoutMs;
    }
  }

  private clearFailures(clientKey: string): void {
    this.attempts.delete(clientKey);
  }

  /** 登录:成功 ⇒ 会话;失败 ⇒ AuthError(bad_password / locked_out)。 */
  async login(
    password: string,
    clientKey: string,
  ): Promise<{ session: Session; role: string }> {
    if (this.isLocked(clientKey)) {
      throw new AuthError("locked_out", "登录暂时锁定(失败次数过多),请稍后再试");
    }
    if (typeof password !== "string" || password.length === 0) {
      this.recordFailure(clientKey);
      throw new AuthError("missing_credentials", "缺少口令");
    }
    const expected = await this.derive(this.config.password);
    const actual = await this.derive(password);
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      this.recordFailure(clientKey);
      throw new AuthError("bad_password", "口令不正确");
    }
    this.clearFailures(clientKey);
    // 角色:必须是 core operator 名单成员(单一权威判定在 core.ops.operatorAllowed)。
    const role = this.config.operators[0] ?? "owner";
    const now = Date.now();
    const session: Session = {
      id: randomToken(),
      role,
      csrf: randomToken(),
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    this.sessionsByRole.set(role, (this.sessionsByRole.get(role) ?? 0) + 1);
    return { session, role };
  }

  logout(sessionId: string | undefined): void {
    if (!sessionId) return;
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const n = (this.sessionsByRole.get(s.role) ?? 1) - 1;
    if (n <= 0) this.sessionsByRole.delete(s.role);
    else this.sessionsByRole.set(s.role, n);
  }

  /** 解析会话:不存在/过期 ⇒ AuthError。 */
  resolve(sessionId: string | undefined): Session {
    if (!sessionId) throw new AuthError("unknown_session", "会话不存在");
    const s = this.sessions.get(sessionId);
    if (!s) throw new AuthError("unknown_session", "会话不存在");
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new AuthError("expired_session", "会话已过期");
    }
    return s;
  }

  /** CSRF 校验(写操作):头值必须与会话内 token 恒定时间相等。 */
  verifyCsrf(session: Session, provided: string | undefined): void {
    if (!provided) throw new AuthError("csrf_missing", "缺少 CSRF 令牌");
    if (!constantTimeEquals(session.csrf, provided)) {
      throw new AuthError("csrf_mismatch", "CSRF 令牌不匹配");
    }
  }

  /** 纵深:同源检查(Origin 存在时必须与 Host 同源;Sec-Fetch-Site 不得为 cross-site)。 */
  verifySameOrigin(headers: { origin?: string | undefined; host?: string | undefined; secFetchSite?: string | undefined }): void {
    const site = headers.secFetchSite;
    if (site && site !== "same-origin" && site !== "none") {
      throw new AuthError("forbidden_cross_site", `跨站请求被拒绝(Sec-Fetch-Site=${site})`);
    }
    const origin = headers.origin;
    if (origin && origin !== "null") {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new AuthError("origin_mismatch", "Origin 无法解析");
      }
      if (headers.host && originHost !== headers.host) {
        throw new AuthError("origin_mismatch", "Origin 与 Host 不同源");
      }
    }
  }

  /** 清理过期会话(定时调用;返回清理条数)。 */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** 当前活跃会话数(健康视图用)。 */
  activeSessions(): number {
    return this.sessions.size;
  }
}

/** 从请求头解析 Cookie 里的会话 id。 */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    const v = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

/** 构造会话 Cookie(本地 HTTP 隧道场景:不设 Secure;仍 HttpOnly + SameSite=Strict)。 */
export function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
