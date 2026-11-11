// 能力登记表的诚实性(P0-02C D-5 / 反例 10):
// 未实现的能力必须显式标记;系统**不得**声称拥有模型驱动的发现/推荐。
import { describe, expect, it } from "vitest";
import { buildCapabilityRegistry } from "../../src/server/capabilities.ts";
import { readFileSync } from "node:fs";

function registry() {
  return buildCapabilityRegistry("stub", "2026-01-01T00:00:00.000Z");
}

describe("P0-02C:能力登记表", () => {
  it("模型驱动的发现与推荐状态如实(REWORK-1 P0 最小=IMPLEMENTED;公网搜索仍 NOT_IMPLEMENTED)", () => {
    const reg = registry();
    const discovery = reg.entries.find((e) => e.id === "goal.discovery.model");
    const recommendation = reg.entries.find((e) => e.id === "goal.recommendation.model");
    // REWORK-1:本地只读调查最小闭环已实现(真模型联验 p0-rework1/REPORT.md)
    expect(discovery?.status).toBe("IMPLEMENTED");
    expect(discovery?.note).toContain("P0 最小");
    expect(discovery?.note).toContain("P1"); // 公网 Search/Crawler 仍 NOT_IMPLEMENTED,如实登记
    expect(recommendation?.status).toBe("IMPLEMENTED");
    expect(recommendation?.note).toContain("规则"); // 无记录/失败时规则面兜底,不冒充模型
  });

  it("D3 超时自动批准标记为 NOT_IMPLEMENTED(永不存在)", () => {
    const entry = registry().entries.find((e) => e.id === "decision.d3.auto_approve");
    expect(entry?.status).toBe("NOT_IMPLEMENTED");
    expect(entry?.note).toContain("永不存在");
  });

  it("GitHub 真实写入标记为 NOT_VERIFIED(不得声称已通过)", () => {
    const entry = registry().entries.find((e) => e.id === "delivery.github.real");
    expect(entry?.status).toBe("NOT_VERIFIED");
    expect(entry?.note).toContain("NOT_VERIFIED");
  });

  it("桩执行面如实标注为 STUB", () => {
    const reg = buildCapabilityRegistry("stub", "2026-01-01T00:00:00.000Z");
    const entry = reg.entries.find((e) => e.id === "worker.model");
    expect(entry?.status).toBe("STUB");
    expect(reg.workerMode).toBe("stub");
  });

  it("源码自证:服务端不存在 D3 自动批准路径(无 approve-on-timeout 代码面)", () => {
    // 剥离注释后扫描服务端源码:不得出现"超时即批准"这类自动批准语句。
    // 注:capabilities.ts 显式登记了 "decision.d3.auto_approve" 这个能力 id
    //     (用于把"不存在"这件事标注出来),因此不纳入"不得出现 auto_approve 字样"的扫描面。
    const files = ["src/server/api.ts", "src/server/views.ts", "src/server/app.ts", "src/server/worker.ts"];
    const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of files) {
      const code = strip(readFileSync(new URL("../../" + f, import.meta.url), "utf8"));
      expect(code).not.toMatch(/setTimeout\s*\([^)]*approve/i);
      expect(code).not.toMatch(/auto[-_]?approve/i);
      expect(code).not.toMatch(/timeout\s*=>\s*\{[^}]*approve/i);
      expect(code).not.toMatch(/setInterval\s*\([^)]*approve/i);
    }
    // core 侧同样自证:超时处理只标 EXPIRED_STILL_BLOCKED,绝不改判为已批准。
    const coreDecisions = strip(readFileSync(new URL("../../src/core/decisions.ts", import.meta.url), "utf8"));
    expect(coreDecisions).toContain("EXPIRED_STILL_BLOCKED");
    expect(coreDecisions).not.toMatch(/RESOLVED_MANUAL[\s\S]{0,200}expireStale/i);
  });
});
