# Runtime、协议、扩展、上下文与技术候选

状态：**FROZEN（概念边界）**；版本、默认实现和成熟度 POC 属 OPEN。

## Runtime != Model

```text
AgentRuntime: PiRuntime(first) | ACPRuntime(future) | ...
ModelProvider: 本地 OpenAI 兼容 API / 商用 API（独立配置）
Run: {runtime, model, capability_tier, scope, budget, checkpoint}
```

Pi 提供 Agent 能力，Relay 提供 Goal/权限/调度/验收。优先评估 Pi Native SDK 与 RPC：SDK 同进程更易定制但扩大进程信任面，RPC 子进程利于隔离但须验证协议、恢复与工具调用。**P0-00 必须实测选择，不预设 SDK 就一定更安全**。默认工具若能直接执行任意 Bash/写文件或读凭据，需禁用/重建受控工具或强化 OS 隔离。用户的本地模型性能差异由 Model Routing 处理，不与 AgentRuntime 耦合。

## 协议和 Session 分工

- **ACP**：Relay 客户端与可适配 Agent Runtime 之间的会话互操作；以正式稳定版本、能力协商为准，P1 接入。ACP v2 草案不能视为已冻结产品 API。
- **MCP**：Agent 工具调用的可选传输，不等于 Plugin/Skill，也不能绕过 Relay Executor。
- **Session/Handoff**：P0 提供持久化 Run Context、来源/摘要/Checkpoint 引用和 Resume（必要时重建上下文）。Session↔Session 的 spawn/send/ask/steer/interrupt/observe/terminate 属 P1+，仅作为可测试设计契约，不是 P0 的并行 Agent 总线。
- **Durable Workflow**：Relay 定义状态机及恢复语义；具体底层 PostgreSQL 事务/lease 或 DBOS，需 POC 选择，**绝不两套引擎同时调度同一 Task**。

### 已有 Pi RPC 与 pstack 复用边界（ADR-0012）

Relay 当前实现已选择固定版本 Pi RPC 与双层沙箱；文档中的 Pi SDK/RPC 取舍是历史 POC，不代表现在还未选型。
生产 Pi 精确锁定，候选升级需验证/回滚；扩展可以运行代码，必须审核网络、挂载、子进程、许可证和权限。当前短 Run 不等于已支持实时附着。
pstack 的需求质疑、独立 Review、根因分析等方法可按需引用；不得启用第二调度、自动循环、自动新建分支或自行扩大执行权限。

## Skill / Capability / Plugin / 传输

```text
Skill（怎么做 / SOP）
    ↓ 声明需要的 Capability（如 scm.read_diff）
Capability Provider（Plugin/Adapter：如 GitHub）
    ↓ 使用 MCP / API / CLI / Native 中的一种途径
Policy + Scoped Executor → Observation
```

Skill 不自带高权限，Plugin 不负责 Task 状态；能力通过版本化输入/输出和最小授权范围提供。P0 只实现必须的少数 Adapter，不做动态 Marketplace、签名分发平台或全面兼容层。

Method Pack 只是内容/检查项。OpenSpec、Superpowers、BMAD、Comet 不作为嵌套编排器。示例：`code-review` 方法声明 `scm.read_diff`、`ci.read` 和 `review.submit`，可由不同 Provider 提供。

## Operator 最小路径

| 层级 | 能力 | 边界 |
| --- | --- | --- |
| P0 | FS/Shell/Git、本地测试/CI 命令、GitHub 受控读写 | 强权限隔离与 Audit；只在已批准的 Project 工作区 |
| P0 测试 | Playwright Test / HTTP 集成测试 | 验证真实交付，**不是**通用可任意浏览的 Agent Browser Operator |
| P1 | Browser/Search/Crawler/SSH/Docker/Deploy、第二 Runtime、ACP/MCP | 需分别验收网络、权限、副作用与失效恢复 |
| DEFERRED | 通用 Browser Use 云环境、全域 SSH 运维、自动生产部署 | 不做默认 P0 权限 |

## Context、Memory 与 Code Intelligence

P0：PostgreSQL 保存 Task/Run/Decision/失败/证据索引；Markdown/结构化 Handoff 保留重要约束。不默认将全部历史输入模型。ContextResolver（可先是简单函数）按目标、Git SHA、来源、日期、权限/预算选取最小 Context Pack。

P1：Project Memory、PostgreSQL FTS/pgvector、按需 Code Intelligence。P2/RESEARCH：CodeGraph、Graphiti、Hindsight、OpenViking、Qdrant 等。检索结果是上下文/证据，不是权限或事实源；必须带可核查来源和时效。

## 建议技术栈（未达到安装承诺）

- TypeScript + Node.js 24、Hono、Zod、PostgreSQL + Drizzle；
- React + Vite（最小 Web 状态/审批 UI）、结构化日志；
- Pi Native SDK/RPC（POC 决定形式）、Git CLI、GitHub API、Docker 基础运行；
- Vitest、Playwright Test、真实 HTTP/API/DB 集成。
- DBOS：**OPEN / POC REQUIRED**。官方文档确认其需 PostgreSQL、Node ≥20；与部分打包工具存在 bundling 约束，且外部副作用仍须可重放/幂等治理。不可未验证便作为强依赖。
- SearchProvider 默认来源、Credential Broker、执行沙箱、CI 提供者、Runtime 回退、Node/依赖精确版本均 OPEN，按 POC 冻结。

上游核查参考：
- Pi：https://github.com/badlogic/pi-mono
- ACP 稳定/草案：https://agentclientprotocol.com/
- DBOS：https://docs.dbos.dev/typescript/integrating-dbos

这些 URL 仅供未来重新核查，上游实时版本不是本仓库冻结事实。
