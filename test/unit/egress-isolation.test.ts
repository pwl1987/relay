// RELAY-EGRESS-ISOLATION-07 B 项:命令注入/模拟执行器隔离反例(合同 B;零真实 docker/iptables/HTTP 外联)。
// 对当前 src/runtime/egress.ts 的三缺陷给出可复现证据(红态),同时固化新语义 spec(绿态验收面):
//   U1 teardownEgress 无所有权校验 ⇒ 本进程零创建零持有也能删默认共享栈(代理容器/链/网络/跳转/INPUT);
//   U2 ensureEgress 每次无条件 docker rm -f 同名代理 ⇒ 健康且配置相同的在用代理被杀(在途请求中断);
//   U3 仅改 RELAY_EGRESS_NETWORK 仍撞固定代理容器名/链名/规则标记/端口(半独立命名空间=假隔离);
//   S1-S4 新语义:完整独立命名空间(createTestEgressScope)+ owner 归属 + teardown 所有权校验 + 健康复用。
// 模拟执行器有状态(iptables/docker/计数端点),保证命令序列与真实语义同构;断言基于记录到的命令面。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- 模拟执行器(vi.hoisted:mock 工厂与测试体共享同一有状态实例) ----
const sim = vi.hoisted(() => {
  type Cmd = { cmd: string; args: string[] };
  const state = {
    recorder: [] as Cmd[],
    chains: new Map<string, string[]>(), // 自定义链名 → 规则串(不含 "-A <chain> " 前缀)
    dockerUser: [] as string[],
    input: [] as string[],
    networks: new Map<string, { subnet: string; labels: Record<string, string> }>(),
    containers: new Map<
      string,
      { running: boolean; env: string[]; labels: Record<string, string>; mounts: string[] }
    >(),
    subnetSeq: 30,
    failChainReads: false,
  };
  const norm = (xs: string[]) => xs.join(" ").replace(/\s+/g, " ").trim();
  const reset = () => {
    state.recorder.length = 0;
    state.chains.clear();
    state.dockerUser.length = 0;
    state.input.length = 0;
    state.networks.clear();
    state.containers.clear();
    state.subnetSeq = 30;
    state.failChainReads = false;
    // 预置宿主基线:DOCKER-USER 存在且已有规则;INPUT 有非本包基线规则(证明 -S 面真实)
    state.dockerUser.push("-A DOCKER-USER -j RETURN");
    state.input.push("-A INPUT -p tcp -m comment --comment relay-baseline -j ACCEPT");
  };
  function countEndpointAlive(port: number): boolean {
    for (const c of state.containers.values()) {
      if (c.running && c.env.includes(`FWD_COUNT_PORT=${port}`)) return true;
    }
    return false;
  }
  function httpOk(port: number): boolean {
    return countEndpointAlive(port);
  }
  function iptables(args: string[]): string {
    const t = args[0] === "-n" && args[1] === "iptables" ? args.slice(2) : args;
    const op = t[0]!;
    const chain = t[1] ?? "";
    const rest = t.slice(2);
    const arrOf = (c: string): string[] | undefined =>
      c === "DOCKER-USER" ? state.dockerUser : c === "INPUT" ? state.input : state.chains.get(c);
    switch (op) {
      case "-S": {
        if (state.failChainReads && (state.chains.has(chain) || chain === "RELAY-EGRESS")) {
          throw new Error("iptables: read failure (simulated infrastructure error)");
        }
        if (!chain) throw new Error("sim: full dump unsupported");
        const arr = arrOf(chain);
        if (!arr) throw new Error("iptables: No chain/target/match by that name.");
        if (arr === state.dockerUser || arr === state.input) return arr.join("\n");
        return arr.map((l) => `-A ${chain} ${l}`).join("\n");
      }
      case "-N": {
        if (state.chains.has(chain)) throw new Error(`iptables: Chain already exists.`);
        state.chains.set(chain, []);
        return "";
      }
      case "-F": {
        const arr = arrOf(chain);
        if (!arr) throw new Error("iptables: No chain/target/match by that name.");
        arr.length = 0;
        return "";
      }
      case "-X": {
        if (!state.chains.delete(chain)) throw new Error("iptables: No chain/target/match by that name.");
        return "";
      }
      case "-A": {
        const arr = arrOf(chain);
        if (!arr) throw new Error("iptables: No chain/target/match by that name.");
        arr.push(norm(rest));
        return "";
      }
      case "-I": {
        const pos = Number(rest[0] ?? "1");
        const rule = rest.slice(1);
        const arr = arrOf(chain);
        if (!arr) throw new Error("iptables: No chain/target/match by that name.");
        arr.splice(Math.max(0, pos - 1), 0, norm(rule));
        return "";
      }
      case "-D": {
        const spec = norm(rest);
        const arr = arrOf(chain);
        if (!arr) throw new Error("iptables: No chain/target/match by that name.");
        const idx = arr.findIndex((l) => l === spec);
        if (idx < 0) throw new Error("iptables: Bad rule (does a matching rule exist in that chain?).");
        arr.splice(idx, 1);
        return "";
      }
      default:
        throw new Error(`sim: unsupported iptables op ${String(op)}`);
    }
  }
  function docker(args: string[]): string {
    const op = args[0]!;
    switch (op) {
      case "network": {
        if (args[1] === "inspect") {
          const name = args[args.length - 1]!;
          const n = state.networks.get(name);
          if (!n) throw new Error(`Error response from daemon: network ${name} not found`);
          const fmt = args.includes("-f") ? (args[args.indexOf("-f") + 1] ?? "") : "";
          if (fmt.includes(".Labels")) {
            const ownerKey = fmt.match(/"([^"]+)"/)?.[1] ?? "";
            return n.labels[ownerKey] ?? "";
          }
          if (fmt.includes("Subnet")) return n.subnet;
          return "";
        }
        if (args[1] === "create") {
          const rest = args.slice(2);
          const labels: Record<string, string> = {};
          const nameParts: string[] = [];
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "--label") {
              const kv = rest[++i]!;
              labels[kv.split("=")[0]!] = kv.split("=").slice(1).join("=");
            } else if (rest[i] !== undefined) nameParts.push(rest[i]!);
          }
          const name = nameParts[nameParts.length - 1]!;
          if (state.networks.has(name)) throw new Error(`network with name ${name} already exists`);
          state.networks.set(name, { subnet: `172.30.${state.subnetSeq++}.0/24`, labels });
          return name;
        }
        if (args[1] === "rm") {
          const name = args[args.length - 1]!;
          if (!state.networks.delete(name)) throw new Error(`Error response from daemon: network ${name} not found`);
          return name;
        }
        throw new Error(`sim: unsupported docker network op ${String(args[1])}`);
      }
      case "inspect": {
        const name = args[args.length - 1]!;
        const c = state.containers.get(name);
        if (!c) throw new Error(`Error response from daemon: No such container: ${name}`);
        const fmt = args.includes("-f") ? (args[args.indexOf("-f") + 1] ?? "") : "";
        if (fmt.includes("Config.Env")) {
          // 组合格式(Running|Status|owner|env|mounts;egress.ts fwdContainerInfo 一次 inspect)
          const ownerKey = fmt.match(/"([^"]+)"/)?.[1] ?? "";
          return `${c.running}|${c.running ? "running" : "exited"}|${c.labels[ownerKey] ?? ""}|${c.env.map((e) => `${e},`).join("")}|${c.mounts.map((m) => `${m},`).join("")}`;
        }
        if (fmt.includes("State.Running")) return c.running ? "true" : "false";
        if (fmt.includes("Mounts")) return c.mounts.map((m) => `${m}\n`).join("");
        if (fmt.includes("Labels")) {
          const key = fmt.match(/"([^"]+)"/)?.[1] ?? "";
          return c.labels[key] ?? "";
        }
        return "";
      }
      case "rm": {
        const name = args[args.length - 1]!;
        const c = state.containers.get(name);
        if (!c) throw new Error(`Error response from daemon: No such container: ${name}`);
        state.containers.delete(name);
        return name;
      }
      case "run": {
        const rest = args.slice(1);
        const env: string[] = [];
        const labels: Record<string, string> = {};
        const mounts: string[] = [];
        let name = "";
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--name") name = rest[++i]!;
          else if (rest[i] === "-e") env.push(rest[++i]!);
          else if (rest[i] === "--label") {
            const kv = rest[++i]!;
            labels[kv.split("=")[0]!] = kv.split("=").slice(1).join("=");
          } else if (rest[i] === "-v") mounts.push(rest[++i]!);
        }
        if (!name) throw new Error("sim: docker run without --name");
        if (state.containers.has(name)) {
          throw new Error(`Error response from daemon: Conflict. The container name "/${name}" is already in use`);
        }
        state.containers.set(name, { running: true, env, labels, mounts });
        return "sim-container-id";
      }
      case "stop": {
        const name = args[args.length - 1]!;
        const c = state.containers.get(name);
        if (!c) throw new Error(`Error response from daemon: No such container: ${name}`);
        c.running = false;
        return name;
      }
      default:
        throw new Error(`sim: unsupported docker op ${String(op)}`);
    }
  }
  function route(cmd: string, args: string[]): string {
    if (cmd === "ip" && args[0] === "-4") return "203.0.113.10 via 198.51.100.1 dev eth0 src 203.0.113.10";
    if (cmd === "sudo") return iptables(args);
    return docker(args);
  }
  function execFileSync(cmd: string, args: string[]): string {
    state.recorder.push({ cmd, args: [...args] });
    return route(cmd, args);
  }
  function spawnSync(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
    state.recorder.push({ cmd, args: [...(args ?? [])] });
    void cmd;
    return { status: 0, stdout: "24.0\n", stderr: "" };
  }
  function httpRequest(
    opts: { port: number; path?: string; timeout?: number },
    cb?: (res: unknown) => void,
  ): {
    on: (ev: string, fn: (e?: unknown) => void) => unknown;
    end: () => void;
    destroy: () => void;
  } {
    const cbs: Record<string, Array<(e?: unknown) => void>> = {};
    const req = {
      on(ev: string, fn: (e?: unknown) => void) {
        if (!cbs[ev]) cbs[ev] = [];
        cbs[ev].push(fn);
        return req;
      },
      end() {
        queueMicrotask(() => {
          if (httpOk(opts.port)) {
            const body = JSON.stringify({ requests: 0, completions: 0, connections: 0, pid: 4242 });
            const res = {
              statusCode: 200,
              resume() {},
              on(ev: string, fn: (d?: unknown) => void) {
                if (ev === "data") fn(Buffer.from(body));
                if (ev === "end") fn();
                return res;
              },
            };
            cb?.(res);
          } else {
            for (const fn of cbs.error ?? []) fn(new Error("sim:ECONNREFUSED"));
          }
        });
      },
      destroy() {},
    };
    return req;
  }
  return { state, reset, execFileSync, spawnSync, httpRequest, countEndpointAlive };
});

vi.mock("node:child_process", () => ({
  execFileSync: sim.execFileSync,
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: sim.spawnSync,
}));
vi.mock("node:http", () => ({
  request: sim.httpRequest,
}));

// ---- 断言助手 ----
const pretty = (c: { cmd: string; args: string[] }) => `${c.cmd} ${c.args.join(" ")}`;
/** 破坏性命令面:容器/网络删除、iptables 清链/删链/删规则。 */
function destructive(recorder: { cmd: string; args: string[] }[]) {
  const isDocker = (cmd: string) => cmd === "docker" || cmd.endsWith("/docker");
  return recorder.filter((r) => {
    const a = r.args;
    if (isDocker(r.cmd)) return a.includes("rm");
    if (r.cmd === "sudo") {
      const t = a[0] === "-n" && a[1] === "iptables" ? a.slice(2) : a;
      return ["-F", "-X", "-D"].includes(t[0] ?? "");
    }
    return false;
  });
}
/** 固定默认资源名(生产共享栈):任何命令触碰到它们即冲突。 */
const FIXED_RESOURCE =
  /relay-egress-fwd|relay-egress-net|RELAY-EGRESS(?![\w-])|relay-p01c-egress|FWD_LISTEN_PORT=13425|FWD_COUNT_PORT=13426/;
function touchesFixed(recorder: { cmd: string; args: string[] }[]) {
  return recorder.filter((r) => FIXED_RESOURCE.test(pretty(r)));
}

// ---- 模块装载助手:每用例重置模块状态(env 常量/归属注册表)与模拟器 ----
async function importEgress() {
  vi.resetModules();
  return await import("../../src/runtime/egress.ts");
}

const ENV_KEYS = [
  "RELAY_EGRESS_NETWORK",
  "RELAY_EGRESS_FORWARD_PORT",
  "RELAY_EGRESS_COUNT_PORT",
  "RELAY_EGRESS_SCOPE_PREFIX",
  "RELAY_EGRESS_OWNER",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sim.reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const BASE_URL = "http://127.0.0.1:3425/v1";

describe("RELAY-EGRESS-ISOLATION-07 红态:当前 egress.ts 资源归属缺陷(模拟执行器,零真实系统调用)", () => {
  it("U1 无 ensure 的裸 teardownEgress() 必须零破坏性命令(当前代码:无所有权校验,删除默认共享栈)", async () => {
    const eg = await importEgress();
    eg.teardownEgress();
    const d = destructive(sim.state.recorder).map(pretty);
    // 新语义:本进程零创建零持有 ⇒ teardown 不得发出任何删除命令(拒绝匿名/他人资源)
    expect(d).toEqual([]);
  });

  it("U2 健康且配置相同的同名代理必须复用(当前代码:每次无条件 docker rm -f + 重建,切断在途请求)", async () => {
    // 预置:共享栈已在位且健康——网络/链(规则齐)/代理容器(running,同配置)/计数端点活
    sim.state.networks.set("relay-egress-net", {
      subnet: "172.30.42.0/24",
      labels: { "relay.egress.owner": "other-process" },
    });
    sim.state.chains.set("RELAY-EGRESS", [
      "-p tcp -d 203.0.113.10 --dport 13425 -j ACCEPT -m comment --comment relay-p01c-egress",
      "-j DROP -m comment --comment relay-p01c-egress",
    ]);
    sim.state.dockerUser.unshift(
      "-A DOCKER-USER -s 172.30.42.0/24 -j RELAY-EGRESS -m comment --comment relay-p01c-egress",
    );
    sim.state.containers.set("relay-egress-fwd", {
      running: true,
      env: ["FWD_ORIGIN_PORT=3425", "FWD_LISTEN_PORT=13425", "FWD_COUNT_PORT=13426"],
      labels: { "relay.egress.owner": "other-process" },
      mounts: [],
    });
    const eg = await importEgress();
    const s = await eg.ensureEgress(BASE_URL);
    expect(s.ok, `ensure 应成功(复用健康栈):${s.reason ?? ""}`).toBe(true);
    // 新语义:健康+同配置 ⇒ 复用 ⇒ 零破坏性命令(不 rm 不重建)
    const d = destructive(sim.state.recorder).map(pretty);
    expect(d).toEqual([]);
  });

  it("U3a 存证守卫:仅改 RELAY_EGRESS_NETWORK 属 default 域配置面而非隔离机制(固定资源仍属同一域;测试不得据此假定隔离)", async () => {
    process.env.RELAY_EGRESS_NETWORK = "relay-test-x";
    const eg = await importEgress(); // env 常量在 import 时解析 ⇒ 网络名生效
    const s = await eg.ensureEgress(BASE_URL);
    expect(s.ok, `ensure 应成功:${s.reason ?? ""}`).toBe(true);
    eg.teardownEgress();
    // 默认域语义:网络名可经 env 配置,但代理容器/链/标记/端口仍属 default 域(生产配置面);
    // 此守卫防"把网络名覆盖误当隔离机制":测试隔离必须走 createTestEgressScope(见 U3b/S2/S6)。
    const f = touchesFixed(sim.state.recorder).map(pretty);
    expect(f.length, `default 域仍应触碰固定资源(非隔离机制):${JSON.stringify(f, null, 1)}`).toBeGreaterThan(0);
    expect(f.some((x) => x.includes("rm -f relay-egress-fwd"))).toBe(true);
  });

  it("U3b 新语义:createTestEgressScope 完整命名空间下,ensure→teardown 零固定资源触碰(合同要求的隔离路径)", async () => {
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("u3b");
    const s = await eg.ensureEgress(BASE_URL, { scope });
    expect(s.ok, `ensure 应成功:${s.reason ?? ""}`).toBe(true);
    expect(s.network).toBe(scope.network);
    expect(s.fwdContainer).toBe(scope.fwdContainer);
    expect(s.chain).toBe(scope.chain);
    eg.teardownEgress(scope);
    // 全部冲突资源(网络/容器/链/规则标记/端口)同源派生 ⇒ 生产默认资源零触碰
    const f = touchesFixed(sim.state.recorder).map(pretty);
    expect(f).toEqual([]);
  });

  it("S1 新语义:createTestEgressScope 提供完整独立命名空间(网络/容器/链/标记/端口全派生)", async () => {
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("s1");
    expect(scope.network).not.toBe("relay-egress-net");
    expect(scope.fwdContainer).not.toBe("relay-egress-fwd");
    expect(scope.chain).not.toBe("RELAY-EGRESS");
    expect(scope.ruleTag).not.toBe("relay-p01c-egress");
    expect(scope.forwardPort).not.toBe(13425);
    expect(scope.countPort).not.toBe(13426);
    expect(scope.forwardPort).not.toBe(scope.countPort);
    // 同 id 确定性(跨进程可继承)
    const again = eg.createTestEgressScope("s1");
    expect(again.network).toBe(scope.network);
    expect(again.forwardPort).toBe(scope.forwardPort);
  });

  it("S2 新语义:作用域内 ensure→teardown→复验(只删本作用域;返回可审计报告)", async () => {
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("s2");
    const s1 = await eg.ensureEgress(BASE_URL, { scope });
    expect(s1.ok, `ensure 失败:${s1.reason ?? ""}`).toBe(true);
    const s2 = await eg.ensureEgress(BASE_URL, { scope });
    expect(s2.ok).toBe(true);
    expect(s2.reused, "健康且同配置的二次 ensure 必须复用而非重建").toBe(true);
    const report = eg.teardownEgress(scope);
    expect(report.deleted.some((x) => x.includes(scope.fwdContainer))).toBe(true);
    expect(report.deleted.some((x) => x.includes(scope.network))).toBe(true);
    expect(report.deleted.some((x) => x.includes(scope.chain))).toBe(true);
    // 复触发:资源已不存在 ⇒ 不抛错,报告如实记录 skipped
    const again = eg.teardownEgress(scope);
    expect(again.deleted).toEqual([]);
  });

  it("S3 新语义:匿名/他人同名资源必须拒绝,不得覆盖或删除(fail-closed)", async () => {
    // 匿名容器占用作用域代理名(无归属标签)⇒ ensure 拒绝,且零删除
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("s3");
    sim.state.containers.set(scope.fwdContainer, {
      running: true,
      env: ["FWD_ORIGIN_PORT=3425", `FWD_LISTEN_PORT=${scope.forwardPort}`, `FWD_COUNT_PORT=${scope.countPort}`],
      labels: {},
      mounts: [],
    });
    const s = await eg.ensureEgress(BASE_URL, { scope });
    expect(s.ok, `匿名同名容器必须拒绝:${JSON.stringify(s)}`).toBe(false);
    expect(sim.state.containers.has(scope.fwdContainer), "拒绝路径不得删除已存在容器").toBe(true);
    const d = destructive(sim.state.recorder).map(pretty);
    expect(d).toEqual([]);
  });

  it("S4 新语义:他人持有的不健康/配置不符代理必须拒绝(仅本执行者可恢复重建)", async () => {
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("s4");
    sim.state.networks.set(scope.network, { subnet: "172.30.51.0/24", labels: { "relay.egress.owner": scope.owner } });
    sim.state.containers.set(scope.fwdContainer, {
      running: false, // 不健康
      env: ["FWD_ORIGIN_PORT=3425", `FWD_LISTEN_PORT=${scope.forwardPort}`, `FWD_COUNT_PORT=${scope.countPort}`],
      labels: { "relay.egress.owner": "other-executor" },
      mounts: [],
    });
    const s = await eg.ensureEgress(BASE_URL, { scope });
    expect(s.ok, `他人持有的不健康容器必须拒绝:${JSON.stringify(s)}`).toBe(false);
    expect(sim.state.containers.has(scope.fwdContainer), "拒绝路径不得删除他人容器").toBe(true);
    // 同一执行者(owner 一致)⇒ 有界恢复:rm + 重建,报告 recovered
    sim.state.containers.set(scope.fwdContainer, {
      running: false,
      env: ["FWD_ORIGIN_PORT=3425", `FWD_LISTEN_PORT=${scope.forwardPort}`, `FWD_COUNT_PORT=${scope.countPort}`],
      labels: { "relay.egress.owner": scope.owner },
      mounts: [],
    });
    // 07R 语义:空链=归属不可证会被拒绝 ⇒ 恢复路径不再预置空链(由 ensure 自建/认领)
    const s2 = await eg.ensureEgress(BASE_URL, { scope });
    expect(s2.ok, `本执行者不健康容器应有界恢复:${s2.reason ?? ""}`).toBe(true);
    expect(s2.recovered, "恢复路径应如实标注 recovered").toBe(true);
  });

  it("S5 新语义:裸 teardownEgress() 在他人栈面前零删除并给出原因(生产默认资源受保护)", async () => {
    // 他人(生产)栈在位;本进程裸 teardown ⇒ 全部 skip,零删除
    sim.state.networks.set("relay-egress-net", {
      subnet: "172.30.42.0/24",
      labels: { "relay.egress.owner": "prod-worker" },
    });
    sim.state.chains.set("RELAY-EGRESS", [
      "-p tcp -d 203.0.113.10 --dport 13425 -j ACCEPT -m comment --comment relay-p01c-egress",
      "-j DROP -m comment --comment relay-p01c-egress",
    ]);
    sim.state.containers.set("relay-egress-fwd", {
      running: true,
      env: ["FWD_ORIGIN_PORT=3425", "FWD_LISTEN_PORT=13425", "FWD_COUNT_PORT=13426"],
      labels: { "relay.egress.owner": "prod-worker" },
      mounts: [],
    });
    const eg = await importEgress();
    const report = eg.teardownEgress();
    expect(report.deleted).toEqual([]);
    expect(sim.state.containers.has("relay-egress-fwd")).toBe(true);
    expect(sim.state.networks.has("relay-egress-net")).toBe(true);
    expect(report.skipped.length, `skipped 应逐项给原因:${JSON.stringify(report)}`).toBeGreaterThan(0);
  });

  it("S6 新语义:env 继承同名空间(子进程/worker 经 RELAY_EGRESS_SCOPE_PREFIX+PORTS+OWNER 收敛复用)", async () => {
    const eg = await importEgress();
    const scope = eg.createTestEgressScope("s6");
    process.env.RELAY_EGRESS_SCOPE_PREFIX = scope.prefix;
    process.env.RELAY_EGRESS_FORWARD_PORT = String(scope.forwardPort);
    process.env.RELAY_EGRESS_COUNT_PORT = String(scope.countPort);
    process.env.RELAY_EGRESS_OWNER = scope.owner;
    const viaEnv = eg.resolveEgressScope();
    expect(viaEnv.network).toBe(scope.network);
    expect(viaEnv.fwdContainer).toBe(scope.fwdContainer);
    expect(viaEnv.chain).toBe(scope.chain);
    expect(viaEnv.forwardPort).toBe(scope.forwardPort);
    expect(viaEnv.countPort).toBe(scope.countPort);
    expect(viaEnv.owner).toBe(scope.owner);
    // env 继承的 scope 与显式 scope 命名完全一致 ⇒ 子进程 ensure 与父进程复用同一栈
    const s = await eg.ensureEgress(BASE_URL);
    expect(s.ok, `env 继承 ensure 失败:${s.reason ?? ""}`).toBe(true);
  });
});

describe("RELAY-EGRESS-ISOLATION-07R 红态:跨作用域链名碰撞与归属误判(模拟执行器,零真实系统调用)", () => {
  /** 破坏性/写命令面(-F/-X/-D;-N 探测在链已存在时无副作用,不计入)。 */
  const destructiveOnChain = (chain: string) =>
    sim.state.recorder.filter((r) => {
      if (r.cmd !== "sudo") return false;
      const t = r.args[0] === "-n" && r.args[1] === "iptables" ? r.args.slice(2) : r.args;
      return ["-F", "-X", "-D"].includes(t[0] ?? "") && t[1] === chain;
    });

  it("R1 命名:共享前 8 字符的两个合法 id 不得得到同一条 iptables 链名(旧实现同链=碰撞)", async () => {
    const eg = await importEgress();
    const A = eg.createTestEgressScope("abcdefgh-one");
    const B = eg.createTestEgressScope("abcdefgh-two");
    expect(A.network).not.toBe(B.network);
    expect(A.forwardPort).not.toBe(B.forwardPort);
    expect(A.ruleTag).not.toBe(B.ruleTag);
    expect(A.chain).not.toBe(B.chain);
    // 确定性:同 id 再派生一致
    expect(eg.createTestEgressScope("abcdefgh-one").chain).toBe(A.chain);
    expect(eg.createTestEgressScope("abcdefgh-two").chain).toBe(B.chain);
  });

  it("R2 人为同链碰撞(A 规则被误置于 B 链名)⇒ ensure(第二作用域)前置归属确认后拒绝,零写零清,A 规则原样", async () => {
    const eg = await importEgress();
    const A = eg.createTestEgressScope("abcdefgh-one");
    const B = eg.createTestEgressScope("abcdefgh-two");
    sim.state.networks.set(A.network, { subnet: "172.31.1.0/24", labels: { "relay.egress.owner": A.owner } });
    sim.state.networks.set(B.network, { subnet: "172.31.2.0/24", labels: { "relay.egress.owner": B.owner } });
    // 人工碰撞:A 的规则被放到 B 的链名上(模拟历史同名/摘要碰撞后的现场)
    sim.state.chains.set(B.chain, [
      `-p tcp -d 203.0.113.10 --dport ${A.forwardPort} -j ACCEPT -m comment --comment "${A.ruleTag} owner=${A.owner}"`,
      `-j DROP -m comment --comment "${A.ruleTag} owner=${A.owner}"`,
    ]);
    const sB = await eg.ensureEgress(BASE_URL, { scope: B });
    expect(sB.ok, `碰撞链必须拒绝:${sB.reason ?? ""}`).toBe(false);
    // A 的规则原样保留(未被 -F 清空重写)
    const rules = (sim.state.chains.get(B.chain) ?? []).join("\n");
    expect(rules).toContain(`--dport ${A.forwardPort}`);
    expect(rules).toContain(A.ruleTag);
    expect(rules).not.toContain(B.ruleTag);
    expect(destructiveOnChain(B.chain).map(pretty)).toEqual([]);
    // 拒绝路径零副作用:不接管链,也不创建自己的代理容器
    expect(sim.state.containers.has(B.fwdContainer), "拒绝路径不得创建容器").toBe(false);
  });

  it("R3 人为同链碰撞 ⇒ teardown(第二作用域)不误删链(skipped 如实;规则保留)", async () => {
    const eg = await importEgress();
    const A = eg.createTestEgressScope("abcdefgh-one");
    const B = eg.createTestEgressScope("abcdefgh-two");
    sim.state.networks.set(B.network, { subnet: "172.31.2.0/24", labels: { "relay.egress.owner": B.owner } });
    sim.state.chains.set(B.chain, [
      `-p tcp -d 203.0.113.10 --dport ${A.forwardPort} -j ACCEPT -m comment --comment "${A.ruleTag} owner=${A.owner}"`,
    ]);
    await eg.ensureEgress(BASE_URL, { scope: B }); // 新实现:归属门拒绝(旧实现:注册共同链并改写)
    const report = eg.teardownEgress(B);
    expect(
      report.deleted.some((x) => x.includes(B.chain)),
      `共同链不得被误删:${JSON.stringify(report)}`,
    ).toBe(false);
    expect(sim.state.chains.has(B.chain), "链仍存在(第一作用域依赖)").toBe(true);
    expect((sim.state.chains.get(B.chain) ?? []).join("\n")).toContain(A.ruleTag);
  });

  it("R4 强制同链碰撞(预置他作用域规则)⇒ 拒绝且零破坏性命令", async () => {
    const eg = await importEgress();
    const B = eg.createTestEgressScope("collide-target");
    sim.state.networks.set(B.network, { subnet: "172.31.3.0/24", labels: { "relay.egress.owner": B.owner } });
    sim.state.chains.set(B.chain, [
      `-p tcp -d 203.0.113.10 --dport 21000 -j ACCEPT -m comment --comment "relay-test-foreign owner=someone-else"`,
      `-j DROP -m comment --comment "relay-test-foreign owner=someone-else"`,
    ]);
    const sB = await eg.ensureEgress(BASE_URL, { scope: B });
    expect(sB.ok, `他作用域规则在链上必须拒绝:${sB.reason ?? ""}`).toBe(false);
    expect((sim.state.chains.get(B.chain) ?? []).join("\n")).toContain("relay-test-foreign");
    expect(destructiveOnChain(B.chain).map(pretty)).toEqual([]);
  });

  it("R5 iptables 读取失败 ⇒ fail-closed(不得盲写 -F/-A)", async () => {
    const eg = await importEgress();
    const B = eg.createTestEgressScope("readfail");
    sim.state.networks.set(B.network, { subnet: "172.31.4.0/24", labels: { "relay.egress.owner": B.owner } });
    sim.state.chains.set(B.chain, [
      `-p tcp -d 203.0.113.10 --dport 22000 -j ACCEPT -m comment --comment "relay-test-stale owner=stale-proc"`,
    ]);
    sim.state.failChainReads = true;
    const sB = await eg.ensureEgress(BASE_URL, { scope: B });
    expect(sB.ok, `读失败必须 fail-closed:${sB.reason ?? ""}`).toBe(false);
    expect(destructiveOnChain(B.chain).map(pretty)).toEqual([]);
    expect((sim.state.chains.get(B.chain) ?? []).join("\n")).toContain("relay-test-stale");
  });

  it("R7 空链宽限:并发创建者窗口内写入本作用域规则 ⇒ 认领收敛(非接管无主链)", async () => {
    const eg = await importEgress();
    const B = eg.createTestEgressScope("gracecase");
    sim.state.networks.set(B.network, { subnet: "172.31.6.0/24", labels: { "relay.egress.owner": B.owner } });
    sim.state.containers.set(B.fwdContainer, {
      running: true,
      env: ["FWD_ORIGIN_PORT=3425", `FWD_LISTEN_PORT=${B.forwardPort}`, `FWD_COUNT_PORT=${B.countPort}`],
      labels: { "relay.egress.owner": B.owner },
      mounts: [],
    });
    // 并发对手(同作用域)已 -N 建链但尚未写规则 ⇒ 空链;600ms 后写入本作用域规则
    sim.state.chains.set(B.chain, []);
    const t = setTimeout(() => {
      sim.state.chains.set(B.chain, [
        `-p tcp -d 203.0.113.10 --dport ${B.forwardPort} -j ACCEPT -m comment --comment "${B.ruleTag} owner=${B.owner}"`,
        `-j DROP -m comment --comment "${B.ruleTag} owner=${B.owner}"`,
      ]);
    }, 600);
    try {
      const sB = await eg.ensureEgress(BASE_URL, { scope: B });
      expect(sB.ok, `宽限期内应认领:${sB.reason ?? ""}`).toBe(true);
      expect((sim.state.chains.get(B.chain) ?? []).length).toBe(2);
      expect(sim.state.containers.has(B.fwdContainer), "健康容器应复用不重建").toBe(true);
    } finally {
      clearTimeout(t);
    }
  });

  it("R8 空链宽限超时 ⇒ 拒绝(历史无主链不自动接管)", async () => {
    const eg = await importEgress();
    const B = eg.createTestEgressScope("emptystale");
    sim.state.networks.set(B.network, { subnet: "172.31.7.0/24", labels: { "relay.egress.owner": B.owner } });
    sim.state.chains.set(B.chain, []); // 无主空链,窗口内无人写入
    const sB = await eg.ensureEgress(BASE_URL, { scope: B });
    expect(sB.ok, `宽限超时必须拒绝:${sB.reason ?? ""}`).toBe(false);
    expect(sim.state.chains.has(B.chain), "拒绝路径不得删链").toBe(true);
    expect(destructiveOnChain(B.chain).map(pretty)).toEqual([]);
  });

  it("R9 子串穿透:hash8 真实碰撞对且短 tag 是长 tag 子串 ⇒ 归属门必须词边界精确匹配拒绝(旧实现 claims 并清空)", async () => {
    // Reviewer 实证的真实 hash8 碰撞对:hash8("frntla") === hash8("frntla-M") === b4888887,
    // 且 "frntla" 是 "frntla-M" 的子串 ⇒ 裸 includes(ruleTag) 归属门被穿透。
    const eg = await importEgress();
    const S1 = eg.createTestEgressScope("frntla");
    const S2 = eg.createTestEgressScope("frntla-M");
    expect(S1.chain).toBe(S2.chain); // 前置:本用例依赖真实 hash 碰撞(链名相同)
    sim.state.networks.set(S2.network, { subnet: "172.31.8.0/24", labels: { "relay.egress.owner": S2.owner } });
    // 链上预置 S2 规则(长 tag);S1(短 tag,为其子串)ensure ⇒ 旧实现 includes 穿透认领并 -F 清空
    sim.state.chains.set(S1.chain, [
      `-p tcp -d 203.0.113.10 --dport ${S2.forwardPort} -j ACCEPT -m comment --comment "${S2.ruleTag} owner=${S2.owner}"`,
      `-j DROP -m comment --comment "${S2.ruleTag} owner=${S2.owner}"`,
    ]);
    const s1 = await eg.ensureEgress(BASE_URL, { scope: S1 });
    expect(s1.ok, `子串穿透必须拒绝:${s1.reason ?? ""}`).toBe(false);
    const rules = (sim.state.chains.get(S1.chain) ?? []).join("\n");
    expect(rules).toContain(S2.ruleTag);
    expect(rules).not.toContain(`${S1.ruleTag} owner=`);
    expect(destructiveOnChain(S1.chain).map(pretty)).toEqual([]);
  });

  it("R10 子串穿透反向:链上是短 tag 规则,长 tag 作用域 ensure ⇒ 同样拒绝(词边界两侧都不得误判)", async () => {
    const eg = await importEgress();
    const S1 = eg.createTestEgressScope("frntla");
    const S2 = eg.createTestEgressScope("frntla-M");
    sim.state.networks.set(S1.network, { subnet: "172.31.9.0/24", labels: { "relay.egress.owner": S1.owner } });
    sim.state.chains.set(S1.chain, [
      `-p tcp -d 203.0.113.10 --dport ${S1.forwardPort} -j ACCEPT -m comment --comment "${S1.ruleTag} owner=${S1.owner}"`,
      `-j DROP -m comment --comment "${S1.ruleTag} owner=${S1.owner}"`,
    ]);
    const s2 = await eg.ensureEgress(BASE_URL, { scope: S2 });
    expect(s2.ok, `反向子串穿透必须拒绝:${s2.reason ?? ""}`).toBe(false);
    const rules = (sim.state.chains.get(S1.chain) ?? []).join("\n");
    expect(rules).toContain(`${S1.ruleTag} owner=`);
    expect(destructiveOnChain(S1.chain).map(pretty)).toEqual([]);
  });

  it("R6 teardown 读失败 ⇒ 零清链(fail-closed,不盲 -F/-X)", async () => {
    const eg = await importEgress();
    const A = eg.createTestEgressScope("teardowntimeout");
    sim.state.networks.set(A.network, { subnet: "172.31.5.0/24", labels: { "relay.egress.owner": A.owner } });
    const sA = await eg.ensureEgress(BASE_URL, { scope: A });
    expect(sA.ok, `ensure A 失败:${sA.reason ?? ""}`).toBe(true);
    sim.state.failChainReads = true;
    const report = eg.teardownEgress(A);
    expect(
      report.deleted.some((x) => x.includes(`chain:${A.chain}`)),
      `读失败不得清链:${JSON.stringify(report)}`,
    ).toBe(false);
    expect(sim.state.chains.has(A.chain)).toBe(true);
  });
});
