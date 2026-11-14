// 无人值守 Run 的网络出口约束(P0-01C C-1 建立;P0-02A C-8 升级为 HTTP 反向代理)。
// 实验依据(2026-11-10 实测):
//   - bridge 容器默认可出外网(registry.npmjs.org 200)—— 出站全开,对无人值守 Run 危险;
//   - bridge 容器 → 宿主任意端口被 ufw INPUT 拦(容器子网非本机信任源);
//   - magpie 对非 loopback 源返回 401(宿主经 eth0 访问亦 401)⇒ 必须让"模型连接源"回到 loopback。
// 方案(三层,全部可幂等重建/撤除):
//   1. 专用 bridge `relay-egress-net`;
//   2. iptables:FORWARD 面 = DOCKER-USER 挂 RELAY-EGRESS 子链(源=本子网):ACCEPT→宿主代理端口,
//      其余 DROP(出站白名单);INPUT 面 = 单条 ACCEPT 子网→宿主代理端口;
//   3. **代理容器 relay-egress-fwd(--network host)**:HTTP 反向代理,监听宿主代理端口——
//      a) **密钥隔离(P0-02A C-8;P0-02B G-3 升级)**:真实 key 只存在于宿主 0600 文件(只读挂载
//         /run/relay-fwd/real-key,env/inspect 零可见);来自 Run 的
//         请求 Authorization 被改写为真实 key,Run 容器内 models.json 仅占位 key;
//      b) **请求计数(P0-02A C-9)**:http server 每收到一个请求计数 +1 并 1:1 转发上游——
//         该计数即真实 Provider 请求数(独立于 Runner 侧回合计数),经本机计数端点读取;
//      c) 模型连接源回到宿主 loopback(magpie 信任),Run 容器**只见代理端口,零直连模型**。
// 失败语义:任何一层建立/验证失败 ⇒ ensureEgress ok:false,launchPi/executeRun FAIL-CLOSED 拒启
// (不得以 --network host 降级)。规则仅作用域本子网/本端口,不改 ufw 策略。
//
// 资源归属与测试隔离(RELAY-EGRESS-ISOLATION-07;2026-11-14):
//   - 全部冲突资源(网络名/代理容器名/iptables 链名/规则标记/监听与计数端口)由唯一
//     `EgressScope` 派生:default=生产名(不变);test=createTestEgressScope/RELAY_EGRESS_SCOPE_PREFIX
//     (完整独立命名空间,含端口 —— 仅改 RELAY_EGRESS_NETWORK 不是隔离机制)。
//   - 归属标签 `relay.egress.owner`:容器/网络创建时打标;iptables 注释携带 `<ruleTag> owner=<owner>`。
//     匿名(无标签)同名资源一律拒绝复用/覆盖/删除(fail-closed;Runbook 核验归属后处置)。
//   - ensureEgress 对**已健康且配置相同**的代理复用(不再每次 rm -f 重建 ⇒ 在途请求不被切断);
//     **真死(exited/dead)且 owner===本执行者** 才有界恢复重建;运行中但配置不符(含密钥挂载面)⇒
//     拒绝不恢复(fail-closed;密钥挂载只能"复用时保持/升级",不得降级);他人持有一律拒绝。
//   - teardownEgress 仅删除**本执行者创建且仍持有**的资源(进程内创建注册表 ∪ owner 标签匹配),
//     返回可审计报告(deleted/skipped 逐项含原因);网络归属不成立时零 iptables 操作。
//     链 -F/-X 另需本进程注册表锚:owner 继承的子进程 teardown 会删容器/规则/网络但保留链
//     (skipped 如实报告),零残留须由原始创建者完成(Minor-2 登记语义;同前缀家族链不误清)。
//   - 本进程创建注册表(owned)只证明"本进程创建过";跨进程持有以 owner 标签为准。
//   - create 冲突收敛要求对手容器 owner===本家族(Minor-1 登记语义):跨 owner 并发冷启动窄窗口
//     下 fail-closed 拒绝而非复用(保守面;后续进程可正常复用)。
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DOCKER_BIN, dockerAvailable, SANDBOX_IMAGE } from "./sandbox.ts";

export const EGRESS_NETWORK = process.env.RELAY_EGRESS_NETWORK ?? "relay-egress-net";
export const EGRESS_FORWARD_PORT = Number(process.env.RELAY_EGRESS_FORWARD_PORT ?? "13425");
export const EGRESS_COUNT_PORT = Number(process.env.RELAY_EGRESS_COUNT_PORT ?? "13426");
/** 生产默认固定名(合同:保持原生产出口默认名称/端口/现有安全边界不变)。 */
const DEFAULT_FWD_CONTAINER = "relay-egress-fwd";
const DEFAULT_RULE_TAG = "relay-p01c-egress";
const DEFAULT_CHAIN = "RELAY-EGRESS";
/** docker/网络归属标签键(仅本文件创建的资源会携带 ⇒ 匿名=非本机制创建)。 */
const OWNER_LABEL = "relay.egress.owner";

// ===================== 作用域(EgressScope)与归属 =====================

/** 一组完全独立的 egress 资源命名空间(default=生产固定名;test=全派生,含端口)。 */
export interface EgressScope {
  kind: "default" | "test";
  /** 命名空间前缀(default="relay-p01c-egress";test="relay-test-<id>")。 */
  prefix: string;
  network: string;
  fwdContainer: string;
  /** iptables 自定义链名(≤28 字符)。 */
  chain: string;
  /** iptables 注释标记(测试作用域独有 ⇒ 规则面天然隔离)。 */
  ruleTag: string;
  /** 代理监听端口(Run 容器模型端口)。 */
  forwardPort: number;
  /** 请求计数端点端口(仅宿主可达)。 */
  countPort: number;
  /** 归属 token(env RELAY_EGRESS_OWNER 可继承给子进程;否则进程级随机)。 */
  owner: string;
}

/** 进程级 owner token(惰性稳定;env 显式继承优先 —— 供测试 harness 与子进程/worker 收敛)。 */
let cachedOwner: string | null = null;
function ownerToken(): string {
  if (process.env.RELAY_EGRESS_OWNER) return process.env.RELAY_EGRESS_OWNER;
  if (cachedOwner === null) {
    cachedOwner = `p${process.pid}-${randomUUID().slice(0, 8)}`;
  }
  return cachedOwner;
}

function hash8(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(-8);
}

/** 前缀 → 端口确定性派生(20000..39999,避开生产默认 13425/13426;同前缀跨进程一致)。 */
function scopePorts(prefix: string): { forwardPort: number; countPort: number } {
  let h = 0;
  for (const c of prefix) h = ((h * 31 + c.charCodeAt(0)) >>> 0) % 1_000_000_007;
  let forward = 20000 + (h % 20000);
  if (forward === EGRESS_FORWARD_PORT || forward === EGRESS_COUNT_PORT || forward + 1 === EGRESS_COUNT_PORT)
    forward += 2;
  return { forwardPort: forward, countPort: forward + 1 };
}

function chainNameFor(id: string): string {
  const base = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
  // iptables 链名上限 28 字符:"RELAY-EGRESS-" + 最多 8 字符
  return `RELAY-EGRESS-${base.length > 0 && base.length <= 8 ? base : hash8(id)}`;
}

/**
 * 从进程 env 解析作用域(RELAY_EGRESS_SCOPE_PREFIX=测试独立命名空间前缀;
 * 配套 RELAY_EGRESS_FORWARD_PORT/COUNT_PORT/RELAY_EGRESS_OWNER 可显式继承给子进程)。
 * 仅设 RELAY_EGRESS_NETWORK **不**构成测试隔离 —— 那只是 default 域的网络名配置面。
 */
export function resolveEgressScope(): EgressScope {
  const prefix = process.env.RELAY_EGRESS_SCOPE_PREFIX;
  if (prefix) {
    const id = prefix.startsWith("relay-test-") ? prefix.slice("relay-test-".length) : hash8(prefix);
    const derived = scopePorts(prefix);
    return {
      kind: "test",
      prefix,
      network: `${prefix}-net`,
      fwdContainer: `${prefix}-fwd`,
      chain: chainNameFor(id),
      ruleTag: prefix,
      forwardPort: Number(process.env.RELAY_EGRESS_FORWARD_PORT ?? derived.forwardPort),
      countPort: Number(process.env.RELAY_EGRESS_COUNT_PORT ?? derived.countPort),
      owner: ownerToken(),
    };
  }
  return {
    kind: "default",
    prefix: DEFAULT_RULE_TAG,
    network: EGRESS_NETWORK,
    fwdContainer: DEFAULT_FWD_CONTAINER,
    chain: DEFAULT_CHAIN,
    ruleTag: DEFAULT_RULE_TAG,
    forwardPort: EGRESS_FORWARD_PORT,
    countPort: EGRESS_COUNT_PORT,
    owner: ownerToken(),
  };
}

/** 测试专用:生成完整独立命名空间(网络/容器/链/标记/端口全派生;同 id 确定性,便于跨进程继承)。 */
export function createTestEgressScope(id?: string): EgressScope {
  const rid = (id ?? randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, "");
  const prefix = `relay-test-${rid}`;
  const ports = scopePorts(prefix);
  return {
    kind: "test",
    prefix,
    network: `${prefix}-net`,
    fwdContainer: `${prefix}-fwd`,
    chain: chainNameFor(rid),
    ruleTag: prefix,
    forwardPort: ports.forwardPort,
    countPort: ports.countPort,
    owner: ownerToken(),
  };
}

/** 本进程创建注册表:teardown 授权的"本次创建"证据("net:x"/"chain:x"/"ctr:x")。 */
const owned = new Set<string>();

export interface EgressStatus {
  ok: boolean;
  network: string;
  subnet?: string;
  hostIp?: string;
  /** Run 容器应使用的模型端口(= 代理端口) */
  modelPort?: number;
  /** 代理背后真正的模型端口(宿主 loopback 侧) */
  originPort?: number;
  /** 密钥改写是否启用(代理持真实 key) */
  keyIsolation?: boolean;
  reason?: string;
  verification?: { modelReachable: boolean; externalBlocked: boolean };
  /** 本状态对应的作用域事实(verify/清理/审计按此对齐;RELAY-EGRESS-ISOLATION-07) */
  chain?: string;
  ruleTag?: string;
  fwdContainer?: string;
  countPort?: number;
  owner?: string;
  /** 复用了已健康且配置相同的既有代理(未重建 ⇒ 在途请求未中断) */
  reused?: boolean;
  /** 本执行者持有的不健康/配置不符代理被有界恢复重建 */
  recovered?: boolean;
}

// stdio 显式 pipe:本 Node 的 execFileSync 会把子进程 stderr 透传父进程 stderr(实测),
// 失败路径(如首建时容器/规则不存在)的 daemon 报错是预期被吞的,不应污染证据日志。
function ipt(args: string[], timeoutMs = 15_000): string {
  return execFileSync("sudo", ["-n", "iptables", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync(DOCKER_BIN, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
}

/** 宿主出口 IP(容器侧以该 IP 访问宿主服务;不走 127.0.0.1——那是容器自身)。 */
export function detectHostIp(): string {
  const out = execFileSync("ip", ["-4", "route", "get", "1.2.3.4"], { encoding: "utf8" });
  const m = out.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
  if (!m) throw new Error("host ip detect failed: ip route get 无 src");
  return m[1]!;
}

/** 容器内模型 baseUrl 重写:localhost/127.0.0.1 → 宿主出口 IP:代理端口(模型连接源回到宿主 loopback)。 */
export function rewriteBaseUrlForContainer(baseUrl: string, eg: EgressStatus): string {
  return baseUrl
    .replace(/\/\/127\.0\.0\.1:(\d+)/, `//${eg.hostIp}:${eg.modelPort}`)
    .replace(/\/\/localhost:(\d+)/, `//${eg.hostIp}:${eg.modelPort}`)
    .replace(/\/\/127\.0\.0\.1\//, `//${eg.hostIp}:${eg.modelPort}/`)
    .replace(/\/\/localhost\//, `//${eg.hostIp}:${eg.modelPort}/`);
}

export function parseModelPort(baseUrl: string): number {
  const m = baseUrl.match(/:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : baseUrl.startsWith("https") ? 443 : 80;
}

function networkExists(name: string): boolean {
  try {
    docker(["network", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

/** 网络归属标签(不存在 ⇒ null;匿名 ⇒ "";有标签 ⇒ owner 值)。 */
function networkOwner(name: string): string | null {
  try {
    return docker(["network", "inspect", "-f", `{{index .Labels "${OWNER_LABEL}"}}`, name]).trim();
  } catch {
    return null;
  }
}

interface FwdInfo {
  running: boolean;
  status: string;
  owner: string;
  env: Record<string, string>;
  hasKeyMount: boolean;
}

/** 代理容器事实(一次 inspect:Running|owner标签|env|挂载面;不存在 ⇒ null)。 */
function fwdContainerInfo(name: string): FwdInfo | null {
  try {
    const raw = docker([
      "inspect",
      "-f",
      `{{.State.Running}}|{{.State.Status}}|{{index .Config.Labels "${OWNER_LABEL}"}}|{{range .Config.Env}}{{.}},{{end}}|{{range .Mounts}}{{.Destination}},{{end}}`,
      name,
    ]).trim();
    const [running, status, owner, envRaw, mountsRaw] = raw.split("|");
    const env: Record<string, string> = {};
    for (const kv of (envRaw ?? "").split(",")) {
      if (!kv) continue;
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return {
      running: running === "true",
      // docker run -d 的 create→start 间隙 status="created"(对手创建中,不得误杀);真死=exited/dead
      status: status ?? "",
      owner: owner ?? "",
      env,
      hasKeyMount: (mountsRaw ?? "").includes("/run/relay-fwd/real-key"),
    };
  } catch {
    return null;
  }
}

function chainRules(chain: string): string[] {
  try {
    return ipt(["-S", chain])
      .split("\n")
      .filter((l) => l.trim());
  } catch {
    return [];
  }
}

function jumpExists(subnet: string, chain: string, ruleTag: string): boolean {
  try {
    return ipt(["-S", "DOCKER-USER"])
      .split("\n")
      .some((l) => l.includes(`-s ${subnet}`) && l.includes(`-j ${chain}`) && l.includes(ruleTag));
  } catch {
    return false;
  }
}

function inputRuleExists(hostIp: string, port: number, subnet: string, ruleTag: string): boolean {
  try {
    return ipt(["-S", "INPUT"])
      .split("\n")
      .some(
        (l) =>
          l.includes(`-s ${subnet}`) &&
          l.includes(`-d ${hostIp}`) &&
          l.includes(`--dport ${port}`) &&
          l.includes(ruleTag),
      );
  } catch {
    return false;
  }
}

// HTTP 反向代理(P0-02A C-8/C-9;P0-02B G-3 持钥 0600 化):密钥改写 + 1:1 请求转发计数 + 本机计数端点。
// 计数语义:http server 每收到一个请求即 +1 且恰好转发一次上游 —— 该数即真实 Provider 请求数。
// G-3:真实 key 不再经 docker 环境变量注入(docker inspect 可见)——宿主 0600 文件只读挂载,
// 代理进程启动时读一次;inspect 可见面/env 全程零 key。
const FWD_SCRIPT = `
const http = require("http");
const fs = require("fs");
const ORIGIN_PORT = Number(process.env.FWD_ORIGIN_PORT ?? "3425");
const LISTEN_PORT = Number(process.env.FWD_LISTEN_PORT ?? "13425");
const COUNT_PORT = Number(process.env.FWD_COUNT_PORT ?? "13426");
let REAL_KEY = "";
try { REAL_KEY = fs.readFileSync("/run/relay-fwd/real-key", "utf8").trim(); } catch {}
let requests = 0;
let completions = 0;
let connections = 0;
const proxy = http.createServer((creq, cres) => {
  requests += 1;
  if (creq.method === "POST" && (creq.url ?? "").includes("completions")) completions += 1;
  const headers = { ...creq.headers };
  delete headers["connection"];
  delete headers["host"];
  delete headers["content-length"];
  if (REAL_KEY) headers["authorization"] = "Bearer " + REAL_KEY;
  const up = http.request(
    { host: "127.0.0.1", port: ORIGIN_PORT, path: creq.url, method: creq.method, headers },
    (ures) => {
      const h = { ...ures.headers };
      delete h["content-length"];
      delete h["transfer-encoding"];
      cres.writeHead(ures.statusCode ?? 502, h);
      ures.pipe(cres);
      ures.on("error", () => cres.destroy());
    },
  );
  creq.pipe(up);
  creq.on("error", () => up.destroy());
  up.on("error", () => {
    if (!cres.headersSent) cres.writeHead(502, { "content-type": "application/json" });
    cres.end(JSON.stringify({ error: "upstream_unreachable" }));
  });
});
proxy.on("connection", () => { connections += 1; });
proxy.listen(LISTEN_PORT, "0.0.0.0", () => console.log("relay-egress-proxy up"));
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ requests, completions, connections, pid: process.pid }));
}).listen(COUNT_PORT, "127.0.0.1", () => console.log("count endpoint up"));
`;

/** 计数端点单次探针(HTTP 200 = http 层已起;比 TCP 探测更诚实)。 */
function probeCountEndpoint(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end(); // 缺 end 则请求头永不发出:服务端等请求、客户端等响应,双向死等(实测坑)
  });
}

/** 代理就绪等待:计数端点 HTTP 200(有界重试)。 */
function waitForwarderReady(timeoutMs = 15_000, port = EGRESS_COUNT_PORT): Promise<boolean> {
  const t0 = Date.now();
  const attempt = (): Promise<boolean> =>
    probeCountEndpoint(port).then((ok) => {
      if (ok) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      return new Promise<boolean>((r) => setTimeout(() => attempt().then(r), 300));
    });
  return attempt();
}

/**
 * 等待既有代理容器进入健康态(有界;状态感知)。
 * created(对手/前进程创建中)与 running-but-warming 都只等待、绝不 rm —— 防止互相误杀;
 * exited/dead(真死)立即返回,由调用方决定恢复(本家族)或拒绝(他人)。
 */
async function waitForFwdHealthy(
  scope: EgressScope,
  timeoutMs: number,
): Promise<{ healthy: boolean; info: FwdInfo | null }> {
  const deadline = Date.now() + timeoutMs;
  let info = fwdContainerInfo(scope.fwdContainer);
  for (;;) {
    if (info === null || info.status === "exited" || info.status === "dead") return { healthy: false, info };
    if (info.running && (await probeCountEndpoint(scope.countPort))) return { healthy: true, info };
    if (Date.now() >= deadline) return { healthy: false, info };
    await new Promise((r) => setTimeout(r, 300));
    info = fwdContainerInfo(scope.fwdContainer);
  }
}

function forwarderUp(container: string): boolean {
  try {
    const state = docker(["inspect", "-f", "{{.State.Running}}", container]).trim();
    return state === "true";
  } catch {
    return false;
  }
}

/** 读取代理层请求计数(独立于 Runner 回合计数的 Provider 请求数;仅宿主可达)。 */
export function readEgressRequestCount(
  timeoutMs = 3000,
  port = EGRESS_COUNT_PORT,
): Promise<{ requests: number; completions: number; connections: number } | null> {
  return new Promise((resolve) => {
    // agent:false:一次性连接 —— 全局 agent 的 keep-alive 复用会与服务端 keepAliveTimeout
    // 相撞(socket hang up 竞态);诊断端点每次新建连接,确定性优先。
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { requests: number; completions: number; connections: number };
          resolve({
            requests: Number(j.requests),
            completions: Number(j.completions ?? 0),
            connections: Number(j.connections),
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      console.error("[egress-debug] count timeout");
      req.destroy();
      resolve(null);
    });
    req.end(); // 同 waitForwarderReady:缺 end 双向死等
  });
}

/** 宿主持钥文件要求:存在、常规文件、0600(G-3;调用方在 ensureEgress 前自证)。 */
export function realKeyFileValid(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

/** iptables 注释标记(含归属;删除面按 `<ruleTag> owner=` 精确匹配防前缀串扰)。 */
function commentTag(scope: EgressScope): string {
  return `${scope.ruleTag} owner=${scope.owner}`;
}

function runFwdContainer(scope: EgressScope, originPort: number, realKeyFile: string | undefined): void {
  const envArgs = [
    "-e",
    `FWD_ORIGIN_PORT=${originPort}`,
    "-e",
    `FWD_LISTEN_PORT=${scope.forwardPort}`,
    "-e",
    `FWD_COUNT_PORT=${scope.countPort}`,
  ];
  const mountArgs: string[] = [];
  if (realKeyFile !== undefined) {
    mountArgs.push("-v", `${realKeyFile}:/run/relay-fwd/real-key:ro`);
  }
  docker([
    "run",
    "-d",
    "--name",
    scope.fwdContainer,
    "--network",
    "host",
    "--restart",
    "unless-stopped",
    "--label",
    `${OWNER_LABEL}=${scope.owner}`,
    ...envArgs,
    ...mountArgs,
    SANDBOX_IMAGE,
    "node",
    "-e",
    FWD_SCRIPT,
  ]);
  owned.add(`ctr:${scope.fwdContainer}`);
}

/**
 * 幂等建立出口约束(网络 + 作用域链 + DOCKER-USER 挂载 + INPUT 放行 + 代理容器)。
 * opts.realKeyFile:宿主 0600 持钥文件路径(G-3:只读挂载进代理容器,env/inspect 零可见;
 * Run 容器/argv/models.json 永不见真值)。缺省 = 透传模式(假密钥本地路由,机制仍计数)。
 * 归属语义(RELAY-EGRESS-ISOLATION-07):
 *   - 已健康且配置相同的代理 ⇒ 复用(reused:true),不 rm 不重建(在途请求不中断);
 *   - 匿名(无归属标签)同名资源 ⇒ 拒绝(零副作用,不覆盖不删除);
 *   - 不健康/配置不符 ⇒ 仅 owner===本执行者时有界恢复重建(recovered:true),他人持有拒绝;
 *   - 期望密钥隔离而既有代理无挂载 ⇒ 拒绝(隔离只能保持/升级,不得静默降级)。
 * 失败即返回 ok:false(调用方 FAIL-CLOSED),拒绝路径零副作用。
 */
export async function ensureEgress(
  modelBaseUrl: string,
  opts: { realKeyFile?: string; scope?: EgressScope } = {},
): Promise<EgressStatus> {
  const scope = opts.scope ?? resolveEgressScope();
  const originPort = parseModelPort(modelBaseUrl);
  const scopeFields = {
    network: scope.network,
    modelPort: scope.forwardPort,
    originPort,
    chain: scope.chain,
    ruleTag: scope.ruleTag,
    fwdContainer: scope.fwdContainer,
    countPort: scope.countPort,
    owner: scope.owner,
  };
  if (!dockerAvailable()) return { ok: false, ...scopeFields, reason: "docker_unavailable" };
  const hostIp = detectHostIp();
  try {
    // ⓪ 代理容器处置预判(拒绝路径零副作用:先于任何网络/规则写操作)
    //    create=不存在;reuse=健康且配置相同(无论 owner 家族谁建;不 rm 不重建);
    //    recover=仅本执行者持有的不健康/配置不符 ⇒ 有界恢复;其余(匿名/他人不健康或不符)⇒ 拒绝。
    const fwdConfigOk = (info: NonNullable<ReturnType<typeof fwdContainerInfo>>) =>
      info.env["FWD_ORIGIN_PORT"] === String(originPort) &&
      info.env["FWD_LISTEN_PORT"] === String(scope.forwardPort) &&
      info.env["FWD_COUNT_PORT"] === String(scope.countPort) &&
      (opts.realKeyFile === undefined || info.hasKeyMount); // 复用可保持/升级隔离,不得降级
    const fwd = fwdContainerInfo(scope.fwdContainer);
    let disposition: "create" | "reuse" | "recover";
    if (fwd === null) {
      disposition = "create";
    } else if (!fwd.owner) {
      return {
        ok: false,
        ...scopeFields,
        hostIp,
        reason: `fwd_container_unowned:同名代理容器无 ${OWNER_LABEL} 归属标签(匿名;拒绝接管/覆盖/删除;Runbook 核验归属后处置)`,
      };
    } else if (fwd.status === "exited" || fwd.status === "dead") {
      // 真死容器:仅本家族可恢复;他人持有 ⇒ 拒绝(零删除)
      if (fwd.owner !== scope.owner) {
        return {
          ok: false,
          ...scopeFields,
          hostIp,
          reason: `fwd_container_foreign_or_stale:代理容器(owner=${fwd.owner})已退出且非本执行者持有 ⇒ 拒绝覆盖删除(持有者或运维处置)`,
        };
      }
      disposition = "recover";
    } else {
      // created/running(可能是并发对手创建中)⇒ 有界等健康;健康即复用(不 rm 不重建)
      const { healthy, info: latest } = await waitForFwdHealthy(scope, 15_000);
      if (healthy && latest !== null && fwdConfigOk(latest)) {
        disposition = "reuse";
      } else if (
        latest !== null &&
        (latest.status === "exited" || latest.status === "dead") &&
        latest.owner === scope.owner
      ) {
        disposition = "recover"; // 等待期间真死 ⇒ 本家族可恢复
      } else {
        return {
          ok: false,
          ...scopeFields,
          hostIp,
          reason: `fwd_container_foreign_or_stale:代理容器(owner=${fwd.owner},status=${latest?.status ?? fwd.status})未在有界窗口内健康且配置相同(configOk=${latest ? fwdConfigOk(latest) : "?"})⇒ 拒绝覆盖删除(可能为并发对手创建中;持有者或运维处置)`,
        };
      }
    }

    // ① 网络:归属校验 → 创建/复用(并发对手已建且带家族标签 ⇒ 收敛复用)
    let subnet: string;
    const netOwner = networkOwner(scope.network);
    if (netOwner === null) {
      try {
        docker(["network", "create", "--label", `${OWNER_LABEL}=${scope.owner}`, scope.network]);
        owned.add(`net:${scope.network}`);
      } catch (e) {
        // 并发竞态:对手进程刚创建(有短暂可视性滞后)⇒ 有界重试归属核验后收敛复用;匿名/超时 ⇒ 原样失败
        let owner: string | null = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          owner = networkOwner(scope.network);
          if (owner !== null) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (owner === null) throw e;
        if (!owner) {
          return {
            ok: false,
            ...scopeFields,
            hostIp,
            reason: `egress_network_unowned:同名网络并发创建竞态且无 ${OWNER_LABEL} 归属标签(匿名;拒绝复用;Runbook 核验归属后处置)`,
          };
        }
        // 家族标签 ⇒ 复用(继续)
      }
    } else if (!netOwner) {
      return {
        ok: false,
        ...scopeFields,
        hostIp,
        reason: `egress_network_unowned:同名网络存在但无 ${OWNER_LABEL} 归属标签(匿名;拒绝在其子网写白名单/复用;Runbook 核验归属后处置)`,
      };
    }
    subnet = docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", scope.network]).trim();
    if (!subnet) return { ok: false, ...scopeFields, hostIp, reason: "subnet_undetectable" };

    // ② 作用域链 + 规则(幂等:规则已齐 ⇒ 不清链不重写,避免白名单空窗)
    let createdChain = false;
    try {
      ipt(["-N", scope.chain]);
      createdChain = true;
    } catch {
      /* 已存在(家族/前进程/并发对手) */
    }
    if (createdChain) owned.add(`chain:${scope.chain}`);
    else if (owned.has(`net:${scope.network}`) || networkOwner(scope.network) === scope.owner) {
      // 并发对手建的链:网络归属成立 ⇒ 视为本家族资源(注册),teardown 可回收
      owned.add(`chain:${scope.chain}`);
    }
    const rules = chainRules(scope.chain);
    const hasAccept = rules.some(
      (l) => l.includes("-j ACCEPT") && l.includes(`--dport ${scope.forwardPort}`) && l.includes(scope.ruleTag),
    );
    const hasDrop = rules.some((l) => l.includes("-j DROP") && l.includes(scope.ruleTag));
    if (!hasAccept || !hasDrop) {
      ipt(["-F", scope.chain]);
      ipt([
        "-A",
        scope.chain,
        "-p",
        "tcp",
        "-d",
        hostIp,
        "--dport",
        String(scope.forwardPort),
        "-j",
        "ACCEPT",
        "-m",
        "comment",
        "--comment",
        commentTag(scope),
      ]);
      ipt(["-A", scope.chain, "-j", "DROP", "-m", "comment", "--comment", commentTag(scope)]);
    }
    if (!jumpExists(subnet, scope.chain, scope.ruleTag)) {
      ipt(["-I", "DOCKER-USER", "1", "-s", subnet, "-j", scope.chain, "-m", "comment", "--comment", commentTag(scope)]);
    }
    if (!inputRuleExists(hostIp, scope.forwardPort, subnet, scope.ruleTag)) {
      ipt([
        "-I",
        "INPUT",
        "1",
        "-p",
        "tcp",
        "-s",
        subnet,
        "-d",
        hostIp,
        "--dport",
        String(scope.forwardPort),
        "-j",
        "ACCEPT",
        "-m",
        "comment",
        "--comment",
        commentTag(scope),
      ]);
    }

    // ③ 代理容器:按预判处置(create 含并发对手刚建的收敛核验)
    let reused = false;
    let recovered = false;
    if (disposition === "create") {
      try {
        runFwdContainer(scope, originPort, opts.realKeyFile);
      } catch (e) {
        // 并发竞态:对手进程刚建同名容器(有短暂可视性滞后)⇒ 有界重试后核验归属(本家族),通过则状态感知收敛
        let info = fwdContainerInfo(scope.fwdContainer);
        const deadline = Date.now() + 5000;
        while (info === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
          info = fwdContainerInfo(scope.fwdContainer);
        }
        if (info === null || !info.owner || info.owner !== scope.owner) {
          throw new Error(
            `create_conflict_converge_rejected:对手容器非本家族(info=${info ? JSON.stringify({ owner: info.owner, status: info.status }) : "null"} scopeOwner=${scope.owner}):${(e as Error).message.slice(0, 200)}`,
          );
        }
        if (info.status === "exited" || info.status === "dead") {
          // 对手容器真死 ⇒ 本家族有界恢复(rm+重建;与 ⓪ recover 同语义,报告 recovered)
          try {
            docker(["rm", "-f", scope.fwdContainer]);
          } catch {
            /* 已不在 */
          }
          runFwdContainer(scope, originPort, opts.realKeyFile);
          recovered = true;
        } else {
          // created/running(in-flight 对手)⇒ 只等健康复用,绝不 rm(防互相误杀);超时 ⇒ fail-closed
          const { healthy, info: latest } = await waitForFwdHealthy(scope, 20_000);
          if (healthy && latest !== null && fwdConfigOk(latest)) {
            reused = true;
          } else {
            throw new Error(
              `create_conflict_converge_unhealthy:对手容器(status=${latest?.status ?? "?"})未在有界窗口内健康(configOk=${latest ? fwdConfigOk(latest) : "?"})⇒ fail-closed(不 rm in-flight 对手)`,
            );
          }
        }
      }
    } else if (disposition === "reuse") {
      reused = true; // 健康且同配置(含他人家族栈):只复用,不动容器 ⇒ 在途请求不中断
    } else {
      // recover:本执行者持有的不健康/配置不符代理 ⇒ 有界恢复(可解释、审计面 recovered)
      try {
        docker(["rm", "-f", scope.fwdContainer]);
      } catch {
        /* 已不在 */
      }
      runFwdContainer(scope, originPort, opts.realKeyFile);
      recovered = true;
    }

    const rulesNow = chainRules(scope.chain);
    if (rulesNow.length < 2 || !forwarderUp(scope.fwdContainer)) {
      let dbg = "";
      try {
        dbg = docker(["logs", "--tail", "3", scope.fwdContainer]).slice(0, 200);
      } catch {
        /* 日志尽力 */
      }
      return {
        ok: false,
        ...scopeFields,
        hostIp,
        reason: `rules_or_forwarder_incomplete(rules=${rulesNow.length} fwdUp=${forwarderUp(scope.fwdContainer)} logs=${dbg})`,
      };
    }
    const fwdReady = await waitForwarderReady(15_000, scope.countPort);
    if (!fwdReady) {
      return { ok: false, ...scopeFields, hostIp, reason: "forwarder_not_ready" };
    }
    return {
      ok: true,
      ...scopeFields,
      hostIp,
      subnet,
      keyIsolation: opts.realKeyFile !== undefined || (fwd !== null && fwd.hasKeyMount),
      reused,
      recovered,
    };
  } catch (e) {
    return { ok: false, ...scopeFields, hostIp, reason: `ensure_failed:${(e as Error).message}` };
  }
}

/** 规则存在性只读核验(launchPi/executeRun docker 分支启动前 FAIL-CLOSED 检查)。
 *  eg 传 EgressStatus/EgressScope 的 {chain,ruleTag,fwdContainer} 三件套(与 ensure 状态对齐);
 *  缺省=env 解析作用域(RELAY-EGRESS-ISOLATION-07)。 */
export function verifyEgressRules(
  subnet: string,
  hostIp: string,
  modelPort: number,
  eg?: Pick<EgressStatus, "chain" | "ruleTag" | "fwdContainer">,
): boolean {
  const scope = resolveEgressScope();
  const chain = eg?.chain ?? scope.chain;
  const tag = eg?.ruleTag ?? scope.ruleTag;
  const fwdContainer = eg?.fwdContainer ?? scope.fwdContainer;
  const rules = chainRules(chain);
  const hasAccept = rules.some((l) => l.includes("-j ACCEPT") && l.includes(`--dport ${modelPort}`) && l.includes(tag));
  const hasDrop = rules.some((l) => l.includes("-j DROP") && l.includes(tag));
  return hasAccept && hasDrop && jumpExists(subnet, chain, tag) && forwarderUp(fwdContainer);
}

/**
 * 真实探针验证(起临时容器实测):模型端点(经代理)可达 + 外网被阻断。
 * 模型探针带 3 次重试(magpie 短时高负载下 SYN 偶发超时,实测观察);两个都成立才算约束生效。
 */
export async function verifyEgressEffective(status: EgressStatus): Promise<EgressStatus> {
  if (!status.ok || !status.subnet || !status.hostIp || !status.modelPort) return status;
  const net = status.network;
  const probe = (script: string) =>
    execFileSync(DOCKER_BIN, ["run", "--rm", "--network", net, SANDBOX_IMAGE, "node", "-e", script], {
      encoding: "utf8",
      timeout: 90_000,
    });
  // 模型可达性以 **TCP 层** 判定:白名单约束验证的对象是网络面(SYN 可达代理端口 + 其余 DROP);
  // 应用层(undici × 代理)行为由 E2E 真实 Run 覆盖。
  const modelScript = `
    const net = require("net");
    const conn = () => new Promise((res) => {
      const s2 = net.connect({ host: "${status.hostIp}", port: ${status.modelPort}, timeout: 6000 });
      s2.on("connect", () => { s2.destroy(); res("REACHABLE"); });
      s2.on("error", (e) => res("BLOCKED:" + e.code));
      s2.on("timeout", () => { s2.destroy(); res("BLOCKED:ETIMEDOUT"); });
    });
    conn().then((v) => console.log(v));`;
  const externalScript = `fetch('https://registry.npmjs.org',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('REACHABLE:'+r.status)).catch(e=>console.log('BLOCKED'))`;
  let modelResult = "";
  for (let i = 0; i < 3; i++) {
    modelResult = probe(modelScript).trim();
    if (modelResult === "REACHABLE") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const externalResult = probe(externalScript).trim();
  const verification = {
    modelReachable: modelResult === "REACHABLE",
    externalBlocked: externalResult === "BLOCKED",
  };
  const ok = verification.modelReachable && verification.externalBlocked;
  return {
    ...status,
    ok,
    verification,
    reason: ok ? undefined : `verify_failed:model=${modelResult} external=${externalResult}`,
  };
}

// ===================== teardown(归属校验;返回可审计报告) =====================

export interface TeardownReport {
  scope: { kind: "default" | "test"; network: string; fwdContainer: string; chain: string; ruleTag: string };
  /** 已删除资源("ctr:x"/"chain:x"/"net:x"/"rule:..." —— 均为本执行者创建且仍持有) */
  deleted: string[];
  /** 拒绝/跳过项(逐项含原因:非本执行者持有/匿名/不存在/授权不足) */
  skipped: Array<{ resource: string; reason: string }>;
}

/** 规则行匹配:精确锚 `<ruleTag> owner=`(防前缀串扰),兼容无 owner 的历史格式(仅 netOwned 时)。 */
function ruleLineMatches(line: string, ruleTag: string): boolean {
  return line.includes(`${ruleTag} owner=`) || (line.includes(ruleTag) && !/owner=/.test(line));
}

/** -S 规则行 → argv 分词(注释含空格且被 iptables 引号包裹 ⇒ 按引号分词,保证 -D 精确匹配)。 */
function ruleTokens(line: string): string[] {
  const body = line.replace(/^-A \S+ /, "");
  return (body.match(/"[^"]*"|\S+/g) ?? []).map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
}

/**
 * 撤除**本执行者创建且仍持有**的作用域资源(测试清理;RELAY-EGRESS-ISOLATION-07)。
 * 授权锚:进程内创建注册表 ∪ 资源 owner 标签===本执行者。不满足 ⇒ 逐项 skipped(零删除)。
 * - 容器/网络:registry ∪ owner 标签匹配;
 * - iptables(链/跳转/INPUT):仅当网络归属成立(netOwned)才授权;链 -F/-X 另需本进程注册(家族共享链不误清);
 * - 重复触发/资源已不存在:如实 skipped,不抛错。
 */
export function teardownEgress(scopeArg?: EgressScope): TeardownReport {
  const scope = scopeArg ?? resolveEgressScope();
  const deleted: string[] = [];
  const skipped: Array<{ resource: string; reason: string }> = [];

  // ① 代理容器
  const fwd = fwdContainerInfo(scope.fwdContainer);
  if (fwd === null) {
    skipped.push({ resource: `ctr:${scope.fwdContainer}`, reason: "不存在" });
  } else if (owned.has(`ctr:${scope.fwdContainer}`) || fwd.owner === scope.owner) {
    try {
      docker(["rm", "-f", scope.fwdContainer]);
      owned.delete(`ctr:${scope.fwdContainer}`);
      deleted.push(`ctr:${scope.fwdContainer}`);
    } catch (e) {
      skipped.push({ resource: `ctr:${scope.fwdContainer}`, reason: `rm 失败:${(e as Error).message}` });
    }
  } else {
    skipped.push({
      resource: `ctr:${scope.fwdContainer}`,
      reason: `非本执行者持有(owner=${fwd.owner || "匿名"})⇒ 拒绝删除`,
    });
  }

  // ② 网络归属判定(iptables 授权锚)
  const netOwned = owned.has(`net:${scope.network}`) || networkOwner(scope.network) === scope.owner;

  // ③ iptables(仅 netOwned;匿名/他人网络零操作)
  if (netOwned) {
    // DOCKER-USER 跳转(按 -S 行精确 -D)
    try {
      const jumps = ipt(["-S", "DOCKER-USER"])
        .split("\n")
        .filter((l) => ruleLineMatches(l, scope.ruleTag));
      for (const l of jumps) {
        const args = ruleTokens(l);
        try {
          ipt(["-D", "DOCKER-USER", ...args]);
          deleted.push(`rule:DOCKER-USER ${args.join(" ")}`);
        } catch {
          skipped.push({ resource: `rule:DOCKER-USER ${args.join(" ")}`, reason: "删除失败(已不在?)" });
        }
      }
    } catch {
      /* 无 DOCKER-USER 链(非 docker 环境) */
    }
    // INPUT 放行(按注释标记)
    try {
      const lines = ipt(["-S", "INPUT"])
        .split("\n")
        .filter((l) => ruleLineMatches(l, scope.ruleTag) && l.includes("-A INPUT"));
      for (const l of lines) {
        const args = ruleTokens(l);
        try {
          ipt(["-D", "INPUT", ...args]);
          deleted.push(`rule:INPUT ${args.join(" ")}`);
        } catch {
          skipped.push({ resource: `rule:INPUT ${args.join(" ")}`, reason: "删除失败(已不在?)" });
        }
      }
    } catch {
      /* 忽略 */
    }
    // 作用域链(-F/-X;仅本进程创建过的链 ⇒ 家族共享链/他人链不误清)
    if (owned.has(`chain:${scope.chain}`)) {
      try {
        ipt(["-F", scope.chain]);
        ipt(["-X", scope.chain]);
        owned.delete(`chain:${scope.chain}`);
        deleted.push(`chain:${scope.chain}`);
      } catch (e) {
        skipped.push({ resource: `chain:${scope.chain}`, reason: `清链失败:${(e as Error).message}` });
      }
    } else {
      const chainExists = (() => {
        try {
          ipt(["-S", scope.chain]);
          return true;
        } catch {
          return false;
        }
      })();
      skipped.push({
        resource: `chain:${scope.chain}`,
        reason: chainExists ? "非本进程创建(家族/前进程链)⇒ 不清链,仅删自身规则" : "不存在",
      });
    }
  } else {
    skipped.push({ resource: "iptables", reason: `网络 ${scope.network} 非本执行者持有(匿名/他人)⇒ 零 iptables 操作` });
  }

  // ④ 网络(仅本执行者持有)
  if (netOwned) {
    try {
      docker(["network", "rm", scope.network]);
      owned.delete(`net:${scope.network}`);
      deleted.push(`net:${scope.network}`);
    } catch (e) {
      skipped.push({ resource: `net:${scope.network}`, reason: `rm 失败:${(e as Error).message}` });
    }
  } else if (networkOwner(scope.network) !== null) {
    skipped.push({ resource: `net:${scope.network}`, reason: "非本执行者持有 ⇒ 拒绝删除" });
  } else {
    skipped.push({ resource: `net:${scope.network}`, reason: "不存在" });
  }

  return {
    scope: {
      kind: scope.kind,
      network: scope.network,
      fwdContainer: scope.fwdContainer,
      chain: scope.chain,
      ruleTag: scope.ruleTag,
    },
    deleted,
    skipped,
  };
}
