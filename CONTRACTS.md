# 核心契约与不变量

状态：**FROZEN（行为保证）**；具体 JSON Schema/字段版本 OPEN，须以 P0-00 验证后形成。

## 1. Workflow / 生命周期

唯一 Lifecycle：`DISCOVER → DESIGN → BUILD → VERIFY → DELIVER → OPERATE`。阶段可跳过，但必须由风险配置/验收要求决定并在 Run/Decision 记录；**不是每一次状态推进都要调用模型**。

状态语义（示例，字段名可变）：`READY → LEASED → RUNNING → SUBMITTED → VERIFYING → ACCEPTED`，异常为 `REWORK / NEEDS_DECISION / NEEDS_RECONCILE / BLOCKED / PAUSED / FAILED`。只有 Core 在事务中转移状态，需校验 expected version、租约持有者和授权门禁。Retry 创建 Attempt，不擦除之前的失败/证据。

## 2. 有界 Run、Session 与 Handoff

Task 至少声明：目标与验收、依赖、允许仓库/路径/Operator、风险级别、预算上限、可逆性、运行时能力需求。Run 固定：输入版本/commit、模型版本、起止时间、attempt、资源消耗、可定位日志及结果。

Session 是 Run 的上下文引用，不承诺可复活同一模型内部隐状态。Handoff 必须结构化：`objective / requirement / current_state / decisions / changed_files / known_risks / failed_attempts / evidence / open_questions / next_action`。设大小上限、来源链接及完整性摘要；恢复应重建上下文，而不是复读全聊天。

## 3. Operator 权限

**Agent → Action Proposal → Policy → Scoped Executor → Observation**。每次动作包括：
- `actor/run_id`、capability、target、scope、arguments hash、risk、approval/ref、idempotency key、deadline；
- 明确的文件/仓库/主机 Allowlist、可调用命令策略、输出大小、秘密脱敏；
- 返回机器可判定的 Observation（退出码、时间、commit SHA、HTTP/CI/Browser 证据），并持久化 AuditEvent。

Agent 不能拿到 GitHub/SSH/生产写凭据。Shell 权限不得由于模型工具默认存在而暗中旁路 Policy；未验证沙箱隔离前不授予远程/宿主机特权。读取不可信网页/仓库内容也必须视作数据，不能从其文本提升权限。

## 4. Durable/恢复语义

- 原子保证仅覆盖**本地 DB 事务**；租约按 fencing token/版本校验。
- GitHub API、Shell、SSH、部署等副作用不可能仅凭 DB 事务获得跨系统 exactly-once；外部写入必须幂等、可观测核对或停止人工处置。
- 重启后扫描过期租约时先核对 Git/外部状态及动作记录，再安全重派。没有确定性结果不能盲重试。
- 中断、重复消息、同一命令执行两次、权限撤销与预算耗尽应有测试用例。

## 5. 可验证 Gate

Gate 输入：需求/验收版本、Task/ChangeSet、变更 commit、运行环境、Reviewer 身份隔离方式及带来源的 Evidence。输出：`PASS / REWORK / BLOCK / ESCALATE` + reason。适用 G0 需求、G1 影响、G2 构建、G3 独立 Review、G4 测试、G5 Reality、G6 Release、G7 Runtime（按风险裁剪）。

Review Agent 不得直接批准自己的代码；执行者和 Reviewer 必须是**独立的运行/上下文**，关键规则仍由确定性检查与真实环境观察兜底。Gate 结果与具体 commit 绑定，代码变更后相关门禁重新验证。Task Gate → ChangeSet Gate → Project Acceptance，不允许“全 Task PASS”直接推导最终发布成功。

## 6. Protocol / Extension

- `AgentRuntime`：一次 Run 的启动、事件、停止、取消、恢复/重建；Pi first，ACP 是可选映射。
- `ModelProvider`：能力、上下文和预算独立于 Runtime。
- `Capability`：声明抽象需要；`Plugin` 提供实现；`Skill` 提供方法；MCP/API/CLI/Native 是调用途径。
- `ContextResolver`：按来源、权限、时效、任务和 token 预算生成上下文包；不成为 Policy Authority。
- P0 只稳定用到的 Port；其他先作为设计边界，不建空 Registry/抽象森林。