// C-1 网络出口约束实测(合同 2/停止条件:白名单必须真实生效,不得以 host 网络降级):
// ensureEgress(幂等建网+RELAY-EGRESS 链+DOCKER-USER 挂载+INPUT 放行)
// → verifyEgressEffective(真容器探针:模型端口可达 + 外网被 DROP)
// → launchPi 无 egress FAIL-CLOSED 拒启 → teardown 清理(只动本包规则)。
import { afterAll, describe, expect, it } from "vitest";
import type { Exec } from "../../src/core/db.ts";
import { execFileSync } from "node:child_process";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  verifyEgressRules,
  teardownEgress,
  detectHostIp,
  parseModelPort,
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

describe.skipIf(!dockerOk || !iptOk)("网络出口约束(容器+iptables 实测)", () => {
  const modelBaseUrl = process.env.RELAY_PI_BASE_URL ?? "http://127.0.0.1:3425/v1";
  const hostIp = detectHostIp();
  const port = parseModelPort(modelBaseUrl);

  afterAll(() => {
    teardownEgress();
  });

  it("ensureEgress 幂等建立;两次执行结果一致;verifyEgressRules 通过", async () => {
    const s1 = await ensureEgress(modelBaseUrl);
    expect(s1.ok, `ensure 失败: ${s1.reason}`).toBe(true);
    const s2 = await ensureEgress(modelBaseUrl);
    expect(s2.ok).toBe(true);
    expect(s2.subnet).toBe(s1.subnet!);
    expect(verifyEgressRules(s2.subnet!, s2.hostIp!, s2.modelPort!)).toBe(true);
  });

  it("真实探针:模型端点可达 + 外网被阻断(两个都成立才算约束生效)", async () => {
    const s = await ensureEgress(modelBaseUrl);
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

  it("teardownEgress 清理后规则消失(只动本包标记的规则)", async () => {
    await ensureEgress(modelBaseUrl);
    teardownEgress();
    const { execFileSync: exec } = await import("node:child_process");
    const out = execFileSync("sudo", ["-n", "iptables", "-S"], { encoding: "utf8" });
    expect(out.includes("RELAY-EGRESS")).toBe(false);
    expect(out.includes("relay-p01c-egress")).toBe(false);
  });
});
