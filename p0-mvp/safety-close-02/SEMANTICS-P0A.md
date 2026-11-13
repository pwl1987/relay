# P0-A 最小交互语义方案:消息授权与终态 Goal(RELAY-SAFETY-CLOSE-02)

状态:**终态 Goal 部分已实施(本包)**;ACTIVE Goal 内消息分类 = **待用户决策**(见 §3)
日期:2026-11-13
依据:AGENT_CONTROL_LOCAL_QUALITY.md §3、ADR-0012 #3、WEB-UX-03C §0(冻结)、本包合同(CURRENT.md)

## 1. 代码实证(纠偏 GAP-REGISTER E-1/E-2)

上包 GAP-REGISTER 的两条结论与代码不符,本包独立复核推翻:

- **E-1 错误**("当前代码已符合设计,无自动派生"):`consumeGoalMessages`(src/core/consumption.ts)
  仅有 task 在途守卫(IN_FLIGHT),**无 Goal 状态守卫**;`POST /api/goals/:id/messages`
  (src/server/api.ts)对任何未消费 USER 消息都会经 `planFollowUpTask` 派生 READY Task,
  scope/commands 继承该 Goal 最近 Task。普通消息 = 隐式授予新任务执行权。
- **E-2 错误**("终态 Goal 消息静默沉淀,无处消费"):终态 Goal(COMPLETED/FAILED)上的消息
  **同样被消费并派生**;且 Goal 终态后 `aggregateGoals` 不再聚合(goal-loop.ts 只扫 ACTIVE),
  派生任务执行后 Goal 状态永不更新 = **孤儿执行**(状态机外执行)。
- 反例实证(修复前真实运行,断言失败输出即漏洞证据):
  `p0-mvp/safety-close-02/evidence/counterexample-terminal-goal-derived.log`
  —— COMPLETED/FAILED/EXHAUSTED/PAUSED 四态 + 未消费消息 ⇒ 全部派生(consumed=true)。

## 2. 已实施(本包):非 ACTIVE Goal fail-closed(含在途窗口边界消费精化)

语义(最小变更,不动 WEB-UX-03C §0 在 ACTIVE Goal 上的冻结行为):

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 非 ACTIVE Goal(COMPLETED/FAILED/EXHAUSTED/PAUSED)+ **终态后新消息** | 派生 READY Task(孤儿执行) | 消费层返回 `goal_closed`;消息保留为 append-only 会话事实;不伪造消费映射 |
| 同上,API 入口 | 201 + followUpTaskId + 误导性"已形成新一轮执行"确认 | 201 + `held:true` + `followUpTaskId:null` + RELAY 确认"已记录……不会自动创建新执行任务;如需继续,请新建一个需求" + `GOAL_MESSAGE_HELD` 审计 |
| **在途窗口补充**(消息创建于终态迁移**之前**;API 在途时已承诺"将在会话流中呈现") | 边界消费派生 | **保留**(§0.1 冻结):可审计重激活(GOAL_ACTIVE)后边界消费派生;aggregateGoals 恢复聚合,补充轮执行完重新聚合回终态 —— 无孤儿执行 |
| 混合批次(部分先于/部分后于终态迁移) | 全部派生 | **整批保守 held**(不部分消费) |
| `planFollowUpTask` 直呼(绕过消费层,目标 Goal 非 ACTIVE) | 成功派生 | fail-closed 抛错(`goal 非 ACTIVE(...)`) |
| ACTIVE Goal + 消息(§0 冻结面) | 派生 | **不变**(回归测试钉住) |

时间戳基准 = `goals.updated_at`(唯一更新源 = `setGoalState`,已核实:终态迁移时刻)。
实现点:src/core/consumption.ts(两级 Goal 状态守卫 + 边界重激活)、src/core/goals.ts
(planFollowUpTask fail-closed)、src/server/api.ts(intake 反馈)。消息、审计、幂等语义全部保留;
不扩大旧 Task 权限与预算(派生继承语义原样,仅在 ACTIVE/重激活会话上仍然可达)。

## 3. 待用户决策:ACTIVE Goal 内消息分类(普通交流 / 补充反馈 / 明确执行请求)

合同要求"区分普通交流、补充反馈和明确执行请求;普通消息不能隐式授予新任务执行权"。
**本项三种可行实现都必须改变 WEB-UX-03C §0 的冻结语义**(冻结语义="无在途 ⇒ 未消费 USER
消息合并派生 follow-up Task"),因此按合同停止条件(改变已冻结用户业务流程须请求决策),
本包**不实施**,仅登记方案:

- **方案 A(意图字段)**:Composer 增加显式"执行 / 仅说明"意图(或发送按钮分离);
  仅 execute 意图进入派生。优点:确定性、零误判;缺点:改变冻结的单 Composer 交互,
  增加用户操作成本。
- **方案 B(确认流)**:消息一律先记录;RELAY 追问"要创建执行任务吗?"(Decision 卡或
  会话内确认),用户确认后才派生(对应反馈词"待确认")。优点:默认最安全;缺点:每次
  补充反馈多一步确认,与 WEB-UX-03"持续告诉 Relay 想做什么"的产品心智冲突。
- **方案 C(会话即授权)**:维持现状(ACTIVE Goal 内一切消息 = 执行授权上下文),仅依赖
  本包已实施的终态守卫。优点:零冻结语义变更;缺点:普通交流仍会派生(本项安全缺口在
  ACTIVE Goal 内保留)。

本包默认生效的是 **C**(不改冻结语义);若用户选择 A 或 B,须新授权包(涉及 web/ Composer、
API 协议字段与 WEB-UX-03C §0 修订)。

## 4. 相关语义边界(本包一并核实)

- PAUSED Goal:当前无任何路径把 Goal 置 PAUSED(setGoalState 支持但无调用方),任务级
  pause 不改 Goal 状态;为防御未来状态引入,PAUSED 已纳入非 ACTIVE 守卫集。
- 暂停任务 + 新消息:ACTIVE Goal 下的派生不受任务级 pause 影响(派生的是"新受控动作",
  非"旧计划领取";AGENT_CONTROL §4 的暂停语义针对旧计划)。该交互与 §3 分类决策相关,
  一并留待用户裁决。
