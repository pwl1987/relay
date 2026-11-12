# R2-REMEDIATION-01 报告:模型输出上限硬编码修复与真实复验

- 包合同:用户指令 2026-11-13(下一阶段完整执行大包第②项)
- 实现 SHA:`6d3eddb`(ADR-0011;`maxOutputTokens` 运行时配置项)
- 状态:**进行中(F2-R 已消耗=FAILED 归因基础设施;F1-R 待上游恢复窗口后一次正式尝试)**

## 1. 修复内容(摘要)

- 根因(历史 R-2 F1,2026-11-12):coder 输出恰 8192 tokens 截断、零文件修改,系
  `src/runtime/sandbox.ts` 为 Run 写入的 Pi `models.json` 模型条目硬编码 `maxTokens: 8192`。
- 修复:运行时配置项 `maxOutputTokens`(`ModelConfig` 可选字段 + Worker env `RELAY_MAX_OUTPUT_TOKENS`),
  透传链 worker.ts envModel → driver → runTask/discovery/reviewer → prepareRunDirs → `models.json`
  现成字段 `maxTokens`(Pi contract:`provider-composer.js` 的 `override.maxTokens ?? model.maxTokens`)。
- 默认值 8192(未配置行为零变化,不做 8192→128000 二次硬编码);上下界 1024~128000
  (=models.json `contextWindow`);超界 fail-closed(envModel 本拍不领取熔断 / worker-entry 启动即拒 /
  prepareRunDirs 构造即拒);Evidence 记录最终采用值与来源(`runs.budget` jsonb
  `maxOutputTokens`/`maxOutputTokensSource`,coder/reviewer/discovery 三类同口径)。
- 自动测试:unit `max-output-tokens` 7/7;typecheck 绿;全量回归 259 过(4 败均定性与本 diff 零交集:
  pi-e2e 2=magpie 方差签名隔离复跑 2/2 绿;github-real 2=网络劣化 ls-remote/ETIMEDOUT 签名)。
- 详见 ADR-0011。

## 2. 复验条件(与历史 F2/F1 完全一致,唯一实验变量 maxOutputTokens)

| 参数 | 值(与 2026-11-12 授权逐项一致) |
| --- | --- |
| model_ref | `zcode/GLM-5.3`(Magpie 网关 127.0.0.1:3425) |
| Coder 预算 | reserve 6/run(F2)·12/run(F1) |
| Reviewer 预算 | reserve 4/run,attempts 1 |
| Goal 预算 | F2=10,F1=30 model_calls |
| wall | F2=420s,F1=600s |
| Gate | 原 API 机判(F2)/Playwright 机判(F1)不变 |
| Reviewer | 原独立 Reviewer 链不变 |
| Fixture | 原 F2 bug 夹具/原 F1 UX journey 夹具不变 |
| **唯一实验变量** | `RELAY_MAX_OUTPUT_TOKENS=32768` |

## 3. F2-R:一次正式尝试 = **FAILED(归因:上游基础设施故障;能力结论不可用)**

- 执行:2026-11-13 01:25:57,117s,`RELAY_F2_E2E=1` + PI 凭据(env 文件 0600,零打印)+ `RELAY_MAX_OUTPUT_TOKENS=32768`。
- 原始日志:`p0-mvp/r2-remediation/f2r-run-20261113.log`;运行证据:`test-evidence/f2/`(runs-detail/tick-summary/gate-evidence)。
- 失败点:tick `PROGRESSED`,coder run `SUCCEEDED`(空转),**Gate `NEEDS_DECISION`(no_verdict:no_gate_verdict_fence)**。
- **归因(网关账本铁证,`magpie-usage-evidence-20261113.jsonl`)**:F2-R 窗口(01:26:02~01:27:53)全部
  **8 次上游请求 status=502 `proxyconnect tcp: 503 Forwarding failure`,`in=0/out=0` 零 token**——
  即 Magpie→api.z.ai 的出口代理链路在两次尝试期间硬故障,模型侧从未收到任何真实补全。
  (初版报告曾按「magpie 方差/零工具退化」归因,经网关账本对账**修正**为上游 502 硬故障。)
- 账本对账偏差(如实):coder run 的 `detail.budget` 记 tokensIn 20000/tokensOut 4000,
  为 **预留记账值**(按 4 次调用×预留额度结算),与网关零 token 矛盾——
  「ledger 消耗 ≠ 真实上游 token」再次实证(与 CONTINUATION 对账注记同源),对账纪律候选包。
- 结论:**本次尝试消耗(合同:失败不得自动重跑);失败归因=上游 502 硬故障,
  不是 maxOutputTokens 变量的能力结论,也不是 8192 钳制复现**。
- 证据缺口(如实,经 Reviewer F-1 修正):本次运行的 `runs.budget` jsonb(含 maxOutputTokens 运行时采用值)
  未被测试证据捕获(F2 夹具当时只导出 `detail` 列);已补 F1/F2 夹具证据查询增列 `budget`——
  **但 F1-R 在 discovery 首步即断,runs-detail 导出从未执行,故 32768 的运行时采用值在两次尝试中
  均未实际入证**;透传正确性由 unit 7/7(models.json 实读断言)与 env 导出事实保证(Reviewer F-2:
  runs-detail 导出缺 `runtime`/`model_ref` 列的自足性缺口已随 digest 补列,供后续窗口使用)。

## 4. F1-R:一次正式尝试 = **FAILED(归因:上游 502 硬故障;能力结论不可用)**

- 执行:2026-11-13 01:50:38,63s,`RELAY_F1_E2E=1` + PI 凭据 + `RELAY_MAX_OUTPUT_TOKENS=32768`
  (上游选择依据:01:44~01:46 生产冒烟 Run 的 5 次上游调用全部 200(真实 token 流动),
  判定窗口可用;01:50 起上游再次硬故障)。
- 失败点:第一步 discovery 即 `no_report:no_discovery_fence`(F1 测试 155 行断言如实失败)。
- **归因(网关账本铁证)**:F1-R 窗口(01:50:40~01:51:32)全部 **4 次上游请求 status=502
  proxyconnect,`in=0/out=0` 零 token**。discovery 无从产出报告栅栏。
- 证据文件:`p0-mvp/r2-remediation/f1r-run-20261113.log` + `test-evidence/f1/discovery.json` +
  网关账本归档。
- 结论:**本次尝试消耗(合同:失败不得自动重跑);失败归因=上游 502 硬故障,与 F2-R 同源**。

## 5. 对照结论

| 维度 | 历史 F1(2026-11-12,授权四参数) | F2-R / F1-R(2026-11-13,maxOutputTokens=32768) |
| --- | --- | --- |
| 上游状态 | 可服务(F2 7×200;F1 13×200) | **12 次请求全 502、零 token(网关账本)** |
| 实验执行 | F2 止损 BUDGET_EXHAUSTED@6;F1 run SUCCEEDED 零编辑+8192 截断根因定位 | F2-R coder 空转+reviewer error;F1-R discovery 首步即断 |
| 能力结论 | 8192 钳制=Runtime 配置阻断(非 GLM 编码能力) | **两次尝试均被基础设施否决,真实模型能力对照不可判定** |

**最终结论**:①8192 硬编码已移除,`maxOutputTokens` 运行时配置项落地(unit 7/7+透传链
models.json 实读断言+Pi contract 核验=复用现成字段);②真实模型端到端对照(8192 vs 32768)
**在 2026-11-13 授权框架内不可判定**——两次正式尝试的全部上游请求被出口代理 502 否决
(网关账本 12 条铁证),合同禁止自动重跑;③修复保留(默认 8192 行为兼容,生产采值
32768 的切换待上游稳定窗口的新授权);④未验证项=真实模型端到端能力对照、生产 worker
32768 采值验证。**R2-REMEDIATION-01 = 工程 REMEDIATION 完成 + 能力对照 UNRESOLVED(基础设施阻断,非代码阻断)**。
