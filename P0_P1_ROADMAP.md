# P0 / P1 路线图

状态：**范围 FROZEN；排序细节 OPEN**

## P0——轻量自治内核

1. PostgreSQL Schema：Project、Goal、Task、Run、Checkpoint、Decision、Approval、Lease、Evidence 和 Audit Event。
2. Lifecycle 状态机与确定性的 Task DAG 状态转换。
3. Supervisor Tick、Lease、重试、退避、Watchdog Recovery、Progress Guard 和有边界预算。
4. Session Fabric：运行上下文、Checkpoint、Handoff Package、Resume 和 Trace Hash。
5. 面向风险、可逆性和权限的 Policy Engine，以及 Decision Timeout 与 Safe Continuation。
6. 带 Model Capability Tier 和 Quality Gate Hook 的 Pi Runtime 适配器。
7. Core Operator：文件系统/进程、Git、GitHub、Docker、SSH；全部具备 Allowlist 和 Audit。
8. CLI 与本地 API；不依赖 ChatGPT。
9. 证据优先的验收：测试、Diff、命令结果和 Review Finding 都是 Artifact，不接受口头声明代替证据。

## P1——能力适配器与 Operator 扩展

1. Playwright Browser Operator 与 Search/Crawler 适配器。
2. 在统一 Runtime Contract 后接入 ACP 和 MCP 适配器。
3. Plugin Registry 与签名/Allowlist Plugin 加载。
4. Skill Pack 与方法模板（OpenSpec 兼容、工程 Review、Discovery），但不拥有控制流。
5. 可选 Memory、Knowledge 和 Code Intelligence Plugin。
6. ChatGPT 适配器、通知、过夜报告和审批收件箱。
7. Model Ladder、Evaluation Harness 和按 Task 类型配置的 Quality Threshold。

## P2 / DEFERRED

Kafka、Kubernetes、Qdrant、OPA、Temporal、Restate、分布式事件网格、自治生产部署、跨租户联邦以及强制性的多 Agent 委员会。

## 退出门禁

P0 只有在以下条件全部满足后才算完成：运行时被终止并重启后可以从 Checkpoint 恢复 Task；未经授权的 Operator 动作会被拒绝；超时 Decision 会被记录；验收可以由持久化 Evidence 证明。P1 还必须证明同一套 Contract 能穿过至少一个外部 Operator 和一个可选 Plugin。
