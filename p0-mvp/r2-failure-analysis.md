# R-2:F1/F2 真实模型失败归因分析(只读诊断;2026-11-11)

- 依据:收口指令 §3——先分析真实失败日志,六类区分;**替代模型未经授权前零重跑**。
- 证据面:`p0-mvp/f1|f2/runs-detail.json`(runs.detail 全量)、`gate-evidence.json`、`tick-full.json`、`test/fixtures/f1-tasklist|f2-api/`(机判标准)、本轮会话测试实录。

## 1. 调用路径核对(指令要求:不得把失败全归因 Magpie)

| 层 | 事实 | 证据 |
| --- | --- | --- |
| Relay 侧 | provider=magpie, model=group/gm, baseUrl=127.0.0.1:3425, API=openai-completions(沙箱 models.json 占位 key;真实调用不经凭据) | runs.model_ref + `src/runtime/sandbox.ts` models.json 装配 |
| Magpie 侧 | `GET /v1/models` 实测:`group/gm` = **"GMD · routing group"**(owned_by=zcode;reasoning=true;tool_call=true;上下文 1M)——**路由组,上游 Provider/Model 对调用方不透明** | 本轮实测(models 端点) |
| 归因边界 | 失败只能归因到"路由组 × 回合预算 × 任务"层面;组内上游模型身份/版本不可见 | 如实声明 |

**结论:失败不能归因于某个具体上游模型;也不应笼统归因于"Magpie"——Magpie 是路由层,观测到的能力面=路由组当前组成的行为。**

## 2. F1/F2 失败实录与六分类

| 轮次 | 任务 | 结果 | turns | 分类(主) |
| --- | --- | --- | --- | --- |
| F1 首轮(采纳装配前) | 任务文本=一句模糊原话 | SUCCEEDED,**零编辑** | 2 | **指令与任务上下文不足**(已修:US-03 采纳装配 goalTextFor) |
| F1 次轮×2 | 采纳装配后 | BUDGET_EXHAUSTED | 6→12(上限) | **预算耗尽**(回合硬顶诚实止损;12 回合未收敛 4 点修复) |
| F1 一次 | 同上 | TIMEOUT | — | **模型服务超时**(wall 预算到点) |
| F2 轮 1 | 修复任务 | SUCCEEDED 但机判 4 项未全过 | — | **Gate 拒绝不合格修改**(机判正确拒;修复不完整) |
| F2 轮 2 | 同上 | BUDGET_EXHAUSTED | 6(上限) | **预算耗尽** |

**排除项(有证据)**:非工具调用错误(tool_execution 事件正常、无 denied 异常);非文件修改能力受限(同链路真实模型曾成功产出候选:`gate-e2e`/A-4 联验 sum=87);非 Gate 误拒(机判标准基线负对照双向实证)。

**归因结论(按证据强度排序)**:
1. **主因:回合预算内未收敛**——路由组模型的推理冗长/工具往返低效,12 回合上限内未完成 4 点修复(简单任务 2 回合可完成,复杂编辑任务方差极端:零编辑↔烧尽预算)。
2. **次因:首轮任务上下文不足**(已修:采纳装配;修后仍受 1 约束)。
3. 服务超时一次(wall 预算);预算耗尽为**止损机制正常工作**,非缺陷。
4. 模型推理能力是否"不足"**不可判定**——在受限预算内无法区分"能力不足"与"需要更多回合";需受控对照实验(同项目/同机判/可比预算,替代模型 vs 原路由组)。

## 3. 受控对照实验设计(待用户授权模型与预算后执行;本包零执行)

- 相同 F1/F2 项目、相同机判标准(check.mjs/api-check.mjs 基线负对照不变)、可比预算(建议 coder reserve 12、reviewer 4、wall 600;目标账本=对照双方一致)。
- 判定:真实模型完成修改+机判通过+独立 Reviewer PASS+commit 绑定正确+交付成功 ⇒ F1/F2 改 VERIFIED;否则维持 PARTIAL 并记录对照数据。
- Stub 成功不替代真实验收(合同明令)。

## 4. 本包动作边界(REVIEW-close-pack Minor-m1 措辞精确化)

- 本包写路径**零主动重跑**真模型任务;但全量回归验证会触发 `live-worker-e2e.test.ts` 的既定 A-4 授权实验(三重门控;预算 limit=8 未变)——**每次全量跑消耗 1 次真模型调用,应向用户明示**(Reviewer 自身全量复核亦触发一次 used=6,已如实披露)。
- F1/F2 维持 PARTIAL;替代模型对照实验待用户授权。

## 5. 证据映射补全(REVIEW 三处缺口)

- run-abe16b7d(F1 某轮 TIMEOUT)补列:该轮 outcome=TIMEOUT(wall 预算到点)——归类同"服务超时"行。
- "采纳装配前/后"标注:F1 首轮(零编辑,SUCCEEDED turns=2)发生于 goalTextFor 采纳装配**之前**(JSON 中 goalText 为模糊原话);后续轮均为装配后——与 runs-detail.json 的 goal 文本字段一致。
- 次轮 turns=12(非 6):F1 次轮声明 reserve=12(JSON budget.reserveCallsPerRun=12),F2 轮 2 为 6——两文件证据各自吻合,已按 JSON 逐轮核对。
