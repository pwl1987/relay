// R2-REMEDIATION-01 单元测试:maxOutputTokens 运行时配置项(零模型;零网络)。
// 覆盖合同测试清单:未配置默认值 / 配置透传 / 上下界 / 超界 fail-closed / 8192 不再被无条件硬编码。
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  appliedMaxOutputTokens,
  prepareRunDirs,
  resolveMaxOutputTokens,
  cleanupSandbox,
  type ModelConfig,
} from "../../src/runtime/sandbox.ts";

const MODEL_BASE: ModelConfig = { provider: "p", model: "m", apiKey: "k", baseUrl: "http://127.0.0.1:1/v1" };

describe("R2-REMEDIATION-01:maxOutputTokens 运行时配置", () => {
  it("resolveMaxOutputTokens:未配置(undefined/null/空串)⇒ undefined(调用方取默认)", () => {
    expect(resolveMaxOutputTokens(undefined)).toBeUndefined();
    expect(resolveMaxOutputTokens(null)).toBeUndefined();
    expect(resolveMaxOutputTokens("")).toBeUndefined();
    expect(resolveMaxOutputTokens("   ")).toBeUndefined();
  });

  it("resolveMaxOutputTokens:配置透传(数字/数字字符串/带空白)", () => {
    expect(resolveMaxOutputTokens(32768)).toBe(32768);
    expect(resolveMaxOutputTokens("32768")).toBe(32768);
    expect(resolveMaxOutputTokens(" 32768 ")).toBe(32768);
    expect(resolveMaxOutputTokens(MIN_MAX_OUTPUT_TOKENS)).toBe(MIN_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(MAX_MAX_OUTPUT_TOKENS)).toBe(MAX_MAX_OUTPUT_TOKENS);
  });

  it("resolveMaxOutputTokens:超界/非法 fail-closed(抛错,不静默钳制)", () => {
    for (const bad of [0, -1, 1.5, "abc", "8192.0x", MIN_MAX_OUTPUT_TOKENS - 1, MAX_MAX_OUTPUT_TOKENS + 1, Number.NaN, Infinity]) {
      expect(() => resolveMaxOutputTokens(bad), String(bad)).toThrow(/invalid maxOutputTokens/);
    }
  });

  it("默认值=8192(保持历史行为兼容;常量显式导出,不再散落硬编码)", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8192);
    expect(appliedMaxOutputTokens(MODEL_BASE)).toBe(8192);
    expect(appliedMaxOutputTokens({ ...MODEL_BASE, maxOutputTokens: 32768 })).toBe(32768);
  });

  it("prepareRunDirs:models.json 写入最终采用值(默认路径=8192;配置路径=透传)", () => {
    const readMaxTokens = (model: ModelConfig): number => {
      const spec = prepareRunDirs(tmpdir(), "host-fallback", model);
      try {
        const modelsJson = JSON.parse(readFileSync(join(spec.homeDir, ".pi", "agent", "models.json"), "utf8")) as {
          providers: Record<string, { models: Array<{ maxTokens: number }> }>;
        };
        return modelsJson.providers[model.provider]!.models[0]!.maxTokens;
      } finally {
        cleanupSandbox(spec);
      }
    };
    expect(readMaxTokens(MODEL_BASE)).toBe(8192); // 未配置 ⇒ 默认(行为兼容)
    expect(readMaxTokens({ ...MODEL_BASE, maxOutputTokens: 32768 })).toBe(32768); // 配置透传
    expect(readMaxTokens({ ...MODEL_BASE, maxOutputTokens: 128_000 })).toBe(128_000); // 上界可用
  });

  it("prepareRunDirs:非法 maxOutputTokens 在 Run 目录构造即拒(fail-closed,不产生半配置沙箱)", () => {
    const dirBefore = mkdtempSync(join(tmpdir(), "mot-guard-"));
    expect(() => prepareRunDirs(dirBefore, "host-fallback", { ...MODEL_BASE, maxOutputTokens: 999_999 })).toThrow(/invalid maxOutputTokens/);
    expect(() => prepareRunDirs(dirBefore, "host-fallback", { ...MODEL_BASE, maxOutputTokens: 0 })).toThrow(/invalid maxOutputTokens/);
  });

  it("上下界常量与 contextWindow 一致(128000;输出上限不得超过模型上下文窗口)", () => {
    expect(MIN_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(MAX_MAX_OUTPUT_TOKENS).toBe(128_000);
  });
});
