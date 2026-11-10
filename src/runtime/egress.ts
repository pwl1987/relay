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
//      a) **密钥隔离(P0-02A C-8)**:真实 key 只存在于代理进程环境(FWD_REAL_KEY);来自 Run 的
//         请求 Authorization 被改写为真实 key,Run 容器内 models.json 仅占位 key;
//      b) **请求计数(P0-02A C-9)**:http server 每收到一个请求计数 +1 并 1:1 转发上游——
//         该计数即真实 Provider 请求数(独立于 Runner 侧回合计数),经本机计数端点读取;
//      c) 模型连接源回到宿主 loopback(magpie 信任),Run 容器**只见代理端口,零直连模型**。
// 失败语义:任何一层建立/验证失败 ⇒ ensureEgress ok:false,launchPi/executeRun FAIL-CLOSED 拒启
// (不得以 --network host 降级)。规则仅作用域本子网/本端口,不改 ufw 策略。
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { DOCKER_BIN, dockerAvailable, SANDBOX_IMAGE } from "./sandbox.ts";

export const EGRESS_NETWORK = process.env.RELAY_EGRESS_NETWORK ?? "relay-egress-net";
export const EGRESS_FORWARD_PORT = Number(process.env.RELAY_EGRESS_FORWARD_PORT ?? "13425");
export const EGRESS_COUNT_PORT = Number(process.env.RELAY_EGRESS_COUNT_PORT ?? "13426");
const FWD_CONTAINER = "relay-egress-fwd";
const RULE_TAG = "relay-p01c-egress";

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
}

function ipt(args: string[], timeoutMs = 15_000): string {
  return execFileSync("sudo", ["-n", "iptables", ...args], { encoding: "utf8", timeout: timeoutMs });
}

function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync(DOCKER_BIN, args, { encoding: "utf8", timeout: timeoutMs });
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

function networkExists(): boolean {
  try {
    docker(["network", "inspect", EGRESS_NETWORK]);
    return true;
  } catch {
    return false;
  }
}

function chainRules(): string[] {
  try {
    return ipt(["-S", "RELAY-EGRESS"]).split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function jumpExists(subnet: string): boolean {
  try {
    return ipt(["-S", "DOCKER-USER"])
      .split("\n")
      .some((l) => l.includes(`-s ${subnet}`) && l.includes("RELAY-EGRESS"));
  } catch {
    return false;
  }
}

function inputRuleExists(hostIp: string, port: number, subnet: string): boolean {
  try {
    return ipt(["-S", "INPUT"])
      .split("\n")
      .some((l) => l.includes(`-s ${subnet}`) && l.includes(`-d ${hostIp}`) && l.includes(`--dport ${port}`) && /ACCEPT/.test(l));
  } catch {
    return false;
  }
}

// HTTP 反向代理(P0-02A C-8/C-9):密钥改写 + 1:1 请求转发计数 + 本机计数端点。
// 计数语义:http server 每收到一个请求即 +1 且恰好转发一次上游 —— 该数即真实 Provider 请求数。
const FWD_SCRIPT = `
const http = require("http");
const ORIGIN_PORT = Number(process.env.FWD_ORIGIN_PORT ?? "3425");
const LISTEN_PORT = Number(process.env.FWD_LISTEN_PORT ?? "13425");
const COUNT_PORT = Number(process.env.FWD_COUNT_PORT ?? "13426");
const REAL_KEY = process.env.FWD_REAL_KEY || "";
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

/** 代理就绪等待:计数端点 HTTP 200(http 层已起;比 TCP 探测更诚实)。 */
function waitForwarderReady(timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: EGRESS_COUNT_PORT, path: "/", timeout: 1500, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end(); // 缺 end 则请求头永不发出:服务端等请求、客户端等响应,双向死等(实测坑)
    }).then((ok) => {
      if (ok) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      return new Promise<boolean>((r) => setTimeout(() => attempt().then(r), 300));
    });
  return attempt();
}

function forwarderUp(): boolean {
  try {
    const state = docker(["inspect", "-f", "{{.State.Running}}", FWD_CONTAINER]).trim();
    return state === "true";
  } catch {
    return false;
  }
}

/** 读取代理层请求计数(独立于 Runner 回合计数的 Provider 请求数;仅宿主可达)。 */
export function readEgressRequestCount(timeoutMs = 3000): Promise<{ requests: number; completions: number; connections: number } | null> {
  return new Promise((resolve) => {
    // agent:false:一次性连接 —— 全局 agent 的 keep-alive 复用会与服务端 keepAliveTimeout
    // 相撞(socket hang up 竞态);诊断端点每次新建连接,确定性优先。
    const req = httpRequest({ host: "127.0.0.1", port: EGRESS_COUNT_PORT, path: "/", timeout: timeoutMs, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { requests: number; completions: number; connections: number };
          resolve({ requests: Number(j.requests), completions: Number(j.completions ?? 0), connections: Number(j.connections) });
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

/**
 * 幂等建立出口约束(网络 + RELAY-EGRESS 链 + DOCKER-USER 挂载 + INPUT 放行 + 代理容器)。
 * opts.realKey:真实模型 key(仅注入代理容器环境;Run 容器/argv/models.json 永不见真值)。
 * 缺省 = 透传模式(假密钥本地路由,机制仍计数;真密钥接入前必须带 realKey 走改写模式)。
 * 代理容器每次 ensure 重建(env 可能变化;结果幂等)。失败即返回 ok:false(调用方 FAIL-CLOSED)。
 */
export async function ensureEgress(modelBaseUrl: string, opts: { realKey?: string } = {}): Promise<EgressStatus> {
  if (!dockerAvailable()) return { ok: false, network: EGRESS_NETWORK, reason: "docker_unavailable" };
  const hostIp = detectHostIp();
  const originPort = parseModelPort(modelBaseUrl);
  try {
    if (!networkExists()) {
      docker(["network", "create", EGRESS_NETWORK]);
    }
    const subnet = docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", EGRESS_NETWORK]).trim();
    if (!subnet) return { ok: false, network: EGRESS_NETWORK, reason: "subnet_undetectable" };

    // RELAY-EGRESS 子链:先 ACCEPT 代理端口,后 DROP 其余(顺序即语义)
    try {
      ipt(["-N", "RELAY-EGRESS"]);
    } catch {
      /* 已存在 */
    }
    ipt(["-F", "RELAY-EGRESS"]);
    ipt(["-A", "RELAY-EGRESS", "-p", "tcp", "-d", hostIp, "--dport", String(EGRESS_FORWARD_PORT), "-j", "ACCEPT", "-m", "comment", "--comment", RULE_TAG]);
    ipt(["-A", "RELAY-EGRESS", "-j", "DROP", "-m", "comment", "--comment", RULE_TAG]);
    if (!jumpExists(subnet)) {
      ipt(["-I", "DOCKER-USER", "1", "-s", subnet, "-j", "RELAY-EGRESS", "-m", "comment", "--comment", RULE_TAG]);
    }
    if (!inputRuleExists(hostIp, EGRESS_FORWARD_PORT, subnet)) {
      ipt(["-I", "INPUT", "1", "-p", "tcp", "-s", subnet, "-d", hostIp, "--dport", String(EGRESS_FORWARD_PORT), "-j", "ACCEPT", "-m", "comment", "--comment", RULE_TAG]);
    }

    // 代理容器(host 网络:模型连接源回到宿主 loopback;真实 key 仅存于代理进程环境)。
    // 每次 ensure 重建(env 可能变化;结果幂等)。容器不存在时 rm 报错被吞(首建场景)。
    try {
      docker(["rm", "-f", FWD_CONTAINER]);
    } catch {
      /* 首建:无容器 */
    }
    const envArgs = [
      "-e", `FWD_ORIGIN_PORT=${originPort}`,
      "-e", `FWD_LISTEN_PORT=${EGRESS_FORWARD_PORT}`,
      "-e", `FWD_COUNT_PORT=${EGRESS_COUNT_PORT}`,
    ];
    if (opts.realKey !== undefined) envArgs.push("-e", `FWD_REAL_KEY=${opts.realKey}`);
    docker(["run", "-d", "--name", FWD_CONTAINER, "--network", "host", "--restart", "unless-stopped", ...envArgs, SANDBOX_IMAGE, "node", "-e", FWD_SCRIPT]);

    const rules = chainRules();
    if (rules.length < 2 || !forwarderUp()) {
      return { ok: false, network: EGRESS_NETWORK, subnet, hostIp, modelPort: EGRESS_FORWARD_PORT, originPort, reason: "rules_or_forwarder_incomplete" };
    }
    const fwdReady = await waitForwarderReady();
    if (!fwdReady) {
      return { ok: false, network: EGRESS_NETWORK, subnet, hostIp, modelPort: EGRESS_FORWARD_PORT, originPort, reason: "forwarder_not_ready" };
    }
    return {
      ok: true,
      network: EGRESS_NETWORK,
      subnet,
      hostIp,
      modelPort: EGRESS_FORWARD_PORT,
      originPort,
      keyIsolation: opts.realKey !== undefined,
    };
  } catch (e) {
    return { ok: false, network: EGRESS_NETWORK, hostIp, modelPort: EGRESS_FORWARD_PORT, originPort, reason: `ensure_failed:${(e as Error).message}` };
  }
}

/** 规则存在性只读核验(launchPi/executeRun docker 分支启动前 FAIL-CLOSED 检查)。 */
export function verifyEgressRules(subnet: string, hostIp: string, modelPort: number): boolean {
  const rules = chainRules();
  const hasAccept = rules.some((l) => l.includes("-j ACCEPT") && l.includes(`--dport ${modelPort}`));
  const hasDrop = rules.some((l) => l.includes("-j DROP"));
  return hasAccept && hasDrop && jumpExists(subnet) && forwarderUp();
}

/**
 * 真实探针验证(起临时容器实测):模型端点(经代理)可达 + 外网被阻断。
 * 模型探针带 3 次重试(magpie 短时高负载下 SYN 偶发超时,实测观察);两个都成立才算约束生效。
 */
export async function verifyEgressEffective(status: EgressStatus): Promise<EgressStatus> {
  if (!status.ok || !status.subnet || !status.hostIp || !status.modelPort) return status;
  const probe = (script: string) =>
    execFileSync(
      DOCKER_BIN,
      ["run", "--rm", "--network", EGRESS_NETWORK, SANDBOX_IMAGE, "node", "-e", script],
      { encoding: "utf8", timeout: 90_000 },
    );
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
  return { ...status, ok, verification, reason: ok ? undefined : `verify_failed:model=${modelResult} external=${externalResult}` };
}

/** 撤除本包规则/代理/网络(测试清理;带注释标记,只动自己的规则)。 */
export function teardownEgress(): void {
  try {
    docker(["rm", "-f", FWD_CONTAINER]);
  } catch {
    /* 无容器 */
  }
  // DOCKER-USER 挂载规则按子网删除(规则源是子网,不是宿主 IP)
  try {
    const subnet = docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", EGRESS_NETWORK]).trim();
    if (subnet) {
      ipt(["-D", "DOCKER-USER", "-s", subnet, "-j", "RELAY-EGRESS", "-m", "comment", "--comment", RULE_TAG]);
    }
  } catch {
    /* 无规则/无网络 */
  }
  // INPUT 放行按注释标记清理
  try {
    const lines = ipt(["-S", "INPUT"]).split("\n").filter((l) => l.includes(RULE_TAG) && l.includes("-A INPUT"));
    for (const l of lines) {
      const args = l.replace(/^-A INPUT /, "").trim().split(/\s+/);
      try {
        ipt(["-D", "INPUT", ...args]);
      } catch {
        /* 已删 */
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    ipt(["-F", "RELAY-EGRESS"]);
    ipt(["-X", "RELAY-EGRESS"]);
  } catch {
    /* 无链 */
  }
  try {
    docker(["network", "rm", EGRESS_NETWORK]);
  } catch {
    /* 无网络或有容器 */
  }
}
