# Relay 顶层架构基线

状态：**FROZEN（原则与所有权）**。实现现状（2026-11-14）：本地质量三级（quality:quick/full/release，QUALITY-LOCAL-01）与对话式单输入+显式执行（CONTROL-READY-03）已实现并经 CI 与独立复核；人工接管/多 Agent 统一控制与性能阈值实测仍 OPEN，代码现实以 live main 和证据为准。

## 1. 使命及非目标

Relay 是自主软件**交付控制系统**：将目标/模糊反馈变为可验证的 ChangeSet，保持受控执行、真实质量门和可恢复交接。它**不重写** Pi、Git、CI、Playwright 或现有模型能力，也不依赖 ChatGPT。

不是多 Agent 聊天平台、AI 公司 ERP、通用 DevOps 产品或自我修改而不经评审的 RSI 运行时。

## 2. 唯一状态/调度所有者

```text
Web(最小界面) / CLI / HTTP API / 可选 ChatGPT Client
              |
      Relay Server（Lifecycle + Policy + State）
              |                   PostgreSQL（任务、租约、决策、审计、证据索引）
      Relay Worker（单队列轮询/受限运行）
              |
       Run / Session Context + Pi Adapter（Runtime != Model）
              |
 Action Proposal -> Policy -> Scoped Executor -> Observation
              |
   Git / FS / Shell / CI（先）；Browser / Search / SSH / Deploy（按里程碑）
```

只有 Relay 的状态机负责 Lifecycle、任务就绪、Lease、Retry/Replan、Gate、接受与最终状态。Worker 执行运行步骤，**不私有化另一套任务调度**；Pi/ACP 及 Plugin 不能自行批准交付或越权。Session Persistence/Handoff 是运行上下文能力，**不是第二个 Workflow Engine**。

默认服务边界：`relay-server`、`relay-worker`、PostgreSQL；P0 允许 server/worker 同进程起步，证明确有故障隔离需求再拆。Chromium 等按需启动。不得因未来扩展提前部署消息总线或服务网格。

## 2.1 用户干预、多 Agent 与质量边界（ADR-0012）

- Relay Core 继续拥有唯一持久工作流、计划版本、权限、预算、Lease 和 Gate；Pi 子 Agent 不能创建第二调度器。
- 用户可以查看、指导、暂停、紧急停止、接管与交还；ACK 不等于操作生效，接管前必须撤销旧 Writer 并核查副作用。
- 用户聊天不能自动变为有写权限的 Task；变更方向需要 PlanRevision 栅栏，终态 Goal 不得静默重启。
- 本地独立验证与 GitHub 云端复核使用同一质量标准；最低机器测试证据不能被 Reviewer 自评替代。
- 最小必要代码与确定性 Policy 优先，性能基线实测后校准，pstack 仅复用经许可的工程方法，不接管编排。

详细合同：[Agent 控制与本地质量契约](docs/AGENT_CONTROL_LOCAL_QUALITY.md)；裁决：[ADR-0012](ADR/0012-agent-control-local-quality.md)。实现进度分层（2026-11-14）：本地质量三级与对话授权执行已实现（CI+独立复核）；接管/多 Agent 控制与性能数值仍未实现未验收——本节原则不因部分实现而视为整体已验收。

## 3. 六阶段与风险裁剪

`DISCOVER → DESIGN → BUILD → VERIFY → DELIVER → OPERATE`；每阶段有准入/产出/可跳过理由，不强制逐阶段执行。BUG 可以 BUILD→VERIFY→DELIVER，大功能才包含 DISCOVER/OPERATE。验证失败必须 REWORK，不能直接由 BUILD 标记 ACCEPTED。细节见 [交付规范](docs/DELIVERY.md)。

## 4. P0 重点与不提前承诺的能力

P0 仅证明**一条单仓端到端垂直路径**（最小模糊需求澄清、任务持久化、Pi、Scope 受控的本地动作、独立测试/观察、允许的 Git 交付、崩溃恢复）。24×7 指能在服务存活或恢复后持续安全推进**有资格执行**的工作，**不承诺无供电、无网络、无模型时仍产出**。

Web UI 仅需展示状态、证据与审批，不建复杂控制台。通用 Search、Crawler、SSH、Docker、Deploy、ACP/MCP 通用互操作及完整跨仓 ChangeSet 不属于 P0 的必经路径。

## 5. 开放边界

- `Project != Repository`；逻辑上支持项目组/多仓/跨仓 ChangeSet，P0 只实现单仓验证。多仓协调、原子性与补偿语义留 P1。
- `Runtime != Model`；首个 Runtime 为 Pi，模型提供商、能力层级及版本均独立配置。
- Agent-to-Agent 的 Session Fabric *方法*（spawn/send/handoff 等）不是 P0 承诺。P0 先做 Session 引用与结构化 Handoff；交互式 Session Fabric 属 P1 设计与 POC。
- ACP 是 Client↔Agent Runtime 互操作，MCP 是 Agent↔Tool 传输方式；均不得成为任务状态 Authority。
- Skill 是方法；Capability 是所需抽象能力；Plugin/Adapter 是实现提供者；API/CLI/MCP/Native 是调用方式。插件不是权限授予系统。
- Context Resolver 仅按需组合来源、权限、时效、token 预算和来源标识；不把全历史默认塞给 Agent。
- 质量来自确定性 Gate、隔离 Reviewer 和真实环境观察，而非模型自评或多个角色相互背书。

## 6. 系统性安全/可恢复不变量

1. 外部写操作统一经 `Action Proposal → Policy → Scoped Executor`，模型看不到高权限令牌；凭据由执行器按动作最小授权取得。
2. 对 DB 内部状态使用事务/租约/栅栏版本。外部副作用按**至少一次可能重放**设计，带幂等键、事后核查或转人工；**绝不声称 GitHub/SSH/部署恰好执行一次**。
3. 崩溃后从 DB 持久状态和 Git 现实恢复；若动作结果不确定，先 Reconcile 再重试，不能盲目重放。
4. 未经授权不得生产发布、强推、破坏数据、扩权、泄露凭据或改变核心 Policy。超时仅决定**可授权的 Fallback**，不制造新权限。
5. Accepted 必须可追溯到基于具体提交/环境的 Requirement、Review、Test、Reality Evidence。Task 全通过≠ChangeSet 或 Project 已验收。
6. 单写者下 `main` 唯一长期分支；集成需校验 base SHA 与快进，不能覆盖并行写入。

详见 [核心契约](CONTRACTS.md)、[自治运维](docs/OPERATIONS.md)及 ADR。
