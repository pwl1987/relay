// RELAY-EGRESS-ISOLATION-07 D 项:隔离 CI 实跑 E2E(创建→模拟并发→核验→清理;CI 与生产资源完全隔离)。
// RELAY-EGRESS-ISOLATION-07R 增补:双 scope 真实 E2E(两个共享前 8 字符 id)+强制同链碰撞拒绝
// +默认面全快照(网络/代理容器/iptables 链/DOCKER-USER/INPUT/监听端口 前后对照,不能只查网络存在)。
// 验证面(全部使用 createTestEgressScope 完整独立命名空间,零生产默认资源触碰):
//   ① 跨进程并发 ensure 安全收敛:两个子进程同时 ensure 同一作用域 ⇒ 恰好一个代理容器,双方 ok;
//   ② 跨进程复用:父进程随后 ensure 同作用域 ⇒ reused:true(不 rm 不重建);
//   ③ 未授权 teardown 拒绝:知道名字但非持有者(不同 owner、空注册表)⇒ 零删除,栈完好;
//   ④ 半残有界恢复:本执行者持有的代理被 stop ⇒ ensure 恢复重建(recovered:true)且健康;
//   ⑤ 退出后清理:owner 匹配的 teardown 回收全部作用域资源,零残留;
//   ⑥ 生产默认资源(relay-egress-net/relay-egress-fwd/RELAY-EGRESS)全程状态不变(_DELTA 不变_)。
// 门:docker + sudo -n iptables 可用(与 egress-enforcement 同门);无付费模型/无真凭据(探针走 TCP 层)。
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  verifyEgressRules,
  createTestEgressScope,
  teardownEgress,
  type EgressScope,
  type EgressStatus,
} from "../../src/runtime/egress.ts";

function sudoIptablesAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = dockerAvailable();
const iptOk = sudoIptablesAvailable();

function dockerPs(namesFilter: string): string {
  return execFileSync("docker", ["ps", "-a", "--filter", `name=^/${namesFilter}$`, "--format", "{{.Names}}"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

interface ChildResult {
  ok?: boolean;
  reason?: string;
  reused?: boolean;
  deleted?: string[];
  skipped?: Array<{ resource: string; reason: string }>;
}

/** 子进程执行器:以指定 env 跑 ensureEgress/teardownEgress 并回传 JSON(跨进程语义的真实证明面)。 */
function runChild(
  mode: "ensure" | "teardown-default" | "teardown-scope",
  scope: EgressScope,
  inheritOwner: boolean,
): Promise<ChildResult> {
  const dir = mkdtempSync(join(tmpdir(), "egress-iso-"));
  const script = join(dir, "child.mjs");
  const modUrl = pathToFileURL(new URL("../../src/runtime/egress.ts", import.meta.url).pathname).href;
  const body =
    mode === "ensure"
      ? `const eg = await import(${JSON.stringify(modUrl)});
       const scope = eg.resolveEgressScope();
       const s = await eg.ensureEgress(process.env.RELAY_CHILD_BASE_URL ?? "http://127.0.0.1:3425/v1", { scope });
       console.log("RESULT:" + JSON.stringify({ ok: s.ok, reason: s.reason, reused: s.reused, network: s.network, fwdContainer: s.fwdContainer }));`
      : mode === "teardown-default"
        ? `const eg = await import(${JSON.stringify(modUrl)});
       const r = eg.teardownEgress(); // 默认域(无 prefix env):授权=默认名+自身 owner/注册表
       console.log("RESULT:" + JSON.stringify({ deleted: r.deleted, skipped: r.skipped }));`
        : `const eg = await import(${JSON.stringify(modUrl)});
       const scope = eg.resolveEgressScope(); // env prefix 继承同作用域名,但 owner 不继承 ⇒ 非持有者
       const r = eg.teardownEgress(scope);
       console.log("RESULT:" + JSON.stringify({ deleted: r.deleted, skipped: r.skipped }));`;
  writeFileSync(script, body);
  const env: Record<string, string> = {
    ...process.env,
    RELAY_EGRESS_FORWARD_PORT: String(scope.forwardPort),
    RELAY_EGRESS_COUNT_PORT: String(scope.countPort),
  };
  if (mode === "teardown-default") {
    // 默认域视角:不带 prefix(解默认作用域);owner 也不继承(陌生进程)
    delete env["RELAY_EGRESS_SCOPE_PREFIX"];
    delete env["RELAY_EGRESS_OWNER"];
    delete env["RELAY_EGRESS_NETWORK"];
  } else {
    env["RELAY_EGRESS_SCOPE_PREFIX"] = scope.prefix;
    if (inheritOwner) env["RELAY_EGRESS_OWNER"] = scope.owner;
    else delete env["RELAY_EGRESS_OWNER"];
    delete env["RELAY_EGRESS_NETWORK"];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    child.stderr!.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理尽力 */
      }
      const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
      if (!line) {
        reject(new Error(`子进程无 RESULT(code=${code}):${out.slice(0, 400)} | stderr:${err.slice(0, 400)}`));
        return;
      }
      resolve(JSON.parse(line.slice("RESULT:".length)) as ChildResult);
    });
  });
}

describe.skipIf(!dockerOk || !iptOk)(
  "egress 资源归属与测试隔离 E2E(RELAY-EGRESS-ISOLATION-07;独立命名空间,零默认资源触碰)",
  { timeout: 300_000 },
  () => {
    const scope: EgressScope = createTestEgressScope("isoe2e");
    let egress: EgressStatus | null = null;
    let defaultNetBefore: boolean = false;
    let defaultFwdBefore: boolean = false;

    const stateOf = () => {
      const has = (name: string) => {
        try {
          execFileSync("docker", ["inspect", name], { stdio: "ignore", timeout: 30_000 });
          return true;
        } catch {
          return false;
        }
      };
      return { net: has("relay-egress-net"), fwd: has("relay-egress-fwd") };
    };

    // 记录生产默认资源基线(只读);套件结束后断言 _DELTA 不变_
    try {
      const s = stateOf();
      defaultNetBefore = s.net;
      defaultFwdBefore = s.fwd;
    } catch {
      /* 只读探测失败不阻断(断言时重新探测) */
    }

    afterAll(() => {
      // 兜底清理:无论用例成败,本作用域资源不得泄漏(owner 归属 ⇒ 有权清理)
      const report = (() => {
        try {
          return teardownEgress(scope);
        } catch (e) {
          return {
            deleted: [`error:${(e as Error).message}`],
            skipped: [] as Array<{ resource: string; reason: string }>,
          };
        }
      })();
      console.log(
        `[egress-isolation-e2e] 兜底清理 deleted=${JSON.stringify(report.deleted)} skipped=${JSON.stringify(report.skipped)}`,
      );
    });

    it("① 跨进程并发 ensure 安全收敛:双子进程同作用域 ensure ⇒ 恰好一个代理容器,双方 ok", async () => {
      const [a, b] = await Promise.all([runChild("ensure", scope, true), runChild("ensure", scope, true)]);
      expect(a.ok, `子进程 A ensure:${a.reason ?? ""}`).toBe(true);
      expect(b.ok, `子进程 B ensure:${b.reason ?? ""}`).toBe(true);
      // 收敛:同名代理容器恰好一个(并发不产生第二容器,也不互相 rm 杀栈)
      expect(dockerPs(scope.fwdContainer)).toBe(scope.fwdContainer);
      // 网络/容器归属标签(审计面;容器=.Config.Labels,网络=.Labels —— 分开 inspect)
      const ctrOwner = execFileSync(
        "docker",
        ["inspect", "-f", `{{index .Config.Labels "relay.egress.owner"}}`, scope.fwdContainer],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      const netOwner = execFileSync(
        "docker",
        ["network", "inspect", "-f", `{{index .Labels "relay.egress.owner"}}`, scope.network],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      expect(ctrOwner).toBe(scope.owner);
      expect(netOwner).toBe(scope.owner);
    });

    it("② 跨进程复用 + 真实探针:父进程 ensure 同作用域 ⇒ reused:true;模型端口可达+外网阻断", async () => {
      const s = await ensureEgress("http://127.0.0.1:3425/v1", { scope });
      expect(s.ok, `父进程 ensure:${s.reason ?? ""}`).toBe(true);
      expect(s.reused, "子进程创建的健康栈必须被复用(不 rm 不重建)").toBe(true);
      egress = s;
      const v = await verifyEgressEffective(s);
      expect(v.ok, `探针:${v.reason ?? ""}`).toBe(true);
      expect(v.verification!.modelReachable).toBe(true);
      expect(v.verification!.externalBlocked).toBe(true);
    });

    it("③ 未授权 teardown 拒绝:知道作用域名但非持有者 ⇒ 零删除,栈完好(默认域 teardown 同样零越界)", async () => {
      const foreign = await runChild("teardown-scope", scope, false);
      expect(foreign.deleted ?? []).toEqual([]);
      expect(
        (foreign.skipped ?? []).length,
        `非持有者 teardown 应逐项 skip:${JSON.stringify(foreign)}`,
      ).toBeGreaterThan(0);
      // 栈完好:容器/网络仍在
      expect(dockerPs(scope.fwdContainer)).toBe(scope.fwdContainer);
      // 默认域 teardown(子进程视角:默认名资源不属于它)——即便 CI 上恰好存在默认栈,也必须零删除
      const foreignDefault = await runChild("teardown-default", scope, false);
      expect(foreignDefault.deleted ?? []).toEqual([]);
    });

    it("④ 半残有界恢复:本执行者持有的代理被 stop ⇒ ensure 恢复重建(recovered)且健康", async () => {
      execFileSync("docker", ["stop", scope.fwdContainer], { timeout: 60_000 });
      const s = await ensureEgress("http://127.0.0.1:3425/v1", { scope });
      expect(s.ok, `恢复失败:${s.reason ?? ""}`).toBe(true);
      expect(s.recovered, "本执行者持有的不健康代理应有界恢复").toBe(true);
      egress = s;
      expect(dockerPs(scope.fwdContainer)).toBe(scope.fwdContainer);
    });

    it("⑤ 退出后清理:owner 匹配的 teardown 回收全部作用域资源,零残留", async () => {
      const { teardownEgress } = await import("../../src/runtime/egress.ts");
      const report = teardownEgress(scope);
      expect(
        report.deleted.some((x) => x.includes(scope.fwdContainer)),
        `报告:${JSON.stringify(report)}`,
      ).toBe(true);
      expect(
        report.deleted.some((x) => x.includes(scope.chain)),
        `报告:${JSON.stringify(report)}`,
      ).toBe(true);
      expect(
        report.deleted.some((x) => x.includes(scope.network)),
        `报告:${JSON.stringify(report)}`,
      ).toBe(true);
      expect(dockerPs(scope.fwdContainer)).toBe("");
      // 零残留:网络/链/规则/标记消失
      const netGone = (() => {
        try {
          execFileSync("docker", ["network", "inspect", scope.network], { stdio: "ignore", timeout: 30_000 });
          return false;
        } catch {
          return true;
        }
      })();
      expect(netGone).toBe(true);
      const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8", timeout: 30_000 });
      expect(out.includes(`-A ${scope.chain} `)).toBe(false);
      expect(out.includes(`${scope.ruleTag} owner=`)).toBe(false);
      egress = null;
    });

    it("⑥ 生产默认资源全程状态不变(DELTA 不变:不存在仍不存在/存在仍存在)", () => {
      const before = { net: defaultNetBefore, fwd: defaultFwdBefore };
      const after = stateOf();
      expect(after).toEqual(before);
    });
  },
);

describe("RELAY-EGRESS-ISOLATION-07R:双作用域隔离与强制同链碰撞(真 docker;零默认资源触碰)", {
  timeout: 300_000,
}, () => {
  // 每 run 唯一后缀:跨 run 不残留确定性链名(历史 run 残留会被本 run 合法认领,污染 DELTA 快照);
  // 两 id 仍共享前 8 字符("07rshare"),保留跨作用域派生区分的真实语境。
  const runTag = randomUUID().slice(0, 6);
  const A: EgressScope = createTestEgressScope(`07rshare-one-${runTag}`);
  const B: EgressScope = createTestEgressScope(`07rshare-two-${runTag}`);
  let defaultSnapshot = "";

  /** 默认面全快照:default 网络/代理容器/RELAY-EGRESS 链/DOCKER-USER/INPUT/监听端口(前后必须一致)。 */
  function defaultPlaneSnapshot(): string {
    const tryOut = (fn: () => string): string => {
      try {
        return fn();
      } catch {
        return "ABSENT";
      }
    };
    const net = tryOut(() => {
      const subnet = execFileSync(
        "docker",
        ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", "relay-egress-net"],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      const labels = execFileSync(
        "docker",
        ["network", "inspect", "-f", `{{index .Labels "relay.egress.owner"}}`, "relay-egress-net"],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      return `net:${subnet}|owner=${labels}`;
    });
    const fwd = tryOut(() => {
      const running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", "relay-egress-fwd"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
      const owner = execFileSync(
        "docker",
        ["inspect", "-f", `{{index .Config.Labels "relay.egress.owner"}}`, "relay-egress-fwd"],
        { encoding: "utf8", timeout: 30_000 },
      ).trim();
      return `fwd:running=${running}|owner=${owner}`;
    });
    const iptAll = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8", timeout: 30_000 });
    const defaultChain =
      iptAll
        .split("\n")
        .filter(
          (l) => l.includes("RELAY-EGRESS ") || l.startsWith("-A RELAY-EGRESS ") || l.startsWith("-N RELAY-EGRESS"),
        )
        .sort()
        .join("\n") || "chain:ABSENT";
    const dockerUser = iptAll
      .split("\n")
      .filter((l) => l.includes("DOCKER-USER"))
      .sort()
      .join("\n");
    const inputRelay =
      iptAll
        .split("\n")
        .filter((l) => l.includes("INPUT") && l.includes("relay-"))
        .sort()
        .join("\n") || "input:ABSENT";
    const ports = ["13425", "13426"]
      .map((pt) => {
        try {
          const out = execFileSync("ss", ["-ltn"], { encoding: "utf8", timeout: 30_000 });
          return `port${pt}:${out.includes(":" + pt + " ") ? "LISTENING" : "free"}`;
        } catch {
          return `port${pt}:unknown`;
        }
      })
      .join("|");
    return [net, fwd, defaultChain, dockerUser, inputRelay, ports].join("\n===\n");
  }

  afterAll(() => {
    const report = (() => {
      try {
        return teardownEgress(A);
      } catch (e) {
        return {
          deleted: [`error:${(e as Error).message}`],
          skipped: [] as Array<{ resource: string; reason: string }>,
        };
      }
    })();
    const reportB = (() => {
      try {
        return teardownEgress(B);
      } catch (e) {
        return {
          deleted: [`error:${(e as Error).message}`],
          skipped: [] as Array<{ resource: string; reason: string }>,
        };
      }
    })();
    console.log(
      `[egress-isolation-e2e-07r] 兜底 A deleted=${JSON.stringify(report.deleted)} B deleted=${JSON.stringify(reportB.deleted)}`,
    );
  });

  const simChainAbsent = (chain: string): boolean => {
    try {
      execFileSync("sudo", ["-n", "iptables", "-S", chain], { stdio: "ignore", timeout: 30_000 });
      return false;
    } catch {
      return true;
    }
  };

  it("默认面基线快照(套件前置)", () => {
    defaultSnapshot = defaultPlaneSnapshot();
    expect(defaultSnapshot.length).toBeGreaterThan(0);
  });

  it("双 scope(共享前 8 字符 id)各自建立:链名不同、规则各归其链", async () => {
    expect(A.chain).not.toBe(B.chain);
    const sa = await ensureEgress("http://127.0.0.1:3425/v1", { scope: A });
    expect(sa.ok, `ensure A:${sa.reason ?? ""}`).toBe(true);
    const sb = await ensureEgress("http://127.0.0.1:3425/v1", { scope: B });
    expect(sb.ok, `ensure B:${sb.reason ?? ""}`).toBe(true);
    // 分别验真实规则:各链规则只含本作用域标记
    const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8", timeout: 30_000 });
    const aRules = out.split("\n").filter((l) => l.includes(`-A ${A.chain} `));
    const bRules = out.split("\n").filter((l) => l.includes(`-A ${B.chain} `));
    expect(aRules.length).toBeGreaterThanOrEqual(2);
    expect(bRules.length).toBeGreaterThanOrEqual(2);
    expect(aRules.every((l) => l.includes(A.ruleTag))).toBe(true);
    expect(bRules.every((l) => l.includes(B.ruleTag))).toBe(true);
    expect(sa.fwdContainer).not.toBe(sb.fwdContainer);
    expect(sa.network).not.toBe(sb.network);
  });

  it("强制同链碰撞:预置他作用域规则的独立链 ⇒ ensure 拒绝且零写零清,第一方不变", async () => {
    // 独立新鲜 scope(其链此刻不存在;A/B 链已被双 scope 用例占用):
    // 手工按 C 的链名预置"他作用域"规则 ⇒ 人工制造同名碰撞现场。
    const C: EgressScope = createTestEgressScope(`07rcollide-${runTag}`);
    expect(simChainAbsent(C.chain)).toBe(true);
    execFileSync("sudo", ["-n", "iptables", "-N", C.chain], { timeout: 30_000 });
    execFileSync(
      "sudo",
      [
        "-n",
        "iptables",
        "-A",
        C.chain,
        "-p",
        "tcp",
        "-j",
        "DROP",
        "-m",
        "comment",
        "--comment",
        "relay-test-foreign owner=someone-else",
      ],
      { timeout: 30_000 },
    );
    try {
      const sc = await ensureEgress("http://127.0.0.1:3425/v1", { scope: C });
      expect(sc.ok, `碰撞链必须拒绝:${sc.reason ?? ""}`).toBe(false);
      // 第一方(预置的他作用域规则)完全不变
      const out = execFileSync("sudo", ["-n", "iptables", "-S", C.chain], { encoding: "utf8", timeout: 30_000 });
      expect(out).toContain("relay-test-foreign");
      expect(out).not.toContain(C.ruleTag);
    } finally {
      // 自建碰撞链的有界自证清理(仅 C 链;default 零触碰)
      try {
        execFileSync("sudo", ["-n", "iptables", "-F", C.chain], { timeout: 30_000 });
        execFileSync("sudo", ["-n", "iptables", "-X", C.chain], { timeout: 30_000 });
      } catch {
        /* 清理尽力 */
      }
    }
  });

  it("teardown A 后 B 仍健康;teardown B 后双域零残留", async () => {
    const rA = teardownEgress(A);
    expect(
      rA.deleted.some((x) => x.includes(A.chain)),
      `报告 A:${JSON.stringify(rA)}`,
    ).toBe(true);
    // B 仍健康:规则核验 + 计数端点 + 容器在跑
    const sb2 = await ensureEgress("http://127.0.0.1:3425/v1", { scope: B });
    expect(sb2.ok, `B 复用失败:${sb2.reason ?? ""}`).toBe(true);
    expect(sb2.reused, "B 的健康栈必须被复用而非重建").toBe(true);
    expect(verifyEgressRules(sb2.subnet!, sb2.hostIp!, sb2.modelPort!, B)).toBe(true);
    const { teardownEgress: td, readEgressRequestCount } = await import("../../src/runtime/egress.ts");
    expect(await readEgressRequestCount(3000, B.countPort)).not.toBeNull();
    const rB = td(B);
    expect(
      rB.deleted.some((x) => x.includes(B.chain)),
      `报告 B:${JSON.stringify(rB)}`,
    ).toBe(true);
    // 双域零残留
    const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8", timeout: 30_000 });
    expect(out.includes(`-A ${A.chain} `)).toBe(false);
    expect(out.includes(`-A ${B.chain} `)).toBe(false);
    expect(out.includes(`${A.ruleTag} owner=`)).toBe(false);
    expect(out.includes(`${B.ruleTag} owner=`)).toBe(false);
    const ps = (name: string) =>
      execFileSync("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
    expect(ps(A.fwdContainer)).toBe("");
    expect(ps(B.fwdContainer)).toBe("");
  });

  it("默认面前后一致(DELTA 不变:网络/代理/链/DOCKER-USER/INPUT/端口)", () => {
    expect(defaultPlaneSnapshot()).toBe(defaultSnapshot);
  });
});
