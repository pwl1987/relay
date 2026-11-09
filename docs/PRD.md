# Relay / HIVE Next 产品需求文档（PRD V1.0）

状态：**FROZEN（产品问题、用户结果、P0范围与验收原则）/ OPEN（具体交互阈值与尚未 POC 的技术实现）**。日期：2026-11-09。本文定义**做什么、为什么、完成标准**；架构与实现归 [详细架构](DETAILED_ARCHITECTURE.md) 和 [建设方案](CONSTRUCTION_PLAN.md)。本文不是已经实现功能的声明。

## 1. 产品摘要

**一句话**：Relay 是面向单人开发者/小团队的自治软件交付系统。用户可以给出模糊目标，Relay 在授权范围内调查、挑战、给出建议、执行受限代码变更、独立验证并交付证据，在中断与人工缺席时安全继续其他可执行工作。

工作方式：`Goal → Discovery/Decision → WorkPackage/Task → Run → ChangeSet → Quality Gate → Delivery → Feedback`。输入是业务目标，输出是经证据验证的成果，不是“Agent 对话很长”或“提交很多代码”。

**重要区别**：
- 不依赖 ChatGPT；ChatGPT 是可选 Client，离线/无 ChatGPT 时 CLI、Web、API 仍可用。
- 持续工作不是无条件执行：没有安全的 Ready Work、预算或授权时保持可解释的 IDLE/BLOCKED。
- 首版针对单用户、单仓、单写者；多仓/复杂联邦是目标兼容能力而非 P0 完成条件。
- RSI 自我改进属于后续能力，不能跳过外部验证、版本隔离和回滚。

## 2. 用户画像与关键任务

| 角色 | 主要需求 | P0 交互面 |
| --- | --- | --- |
| Owner（单人项目负责人） | 不会完整写 PRD，也想持续产出；希望只在必要处决策 | Web 最小入口/审批、CLI |
| Operator（可与 Owner 是同一人） | 知道目前在做什么、失败在哪里、如何停止/恢复 | Web 状态、审计、CLI/API |
| Reviewer（独立运行上下文/验证器） | 不依赖编码 Agent 的口述，独立判断是否达成验收 | Diff、CI/测试、证据索引 |
| Agent（非人） | 获得明确任务/预算/作用域及工具能力，提交结果而非自行批准 | Runtime Contract |

P0 明确**单租户**；不创建角色模拟员工组织，不建设团队 HR、跨组织 SSO 或通用工单平台。

## 3. 用户问题与价值

- P1：需求不清楚，如“界面不好用”，现有 Coding Agent 往往直接写功能或反问十几个问题。
- P2：Agent 长任务断线、被动等待或反复失败，难以 24×7 稳定推进。
- P3：Agent 自报完成，与真实运行情况、用户旅程或整体发布结果脱节。
- P4：模型能力/额度不稳定，需要在本地模型为主的情况下控制成本与质量。
- P5：外部工具权限过大，自动化可能误删/误推送/生产误操作。
- P6：跨对话、跨 Runtime 缺乏可靠状态与项目事实源。

产品价值应以**已验收成果、失败可恢复性、人工介入减少、风险隔离、证据可追溯**衡量，不能以 Token 消耗、循环次数或自评质量作为完成指标。

## 4. P0 完整业务流程（E2E 主线）

1. Owner 在 CLI 或 Web 输入一句话需求、选择已登记的项目、设置执行预算/风险授权。
2. Relay 先读取允许的仓库事实，产生问题陈述、假设、风险、推荐方案。可自行核查时不反问用户。对业务目标/高风险选择形成 Decision。
3. Owner 可采纳推荐；若不回应，只有事先授权的 D0–D2 低风险路径继续，其他依赖 D3/D4 的动作局部阻塞。
4. Workflow 把目标编成有界 WorkPackage/Task，含范围、验收、预算、依赖和回滚线索。
5. Worker 通过 Pi 调用受控 Operator，在独立工作区创建候选 ChangeSet；不把高权限 GitHub/SSH Token 给模型。
6. Coder 只能 SUBMITTED，不能直接 ACCEPTED。Reviewer 独立读取候选 Diff 与需求，测试工具输出机器证据；必要时以真实 HTTP 或 Playwright Test 验证用户旅程。
7. Gate 按具体 commit、环境与证据做 PASS/REWORK/BLOCK/ESCALATE；通过且授权足够才进行 GitHub 受控集成/交付。
8. 记录 ChangeSet 的变更、核查结果、未解风险、回滚、耗时/预算；对后续反馈新建 Goal，不覆写历史。
9. 任何中途断电/断线后，Relay 从持久元数据和外部 Git 现实进行 reconcile，恢复有资格的工作；无法判断副作用结果时进入 NEEDS_RECONCILE。

## 5. 用户故事与可观察验收

**US-01 创建模糊目标（P0）**  
作为 Owner，我可以输入“这个管理页不好用”，指定 Project、允许的代码库、预算和约束；系统保留原话，列出可核查假设和**一个推荐行动**，并指出仍需人决定的事项。验收：保留原始需求及来源；输出至少一个可判定成功条件，若信息不足则提出最少的关键问题或验证性原型，而非假造业务答案。

**US-02 主动质疑与调研（P0 最小，P1 完整）**  
系统应区分用户想实现的方案与真正目标；先读取代码/已知缺陷/测试，允许质疑用户方案，给出理由及证据。P0 至少能对已注册项目做本地代码与文档调查；公网 Search/Crawler 属 P1。验收：至少一次问题定义与方案对比记录可回放；不可用的调研能力要显式说明。

**US-03 有界工作包（P0）**  
Owner 或 Relay 可以把采纳目标转为 Task（目标、输入 ref、允许文件、依赖、预算、验收）；超范围提案必须拒绝或另行申请。验收：不具备授权的任务不会领取 Lease，不会触碰禁止路径。

**US-04 不依赖 ChatGPT 的控制（P0）**  
用户可从本地 CLI/API 创建、查看、暂停、恢复 Goal；最小 Web 显示目标、状态、审批和证据。验收：不连接 ChatGPT 情况下完成完整演示，且控制面不依赖浏览器会话长连接。

**US-05 断线恢复（P0）**  
Worker/Agent 意外终止后，系统识别过期 Lease，核对上次副作用和可恢复的 Handoff，再安全重启任务。验收：故障注入后不能发生重复不可逆写入；进度、原因和恢复动作可查询。**不承诺恢复模型隐状态**。

**US-06 决策超时（P0）**  
人工未回应时，系统只让不依赖审批且符合 D0–D2 预授权的任务前进。验收：D3 生产/扩权动作无论超时多久都不执行，受影响分支 BLOCKED，独立安全任务仍可执行。

**US-07 独立质量门（P0）**  
Coder 提交后独立 Reviewer、确定性测试和 Reality Check 组成判定链。验收：假造 DONE、缺少 commit 证据、测试失败、Review BLOCK 均不能通过；修改 commit 后对应 Gate 自动失效需重跑。

**US-08 GitHub 安全集成（P0）**  
在单仓 `main` 和唯一 Writer 下，Relay 可提交已接受 ChangeSet（P0 初期要求用户确认写远端）；不允许强推。验收：基线 HEAD 不匹配时不覆盖新提交而是重新 reconcile，报告冲突。

**US-09 持续运行与预算（P0）**  
系统自动执行 Ready Task，在连续错误、失联、无进展、预算上限时有界 Retry/Replan/Block。验收：故意制造无限失败用例后成本/尝试数有限；没有可执行任务时稳定 IDLE，不循环烧 Token。

**US-10 真实交付可见（P0）**  
Goal 页面可见运行、证据、问题、当前 Owner 待办、变更 SHA 与回滚。验收：用户无需读 Agent 长日志即可识别“已完成/待批准/失败/无法判断”。

**US-11 多仓 ChangeSet（P1）**  
一个 Project 可以关联多个 Repo，变更跨仓有关联验收和部分失败补偿；不承诺跨仓原子 Git 事务。验收：一个仓失败时不得错误宣称整体交付成功。

**US-12 Runtime/模型切换（P1）**  
Task 可以按能力档位/预算选择合适模型或第二 Runtime；模型弱则缩小任务范围和加强证据。验收：切换不改变 Goal/Policy/Gate 权威，不降低验证强度。

**US-13 Self-improvement 提案（P1/P2）**  
系统根据复发失败、人工介入和性能指标形成改进 Proposal；仅隔离环境实现/验证并经过独立升级门后才能推广。验收：线上运行实例不能直接覆盖自己的代码/策略并宣称成功。

## 6. 优先级与范围（MoSCoW）

- **Must / P0**：单仓 Goal、最小 Discovery、Task/Run/Lease、Pi、最小 CLI/API/Web、隔离的 FS/Shell/Git、GitHub 安全提交、Decision D0–D4、独立 Review/真实测试、Evidence、崩溃恢复、可解释预算停止。
- **Should / P1**：通用 Browser/Search/Crawler/SSH/Docker/Deploy Adapter、多仓 ChangeSet、ACP/MCP 互通、Model Router、Method Pack、Memory/FTS/Code Intelligence、通知和审批摘要。
- **Could / P2**：复杂多 Session 协作、可视化任务图、Benchmark 驱动 Self-improvement、候选版本自动 Promotion（仅受控）。
- **Won't / 当前**：Kubernetes、Kafka 等重型强依赖，生产自动扩权/发布，全量 RSI、AI 软件公司 ERP、固定 16 阶段。

## 7. 非功能要求（NFR）

| ID | 必要约束 | 验证方式/当前状态 |
| --- | --- | --- |
| NFR-01 独立性 | 不使用 ChatGPT 时可创建/执行/验收完整案例 | P0 E2E 实测 |
| NFR-02 持久化 | 所有状态变化可在重启后重建，动作日志不可无痕改写 | DB/故障注入 |
| NFR-03 权限 | 默认拒绝；Agent 无宿主机/生产高权限令牌，未授权动作不得执行 | OS 级隔离+对抗测试 |
| NFR-04 可解释 | 每个阻塞、超时、重试、验收都有原因与证据引用 | UI/API/日志测试 |
| NFR-05 资源边界 | 每 Task 限时间、成本/token、尝试次数与输出大小 | 人为无尽失败测试 |
| NFR-06 重复执行 | 外部写动作结果未知时先 Reconcile，不能盲目重放 | 强故障注入 |
| NFR-07 单人维护 | 常驻组件优先 server/worker/Postgres，浏览器按需 | 部署拓扑与重启演练 |
| NFR-08 质量 | 代码 diff/真实测试/独立 review 与精确 SHA 关联 | 证据矩阵 |
| NFR-09 可迁移 | Project!=Repository、Runtime!=Model、Context/Policy 可替换 | 合同测试（P1 再做第二实现） |
| NFR-10 数据治理 | 日志脱敏、证据保留/清理、密钥不传给模型 | 安全审计 |

## 8. MVP 发布验收（避免假装数值已被验证）

必须在**预先记录的、可复现的样例仓库**完成：一例模糊需求、一个普通缺陷、一个故意失败用例；验证至少一次服务进程强杀+恢复、一个重复外部写入回执丢失、一个权限越界尝试、一个 D3 超时、一个 Reviewer 抵制伪造 DONE、一个真实 API/Web 行为检查。样例和固定失败注入脚本见 [验证计划](VALIDATION_PLAN.md)。

量化服务 SLO（如自动恢复时延、任务成功率、24h/72h 长稳、Token 预算、并发）在 P0-00 测试环境与样本确定后冻结，不应虚构完成率目标。**MVP 出口是能够可靠拒绝不安全动作，不是每种请求都自动交付**。

## 9. 发布后观测指标

第一优先：`accepted_changesets/goal`、`real_world_pass_rate`、`rework_count`、`unsafe_actions_blocked`、`unknown_side_effect_reconciled`、`stalled_runs`、`human_decisions`、`cost_per_accepted_outcome`。绝不把“总 Token/运行小时/产出文件数”视为产品成功。初期仅采集匿名或项目内允许的数据，不做外部上报。

## 10. 关键风险与开放问题

- **OPEN-A**：Pi 工具能否在实际 OS 沙箱下做到仅 Scoped Executor 可写。
- **OPEN-B**：PostgreSQL 自建 Tick/Lease vs DBOS 的最小可维护路径。
- **OPEN-C**：外部网络/模型额度断供后持续工作的正确降级与预算参数。
- **OPEN-D**：VM80 运行资源、容器/网络安全基线、备份条件实际检测。
- **OPEN-E**：首版 Web 认证和远程访问策略（必须先确定，不允许默认公网裸露）。
- **DEFERRED**：自动线上自我升级、跨仓事务、第二 Runtime、复杂 SearchProvider。

本 PRD 在这些实现问题未关闭前保持“**产品与可验收边界完整，技术决策有意开放**”。