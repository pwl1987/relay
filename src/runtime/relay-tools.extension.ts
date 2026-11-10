// Relay 受控工具扩展(工具层,ADR-0003:P0-01B 合同条款 3)。
// Pi 以 --no-builtin-tools 启动,本扩展是唯一工具面:relay_read(作用域文件读)+
// relay_exec(受限命令执行)。每次调用(允许或拒绝)都追加机器可读审计
// .relay/tool-audit.jsonl —— "工具旁路无法阻断→BLOCK" 的证据源。
//
// 自包含约束:本文件在容器/宿主两种布局下都由 Pi 的 jiti 加载,仅依赖
// typebox + node 内建 + @earendil-works/pi-coding-agent(类型 only,运行时擦除)。
// 不得 import 仓库内部模块(避免加载器路径解析脆弱性);与 src/core/policy.ts 的
// V02 语义一致性由 test/integration/extension-policy-parity.test.ts 固定矩阵保证。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, readFileSync, realpathSync, statSync, mkdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve as resolvePath, sep } from "node:path";

export interface ScopeDecision {
  ok: boolean;
  reason?: string;
  realPath?: string;
}

/**
 * V02 作用域判定(与 src/core/policy.ts 的 checkPathScope 同语义,前缀为 allowedRoot):
 * - allowedRoot 未配置 ⇒ 一律拒绝(scope_empty_default_deny 同源);
 * - realpath 解析后必须等于 root 或位于 root 之下(段边界,防 prefix 字面命中);
 * - 非普通文件拒绝;解析失败拒绝。
 */
export function checkReadScope(
  allowedRoot: string | null,
  requested: string,
): ScopeDecision {
  if (!allowedRoot) return { ok: false, reason: "allowed_root_not_configured" };
  let real: string;
  try {
    real = realpathSync(resolvePath(requested));
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, reason: `resolve_failed:${code ?? (e as Error).message}` };
  }
  const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : allowedRoot + sep;
  if (real !== allowedRoot && !real.startsWith(rootWithSep)) {
    return { ok: false, reason: `outside_allowed_root:${allowedRoot}` };
  }
  try {
    const st = statSync(real);
    if (!st.isFile()) return { ok: false, reason: "not_regular_file" };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, reason: `stat_failed:${code ?? (e as Error).message}` };
  }
  return { ok: true, realPath: real };
}

export interface ToolAuditLine {
  ts: string;
  tool: string;
  params: Record<string, unknown>;
  denied: boolean;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
}

/** Pi 工具返回的统一形状(details 形状固定,避免联合类型分歧)。 */
interface RelayToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    denied: boolean;
    reason?: string;
    resolvedPath?: string;
    exitCode?: number | null;
  };
}

/** 审计落盘;审计失败不得影响拒绝语义(拒绝优先,尽力留痕)。 */
export function appendToolAudit(auditPath: string | null, line: ToolAuditLine): void {
  if (!auditPath) return;
  try {
    mkdirSync(resolvePath(auditPath, ".."), { recursive: true });
    appendFileSync(auditPath, JSON.stringify(line) + "\n");
  } catch {
    /* 尽力而为:审计不可写不改变拒绝结果,测试环境不应出现 */
  }
}

const EXEC_DEFAULT_TIMEOUT_MS = 10_000;
const EXEC_MAX_OUTPUT = 64 * 1024;

/** relay_exec 的环境面:白名单透传,显式排除凭据类变量(docker 层已隔离,此处纵深)。 */
export function scrubExecEnv(passThrough: Record<string, string | undefined>): Record<string, string> {
  const allow = ["PATH", "HOME", "TERM", "NO_COLOR", "LANG", "LC_ALL"];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = passThrough[k];
    if (typeof v === "string") env[k] = v;
  }
  for (const k of Object.keys(passThrough)) {
    if (/^(SSH_AUTH_SOCK|SSH_AGENT|DOCKER|GH_|GITHUB|AWS_|GIT_)/.test(k)) delete env[k];
  }
  return env;
}

export interface ExecOutcome {
  denied: boolean;
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * P0-01C C-1:relay_exec 最小命令能力(按任务授权,V02 段语义的命令版)。
 * - 空白名单 ⇒ 一律拒绝(默认拒绝;任务未授权命令能力即禁 exec);
 * - shell 控制字符全禁(; & | ` 换行 $( 等)——白名单匹配针对"单条简单命令";
 * - 匹配规则:请求命令须等于某前缀,或以"前缀+空格"开头(段边界,防 "npmx" 命中 "npm")。
 */
export function checkCommandScope(
  allowed: readonly string[] | null,
  command: string,
): { ok: boolean; reason?: string } {
  if (!allowed || allowed.length === 0) return { ok: false, reason: "exec_not_authorized" };
  if (/[;&|`\n]/.test(command)) return { ok: false, reason: "shell_metacharacters_forbidden" };
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty_command" };
  for (const raw of allowed) {
    const prefix = raw.trim();
    if (!prefix) continue;
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
      return { ok: true };
    }
  }
  return { ok: false, reason: `command_not_allowed:${trimmed.split(/\s+/)[0]}` };
}

/** 执行 relay_exec(独立函数便于测试;扩展注册处只做参数搬运)。 */
export function runScopedExec(
  opts: { cwd: string; command: string; timeoutMs?: number; env?: Record<string, string> },
): ExecOutcome {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
  try {
    const stdout = execFileSync("/bin/sh", ["-c", opts.command], {
      cwd: opts.cwd,
      env: opts.env ?? scrubExecEnv(process.env as Record<string, string>),
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_OUTPUT,
      encoding: "utf8",
    });
    return { denied: false, exitCode: 0, stdout: stdout.slice(0, EXEC_MAX_OUTPUT), stderr: "", durationMs: Date.now() - t0 };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return {
      denied: false,
      exitCode: err.status ?? null,
      stdout: (err.stdout ?? "").slice(0, EXEC_MAX_OUTPUT),
      stderr: (err.stderr ?? err.message ?? "").slice(0, EXEC_MAX_OUTPUT),
      durationMs: Date.now() - t0,
    };
  }
}

/** Pi 扩展注册入口(--extension 本文件)。配置全部来自环境,不读共享状态。 */
export default function registerRelayTools(pi: ExtensionAPI) {
  const allowedRootRaw = process.env.RELAY_ALLOWED_ROOT ?? null;
  let allowedRoot: string | null = null;
  if (allowedRootRaw) {
    try {
      allowedRoot = realpathSync(allowedRootRaw);
    } catch {
      allowedRoot = null; // root 本身不可解析 ⇒ 全拒(default deny)
    }
  }
  const auditPath = process.env.RELAY_TOOL_AUDIT ?? null;
  const execTimeoutMs = Number(process.env.RELAY_EXEC_TIMEOUT_MS ?? "") || EXEC_DEFAULT_TIMEOUT_MS;
  // 命令白名单(JSON 数组,来自 task.allowed_commands);缺省/空 = 禁 exec
  let allowedCommands: string[] | null = null;
  if (process.env.RELAY_ALLOWED_COMMANDS) {
    try {
      const parsed = JSON.parse(process.env.RELAY_ALLOWED_COMMANDS) as unknown;
      allowedCommands = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      allowedCommands = []; // 配置损坏 ⇒ 全拒(FAIL-CLOSED)
    }
  }

  const audit = (line: ToolAuditLine) => appendToolAudit(auditPath, line);

  pi.registerTool({
    name: "relay_read",
    label: "Relay Scoped Read",
    description:
      "Read a regular file inside the Relay-allowed workspace root. Paths outside the root are DENIED and audited.",
    parameters: Type.Object({ path: Type.String({ description: "File path to read" }) }),
    execute: async (_id, params): Promise<RelayToolResult> => {
      const decision = checkReadScope(allowedRoot, params.path);
      audit({ ts: new Date().toISOString(), tool: "relay_read", params: { path: params.path }, denied: !decision.ok, reason: decision.reason });
      if (!decision.ok) {
        return {
          content: [{ type: "text", text: `DENIED: ${decision.reason}` }],
          details: { denied: true, reason: decision.reason },
        };
      }
      const text = readFileSync(decision.realPath!, "utf8");
      return {
        content: [{ type: "text", text: text.slice(0, 20_000) }],
        details: { denied: false, resolvedPath: decision.realPath },
      };
    },
  });

  pi.registerTool({
    name: "relay_exec",
    label: "Relay Scoped Exec",
    description:
      "Run a shell command with cwd pinned to the Relay workspace, scrubbed environment and a hard timeout. Output is truncated.",
    parameters: Type.Object({ command: Type.String({ description: "Shell command to run" }) }),
    execute: async (_id, params): Promise<RelayToolResult> => {
      if (!allowedRoot) {
        audit({ ts: new Date().toISOString(), tool: "relay_exec", params: { command: params.command }, denied: true, reason: "allowed_root_not_configured" });
        return {
          content: [{ type: "text", text: "DENIED: allowed_root_not_configured" }],
          details: { denied: true, reason: "allowed_root_not_configured" },
        };
      }
      const cmdScope = checkCommandScope(allowedCommands, params.command);
      if (!cmdScope.ok) {
        audit({ ts: new Date().toISOString(), tool: "relay_exec", params: { command: params.command }, denied: true, reason: cmdScope.reason });
        return {
          content: [{ type: "text", text: `DENIED: ${cmdScope.reason}` }],
          details: { denied: true, reason: cmdScope.reason },
        };
      }
      const outcome = runScopedExec({
        cwd: allowedRoot,
        command: params.command,
        timeoutMs: execTimeoutMs,
        env: scrubExecEnv(process.env as Record<string, string>),
      });
      audit({
        ts: new Date().toISOString(),
        tool: "relay_exec",
        params: { command: params.command },
        denied: false,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      });
      return {
        content: [
          {
            type: "text",
            text: `exit=${outcome.exitCode}\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
          },
        ],
        details: { denied: false, exitCode: outcome.exitCode },
      };
    },
  });
}

// 供测试直接驱动(不经 Pi):保留 spawn 引用避免 tree-shaking 误判
void spawn;
