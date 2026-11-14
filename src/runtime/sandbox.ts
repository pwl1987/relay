// Run 沙箱(ADR-0003 双层边界之 OS 层 + 一次性 HOME)。
// 正式路径:docker 容器(--cap-drop ALL、非 root UID 10001、仅挂载 run 工作区 +
// 一次性 HOME + 只读 vendored node_modules;无 docker.sock/SSH agent/宿主凭据)。
// host-fallback:同 UID 直启 + 一次性 HOME + 环境清洗 —— **不是安全边界**,
// 仅用于无 docker 的测试环境,run 记录如实标注 sandbox=host-fallback。
// 模型路由事实(p0-00 §0):宿主 ufw 拒绝容器→宿主,故容器用 --network host;
// 网络隔离由 p0-00 A4a(--network none)独立证明,FS/凭据边界由本层强制。
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, chmodSync, writeFileSync, existsSync } from "node:fs";
import { markRunDir, safeRm, RUN_SENTINEL } from "./safe-rm.ts";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PiRpcSession, type PiSpawnOptions } from "./pi-rpc.ts";
import { verifyPiRuntime, type PiInstallation } from "./pi-version.ts";
import { resolveEgressScope, verifyEgressRules, type EgressStatus } from "./egress.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * 宿主 umask/ACL 可能给 node_modules 加 other-不可读(本 VM 实测 other::---),
 * 容器内 SANDBOX_UID 将无法读取挂载的 vendored 依赖。该树是本仓库 npm 管理的
 * 本地依赖(gitignore,非宿主共享服务),此处一次性放开 other 读+目录穿越
 * (o+rX,不含写);权限正常的环境为 no-op。
 */
let nmReadableDone = false;
export function ensureNodeModulesReadable(repoRoot: string): void {
  if (nmReadableDone) return;
  // 无条件幂等 chmod:P0-01C 实测 — npm install 会新增嵌套 node_modules(如 jiti),
  // 单点探测会漏;chmod -R o+rX 每进程一次,成本可接受,权限正常环境为 no-op 效果。
  const nm = join(repoRoot, "node_modules");
  if (existsSync(nm)) {
    execFileSync("chmod", ["-R", "o+rX", nm], { timeout: 120_000 });
  }
  nmReadableDone = true;
}

export const SANDBOX_IMAGE = process.env.RELAY_SANDBOX_IMAGE ?? "node:24-bookworm-slim";
/** 容器内 run 专用 UID(非 root;P0-00 A4 同款)。 */
export const SANDBOX_UID = 10001;

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** R2-REMEDIATION-01:每次补全最大输出 tokens(Pi models.json 现成字段 maxTokens 的来源;
   *  历史=无条件硬编码 8192 ⇒ GLM-5.3 真实编码输出被钳制截断(R-2 F1 零编辑根因)。
   *  缺省 DEFAULT_MAX_OUTPUT_TOKENS;超界 fail-closed(runner/discovery/reviewer 启动即拒)。 */
  maxOutputTokens?: number;
}

/** models.json maxTokens 默认值(=历史硬编码值;保持未配置行为兼容;Pi 自身缺省 16384,不采用)。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** 上下界:下限=编码可用输出下限;上限=models.json contextWindow(128000;超上下文窗口无意义)。 */
export const MIN_MAX_OUTPUT_TOKENS = 1024;
export const MAX_MAX_OUTPUT_TOKENS = 128_000;

/** 校验 maxOutputTokens(超界 fail-closed=抛错;undefined/null/空串=未配置 ⇒ 调用方取默认值)。 */
export function resolveMaxOutputTokens(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_MAX_OUTPUT_TOKENS || n > MAX_MAX_OUTPUT_TOKENS) {
    throw new Error(
      `invalid maxOutputTokens:${String(raw)}(须为 ${MIN_MAX_OUTPUT_TOKENS}~${MAX_MAX_OUTPUT_TOKENS} 的整数;fail-closed 不启动)`,
    );
  }
  return n;
}

/** 最终采用值(models.json maxTokens):配置值经校验;未配置 ⇒ DEFAULT(=8192,行为兼容)。 */
export function appliedMaxOutputTokens(model: Pick<ModelConfig, "maxOutputTokens">): number {
  return resolveMaxOutputTokens(model.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * runs.budget Evidence 两字段(READINESS-01 子包②收口:coder/reviewer/discovery 三口径单一来源)。
 * 来源语义与 resolveMaxOutputTokens 对齐:仅当存在「通过校验的配置值」时记 "config",
 * undefined/null/空串一律 "default"(与最终采用值的一致性由同一 resolve 判定保证)。
 */
export function budgetEvidence(model: Pick<ModelConfig, "maxOutputTokens">): {
  maxOutputTokens: number;
  maxOutputTokensSource: "default" | "config";
} {
  const resolved = resolveMaxOutputTokens(model.maxOutputTokens);
  return resolved === undefined
    ? { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensSource: "default" }
    : { maxOutputTokens: resolved, maxOutputTokensSource: "config" };
}

/**
 * Run 容器内 models.json 的占位 key(P0-02A C-8 密钥隔离;P0-02B G-3 后持钥面 = 宿主 0600
 * 文件只读挂载进代理容器):容器内可见面(models.json/env/argv)只出现本占位值,
 * 代理改写 Authorization 后转发上游。
 */
export const PROXY_PLACEHOLDER_APIKEY = "sk-relay-proxy-placeholder";

export interface SandboxSpec {
  mode: "docker" | "host-fallback";
  /** 一次性 run 目录:home/(Pi HOME) ws/(工作区) ext/(容器扩展挂载源) */
  runDir: string;
  homeDir: string;
  workspaceDir: string;
  extSourcePath: string; // 宿主侧扩展源(repo 内,host-fallback 直接引用)
  extMountPath: string; // 容器内扩展路径
}

const REPO_ROOT_CANDIDATE = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
})();

export const EXTENSION_SOURCE = join(REPO_ROOT_CANDIDATE, "src", "runtime", "relay-tools.extension.ts");

let dockerProbeCache: boolean | null = null;
/** docker 绝对路径(从当前进程 PATH 解析;子进程 env 收敛后 spawn 仍可定位)。 */
export const DOCKER_BIN = (() => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "docker");
    try {
      if (existsSync(p)) return p;
    } catch {
      /* 忽略不可读 PATH 项 */
    }
  }
  return "docker";
})();

export function dockerAvailable(): boolean {
  if (dockerProbeCache !== null) return dockerProbeCache;
  const r = spawnSync(DOCKER_BIN, ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  dockerProbeCache = r.status === 0;
  return dockerProbeCache;
}

/** 准备一次性 run 目录与配置文件。runDir 属调用方生命周期(cleanupSandbox 释放)。 */
export function prepareRunDirs(baseDir: string, mode: SandboxSpec["mode"], model: ModelConfig): SandboxSpec {
  const runDir = mkdtempSync(join(baseDir, "relay-run-"));
  const homeDir = join(runDir, "home");
  const workspaceDir = join(runDir, "ws");
  const extDir = join(runDir, "ext");
  // 清理安全(D4):打哨兵证明目录归属,cleanupSandbox 走 safeRm 守卫
  markRunDir(runDir, { kind: "sandbox", mode });
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(workspaceDir, ".relay"), { recursive: true });
  mkdirSync(extDir, { recursive: true });
  // 容器内 UID 10001 需要穿越 runDir 并写 HOME 与 workspace(含 .relay 审计)
  chmodSync(runDir, 0o755); // mkdtemp 默认 0700,不放开则挂载源不可穿越(实测坑)
  chmodSync(homeDir, 0o777);
  chmodSync(workspaceDir, 0o777);
  chmodSync(extDir, 0o755);
  chmodSync(join(workspaceDir, ".relay"), 0o777);
  writeFileSync(
    join(homeDir, ".pi", "agent", "models.json"),
    JSON.stringify(
      {
        providers: {
          [model.provider]: {
            api: "openai-completions",
            // 密钥隔离(P0-02A C-8):只写占位 key;真实 key 在出口代理进程,经其改写 Authorization
            apiKey: PROXY_PLACEHOLDER_APIKEY,
            baseUrl: model.baseUrl,
            models: [
              {
                id: model.model,
                name: model.model,
                // 上界常量=models.json contextWindow(ADR-0011:输出上限上界 128000 即取自此处;
                // 两处共享同一常量,避免双字面量漂移)
                contextWindow: MAX_MAX_OUTPUT_TOKENS,
                // R2-REMEDIATION-01:模型定义输出上限=可配置(Runner/Worker 透传 ModelConfig.maxOutputTokens;
                // 缺省=历史值 8192,行为兼容;超界在 resolveMaxOutputTokens fail-closed)
                maxTokens: appliedMaxOutputTokens(model),
                reasoning: true,
              },
            ],
          },
        },
      },
      null,
      1,
    ),
  );
  chmodSync(join(homeDir, ".pi", "agent", "models.json"), 0o644); // 容器内 SANDBOX_UID 可读
  // HOME 整树放开 other 读写(目录 X):.pi 子目录继承宿主 umask 会是 770,SANDBOX_UID 写不进 trust lock
  execFileSync("chmod", ["-R", "o+rwX", homeDir], { timeout: 30_000 });
  return {
    mode,
    runDir,
    homeDir,
    workspaceDir,
    extSourcePath: EXTENSION_SOURCE,
    extMountPath: mode === "docker" ? "/opt/relay/ext/relay-tools.extension.ts" : EXTENSION_SOURCE,
  };
}

export function cleanupSandbox(spec: SandboxSpec): void {
  safeRm(spec.runDir, { roots: [spec.runDir], sentinel: RUN_SENTINEL });
}

/** 容器内 workspace/audit 固定路径;host-fallback 用宿主真实路径。 */
export function sandboxPaths(spec: SandboxSpec): { workspace: string; audit: string; home: string } {
  if (spec.mode === "docker") {
    return {
      workspace: "/workspace",
      audit: "/workspace/.relay/tool-audit.jsonl",
      home: "/pihome",
    };
  }
  return {
    workspace: spec.workspaceDir,
    audit: join(spec.workspaceDir, ".relay", "tool-audit.jsonl"),
    home: spec.homeDir,
  };
}

export interface LaunchOptions {
  spec: SandboxSpec;
  pi: PiInstallation;
  model: ModelConfig;
  /** 出口约束状态(docker 分支必需;ok=false/缺失 ⇒ FAIL-CLOSED 拒启) */
  egress?: EgressStatus;
  /** relay_exec 命令白名单(来自 task.allowed_commands;缺省 = 禁 exec) */
  allowedCommands?: readonly string[];
  execTimeoutMs?: number;
  /** 测试注入口:覆盖默认 argv(stub RPC 进程)。仅供测试,正式路径禁用。 */
  argvOverride?: string[];
  envOverride?: Record<string, string>;
  onRecord?: PiSpawnOptions["onRecord"];
  /** P0-02B G-4:工作区 FS 级只读挂载(docker;Reviewer 检查候选面)。
   * 工具审计随之移出候选面(/pihome),候选工作区零写入(OS 层强制)。host-fallback 不支持,如实降级。 */
  workspaceReadOnly?: boolean;
}

/** pi 进程 argv(密钥隔离自证用导出:断言无 --api-key;launchPi 内部同源)。 */
export function buildPiArgs(model: ModelConfig, extMountPath: string): string[] {
  return [
    "--provider",
    model.provider,
    "--model",
    model.model,
    // 密钥隔离(P0-02A C-8):不再经 argv 传 key(宿主 ps 可见面,P0-01B F-7);
    // pi 从 models.json 读占位 key,出口代理改写 Authorization。
    "--mode",
    "rpc",
    "--no-session",
    "--no-builtin-tools",
    "--extension",
    extMountPath,
  ];
}

/** docker run 完整 argv(launchPi 同源;导出仅供测试断言挂载/审计面,如 G-4 只读挂载)。 */
export function buildDockerRunArgs(
  spec: SandboxSpec,
  pi: PiInstallation,
  opts: {
    piArgs: string[];
    containerCli: string;
    allowedCommands?: readonly string[];
    execTimeoutMs?: number;
    workspaceReadOnly?: boolean;
    /** Run 容器加入的 egress 网络(来自 ensureEgress 状态;缺省=env 解析作用域;RELAY-EGRESS-ISOLATION-07)。 */
    egressNetwork?: string;
  },
): string[] {
  return [
    DOCKER_BIN,
    "run",
    "--rm",
    "-i", // -i:RPC 走 stdin;无 -i 容器 stdin EOF ⇒ pi 静默退出(实测坑)
    "--name",
    basename(spec.runDir), // 可寻址:测试可对真实容器注入 docker kill(断连故障)
    "--user",
    `${SANDBOX_UID}:${SANDBOX_UID}`,
    "--cap-drop",
    "ALL",
    "--network",
    opts.egressNetwork ?? resolveEgressScope().network, // 专用 bridge + iptables 白名单(egress.ts;host 网络已于 P0-01C 废止)
    // G-4:只读面(workspaceReadOnly)时候选工作区以 :ro 挂载 —— 写/删/替换在 OS 层被拒
    "-v",
    `${spec.workspaceDir}:/workspace${opts.workspaceReadOnly ? ":ro" : ""}`,
    "-v",
    `${spec.homeDir}:/pihome`,
    "-v",
    `${spec.runDir}/ext:/opt/relay/ext:ro`,
    "-v",
    `${join(pi.repoRoot, "node_modules")}:/opt/relay/node_modules:ro`,
    "-e",
    "HOME=/pihome",
    "-e",
    "TERM=dumb",
    "-e",
    "NO_COLOR=1",
    "-e",
    `RELAY_ALLOWED_ROOT=/workspace`,
    // 工具审计是 infra 写入面:只读候选面时必须移出候选(落一次性 HOME),候选零写入
    "-e",
    `RELAY_TOOL_AUDIT=${opts.workspaceReadOnly ? "/pihome/tool-audit.jsonl" : "/workspace/.relay/tool-audit.jsonl"}`,
    "-e",
    `RELAY_EXEC_TIMEOUT_MS=${opts.execTimeoutMs ?? 10_000}`,
    "-e",
    `RELAY_ALLOWED_COMMANDS=${JSON.stringify(opts.allowedCommands ?? [])}`,
    "-w",
    "/workspace",
    SANDBOX_IMAGE,
    "node",
    opts.containerCli,
    ...opts.piArgs,
  ];
}

/** 以 ADR-0003 边界启动 Pi RPC 子进程。前置:resolveVendoredPi + verifyPiRuntime 已通过。 */
export function launchPi(opts: LaunchOptions): PiRpcSession {
  const { spec, pi, model } = opts;
  const paths = sandboxPaths(spec);
  if (spec.mode === "docker" && !dockerAvailable()) {
    throw new Error("docker unavailable:正式路径 Run 必须在容器内(ADR-0003 双层边界),不得静默降级");
  }
  const piArgs = buildPiArgs(model, spec.extMountPath);
  // 测试注入口:完整替换 argv(stub RPC 进程);正式路径必须走真实 vendored pi
  if (opts.argvOverride) {
    return PiRpcSession.spawn({
      argv: opts.argvOverride,
      cwd: spec.mode === "docker" ? paths.workspace : spec.workspaceDir,
      env: { PATH: "/usr/bin:/bin", HOME: spec.homeDir, ...(opts.envOverride ?? {}) },
      onRecord: opts.onRecord,
    });
  }
  if (spec.mode === "docker") {
    // 网络出口约束(P0-01C C-1):docker Run 必须在带白名单的专用网络上;规则缺失 ⇒ 拒启。
    // 不得以 --network host 降级(合同停止条件)。
    const eg = opts.egress;
    if (
      !eg?.ok ||
      !eg.subnet ||
      !eg.hostIp ||
      !eg.modelPort ||
      !verifyEgressRules(eg.subnet, eg.hostIp, eg.modelPort, eg)
    ) {
      throw new Error("egress_rules_missing:无人值守 Run 的网络白名单未建立/验证失败,FAIL-CLOSED 拒启");
    }
    ensureNodeModulesReadable(pi.repoRoot);
    // 启动链第三道校验(合同条款 2):真实 Pi 启动前,二进制 --version 必须等于锁定版本
    // (包声明+路径钉死已在 resolveVendoredPi;stub argvOverride 测试路径不经过此处)
    verifyPiRuntime(pi);
    // 容器扩展从 runDir/ext 挂载(walk-up 解析 typebox:/opt/relay/ext -> /opt/relay/node_modules)
    const extDest = join(spec.runDir, "ext", "relay-tools.extension.ts");
    cpSync(spec.extSourcePath, extDest);
    chmodSync(extDest, 0o644); // SANDBOX_UID 可读
    // 容器内 cli 路径 = node_modules 挂载点 + 包内相对路径(与宿主 vendored 布局同构)
    const containerCli = join(
      "/opt/relay/node_modules",
      pi.cliPath.slice(join(pi.repoRoot, "node_modules").length + 1),
    );
    const argv = buildDockerRunArgs(spec, pi, {
      piArgs,
      containerCli,
      allowedCommands: opts.allowedCommands,
      execTimeoutMs: opts.execTimeoutMs,
      workspaceReadOnly: opts.workspaceReadOnly,
      egressNetwork: opts.egress?.network,
    });
    return PiRpcSession.spawn({
      argv,
      cwd: spec.runDir, // docker client 的 cwd 必须是宿主存在的目录;容器内工作目录由 -w 指定
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", HOME: process.env.HOME ?? "" },
      onRecord: opts.onRecord,
    });
  }
  // host-fallback(测试专用):同 UID 直启 vendored cli;环境清洗 + 一次性 HOME。
  // 与容器同构的 Relay 策略环境变量;**不做** OS 隔离(合同:sandbox=host-fallback 如实标注)。
  const env: Record<string, string> = {
    HOME: spec.homeDir,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "dumb",
    NO_COLOR: "1",
    RELAY_ALLOWED_ROOT: paths.workspace,
    RELAY_TOOL_AUDIT: paths.audit,
    RELAY_EXEC_TIMEOUT_MS: String(opts.execTimeoutMs ?? 10_000),
    RELAY_ALLOWED_COMMANDS: JSON.stringify(opts.allowedCommands ?? []),
    ...(opts.envOverride ?? {}),
  };
  // docker 不传宿主环境,host-fallback 需显式保证凭据类变量不进入 Run
  for (const k of Object.keys(env)) {
    if (/^(SSH_AUTH_SOCK|DOCKER|GH_|GITHUB|AWS_)/.test(k)) delete env[k];
  }
  return PiRpcSession.spawn({
    argv: [process.execPath, pi.cliPath, ...piArgs],
    cwd: spec.workspaceDir,
    env,
    onRecord: opts.onRecord,
  });
}

export function newRunId(): string {
  return `run-${randomUUID()}`;
}
