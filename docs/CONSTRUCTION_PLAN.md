# Relay 建设方案与实施计划

状态：**FROZEN（交付顺序、风险门禁、MVP 出口） / OPEN（工期、技术选型、容量参数）**。本方案供本地/VM80 Agent 接单执行；**不要直接把本设计文档当自动实施授权**。唯一 ACTIVE 包由 `CURRENT.md` 声明。

## 1. 环境选型与职责

**推荐：VM80 为首个主执行/测试节点，Mac 为终端、产品评审、远程管理入口。** 2026-11-09 只读查询 VM80 开发控制器：`ready`；ZCode、Pi、LoopX 均可用，开发根目录 `/home/ubuntu/dev`；项目列表中**未见 Relay 检出**。这些是当次观察，不构成 VM80 永远可用的保证。VM80 是否具备资源/备份/网络隔离，尚需 `P0-00` 重新检测。

原则：不要同时在 Mac/VM80 持有活跃 Relay 写者；VM80 创建独立项目工作区（路径建议 `/home/ubuntu/dev/relay`，须先检查存在性、权限与资源），不污染现有 dev-agent-kit / LoopX 的状态。GitHub `main` 始终唯一持久代码事实源，VM80 控制器是执行工具，**不是 Relay 长期架构依赖**。Mac 上可执行只读审核/远程 CLI，但写操作交给唯一 Writer。

P0 初期以独立测试项目/沙箱运行，不动现有生产服务/数据。反向依赖禁止：Relay 不应需要 VM80 特有 Controller 才能启动；VM80 提供的是 bootstrap 的执行环境而非 Relay 引擎。

## 2. 分阶段产出（先证明，再加功能）

| 里程碑 | 交付边界 | 可判定退出条件 | 失败策略 |
| --- | --- | --- | --- |
| P0-00 可行性与威胁 POC | Pi SDK/RPC、默认工具隔离、PG Tick/Lease vs DBOS、外部动作失败语义；威胁模型 | 实测重复/崩溃/越权并留证；能选出最小安全路径或明确阻塞 | 安全隔离不成立→BLOCK，不转实施 |
| P0-01A 持久状态 | 最小 DB schema/migrations、状态转换、Lease、Audit、预算、CLI | 断电/重复 Tick、错误状态转换、双 Worker 竞争测试 | 只读追踪问题，不叠加复杂分布式队列 |
| P0-01B 有界 Pi Run | 单项目单任务、Pi 启停、Context/Handoff、受限工具 | 允许动作成功，禁止动作拒绝；Run 断线可重建上下文 | 工具旁路无法阻断→BLOCK |
| P0-01C Goal Loop | 简单目标→任务→状态，Decision Fallback，重试/replan/停滞熔断 | 人工缺席时安全 Task 继续；D3 一直被阻断；无限失败有限停止 | 退回小样例诊断 |
| P0-02A 提交与独立验证 | Candidate Diff、独立 Reviewer、测试/Reality Gate、Evidence | 错误答案/假 DONE 必失败；证据绑定 commit | Gate 缺失→不得 DELIVER |
| P0-02B GitHub 安全集成 | main-only、CAS/fast-forward、审批/授权/回滚记录 | 模拟远端 HEAD 已变时安全拒绝；成功写仅在 Gate 通过后 | 不重写历史；重审变更 |
| P0-02C 最小 Web + E2E | Dashboard、Goal、Decision、Evidence/ChangeSet，真实 journey | 完成 PRD 的 3 类样例与故障注入矩阵，CLI/API/Web 不依赖 ChatGPT | 不通过则不宣布 MVP |
| P0-ACCEPT | 独立复核设计/实现一致性和长稳报告 | 按 [验证计划](VALIDATION_PLAN.md) 出具通过/返工/阻塞的真实证据 | 接受之前不开展 RSI 自改 |

上表是可交付**切片**，不要求 7 个并行 Agent；一次只有一个 ACTIVE 工作包。Issue 适合跟踪，不能替代状态机；完成标准是 Outcome 和 exact-SHA Evidence。

## 3. P0-00 可执行实验包（首包建议）

**前置核验**：live GitHub `main`、仓库 Writer、VM80 `relay` 路径、剩余 CPU/RAM/Disk、Docker/Node/PG/git、出口/防火墙、Pi 可执行版本/来源、是否受其他项目占用。先只读，不要自动清理既有目录。

实验 A：Pi 启动时显式禁用默认 Bash/FS 工具并注入受控工具，尝试通过 prompt、extension、shell、环境变量读取超范围文件/令牌；OS 层阻断必须独立验证。

实验 B：同一 Task 并发两个 Tick/Worker 请求、Lease 过期后旧 Worker 继续、子进程 SIGKILL；状态不得出现双接受/越权提交。

实验 C：外部写动作**实际成功但响应/回执丢失**，新运行恢复后必须先查询目标状态，不得重复产生副作用；在 GitHub 测试仓库/Mock API 上模拟。

实验 D：对比 Pg 事务/租约小实现与 DBOS 的代码/依赖/排错/恢复；选择能满足上述测试且单人可维护的方案，而非先引入重型框架。

实验 E：对 3 类固定样例形成最小验收：模糊 UX 问题、普通缺陷、循环失败。记录 VM80 实际吞吐/预算/异常，未来才冻结 P0 限额。

**交付**：`p0-00/REPORT.md`（POC 真实命令/结果/失败归因/替代方案/决策）、ADR 更新、最小 P0-01A 执行契约。POC 使用临时受控测试代码，**不等于开始完整产品实现**。

## 4. 任务包必须具备的 Contract

每个 CURRENT ACTIVE：
- 唯一 outcome、起点 `origin/main`、唯一 Writer、允许读写路径/禁止路径；
- 可验证验收（工具、输入、预期输出、证据位置）、限时/资源预算；
- 不允许的外部环境、凭据、生产主机范围；
- 遇冲突/安全失败/不确定外部操作的停止与回滚；
- 最终报告：diff、commit SHA、exact-head CI、真实运行/E2E、未验证项；
- 完成后落盘、推送快进 `main`、`origin/main==HEAD`、本地 clean、交接下一包。

禁止临时再建长期 feature 分支；允许不指向命名分支的**临时 detached worktree**隔离候选改动，提交到 `main` 必须经过单写者租约/远端 SHA 校验。

## 5. 交付范围分界

**现在不开始**：第二 Runtime、Browser/Search/SSH 全能工具、跨仓事务、模型在线微调、大型 Knowledge Platform、全自动部署、Marketplace、复杂编排可视化。不要因已有其他项目的现成框架而绕过 Relay Contract 引入第二 Workflow 引擎。

**P1 进入条件**：P0 E2E 真实可复现；问题有指标支撑；Adapter 的安全、失败恢复及消费者已明确。首批建议模型能力分档/Reviewer、Browser/Search 受限工具、多仓 ChangeSet，从实际障碍中选择一项。

## 6. 建设质量/独立复核

- 文档阶段：一致性检查 + ADR/需求编号可追溯；不声称 CI 已运行。
- 实验阶段：复现脚本和结果有版本/环境标识，必须留失败日志。
- 开发阶段：类型/单测→真实集成→安全故障注入→独立 Reviewer→真实用户 Journey→ChangeSet Gate。
- 里程碑：每个验收对象需明确有效证据的确切 commit，变更后重新验证。
- 运行阶段：由 Operator/Owner 完成独立验收，不能只有同一个 Agent 的多个角色互赞。

## 7. 成本与容量计划

不先购买任何新中间件。直接成本：VM80 计算/磁盘、PostgreSQL、模型 API/本地推理、日志/截图存储、网络流量；间接成本：审计与恢复维护。**预算按每 Goal/Run/Day 分级控制**，部署后用实测 `tokens_per_accepted_change`、`cost_per_accepted_outcome`、`retry_ratio` 决定额度。

容量预估先测试：1 Worker/1 Run/1 Project，压测任务状态与 DB 竞争，CPU/RAM/IO/截图空间、模型响应和 GitHub 限流都要实际量化；不要把 3–5 万并发或企业多租户作为首版目标。扩展第二 Worker 前通过 Lease fencing 和外部副作用防重测试。

## 8. MVP 后自行迭代的进场门

阶段 1：Relay 开发**外部测试仓库**；阶段 2：Relay 在自己仓库隔离的 detached 工作区生成低风险候选；阶段 3：稳定版本编排独立评测、自动测试、用户门禁和人工可回滚升级；阶段 4：才可能持续产生 Improvement Proposal。任何当前在运行的 Relay 版本都不能无门禁直接覆盖自己的运行代码、Policy 或数据库迁移。

具体 Threat/Rollback、环境与测试分别见 [威胁模型](SECURITY_MODEL.md)、[部署方案](DEPLOYMENT_PLAN.md)、[验证计划](VALIDATION_PLAN.md)。