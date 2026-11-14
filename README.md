# Relay / HIVE Next

**状态：顶层原则 FROZEN；现有 Core、Worker、Pi、Web、Gate 能力须区分代码实现、CI、用户实机与生产运行。2026-11-14 预检发现错误 PASS 风险，生产 NO-GO；唯一当前开发合同见 [CURRENT.md](CURRENT.md)。**

Relay 是轻量、可独立运行、证据驱动、可恢复地持续推进的自主软件交付系统（Autonomous Software Delivery Engine）。用户提出模糊或明确目标，Relay 负责质疑、调查、规划、开发、独立验证、受控交付与持续反馈。ChatGPT 是**可选入口**，不是运行依赖。

第一版以**单人、自托管、本地模型为主、单仓、唯一 Writer、main-only**为约束，采用模块化单体 + Pi First + PostgreSQL；常驻服务优先 `relay-server`、`relay-worker`、`postgres`。不做 AI 软件公司 ERP、IDE、Kubernetes 控制平台、重型中间件平台及无门禁 RSI。

## 设计阅读路线（避免重复 Authority）

**产品/建设/验收**：
- [完整版 PRD](docs/PRD.md)：用户任务、需求 US-01～US-13、MVP/NFR、业务交付条件。
- [建设实施计划](docs/CONSTRUCTION_PLAN.md)：VM80/Mac 分工、P0-00～P0-ACCEPT 的有界切片。
- [验证与验收矩阵](docs/VALIDATION_PLAN.md)：测试 fixture、故障注入 V01～V20、质量门与证据。
- [Web / CLI / API UX](docs/UI_UX.md)：页面、状态与审批交互。
- [自托管部署方案](docs/DEPLOYMENT_PLAN.md)：VM80 选址、目录/网络/恢复/监控。

**四项目借鉴研究（不是新功能授权）**：
- [AgentRun / PINE / agentes.chat / grokbot-clone 参考方法与取舍](docs/EXTERNAL_PATTERN_COMPARISON_20261114.md)。

**架构/安全/扩展**：
- [架构基线](ARCHITECTURE_BASELINE.md) 和 [详细架构](docs/DETAILED_ARCHITECTURE.md)。
- [Agent 控制与本地质量专项契约](docs/AGENT_CONTROL_LOCAL_QUALITY.md)：会话、人工接管、多 Agent、计划修订、机器质量门和本地 CI。
- [领域模型](DOMAIN_MODEL.md)、[核心契约](CONTRACTS.md)、[安全威胁模型](docs/SECURITY_MODEL.md)。
- [生命周期与质量](docs/DELIVERY.md)、[24×7 自治原则](docs/OPERATIONS.md)、[Runtime/插件/技术候选](docs/INTEGRATIONS.md)。
- [路线图](P0_P1_ROADMAP.md)、[ADR](ADR/README.md)、[最终审计](docs/FINAL_AUDIT.md)。
- [治理规则](AGENTS.md)、[当前唯一工作包](CURRENT.md)、[新窗口续接](docs/CONTINUATION.md)。

## 状态词汇

- **FROZEN**：产品结果、架构不变量或安全边界已经决定；修改需证据和 ADR。
- **OPEN**：未验证或需要 POC 的选择，不能当已实现能力。
- **RESEARCH**：探索，不是当前交付承诺。
- **DEFERRED**：明确延期。
- **REJECTED**：明确否决。

**当前状态**：代码已实现最小交付链，但用户体验与模型对照仍有未完成验证；R-2、R-3 历史保持 PARTIAL。当前唯一授权任务以 [CURRENT.md](CURRENT.md) 为准，不能从此 README 推断可直接运行新开发。
