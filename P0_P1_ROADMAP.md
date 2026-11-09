# P0 / P1 路线图

状态：**FROZEN（阶段目标及负面范围）**；具体工具版本、工期和阈值 OPEN。

## P0 的原则：先证明一条端到端纵向能力

**P0-00：设计后的可行性/安全 POC（下一工作包，尚未 ACTIVE）**
- 验证 Pi SDK 与子进程 RPC 的工具权限/隔离边界，确认默认工具是否会绕过 Policy。
- 比较 PostgreSQL 事务+租约实现与 DBOS；复现实验：中途崩溃、重试、外部副作用结果未知、恢复去重、重复触发。
- 为单仓样例制定从模糊反馈到接受的可执行验收，包含运行预算/停止条件、责任边界与故障矩阵。
- 产出短 ADR/POC 结果，**失败也作为决策证据，不直接开工大框架**。

**P0-01：单仓最小可恢复执行闭环**
- PostgreSQL 只持久化必要的 Goal/Task/Run、状态事件、Lease、Decision、Evidence 引用；WorkPackage/ChangeSet 可以先是轻量关联或文档，不强制完整表。
- CLI + 最小 HTTP API；单实例定时 Tick、预算、退避、Watchdog、Pause/Resume、重启后 Recovery。
- Pi 一个 Runtime/一种可替换模型 Provider；Scope 限定的工作区 FS/Shell/Git；只允许声明范围内执行。
- 每次 Run 有界输出与结构化 Handoff；日志/证据带来源、Run/commit SHA；阻止相同故障无限轮转。

**P0-02：安全交付与实际质量**
- 加入 Action Proposal/Policy/Executor，默认拒绝未经授予的写/远程/破坏性能力。
- 独立 Review + 真实测试（至少 API 或一个 Web Journey）+ Task/ChangeSet Gate；验收只认特定 commit 的证据。
- GitHub 最小读/受控写集成；使用 HEAD compare-and-swap/快进，默认不自动发布生产。
- 最小 Web 状态/人工审批视图（非可视化编排器）；无 ChatGPT 的 CLI/API/Web 本地演示。

P0 出口：**至少一个真实的模糊需求/缺陷 → 计划 → 有界改动 → 独立验证 → 安全集成**，可重启恢复；拒绝越权；无权限/预算/安全任务时停在可解释状态而非空烧 Token。P0 目标是**有限条件下 24×7 可持续推进能力**，不是“完全无人负责所有生产风险”。

## P1：经 P0 数据证明后按需扩展

- 多仓 Project/Project Group/ChangeSet 与跨仓补偿；进一步拆分 worker/执行隔离。
- Browser Operator（Playwright）、Search/Crawler Provider、SSH/Docker/Deploy Scoped Adapter；P0 仅可把 Playwright 用作**测试工具**。
- ACP 兼容层、MCP 工具桥接、结构化多 Session handoff/steer，第二 Runtime 证明抽象边界。
- Method/Skill Pack（OpenSpec、Superpowers、BMAD、Comet 的理念吸收，不嵌套其工作流引擎）。
- 模型能力档位与路由、Project Memory/FTS、Code Intelligence；评价体系按风险调整。
- 审批通知、可选 ChatGPT 接入、运维报告和持续评测。

## P2 / RESEARCH / DEFERRED

- **RESEARCH**：DBOS（先 POC）、pgvector/CodeGraph 方案、复杂 Session Fabric、受限自我改进候选评测。
- **DEFERRED**：Kafka/NATS/Redis/Qdrant/Neo4j/Elasticsearch/OPA/Kubernetes/Temporal/Restate/OpenBao/Marketplace、分布式控制面、自动生产发布、全量 RSI。
- **REJECTED（首版）**：固定 16 阶段、完整软件公司角色体系、双 Workflow Engine、必须多 Agent 委员会、把 GitHub Issue 当任务调度器、无上限 Loop。

任何 P1 项目进入 P0 都需新 ADR 证明必须性，并退出等量范围，避免 P0 膨胀。