# 核心领域模型

状态：**FROZEN（语义/归属）**；物理表结构、API 细节 OPEN。

## 六个顶层概念（不等于六张必须同时落库的表）

| 概念 | 唯一职责 |
| --- | --- |
| Project | 交付的业务/安全边界和关联资源；**不等于仓库**。可含多个 Repository。 |
| Goal | 用户授权的目标、成功条件、风险/成本边界与来源。 |
| WorkPackage | 可验收的范围包；绑定 Goal、依赖、责任与交付门；P0 可使用结构化文件/轻量映射。 |
| Task | 可调度的最小有界动作，属于 WorkPackage/Goal，包含依赖与停止条件。 |
| Run | Task 的一次执行尝试，独立预算、Runtime/Model、Checkpoint、Observation 和证据。 |
| ChangeSet | 被审查/交付的变更集合，绑定 base/ref、受影响仓库及整体 Gate；P0 限单仓。 |

必要的支持实体按真实需求持久化，不升级为另一套业务系统：Session（Run Context/Handoff）、Decision（授权/假设）、Evidence（来源与不可变引用）、Artifact（输出）、AuditEvent（只追加）、Lease（工作权与栅栏）。AgentProfile 是配置，不是 P0 的“员工档案”。

## 关系及分界

```text
Project 1 -> N Repository (P0 允许 N=1)
Project 1 -> N Goal
Goal -> WorkPackage -> Task -> Run
ChangeSet -> N Task/Artifact/Evidence + N Repository (P0 只一个)
Run -> Session/Handoff + Observation/Evidence
Decision -> affected Task/ChangeSet + Assumption
```

GitHub Issue 是外部同步视图；不承担运行时 Ready/Running/Blocked 的唯一事实源。PostgreSQL 是运行元数据的唯一事实源，Git commit 是代码内容事实，CI/Browser/服务端观测是结果事实。它们不能彼此替代。

## 核心不变量

1. Task 不得因 Agent 宣布 DONE 而 Accepted；至少要有适用 Gate 的可信 Evidence。
2. Run 绑定 Task/配置/授权作用域与执行起点 commit；失败或重试创建新 Attempt/事件，不抹写旧证据。
3. Session 不得自行持有新 Task、Lease 或权限；工作流程所有权在 Core。
4. ChangeSet Gate 对集成前的**具体提交集合与环境**裁决；Task PASS 不代表跨仓原子提交成功。
5. Project Group 只描述组合视图，P0 不引入跨项目全局事务。
6. D3/D4 未获批准时，所有依赖该 Decision 的动作不得因为超时被绕过。
7. 强副作用结果不确定时，Task 必须进入 NEEDS_RECONCILE/受控 Block，避免重试造成重复损害。