# R-2 F1 正式尝试失败归因(zcode/GLM-5.3;2026-11-12)

- 性质:**一次正式尝试,失败即停,未自动重跑**(与 F2 同一合同约束)。测试实录:vitest `test/integration/f1-ux-journey.test.ts`,真模型 describe 失败(run SUCCEEDED 但 Gate FAILED)、stub 机制演示通过(4.6s,零模型)。
- 门禁与环境:与 F2 同一四参数与边界(`RELAY_F1_E2E=1` + zcode/GLM-5.3 + Magpie 现有凭据);独立 schema(`createTestDb("d-f1-ux")`)、独立 workspace、本地 bare 远端;soak 三进程零触碰。

## 结果事实

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| Discovery | **SUCCEEDED·高质量**:3 turns,真实调查(识别出无 label/无校验反馈/无成功确认/不回列表四类缺陷),产出可判定验收标准;toolAudit 4 次工具调用零拒绝 | discovery.json / runs-detail.json |
| Coder | run=SUCCEEDED 但 **actualCalls=2、tokensOut=8248、零文件变更(空提交)** | runs-detail.json + Reviewer 核对"变更清单为空" |
| Gate(Playwright 机判) | **FAILED(正确拒绝)**:C1-label 0/3、C2 空提交静默、C3 无成功反馈、C4 列表显示通过(1/4) | gate-evidence.json `evidence_not_passed` |
| Reviewer | **BLOCK(判定精准)**:"变更清单为空(零文件变更)且唯一确定性测试 passed=false……判定 BLOCK(而非 REWORK,因为不存在可供返工修复的变更集)" | gate-evidence.json reviewer_output |
| Delivery | 未到达 | tick-summary.json |

## Magpie 路由对账(routing-window.jsonl,行 100-105,共 6 行)

- **实际 model_ref 实证:6 行全部 `model=zcode/GLM-5.3`,status=200,tries=1**;窗口 11:06:16→11:09:41。
- 逐行:discovery 3 行(1158/90、1464/91、2545/1024)+ coder 2 行(1016/56、**9514/8192/144.4s**)+ reviewer 1 行(1921/942,BLOCK)。
- 网关聚合:in 17618 / out 10395。
- 记账口径:run 侧 coder tokensOut=8248 与网关两行 out 之和(56+8192)**精确一致**;tokensIn 口径仍不一致(run 1386 vs 网关 10530)——与 F2 同一披露:对账以网关日志为权威。
- **candidateCommitError 字段披露(Reviewer Minor-3 消化)**:F1 runs-detail 含 `"candidateCommitError": "git_failed: git -c failed: "`——系候选 diff 为空、git 无可提交内容所致,与零编辑空提交(baseSha==candidateSha)自洽,**非 git 链路故障**,避免误读。

## 决定性根因(实证)

**`src/runtime/sandbox.ts:131` — Relay 沙箱侧硬编码 `maxTokens: 8192`**:

- zcode/GLM-5.3 自身 max_output_tokens=128000(/v1/models 实测),但 Relay 每次模型调用钳制 8192;
- coder 第 2 调用 out=**8192 整**、耗时 144.4s ⇒ 输出在请求级上限处截断,截断发生在文件编辑工具调用落实之前 ⇒ 零编辑空提交;
- GLM-5.3(medium effort)重推理输出风格 × 8192 钳制 = "长思考吃掉全部输出预算"的确定性截断;
- 对照:F2 主工作回合 out=5995(未触顶)——F2 败因是 6 回合预算,非截断;两实验失败模式**不同且均已定位**。

## 六分法归因

| 维度 | 裁决 | 依据 |
| --- | --- | --- |
| **编码执行(新类)** | **主因**:coder 2 调用零编辑;输出截断实证(8192 整 × sandbox.ts:131) | routing-window + gate/reviewer 证据 |
| 回合预算 | 非本轮主因(2/12 未用尽)——与 F2/历史 Flash 形成对比 | runs-detail |
| 超时 | 排除(总 247.3s ≪ 600s) | vitest 实测 |
| 上游故障 | 排除(6×200,tries=1) | routing-window |
| 上下文/提示词 | 排除:任务文本为采纳装配后的显式可判定验收(非模糊原话),coder 上下文 9514 tokens 含全部验收标准 | routing 行 5 + adoptedTaskText |
| 工具限制 | 排除:discovery 4 次工具零拒绝;coder 无 denied 记录 | toolAudit |

## 治理链正面实证(重要)

本轮虽 FAIL,但**全链 FAIL-CLOSED 精确工作**:Discovery 高质量 → Gate 机判如实拒绝不合格候选(3/4 不过)→ Reviewer 精准 BLOCK 空提交并给出"为何非 REWORK"的理由 → 交付被阻止 → 预算/账本如实记账。**失败被系统诚实拦截,而非被掩盖**——这正是 Gate/Reviewer 作为 MVP 必需项的设计目的。

## 潜在修复路径(仅记录,不在本次授权内,未实施)

- 上调 `src/runtime/sandbox.ts` maxTokens(8192 → 32K/128K)属**实验变量变更**,不在授权四参数(模型/预算/wall/凭据)内;按合同不改动、不重跑;
- 该发现同时解释历史部分失败面(Flash 时代重回合同样受 8192 钳制),建议作为**下一轮授权决策输入**交用户裁决(如"调 maxTokens 后重跑 F1/F2 各一次")。

## 裁决影响

- **F1 = FAILED(机判拒 + Reviewer BLOCK)**;R-2 双败 ⇒ **PARTIAL(双败+归因)**,不存在 VERIFIED 路径;
- 不重跑、不加预算、不换模型、不改 sandbox maxTokens(合同边界全程遵守)。
