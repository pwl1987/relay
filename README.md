# Relay / HIVE Next

**状态：FROZEN（顶层设计基线）；产品尚未实现。** 最后审计：2026-11-09。

Relay 是**轻量内核、可独立运行、证据驱动、可恢复地持续推进的软件交付系统**（Autonomous Software Delivery Engine）。用户提供目标或模糊问题，系统负责质疑、查证、设计、执行、验证与交接。ChatGPT 仅是可选入口，**不是控制面或运行依赖**。

长期愿景包括自我改进，但 P0 不做 RSI。Relay 不是多 Agent 聊天室、软件公司角色模拟器、IDE、通用 DevOps/Kubernetes 控制平台，也不替代已有编程 Agent。

## 已冻结与尚未实现的区别

- **FROZEN**：设计必须遵守的边界，不表示代码已经实现或完成可靠性测试。
- **OPEN**：需要 POC、测量或 ADR 才能决定。
- **RESEARCH**：仅进行对比实验，不作交付承诺。
- **DEFERRED**：不纳入当前里程碑。
- **REJECTED**：有意识否决，不应无依据重新引入。

## 设计入口（避免多份事实源）

- [架构与职责边界](ARCHITECTURE_BASELINE.md)：产品、组件、协议与状态所有权。
- [路线图与里程碑](P0_P1_ROADMAP.md)：P0 可验收切片及延期项。
- [领域模型](DOMAIN_MODEL.md)：Project、Goal、WorkPackage、Task、Run、ChangeSet。
- [核心契约](CONTRACTS.md)：状态转换、Operator、Evidence 和门禁不变量。
- [交付方法与质量门](docs/DELIVERY.md)：DISCOVER → OPERATE、独立复核、Reality Check。
- [自治运行与安全](docs/OPERATIONS.md)：24×7、Decision Timeout、恢复与预算。
- [Runtime、扩展及技术候选](docs/INTEGRATIONS.md)：Pi、ACP/MCP、Skill/Plugin、Context、技术栈。
- [最终专业审计](docs/FINAL_AUDIT.md)：采纳、修正与拒绝理由。
- [ADR 索引](ADR/README.md)：不可忽略的架构决策及待定 POC。
- [执行治理](AGENTS.md)、[当前任务](CURRENT.md)、[窗口续接](docs/CONTINUATION.md)。

## 第一版的真正目标

在**单仓、单写者、受限工作区**中，以 CLI/API（配最小状态/审批界面）实现一个可重启的完整垂直闭环：
`目标/澄清 → 有界任务 → Pi 执行 → 独立证据 → 审批与接纳 → Git 交付/恢复`。

GitHub Issue 可作为任务展示与协作记录，**不是调度器，也不是 PostgreSQL 运行状态的替代品**。先证明恢复、权限和交付，再扩展多仓、通用 Browser Operator 和 Agent-to-Agent 编排。

本仓库所有正式设计文档使用中文；只用 `main`，不强推。