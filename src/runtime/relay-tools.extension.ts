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
 * - shell 控制字符与命令替换全禁(; & | ` 换行 $( ${ —— /bin/sh -c 下无任何求值逃逸面);
 * - 匹配规则:请求命令须等于某前缀,或以"前缀+空格"开头(段边界,防 "npmx" 命中 "npm")。
 */
export function checkCommandScope(
  allowed: readonly string[] | null,
  command: string,
): { ok: boolean; reason?: string } {
  if (!allowed || allowed.length === 0) return { ok: false, reason: "exec_not_authorized" };
  if (/[;&|`\n]/.test(command) || /\$[({]/.test(command)) {
    return { ok: false, reason: "shell_metacharacters_forbidden" };
  }
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

/**
 * 拒绝原因的可执行提示(P0-02B 补验发现:真实模型 E2E 因"拒绝文本不可行动"而反复试错、
 * 耗尽回合预算 —— 审计 reason 码保持稳定,提示只进模型可见文本)。
 * 语义:告诉模型**下一步该怎么做**,而不是只说"不允许"。
 */
export function execDenialHint(reason: string | undefined): string {
  if (!reason) return "";
  if (reason.startsWith("shell_metacharacters_forbidden")) {
    // 提示文本自身不得含 ASCII 禁用字符(模型可能照抄示例):禁用字符一律用文字描述(全角标点)
    return "只允许单条命令：请勿使用 shell 控制字符（分号、与号、竖线、反引号）或命令替换语法。写文件请用重定向（大于号，允许），例如 echo sum=87 > result.txt 。请勿再追加第二条命令或校验命令。";
  }
  if (reason.startsWith("command_not_allowed")) {
    return "该命令未获任务授权：只能使用任务已授权的命令（写文件通常是 echo 加重定向）。请勿改用 python3、ls、cat 等替代命令。";
  }
  if (reason === "exec_not_authorized") {
    return "任务未授权任何命令能力：若任务需要写文件，需由编排方在 allowed_commands 中授权对应命令（例如 echo）。";
  }
  if (reason === "empty_command") {
    return "命令为空：请给出单条可执行命令。";
  }
  if (reason.startsWith("outside_allowed_root")) {
    return "路径越出允许根：只能访问工作区内的文件。";
  }
  return "";
}

/** relay_read 拒绝提示(读取路径越界/解析失败的可行动说明;F-9 收敛:消除死分支)。 */
export function readDenialHint(reason: string | undefined): string {
  if (!reason) return "";
  if (reason === "allowed_root_not_configured") {
    return "工作区根未配置：无法读取任何文件（请由编排方配置 RELAY_ALLOWED_ROOT）。";
  }
  if (reason.startsWith("outside_allowed_root")) {
    return "路径越出允许根：只能读取工作区内的文件。";
  }
  if (reason.startsWith("resolve_failed:EACCES")) {
    return "无法解析该路径（权限不足）：请确认文件在工作区内且可读。请勿反复重试同一路径。";
  }
  if (reason.startsWith("resolve_failed:ENOENT")) {
    return "文件不存在：请使用变更清单中列出的确切文件名。";
  }
  if (reason === "not_regular_file") {
    return "目标不是普通文件：请读取具体文件，而非目录或链接。";
  }
  if (reason.startsWith("stat_failed:")) {
    return "无法读取该文件的状态（权限或文件类型问题）：请改读工作区内可读的具体文件。";
  }
  return "";
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
        const hint = readDenialHint(decision.reason);
        return {
          content: [{ type: "text", text: `DENIED: ${decision.reason}${hint ? `\n提示:${hint}` : ""}` }],
          details: { denied: true, reason: decision.reason, ...(hint ? { hint } : {}) },
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
      "Run a shell command with cwd pinned to the Relay workspace, scrubbed environment and a hard timeout. Output is truncated." +
      // F-9 收敛:向模型披露本任务授权的命令清单(否则"未授权"拒绝不可行动)
      (allowedCommands && allowedCommands.length > 0
        ? ` Allowed commands for this task: ${allowedCommands.join(", ")} (single command only; shell metacharacters ; & | \` and command substitution are rejected; output redirection > is allowed).`
        : " No command is authorized for this task: any relay_exec call will be DENIED."),
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
        const hint = execDenialHint(cmdScope.reason);
        return {
          // 模型可见文本带可执行提示(使其能在下一回合自我纠正,少耗回合预算);
          // details.reason 保持稳定审计码(测试与审计口径不变)。
          content: [{ type: "text", text: `DENIED: ${cmdScope.reason}${hint ? `\n提示:${hint}` : ""}` }],
          details: { denied: true, reason: cmdScope.reason, ...(hint ? { hint } : {}) },
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
