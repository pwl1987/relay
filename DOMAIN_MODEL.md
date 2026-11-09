# 领域模型

状态：**名词与不变量 FROZEN；字段级 Schema OPEN**

- **Project**：受边界约束的源代码/工作区上下文和 Policy Profile。
- **Goal**：包含验收标准和预算、由用户授权的结果。
- **ChangeSet**：包含意图、约束、证据和受影响 Project 的变更包。
- **Task**：DAG 中可执行的工作单元，包含状态、所有者、依赖、预算、尝试次数和证据。
- **Run**：一次 Task 的有边界执行尝试。
- **Session**：Run 的可恢复上下文，保存 Handoff 和 Checkpoint 引用。
- **Decision**：包含风险、可逆性、超时、Fallback 和回滚信息的审批或假设节点。
- **Evidence**：指向测试、Diff、命令结果、Review 或外部观察的不可变引用。
- **Operator**：在 Policy 约束下执行外部动作的能力适配器。
- **Policy**：权限、风险、预算和必需 Gate 的规则。
- **Plugin**：适配器与配置的打包单元。
- **Skill**：声明式方法内容（指令、Schema、检查项），绝不作为调度器。

## 状态不变量

1. 没有 Evidence 引用，Task 不能进入 Accepted。
2. Run 不能在其 Operator Grant 之外修改 Project。
3. Lease 过期不等于失败；Recovery 必须检查 Checkpoint。
4. Decision Timeout 只能按照声明的 Fallback 继续。
5. Audit Event 只追加不修改，并标识 Actor、Authority、Target、Result 和 Trace。
6. 外部入口是 Client Identity，不是 Runtime 状态事实来源。
