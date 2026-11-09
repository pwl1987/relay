# ADR-0007：Durable Workflow 技术选型

状态：**ACCEPTED（REJECT DBOS FOR P0；自研 PostgreSQL 事务+租约+fencing）**。裁决依据：`p0-00/REPORT.md` §4（2026-11-09 实测）。修改本裁决须提供同级别的对比实验证据。

候选 A：PostgreSQL 事务 + outbox/lease + 单 Tick + version fencing 的最小自实现。
候选 B：DBOS TypeScript + PostgreSQL。

**实测对比（详见 REPORT）**：
- 自研（exp-b，227 行，单依赖 `pg`）：并发争抢唯一赢家（B1）、过期 fencing 阻断旧 Writer（B2）、SIGKILL 后 reconcile+重领、审计 9 步全史（B3）、外部副作用先核对后决策（exp-c C1–C3）。
- DBOS 5.4.0（exp-d）：同 `workflowID` 去重（D1）与崩溃恢复/步骤恰好一次（D2）真实且优秀；但**不提供任务级单写者**（不同 ID 并发同任务均 SUCCESS，D3 实证），不提供外部副作用核对；依赖 50M/5 直接依赖（自研 900K/1）；v3→v5 破坏性迁移、无 ORM 的 pg datasource 缺失、ctx 注入语义未文档化且首参会吞参数（实测）。

**选择标准核对**：重启恢复（两者均可）、并发竞争与租约过期（仅 A 内建）、外部副作用结果未知的核对（两者都需应用层实现，A 已实现）、重复请求/取消（A：fencing+终态锁；B：workflowID 级）、持续运行成本/打包升级/诊断与单人可维护（A 显著更小）。

**约束保持**：即使未来引入 DBOS 处理步骤级持久化，Relay 状态机仍是唯一业务所有者，禁止叠加第二套自制 workflow 调度；DBOS 不得成为任务状态 Authority。

参考：https://docs.dbos.dev/typescript/integrating-dbos ；实验代码 `p0-00/exp-b`、`p0-00/exp-d`。