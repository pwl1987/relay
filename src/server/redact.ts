// 敏感信息脱敏(P0-02C G-5)。
// 目标:**任何**离开服务端的文本都不得含明文凭据 —— 包括 API 响应、错误文本、
// 证据原文(evidence.raw_output)、审计 detail 与日志行。
// 策略:两条腿 —— (a) 按"形态"识别已知凭据;(b) 按"字段名"识别敏感键。
// 键名匹配用下划线/驼峰分词,避免误伤 tokensIn / tokensOut 等计量字段。

export interface RedactionRule {
  kind: string;
  re: RegExp;
}

export const REDACTION_RULES: readonly RedactionRule[] = [
  // GitHub 经典/细粒度令牌(ghp_/gho_/ghs_/ghu_/ghr_/github_pat_)
  { kind: "github_token", re: /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g },
  { kind: "github_token", re: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g },
  // HTTP 认证头
  { kind: "bearer", re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // git credential helper store 形态:https://user:secret@host
  { kind: "url_userinfo", re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi },
  // x-access-token:<tok> 形态
  { kind: "access_token", re: /\b(x-access-token\s*:\s*)([^\s@]+)/gi },
  // URL 查询串里的凭据
  { kind: "query_credential", re: /([?&](?:access_token|token|api_key|apikey|secret|password|pwd)=)([^&\s]+)/gi },
  // 私钥块
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

// 敏感字段名(分词后整词匹配;tokensIn/tokensOut/tokenBudget 不命中)。
const SENSITIVE_KEY = /^(?:pass(?:word|wd)?|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|auth|private[_-]?key|credential|credentials|cookie|session[_-]?id)$/i;

export function redactText(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (_m, ...groups: unknown[]) => {
      // 保留分隔前缀(便于人工定位),只替换秘密本体。
      if (rule.kind === "url_userinfo") {
        const prefix = String(groups[0] ?? "");
        const user = String(groups[1] ?? "");
        return `${prefix}${user}:<redacted>@`;
      }
      if (rule.kind === "bearer") {
        return `${String(groups[0] ?? "Bearer")} <redacted>`;
      }
      if (rule.kind === "access_token") {
        return `${String(groups[0] ?? "")}<redacted>`;
      }
      if (rule.kind === "query_credential") {
        return `${String(groups[0] ?? "")}<redacted>`;
      }
      return "<redacted>";
    });
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

/** 递归脱敏任意 JSON 结构(对象/数组/字符串)。不修改入参。 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, 0) as T;
}

const MAX_DEPTH = 12;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "<redacted:max-depth>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "<redacted:field>" : redactValue(v, depth + 1);
    }
    return out;
  }
  return "<redacted:unsupported>";
}

/** 错误对象安全化(不回显堆栈;只取 message 并脱敏)。 */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactText(msg).slice(0, 500);
}
