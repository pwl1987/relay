# ADR-0006：Memory、Knowledge 与 Code Intelligence

状态：**FROZEN**

这些能力属于 Plugin，不属于 Core。Core 只存储 Recovery、Policy、Task 状态、Evidence 和 Audit 所需的最小持久化事实。可选 Plugin 可以通过带有来源、时效、范围和删除行为的 Query/Index Contract 提供 Memory、文档 Knowledge 或 Code Intelligence。

Plugin 结果只能作为 Evidence 或 Context，不能成为 Authority。任何 Plugin 都不能静默修改 Task、Policy、Permission 或 Acceptance 状态。初始实现使用 PostgreSQL 元数据和普通 Search；只有在有度量支持的使用场景下，才引入 Embedding、Vector Store 或 Code Graph。

OPEN：保留策略、索引周期和首个 Plugin API。
