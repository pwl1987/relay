# Relay / HIVE Next

**状态：FROZEN（顶层原则、完整 PRD、建设路线与验收要求）；代码未实现、关键技术 POC 仍 OPEN。** 更新：2026-11-09。

Relay 是轻量、可独立运行、证据驱动、可恢复地持续推进的自主软件交付系统（Autonomous Software Delivery Engine）。用户提出模糊或明确目标，Relay 负责质疑、调查、规划、开发、独立验证、受控交付与持续反馈。ChatGPT 是**可选入口**，不是运行依赖。

第一版以**单人、自托管、本地模型为主、单仓、唯一 Writer、main-only**为约束，采用模块化单体 + Pi First + PostgreSQL；常驻服务优先 `relay-server`、`relay-worker`、`postgres`。不做 AI 软件公司 ERP、IDE、Kubernetes 控制平台、重型中间件平台及无门禁 RSI。

## 设计阅读路线（避免重复 Authority）

**产品/建设/验收**：
- [完整版 PRD](docs/PRD.md)：用户任务、需求 US-01～US-13、MVP/NFR、业务交付条件。
- [建设实施计划](docs/CONSTRUCTION_PLAN.md)：VM80/Mac 分工、P0-00～P0-ACCEPT 的有界切片。
- [验证与验收矩阵](docs/VALIDATION_PLAN.md)：测试 fixture、故障注入 V01～V20、质量门与证据。
- [Web / CLI / API UX](docs/UI_UX.md)：页面、状态与审批交互。
- [自托管部署方案](docs/DEPLOYMENT_PLAN.md)：VM80 选址、目录/网络/恢复/监控。

**架构/安全/扩展**：
- [架构基线](ARCHITECTURE_BASELINE.md) 和 [详细架构](docs/DETAILED_ARCHITECTURE.md)。
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

**当前状态**：设计达到可拆分可验收的施工基线，尚无 Relay 实现或 24×7 实际运行证据。下一唯一包是 `P0-00` 的 Pi 隔离/恢复语义 POC，不能跳过。