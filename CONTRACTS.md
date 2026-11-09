# 契约

状态：**原则 FROZEN；线协议 Schema OPEN**

## Lifecycle 契约

`DISCOVER -> SPECIFY -> PLAN -> EXECUTE -> VERIFY -> DELIVER -> OPERATE` 是统一词汇。实现可以跳过阶段，但必须记录原因并产生 Policy Decision。

## Task 契约

Task 声明 `id`、`goal_id`、`depends_on`、`owner`、`acceptance`、`risk`、`reversibility`、`budget` 和 `allowed_operators`。状态转换原则上单向，只有明确的 Replan/Reopen Event 可以回退。

## Session 契约

Checkpoint 包含目标、已完成工作、剩余工作、变更 Artifact、Evidence、失败、Decision 和下一步动作。Handoff 必须确定性生成、有大小上限并可计算 Hash。

## Operator 契约

每个 Operator 暴露 Capability Metadata、Input Schema、Authorization Check、Timeout、Output Limit、Redaction、Idempotency Key 和 Audit Result。Operator 返回 Observation，不推进 Lifecycle 状态。

## Quality 契约

Quality Gate 接收 Task 类型、Model Tier、验收标准和 Evidence，返回 `PASS`、`REWORK`、`ESCALATE` 或 `BLOCK`。自由文本形式的模型置信度不能取代 Evidence。

## 适配边界

- ACP：Agent Runtime 会话互操作。
- MCP：工具调用传输。
- Plugin：安装、版本管理和能力封装。
- Skill：可复用的方法内容和检查项。

这些适配器可以发出 Event 和 Observation，但不能 Claim Task、覆盖 Policy 或批准自己的输出。
