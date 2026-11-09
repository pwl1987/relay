# ADR-0007：Durable Workflow 技术选型

状态：**OPEN / POC REQUIRED**，不属于 FROZEN 技术依赖。

候选 A：PostgreSQL 事务 + outbox/lease + 单 Tick + version fencing 的最小自实现。
候选 B：DBOS TypeScript + PostgreSQL。

**选择标准**：重启恢复、并发竞争、租约过期、外部副作用结果未知时的核对能力、重复请求/取消、持续运行成本、诊断与集成测试、打包/部署与升级成本。不得只以“官方声称 durable”作结论。

DBOS 文档显示 Node.js/TypeScript 可用，依赖 PostgreSQL，且存在 bundler 限制；它能帮助步骤级持久化，但对 GitHub/SSH 这种外部系统不能无条件保证 exactly-once。若引入 DBOS，Relay 状态机仍须保持唯一业务所有者，禁止叠加第二套自制 workflow 调度。

P0-00 做可复现实验后决定；若 A 已能满足单实例闭环且较简单，允许 **REJECT B FOR P0**。参考：https://docs.dbos.dev/typescript/integrating-dbos