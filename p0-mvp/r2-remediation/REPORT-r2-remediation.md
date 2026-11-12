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

## 3. F2-R:一次正式尝试 = **FAILED(归因:基础设施劣化;能力结论不可用)**

- 执行:2026-11-13 01:25:57,117s,`RELAY_F2_E2E=1` + PI 凭据(env 文件 0600,零打印)+ `RELAY_MAX_OUTPUT_TOKENS=32768`。
- 原始日志:`p0-mvp/r2-remediation/f2r-run-20261113.log`;运行证据:`test-evidence/f2/`(runs-detail/tick-summary/gate-evidence)。
- 失败点:tick `PROGRESSED`,coder run `SUCCEEDED`,**Gate `NEEDS_DECISION`(no_verdict:no_gate_verdict_fence)**。
- 归因证据:
  1. **Reviewer run(run-5bece912)上游故障铁证**:`stopReason:"error"`、usage 全零、auto_retry×3 全败、
     `no_verdict:no_gate_verdict_fence`(runs-detail.json)。即外部上游(zcode 经 Magpie)在本次窗口不可用。
  2. **Coder run(run-f3bd40ca)零工具调用**:4 次模型调用(tokensIn 20000/tokensOut 4000)、
     `toolCallEvents:0`、`toolAuditLines:0`、`changeset.diff` 空、`candidateCommitError:base_commit_missing`——
     与已落账的「magpie 间歇挂起/方差极端(零编辑/烧回合)」签名一致;输出均值 ~1000 tokens/次,
     **未触及任何输出上限钳制**(旧 8192 或新 32768 都不是本次失败的因素)。
  3. 外部网络窗口:本次尝试期间 GitHub SSH/HTTPS/gh API 三路均断(探测循环 40×45s 无一成功),
     zcode 上游与该劣化同路径。
- 结论:**本次尝试消耗(合同:失败不得自动重跑);失败归因=基础设施(上游 error+模型零工具退化),
  不是 maxOutputTokens 变量的能力结论,也不是 8192 钳制复现**。
- 证据缺口(如实):本次运行的 `runs.budget` jsonb(含 maxOutputTokens 运行时采用值)未被测试证据捕获
  (F2 夹具当时只导出 `detail` 列);**已补**——F1/F2 夹具证据查询增列 `budget`(commit 随本报告),
  F1-R 起运行时采用值入证。透传正确性由 unit 7/7(models.json 实读断言)与 env 导出事实保证。

## 4. F1-R:待上游恢复窗口(一次正式尝试,未消耗)

- 触发条件:GitHub 探测恢复 + Magpie 上游可服务(避免在死窗口消耗第二次授权)。
- 命令:`RELAY_F1_E2E=1 RELAY_MAX_OUTPUT_TOKENS=32768` + PI 凭据(env 文件)+ 显式测试 DB URL,
  `npx vitest run test/integration/f1-ux-journey.test.ts`。
- 结果:待补。

## 5. 对照结论(待 F1-R 后定稿)

- 历史 8192:F1 coder 第二次输出恰 8192 截断、零编辑(R-2 报告)。
- 可配置 maxOutputTokens:F2-R 窗口因基础设施劣化不可判定;F1-R 待执行。
