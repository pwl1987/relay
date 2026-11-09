# Relay 首次正式顶层设计最终审计

日期：2026-11-09。状态：**FROZEN（审计裁决）**。审计依据：live `main` 起点 `342c9bce59c0fbbfbc37e5b8880babcd9ad725b9` 的 README、四份领域/架构文档与六个 ADR，以及当前目标约束。**这是设计审计，不是对尚未存在的运行代码的安全认证。**

## 十项审计结论

| 审计维度 | 裁决及关键修正 |
| --- | --- |
| 1. 过度设计 | **修正**：只有一个 Workflow Owner；撤掉首版多 Agent 总线、通用 Registry/大公司角色模型。 |
| 2. P0 过重 | **修正**：P0-00 POC → 单仓纵向闭环 → 安全交付；把通用 SSH/Docker/Browser/Search 等移到 P1。 |
| 3. 职责重叠 | **修正**：Supervisor/State/Lease 一处拥有；Session 保存上下文，ACP/MCP 仅传输。 |
| 4. 难以实现或维护 | **修正**：不承诺跨系统 exactly-once、同一模型内部会话“复活”、无条件 24×7 成果。 |
| 5. 单人自托管适配 | **采纳**：main-only + 单写者 + PostgreSQL + 可选拆分 worker；不要求多角色协调服务。 |
| 6. 真正 24×7 | **条件性成立**：有安全 Ready Task、预算和可用服务可持续推进，失效有恢复/熔断；不是永久自主生产发布。 |
| 7. 离开 ChatGPT | **采纳**：CLI/API/最小 Web 本地控制；ChatGPT 仅 Adapter，不能成为唯一鉴权/状态事实源。 |
| 8. 模糊需求到交付 | **修正**：Discovery 必须挑战用户假设，提出推荐/原型；以 Outcome 和 Reality Gate 收口。 |
| 9. 质量门禁独立性 | **修正**：Reviewer 独立 Run/上下文；结合真实 CI/浏览器/HTTP 证据，不凭 Agent 自报。 |
| 10. 未来扩展空间 | **采纳但延期**：ACP/MCP、Multi-Repo、Memory、Model Router 只冻结边界，不建立空基础设施。 |

## 原仓库的实际冲突及消解

- `CONTRACTS.md` 写 `DISCOVER→SPECIFY→PLAN→EXECUTE→VERIFY→DELIVER→OPERATE`，与六阶段不一致：统一为 `DISCOVER→DESIGN→BUILD→VERIFY→DELIVER→OPERATE`。
- `P0_P1_ROADMAP.md` 和 ADR-0005 把 SSH/Docker 放进 P0，而用户要求首版轻量：改为 **P1 独立受控 Adapter**；P0 可使用 Docker 启动基础服务，但不把它建成 Agent 任意操作能力。
- `Session Fabric` 若 P0 同时实现 Agent-to-Agent、恢复、调度，将变成第二个引擎：P0 仅限 Session Persistence/Handoff；交互编排 P1。
- `DOMAIN_MODEL.md` 缺 WorkPackage 并未清晰规定 Project≠Repository：补语义，不强制增加同名数据库表。
- 缺 `AGENTS.md`、`CURRENT.md`、`docs/CONTINUATION.md`，补齐单写者、可接手任务及源事实边界。
- P0 安全盲区：模型默认 Shell/写入工具可能绕过应用 Policy；必须先验证进程/操作系统隔离，无法做到时降权而非上线。
- Lease/Checkpoint 不提供外部 exactly-once；必须建含“副作用结果未知”的恢复路径。
- P0 的 Browser 现实检验允许用 Playwright Test，但不等于开放 Agent 通用浏览器 Operator。

## 冻结、开放、拒绝

**FROZEN**：模块化单体；唯一 Lifecycle/Supervisor；六阶段；Project≠Repository；Runtime≠Model；Pi first；ChatGPT optional；ACL/Policy before Executor；有界运行/恢复；独立证据门；超时不放权；单写者 main-only。

**OPEN**：Pi SDK vs RPC 隔离、DBOS vs 自建简易持久化 tick、P0 数值预算及 Gate 阈值、Credential Broker/Sandbox、Search 默认实现、P1 Memory/CodeGraph 与 ACP 版本。

**RESEARCH**：跨仓补偿、第二 Runtime、Agent-to-Agent Session Fabric、更精细 Model Router、自我改进评测。

**DEFERRED/REJECTED**：重型消息/存储/控制面、通用插件市场、全量自我进化、自动生产部署、强制多 Agent 委员会、无界 Loop、固定文档流水线。

## 真实性边界

- 当前仓库仍是设计资料，没有完整源代码、CI、真实 Browser/Operator/故障恢复证据。
- 本次不宣称 24×7 已经可用，不将模型自测或文件存在当作可靠性验收。
- 对 DBOS/ACP/Pi 的接口与版本只能依据 P0-00 使用当时的上游文档和真实集成实验再确认。