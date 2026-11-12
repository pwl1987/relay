# MODEL-POLICY-00 设计包·独立 Reviewer 复核记录

- 复核时间:2026-11-12 上午(+0800);Reviewer:独立全新上下文 Agent(与写者会话隔离,只读复核)。
- 被审物:`docs/MODEL_POLICY.md`(主设计)、`ADR/0009-model-policy.md`、`ADR/README.md`(索引)、`CURRENT.md` 合同行。
- 审查面:①用户规格《MODEL-POLICY-00 设计包》(2026-11-12)逐项覆盖性;②与 ARCHITECTURE_BASELINE/ADR-0003/0004/README/R-2 调查证据一致性;③越界核查(git 状态、soak 未跟踪文件、零代码改动)。

## 结论:**PASS-WITH-FINDINGS**(Major 0 · Minor 6;均不阻塞设计冻结)

### 规格覆盖性(摘要)

- 【二】Provider 四层:四层定位/资源面/稀缺度全录;glm_weekly 单池硬约束+Registry 写入校验成文;ChatGPT"非必需依赖、不可用时照常工作"成文。
- 【三】Magpie 重定位:optional provider/adapter/experiment router;五项策略面归 Core;暂不删不迁移。
- 【四】数据模型:ProviderRegistry 九建议字段+增强字段;QuotaPool 七 limit_type+六建议字段+members;Scarcity 六级;RunModelDecision 九项必留痕+"禁止只记最终模型"列为 01 验收项。
- 【五】调度原则:禁 token 级换模型/仅 Run·Attempt 边界;默认链与四级升级链与规格逐条一致;Supervisor 四类触发全录。
- 【六】异构:家族级硬约束+组合表+高风险 Supervisor 增审+禁同模型写审裁。
- 【七】DEGRADED_LOCAL:触发四条件+七项不停摆清单;"不自动 ACCEPTED、门禁只严不松"。
- 【八】指标:九项全列;tok/s 降为容量参考;四元组调整+版本化发布防 RSI。
- 【九】实施边界:六类输出物齐备;七项禁止以设计冻结+激活前置成文;零实现代码。
- 【十】01 验证范围:四通道+八项故障场景(含重启恢复)+可回放 Evidence 要求逐项对应。

### 一致性(摘要)

与基线"不依赖 ChatGPT"/"Runtime != Model;模型提供商独立配置"/"质量来自确定性 Gate、隔离 Reviewer"、ADR-0003(Core 管 Policy,Pi 不拥有模型策略)、ADR-0004(Reviewer-Coder 分离/有界止损)、README"ChatGPT 是可选入口"无矛盾;与 R-2 证据(auth_source=magpie、占位 key+egress 改写、budget_ledger 口径、测试次数≠模型请求次数、Flash 级承接≈95%)一致;ADR 索引状态沿用 0007 先例。

### 发现与处置

| 编号 | 严重度 | 定位 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| F-1 | Minor | ADR-0009 理由段;设计文档 §1 | 归因表述沿用修正前"路由组不透明"与调查报告修正后结论并置,措辞张力 | **已修**:改为"运行时调用面上游身份不可见(仅事后经路由日志对账)+归因精确化为 Flash 级单模型×回合预算组合" |
| F-2 | Minor | 设计文档 §4.3 同池校验 | 校验锚 providerId=zcode,与家族判定口径(modelFamily)不一,未来同提供方非 GLM 模型会误伤 | **已修**:校验锚改 `modelFamily=glm` |
| F-3 | Minor | CURRENT.md 基线行 | "HEAD b373726==origin/main、工作区仅 runner 日志"已因本包提交过时 | **已修**:基线行改为"启动时 b373726+各包快进推进(见 git log)+未跟踪仅 soak 产物" |
| F-4 | Minor | §4.5 注释/§4.1 示例/§5.2 记号 | escalationReason 示例与 FailureClass 不对齐;ModelRef 示例型号连字符与用户口径不一;池状态机大小写混用 | **已修**:三处对齐(示例取值=FailureClass 枚举;型号以用户口径+上游注册名注记;状态机统一大写) |
| F-5 | Minor | §4 | TS camelCase 与用户规格 snake_case 及 PG 列名映射未注明 | **已修**:§4 开头补"TS camelCase ↔ PG snake_case 机械映射"约定 |
| F-6 | Minor | §3 vs §10.1 | 对 01 是否含迁移实施两处表述有差 | **已修**:两处统一为"01 只出评估结论与迁移方案;迁移实施另行授权立项" |

### 越界核查(Reviewer 亲测)

- 零代码改动:diff 仅 ADR/README.md 索引 +1 行与本包文档;src/、test/、deploy/、ARCHITECTURE_BASELINE.md、Pi Runtime、生产 Worker、R-2 实验变量、Magpie 零触碰;暂存区管理合规。
- soak 未跟踪文件未被触碰:`p0-mvp/soak-24h/final-runner.log` 与 `p0-mvp/soak-r3b/`(六预置文件)保持未跟踪、未入暂存、未出现在任何提交,符合"预置文件不混入提交"边界。
- 设计文档零"已实测"误称(100 tok/s、MiniMax 5h 语义、ChatGPT OAuth 均标注 OPEN/待 01 校准);零模型消耗与 git 证据自洽。
