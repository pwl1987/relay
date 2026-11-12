# R-2 F2 正式尝试失败归因(zcode/GLM-5.3;2026-11-12)

- 性质:**一次正式尝试,失败即停,未自动重跑**(合同约束遵守)。测试实录:vitest `test/integration/f2-bug-fix.test.ts`,真模型 describe 失败、stub 机制演示 describe 通过(2.9s,零模型,链路机制健康)。
- 门禁与环境:`RELAY_F2_E2E=1`;`RELAY_PI_PROVIDER=magpie` / `RELAY_PI_MODEL=zcode/GLM-5.3` / `RELAY_PI_API_KEY=<占位,真实凭据由 Magpie 持有>` / `RELAY_PI_BASE_URL=http://127.0.0.1:3425/v1`。独立 schema(`createTestDb("d-f2-bug")`)、独立临时 workspace(safeRm 哨兵)、本地 bare 远端交付;soak 三进程零触碰。

## 结果事实

| 维度 | 值 | 证据 |
| --- | --- | --- |
| run outcome | **BUDGET_EXHAUSTED**(reason=`budget_turns_cap`) | runs-detail.json |
| turns / cap | **6 / 6**(actualCalls=6) | 同上 |
| wall | **135.2s** ≪ 420s 上限(**非超时**) | vitest 实测 135196ms |
| gate | **null(未到达)** | tick-summary.json |
| delivery | **null(未到达)**(无 diff、无 input/candidate/output SHA——未产生候选) | 同上 |
| 机器机判 | 未执行(候选未提交) | gate-evidence.json = `[]` |
| Reviewer | 未执行 | 同上 |

## Magpie 路由对账(routing-window.jsonl,行 93-99,共 7 行)

- **实际 model_ref 实证:7 行全部 `model=zcode/GLM-5.3`,`provider=zcode`,`effort=medium`,`status=200`,`tries=1`** ——授权模型真实承接,零上游重试、零 499/502、零回退到组内其他成员。
- 时间窗:10:59:46 → 11:01:59(第 7 行为预算止损边界上的在途调用:网关侧 200 完成,未计入 run 的 6 turns 记账)。
- 逐行(tokens=输入/out=输出/ms=耗时):840/62/7.3s → 960/50/5.4s → 1199/157/7.9s → 1120/28/6.3s → **7515/5995/87.8s(主工作回合)** → 4119/948/18.1s → [7] 4722/744/14.4s。
- 网关聚合:in 20475 / out 7984 / 总耗时 147.2s。

## 记账口径差异(如实披露,不掩盖)

1. **调用数**:网关 7 行(agent=pi,全部属于本 run)vs run 记账 6 turns/6 calls——第 7 行为止损边界的在途调用;"测试次数≠模型请求次数"在该粒度上再次实证。
2. **token 口径**:run 记账 in 3265/out 7240 vs 网关 in 20475/out 7984——两端口径不一致(run 侧未按网关全量 prompt token 计)。对账以**网关路由日志为权威**。

## 六分法归因

| 维度 | 裁决 | 依据 |
| --- | --- | --- |
| **回合预算** | **主因(实证)**:6 回合硬顶止损,候选未成形即停 | budget_turns_cap;gate null |
| 模型超时 | **排除**(135s ≪ 420s) | vitest 实测 |
| 上游故障 | **排除**(7×200,tries=1,零 499/502/零回退) | routing-window.jsonl |
| 上下文不足 | **排除**(最大输入 7515 ≪ 1M 上下文) | 路由行 tokens |
| 工具限制 | 未见 denied 证据;workspace 已随 afterAll 清理,**无法事后逐工具审计(如实声明)** | runs-detail 无 toolAudit 面 |
| 提示词 | **排除**:F2 brief 具体明确(非模糊原话),非首轮上下文问题 | test/integration/f2-bug-fix.test.ts brief |

## 行为模式观察(对照价值)

- 前 4 回合小而快(5-8s,输出 28-157 tokens)——探索/读取型回合;第 5 回合重推理(87.8s,输出 5995 tokens);第 6-7 回合中量继续。
- 与历史 Flash(F2 轮 2,BUDGET_EXHAUSTED@6)**同模式**:回合预算 × 模型工作风格的错配,而非服务或凭据故障。
- effort=medium 为网关侧默认,不在授权四参数内,**不得擅自调整**。

## 裁决影响

- **F2 = FAILED(一次正式尝试,失败即停)**;不重跑、不加预算、不换模型。
- R-2 裁决联动:F1 结果决定单过(PARTIAL)或双败(PARTIAL+归因);**不存在 VERIFIED 路径**(F2 已败)。
- 归因不指向"zcode/GLM-5.3 能力不足"的决定性结论:6 回合硬顶内无法区分"能力不足"与"需要更多回合"(与 r2-failure-analysis.md §2 同一边界诚实)。
