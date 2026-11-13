// RELAY-CONTROL-READY-03 P0-2:生产 Gate 可用性 —— 功能性机器检查环境配置(resolveEvidenceChecks)。
// 严格校验 fail-closed:非法 JSON/非数组/空数组/非功能性 kind/坏 command/越界超时 ⇒ 启动即抛;
// 未配置 ⇒ 不注入 ⇒ Gate 编排保守停机(SAFETY-CLOSE-02 P0-B 语义,不得由用户消息/模型文本/manifest 顶替)。
import { describe, expect, it } from "vitest";
import { resolveEvidenceChecks, startWorkerEntry } from "../../src/worker-entry.ts";

const VALID = JSON.stringify([
  { kind: "deterministic_test", command: ["node", "-e", "console.log('ok')"] },
  { kind: "api_behavior", command: ["node", "-e", "process.exit(0)"], timeoutMs: 30000 },
]);

describe("RELAY-CONTROL-READY-03 P0-2:evidenceChecks 环境配置(fail-closed)", () => {
  it("合法配置 ⇒ 解析为 CheckSpec[](cwdWorkspace 缺省 true;超时/期望输出透传)", () => {
    const out = resolveEvidenceChecks(VALID);
    expect(out).toHaveLength(2);
    expect(out![0]).toMatchObject({ kind: "deterministic_test", cwdWorkspace: true });
    expect(out![1]).toMatchObject({ kind: "api_behavior", timeoutMs: 30000 });
    expect(out![1]!.cwdWorkspace).toBe(true);
  });

  it("未配置(undefined/空串)⇒ undefined(不注入 ⇒ Gate 保守停机,不伪装)", () => {
    expect(resolveEvidenceChecks(undefined)).toBeUndefined();
    expect(resolveEvidenceChecks("")).toBeUndefined();
  });

  it("fail-closed:非法 JSON/非数组/空数组/非功能性 kind/坏 command/越界 timeout 全部抛错", () => {
    expect(() => resolveEvidenceChecks("not-json")).toThrow(/非法 JSON/);
    expect(() => resolveEvidenceChecks('{"kind":"deterministic_test"}')).toThrow(/必须为 CheckSpec 数组/);
    expect(() => resolveEvidenceChecks("[]")).toThrow(/空数组/);
    expect(() => resolveEvidenceChecks('[{"kind":"reviewer_output","command":["true"]}]')).toThrow(/功能性证据/);
    expect(() => resolveEvidenceChecks('[{"kind":"candidate_manifest_verify","command":["true"]}]')).toThrow(
      /功能性证据/,
    );
    expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":[]}]')).toThrow(/非空字符串数组/);
    expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":["x",1]}]')).toThrow(/非空字符串数组/);
    expect(() => resolveEvidenceChecks('[{"kind":"deterministic_test","command":["x"],"timeoutMs":5}]')).toThrow(
      /1000~600000/,
    );
  });

  it("startWorkerEntry:非法配置在连接 DB 之前即抛(启动 fail-closed,零连接零副作用)", () => {
    const saved = process.env.RELAY_EVIDENCE_CHECKS_JSON;
    try {
      process.env.RELAY_EVIDENCE_CHECKS_JSON = "broken";
      expect(() => startWorkerEntry({ dbUrl: "postgresql://postgres:pw@127.0.0.1:55433/relayp000" })).toThrow(
        /非法 JSON/,
      );
    } finally {
      if (saved === undefined) delete process.env.RELAY_EVIDENCE_CHECKS_JSON;
      else process.env.RELAY_EVIDENCE_CHECKS_JSON = saved;
    }
  });

  it("startWorkerEntry:合法配置 ⇒ 正常启动(provider 未配置 ⇒ IDLE_PROVIDER_DOWN 不领取)+ 检查随 driver 注入", {
    timeout: 60_000,
  }, async () => {
    const saved = process.env.RELAY_EVIDENCE_CHECKS_JSON;
    try {
      process.env.RELAY_EVIDENCE_CHECKS_JSON = VALID;
      // 守卫放行的默认测试库三元组;provider 未配置 ⇒ tick 直接 IDLE_PROVIDER_DOWN(零沙箱零模型)
      const { handle, driver } = startWorkerEntry({
        dbUrl: "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000",
      });
      try {
        const report = await driver.tick();
        expect(report.status).toBe("IDLE_PROVIDER_DOWN");
      } finally {
        await handle.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.RELAY_EVIDENCE_CHECKS_JSON;
      else process.env.RELAY_EVIDENCE_CHECKS_JSON = saved;
    }
  });
});
