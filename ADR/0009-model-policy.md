# ADR-0009:Model Policy v0.1 与多 Provider 分层

状态:**ACCEPTED(v0.1 设计冻结;实现 OPEN——激活前置:MVP 最终 ACCEPTED,由 MODEL-POLICY-01 实施)**。完整设计见 [Model Policy v0.1](../docs/MODEL_POLICY.md);本 ADR 只记裁决与理由。

**决定**:

1. Relay Core(非 Magpie、非 ChatGPT)唯一拥有 Model Policy:Provider Registry、Quota Policy、Health Policy、Escalation Policy;每次 Run 的模型选择持久化为 `RunModelDecision`(候选/当选/provider/池/稀缺度/选择理由/升级原因/前次失败)——**禁止只记最终模型而不留"为什么选它"**。
2. Provider 四层分层:LOCAL_PRIMARY(本地 Qwen,UNMETERED)/ CLOUD_PRIMARY(MiniMax M3.1,5h 窗口型可恢复资源)/ SCARCE_GLM_POOL(GLM-5.3-Flash 与 GLM-5.3 **共享 `glm_weekly` 单池**,不得视为两池)/ SCARCE_SUPERVISOR(ChatGPT Plus/Codex,可选)。
3. Magpie 重定位为 optional provider / compatibility adapter / experiment router;MVP 内**不删除、不迁移**现有链路;迁移评估入 MODEL-POLICY-01。
4. ChatGPT 是可选 Supervisor(架构质疑/需求合理性/连续失败归因/高风险终审/稀缺消耗裁决),**不是生命周期、状态机或调度的必需依赖;不可用时 Relay 照常工作**。
5. 模型切换只发生在新的 Run / Attempt 边界;**禁止每轮 token 级动态换模型**。
6. Coder/Reviewer 家族级异构硬约束(`Coder family != Reviewer family`);禁止默认同模型写、审、裁一体。
7. DEGRADED_LOCAL 为正式降级模式:云端全损时 Core 用本地 Qwen 维持低风险生产/测试/诊断/Discovery、产出 Candidate 挂起待异构 Review、高风险任务记 `WAIT_STRONG_MODEL`;系统不停摆、门禁不降。
8. 优先级调整以 **Accepted Task / 时间 / 成本 / 稀缺资源消耗**为据、tok/s 不作主判据,结论走 Model Policy 版本化发布(带证据+独立 Reviewer),禁止运行中静默自我改写。

**理由**:R-2 调查实证(`p0-mvp/r2-model-investigation.md`)——运行时调用面上游身份不可见(仅事后经 Magpie 路由日志对账可见);归因已精确化为"Flash 级单模型×回合预算"组合:组内约 95% 成功 try 由 Flash 级承接,回退成员因本机代理故障不可用而调用方不可见。缺显式 Registry/健康/升级面 ⇒ 失败不可在链路内归因与修正、额度不可对账。GLM 双模型共享周额度,拆池记账必然对账失效。成本/稀缺高度不对称(本地无限 vs 周额度 vs 人工订阅),需要稀缺度一等公民化。ADR-0004"Reviewer 与 Coder 分离上下文"升级为家族级约束以杜绝同模型背书。

**备选方案**:

- (a) 维持单一 Magpie 路由组(group/gm)现状——回退成员健康与身份不可控不可见,已实证不可归因,**否决**;
- (b) token 级动态换模型——决策不可归因、证据链断裂、状态爆炸,**否决**;
- (c) Magpie 作为唯一模型控制中心——额度/健康/升级策略不可审计且单点,**否决**(降格为 optional provider/adapter)。

**后果**:MODEL-POLICY-01 新增 ProviderRegistry/QuotaPool/RunModelDecision 持久化与策略面(引用本 ADR 为授权依据);现有 MVP 链路(含 R-2 `zcode/GLM-5.3` 授权对照实验)零改动;零模型消耗的设计包即 MODEL-POLICY-00。

**残余风险(转 MODEL-POLICY-01 实测)**:本地 Qwen 在 Relay 链路内的真实吞吐/工具正确性未实测;MiniMax 5h 窗口语义未实测;ChatGPT OAuth 通道未实测;QuotaPool 上报口径须 ledger+上游双对账(测试次数≠模型请求次数);`dynamic_allowance` 观测语义 OPEN。
