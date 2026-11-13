# RELAY-QUALITY-LOCAL-01 差距登记（阶段 E，只读）

审计基线：live main = 2b57f04（本包合同登记提交）；审计时点：2026-11-13。
性质：**只读核查**，本包不实现下列任何能力；每项给出代码事实、设计预期、风险、最小后续任务与优先级。
排序原则：安全风险优先于用户体验价值；避免把差距扩展为新平台。

## E-1 普通用户消息自动派生 READY Task 的授权风险

- **代码事实**：`planGoal` 唯一入口 = `POST /api/goals`（src/server/api.ts:321，显式用户意图 + deriveDefaultPlan）；goal_messages 经 `consumeAllPendingGoals`（src/core/consumption.ts）仅注入**在途 Run** 上下文（IN_FLIGHT_STATES，at-most-once 消费表），无任何 `INSERT INTO tasks` 路径。
- **设计预期**：AGENT_CONTROL_LOCAL_QUALITY.md §3"普通对话不得默认创建 READY Task"。
- **结论**：当前代码**已符合设计**（无自动派生）。风险=未来功能演进可能在消息链上加派生。
- **最小后续任务**：在 consumption.ts 消费路径加一条"禁止任务派生"的断言注释/回归测试（防回归护栏），P2。
- **依赖/优先级**：无依赖；P2（护栏性质）。

## E-2 Goal 已完成（终态）后的后续消息处理

- **代码事实**：消息注入仅面向在途 Goal/Task（consumption.ts:60-62 IN_FLIGHT 过滤）；终态 Goal 的追加消息**无处消费**（静默沉淀在 goal_messages 表，无 UI 提示、无关联新 Goal 流程）。
- **设计预期**：§3"终态 Goal 上的新要求不得静默派生可执行 Task；应生成关联新 Goal 或经可审计授权重开"。
- **风险**：用户在已完成 Goal 里继续输入 → 无任何反馈（用户体验缺口，非安全缺口——不会误执行）。
- **最小后续任务**：①Feed 层对终态 Goal 的消息显示"该需求已完成，请新建需求"提示；②可选"从该 Goal 派生新 Goal"按钮（预填原文，用户显式提交）。P1（用户价值高、实现小）。
- **依赖/优先级**：依赖 WEB-UX-03 Feed 视图；P1。

## E-3 Agent 实时观察、steer、abort、pause

- **代码事实**：pause/resume 有（tasks 状态 + ops API + Decision defer）；`steer`/`abort` 关键字在 src/server/ 与 src/core/ **零命中**；runner 内部有取消信号（cancel 轮询 → SIGTERM→SIGKILL，run=CANCELLED，src/runtime/runner.ts:69,367-386）但**无用户入口**。
- **设计预期**：§4 六种操作 + 命令回执语义（RECEIVED/QUEUED/APPLIED/STOP_CONFIRMED）。
- **风险**：在途 Run 一旦启动，用户只能等租约/预算耗尽或暂停领取，无法即时纠偏（成本与体验风险，非安全风险——权限不会扩大）。
- **最小后续任务**：①abort = 复用 runner 现成 cancel 信号 + ops API 暴露 `POST /api/tasks/:id/abort`（校验租约/版本，落 ControlCommand 审计）；②steer = goal_messages 已有的 Run 注入通道即可承载（消息已进 Run 上下文），缺的只是 UI 语义标注。P1。
- **依赖/优先级**：abort 依赖 runner cancel 信号暴露；P1（安全价值：及时止损）。

## E-4 人工接管/交还及旧 Writer 撤销

- **代码事实**：无 takeover/handback 实现；最接近的机制 = 验证租约接管（acquireVerificationLease，verify-lease.ts）与租约 TTL 过期回收（lease.ts）；"接管"字样仅出现于验证编排注释。
- **设计预期**：§4 人工接管 = 撤销旧 Writer 资格 + 阻止旧 Run 推进 + 核查副作用 + 交还控制权。
- **风险**：模型 Run 卡死/失控时，用户无法即时取得工作区写权（当前只能等 TTL）；交还时无副作用核对清单。
- **最小后续任务**：①管理员 API `POST /api/tasks/:id/takeover` = 显式撤销租约（fencing 失效）+ 任务转 NEEDS_DECISION/PAUSED + 审计；②交还 = 新 Run 重建（现有 resume 语义）+ Git 状态核对（working tree 干净才放行）。P1。
- **依赖/优先级**：依赖 E-3 的 ControlCommand 审计面；P1。

## E-5 PlanRevision 版本栅栏

- **代码事实**：无 plan_revision 表/结构；现有栅栏 = task.state_version + requirementSha（goalText+约束快照，changesets.ts:46）——需求文本变化 ⇒ 旧 Gate 全部失效（绑定校验拒绝）。
- **设计预期**：§5 方向变化先落不可变修订记录、旧计划不可领取、旧证据不自动复用。
- **风险**：目前"计划变化"只能靠重开 Goal/REWORK 重试，方向级纠偏无first-class记录（可追溯性缺口，非安全缺口——requirementSha 已挡住旧证据复用）。
- **最小后续任务**：PlanRevision = goals 表加 plan_revision 计数 + audit 记录（复用现有结构，不建新表——契约 §2 已预留此路径）；旧任务栅栏校验 revision 一致。P2。
- **依赖/优先级**：依赖 E-3/E-4 的控制面成熟；P2。

## E-6 子 Agent 权限、预算和取消传播

- **代码事实**：Pi 以单子进程运行（pi-rpc.ts spawn），取消/止损 = session.kill（SIGTERM→SIGKILL，runner.ts:240,367-386）；预算 = goal 级账本（budget.ts，coder/reviewer 同账本核算）；**无 Pi 子 Agent spawn 面暴露**（当前 Run 不派生子 Agent），故"子 Agent 权限收紧/取消传播"尚无真实攻击面。
- **设计预期**：§6 子 Agent 权限 ⊆ 父任务、消耗计入父预算、取消可传播。
- **风险**：若未来启用 Pi 多子 Agent，进程组传播与预算归集需要验证（当前 Pi 进程的工具子进程是否随 SIGKILL 全组终止未验证）。
- **最小后续任务**：①验证工具子进程组终止（进程组/sid 检查，一次故障注入测试）；②若启用子 Agent，先落"权限子集 + 预算子账本"两个断言测试。P2。
- **依赖/优先级**：依赖 Pi 升级/子 Agent 功能启用；P2。

## E-7 Provider 离线时确定性维护

- **代码事实**：provider 未配置/不可达 ⇒ tick 返回 IDLE_PROVIDER_DOWN 不领取（worker.ts:132-141，fail-closed 零消耗）；ops API（decisions resolve/defer/pause/resume）、迁移、对账均为确定性路径，不依赖模型。
- **设计预期**：§11"模型不可用时仍可安全完成已授权的确定性维护"。
- **结论**：**已符合设计**。缺口=NEEDS_RECONCILE 生产不自愈（DEPLOY-03D 已登记，Owner resume 实测有效）。
- **最小后续任务**：supervisor 循环加 executor（对 NEEDS_RECONCILE 先 Reconcile 再重派），沿用既有租约语义。P1（生产运维价值）。
- **依赖/优先级**：独立；P1。

## E-8 Pi 原生能力与 pstack 方法复用

- **代码事实**：Pi 1.5.0 精确锁定（package.json + pi-version.ts）；steer/abort/Session/Compaction 等 Pi 原生能力未在 Relay 侧暴露（与 E-3 同根）；pstack 方法（质疑/反例/TDD）体现为 Reviewer 围栏与 Gate 证据，无第二调度。
- **设计预期**：§7 生产 Pi 锁定、按需复用原生能力、pstack 仅方法复用。
- **结论**：边界**已符合设计**；升级路径=候选验证+回滚（已写入 INTEGRATIONS.md）。
- **最小后续任务**：无独立任务；随 E-3 一并暴露 steer/abort 时复用 Pi 原生 RPC 而非自建协议。P2。
- **依赖/优先级**：依赖 E-3；P2。

## 汇总

| 项 | 现状 | 安全风险 | 建议优先级 |
| --- | --- | --- | --- |
| E-1 消息派生任务 | 已符合设计 | 无 | P2 护栏 |
| E-2 终态 Goal 消息 | 体验缺口 | 无 | P1 |
| E-3 steer/abort | 缺失（内部信号已有） | 中（止损慢） | P1 |
| E-4 接管/交还 | 缺失 | 中（TTL 才能收回） | P1 |
| E-5 PlanRevision | 缺失（requirementSha 已兜底） | 低 | P2 |
| E-6 子 Agent 传播 | 无暴露面 | 低（暂无攻击面） | P2 |
| E-7 Provider 离线维护 | 已符合设计（NEEDS_RECONCILE 自愈缺口） | 低 | P1 |
| E-8 Pi/pstack 边界 | 已符合设计 | 无 | P2 |

后续大包建议：**"用户控制面最小实现"**（E-3 abort + E-4 takeover + E-2 终态提示，共享 ControlCommand 审计面），一个有界包覆盖三个 P1 项；E-7 supervisor executor 可并行独立小包。
