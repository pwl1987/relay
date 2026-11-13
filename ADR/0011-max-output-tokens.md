# ADR-0011:模型输出上限(maxOutputTokens)从硬编码改为运行时配置项

- 状态:ACCEPTED(2026-11-13;R2-REMEDIATION-01 包合同=用户指令 2026-11-13)
- 关联:R-2 对照报告(`p0-mvp/r2-contrast/REPORT-r2-contrast.md`)、MODEL-POLICY-00(冻结维持,本 ADR 不属于 MODEL-POLICY-01)

## 背景

R-2 F1 对照实验(2026-11-12,zcode/GLM-5.3)实证:Run 可完成但 coder 输出在恰好 8192 tokens 处被截断,
零文件修改、机判拒、Reviewer BLOCK。根因=Relay 沙箱侧硬编码:
`src/runtime/sandbox.ts` 为 Run 写入的 Pi `models.json` 模型条目固定 `maxTokens: 8192`,
而模型自身上限远高于此(Pi contract 核验:`provider-composer.js` 按 `override.maxTokens ?? model.maxTokens`
取值;模型定义缺省 16384;≤0 抛 invalid maxTokens)。该值是 **Relay Runtime 配置阻断**,
不应继续归因于 GLM 编码能力。

## 决策

1. 新增运行时配置项 **`maxOutputTokens`**(`ModelConfig` 可选字段;Worker env `RELAY_MAX_OUTPUT_TOKENS`),
   Runner/Sandbox 一路透传至 `prepareRunDirs` 写入的 `models.json` 现成字段 `maxTokens`——
   **复用 Pi 既有字段,不新造重复配置,不改 Pi Runtime**。
2. 默认值 `DEFAULT_MAX_OUTPUT_TOKENS = 8192`:保持未配置行为与历史完全兼容;不做 8192→128000 的
   另一次硬编码替换。
3. 上下界:`MIN_MAX_OUTPUT_TOKENS = 1024`,`MAX_MAX_OUTPUT_TOKENS = 128_000`
   (=models.json `contextWindow`;输出上限超过模型上下文窗口无意义)。
4. 超界 **fail-closed**:`resolveMaxOutputTokens` 抛错 ⇒ Worker 环境非法时本拍不领取(envModel 抛错→
   safe loop TICK_ERROR+熔断审计;worker-entry 启动横幅即抛);Run 侧在沙箱目录构造时即拒。
5. Evidence 记录最终采用值:coder/reviewer/discovery 三类 Run 的 `runs.budget` jsonb 记
   `maxOutputTokens` + `maxOutputTokensSource: "default"|"config"`;Run 全程可审计、可对照。
6. Budget(模型调用/turns 账本)、attempt、Reviewer/Gate 语义**独立且不受影响**;模型侧仍受
   Pi/Provider 自身约束,"不允许模型自行突破"由请求参数钳制保证。

## 后果

- 未配置环境(含全部既有测试/生产 worker)行为零变化;
- F2-R/F1-R 复验(2026-11-13 授权)以 `RELAY_MAX_OUTPUT_TOKENS=32768` 为唯一实验变量;
- 后续模型策略(MODEL-POLICY-01)激活时可基于此配置项实施 RunModelDecision,无需再次改沙箱。

## 语义澄清(READINESS-01 子包②,2026-11-13;仅措辞,不改决策)

决策第 4 条原文「本拍不领取」表述不精确,实测行为核验(src/core/loop-safety.ts)后澄清:
Worker 环境非法(`RELAY_MAX_OUTPUT_TOKENS` 非法)时 `envModel` 抛错沿 tick 向上传播 ⇒
**该拍不领取任务并由 loop-safety 计连续错误与审计;连续 3 拍错误(阈值默认 3)⇒ 整环熔断
`circuitOpen`,停止调度新 tick**——即 fail-closed 的实现机制是「错误累积→环路熔断」,
不是单拍优雅跳过后继续正常调度。fail-closed 性质不变(非法配置永不进入 Run、审计留痕),
仅明确熔断的触发方式。

另:三处 `runs.budget` 证据字段(决策第 5 条)自 READINESS-01 起由 `sandbox.ts` 的
`budgetEvidence()` 单一来源生成;来源语义与 `resolveMaxOutputTokens` 对齐
(undefined/null/空串一律记 `"default"`,仅通过校验的配置值记 `"config"`);
`MAX_MAX_OUTPUT_TOKENS` 与 `models.json` 条目的 `contextWindow` 共享同一常量(消除双字面量)。
