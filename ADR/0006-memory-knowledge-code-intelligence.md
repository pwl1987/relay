# ADR-0006：Context、Memory 与 Code Intelligence

状态：**FROZEN（分层）**；Provider 选择 OPEN。

**决定**：P0 保存恢复必需的 Goal/Task/Run/Decision/失败/Evidence/Handoff；用 PostgreSQL 元数据和有来源的 Markdown/结构化引用即可。按任务/权限/时效/token 预算组 Context Pack，不默认将全会话历史注入 Agent。

P1 才评估 Project Memory、PostgreSQL FTS/pgvector、Code Intelligence；P2 研究 CodeGraph、Graphiti、Qdrant 等。检索结果只作 Context/Evidence，不能改写 Policy、Task/Acceptance 状态或成为仓库 Authority。

ContextResolver 等接口仅在有实际消费方时实现，不提前搭建 Knowledge Platform。