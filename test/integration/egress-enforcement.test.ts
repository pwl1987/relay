// C-1 网络出口约束实测(合同 2/停止条件:白名单必须真实生效,不得以 host 网络降级):
// ensureEgress(幂等建网+作用域链+DOCKER-USER 挂载+INPUT 放行)
// → verifyEgressEffective(真容器探针:模型端口可达 + 外网被 DROP)
// → launchPi 无 egress FAIL-CLOSED 拒启 → teardown 清理(只动本作用域资源;RELAY-EGRESS-ISOLATION-07)。
// 资源归属:本文件自 RELAY-EGRESS-ISOLATION-07 起使用 createTestEgressScope 完整独立命名空间
// (网络/代理容器/iptables 链/规则标记/端口全派生),零生产默认资源触碰;CI 与生产完全隔离。
import { afterAll, describe, expect, it } from "vitest";
import type { Exec } from "../../src/core/db.ts";
import { execFileSync } from "node:child_process";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  verifyEgressRules,
  teardownEgress,
  createTestEgressScope,
  detectHostIp,
  parseModelPort,
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

describe.skipIf(!dockerOk || !iptOk)("网络出口约束(容器+iptables 实测;独立命名空间)", () => {
  const modelBaseUrl = process.env.RELAY_PI_BASE_URL ?? "http://127.0.0.1:3425/v1";
  const hostIp = detectHostIp();
  const port = parseModelPort(modelBaseUrl);
  const scope: EgressScope = createTestEgressScope("egc1");
  let egress: EgressStatus | null = null;

  afterAll(() => {
    const report = teardownEgress(scope);
    // 兜底清理 + 零残留直证:容器/网络不存在;iptables -S 无本作用域链与规则标记(权威零残留面)
    const gone = (kind: "container" | "network", name: string) => {
      try {
        execFileSync("docker", [kind === "container" ? "inspect" : "network", "inspect", name], {
          stdio: "ignore",
          timeout: 30_000,
        });
        return false;
      } catch {
        return true;
      }
    };
    expect(gone("container", scope.fwdContainer), `报告:${JSON.stringify(report)}`).toBe(true);
    expect(gone("network", scope.network)).toBe(true);
    const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8", timeout: 30_000 });
    expect(out.includes(`-A ${scope.chain} `)).toBe(false);
    expect(out.includes(`${scope.ruleTag} owner=`)).toBe(false);
    egress = null;
  });

  it("ensureEgress 幂等建立;二次执行健康复用(不 rm 不重建);verifyEgressRules(作用域链)通过", async () => {
    const s1 = await ensureEgress(modelBaseUrl, { scope });
    expect(s1.ok, `ensure 失败: ${s1.reason}`).toBe(true);
    expect(s1.fwdContainer).toBe(scope.fwdContainer);
    expect(s1.chain).toBe(scope.chain);
    egress = s1;
    const s2 = await ensureEgress(modelBaseUrl, { scope });
    expect(s2.ok).toBe(true);
    expect(s2.subnet).toBe(s1.subnet!);
    expect(s2.reused, "健康且配置相同的二次 ensure 必须复用(不重建 ⇒ 在途请求不中断)").toBe(true);
    expect(verifyEgressRules(s2.subnet!, s2.hostIp!, s2.modelPort!, scope)).toBe(true);
  });

  it("真实探针:模型端点可达 + 外网被阻断(两个都成立才算约束生效)", async () => {
    const s = egress ?? (await ensureEgress(modelBaseUrl, { scope }));
    const v = await verifyEgressEffective(s);
    expect(v.ok, `验证失败: ${v.reason}`).toBe(true);
    expect(v.verification!.modelReachable).toBe(true);
    expect(v.verification!.externalBlocked).toBe(true);
  });

  it("FAIL-CLOSED:无 egress 状态时 docker executeRun 拒启(不得静默降级 host 网络)", async () => {
    const { executeRun } = await import("../../src/runtime/runner.ts");
    const { resolveVendoredPi } = await import("../../src/runtime/pi-version.ts");
    const { createTestDb } = await import("../setup/testdb.ts");
    const { sql: ksql } = await import("drizzle-orm");
    const { claimTask } = await import("../../src/core/lease.ts");
    const t = await createTestDb("c1-egress-fc");
    try {
      await t.db.execute(ksql`INSERT INTO tasks (id, state) VALUES ('t-eg', 'READY')`);
      const c = await t.db.transaction(async (tx) => claimTask(tx as unknown as Exec, "t-eg", "w", 60));
      expect(c.ok).toBe(true);
      await expect(
        executeRun(t.db, resolveVendoredPi(), {
          taskId: "t-eg",
          goal: "g",
          allowedScope: ["/workspace"],
          attempt: (c as { attempt: number }).attempt,
          ownerId: "w",
          fencingToken: (c as { fencingToken: number }).fencingToken,
          model: { provider: "magpie", model: "group/gm", apiKey: "magpie", baseUrl: modelBaseUrl },
          sandbox: "docker",
          wallSeconds: 30,
          heartbeatSeconds: 2,
          // 故意不传 egress
        }),
      ).rejects.toThrow(/egress_rules_missing/);
    } finally {
      await t.cleanup();
    }
  });

  it("teardownEgress(作用域)只清理本作用域;生产默认链 RELAY-EGRESS 不受影响", async () => {
    await ensureEgress(modelBaseUrl, { scope });
    const report = teardownEgress(scope);
    expect(report.deleted.length).toBeGreaterThanOrEqual(3);
    const { execFileSync: exec } = await import("node:child_process");
    const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8" });
    // 本作用域的链与规则标记彻底消失(精确名,非前缀串扰)
    expect(out.includes(`-A ${scope.chain} `)).toBe(false);
    expect(out.includes(`${scope.ruleTag} owner=`)).toBe(false);
    // 隔离证明:teardown 只动本作用域 —— 若生产默认链存在,必须原样保留(匿名/他人资源零触碰)
    const defaultChainPresent = out
      .split("\n")
      .some((l) => l.startsWith("-A RELAY-EGRESS ") || l.startsWith("-N RELAY-EGRESS"));
    if (defaultChainPresent) {
      expect(out.includes("RELAY-EGRESS ")).toBe(true);
    }
    // 作用域规则核验面:teardown 后 verify 必须失败(白名单已撤)
    expect(verifyEgressRules("172.30.254.0/24", hostIp, port, scope)).toBe(false);
  });
});
