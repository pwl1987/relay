# WEB-UX-03 · Relay 对话式 AI 开发工作台重构大包（合同登记）

- 状态：**执行中——03A~03D 已完成（2026-11-13，各阶段独立 Reviewer PASS，记录 p0-mvp/REVIEW-webux-03*.md）；整体 ACCEPTED 唯一剩余门=§12 之⑤用户 Mac 实机验收（Agent 不代宣布）**。用户指令 2026-11-12 下发完整合同文本；本文件为登记与执行摘录，完整合同以用户指令原文为准。
- 性质：治理/设计包——**零模型消耗、零产品代码变更**（03A 阶段）。实现（03B–03E）另行按合同授权逐阶段进行。
- 权威链（不变）：`Relay Web → Relay API → Relay Core → Goal/Task/Run、Policy/Budget/Lease、Reviewer/Gate、Delivery/Evidence → Pi Runtime`。Pi 仍只是执行 Runtime，Chat UI 只是 Relay Core 的操作界面。

## 1. 背景与当前裁决

- `WEB-UX-02 Engineering = PASS`，但 `User Experience = REWORK`（用户 Mac 实机反馈：打开后不知如何操作、不知如何持续交互、仍像后台管理系统、"创建需求→去其他页看状态"不自然）。
- 因此**不得**以调色/圆角/标题/加卡片修补主交互；必须重构交互模型：从"后台管理控制台"→"**AI 软件开发工作台**"。
- 用户核心行为只有一件事：**选择一个项目，然后持续告诉 Relay 想做什么**。Relay 自动完成 理解→调查→规划→编码→测试→复核→决策请求→交付，全程在同一工作会话中呈现。

## 2. 交互参考边界

- 参考 `agegr/pi-web`（仅借鉴：工作区布局、会话交互、项目/会话侧栏、Agent 状态展示、移动端交互、输入区体验）。
- 禁止移植 Pi-Web 的 Session、后端、模型管理或生命周期到 Relay。既有登记台账 `docs/PI_WEB_REFERENCE.md`（HEAD `b96b28b`、MIT、零移植）继续有效。

## 3. 核心架构约束（不得制造第二状态机）

- 建立 **Goal Feed Read Model**：把现有事实（用户消息、Relay 回复、Discovery、Task 创建、Run 开始、工具执行摘要、修改完成、测试结果、Reviewer、Gate、Decision、Delivery、Failure）投影成统一时间流。
- Task/Run/Gate/Decision/Delivery 状态**仍以现有 Core/DB 为唯一事实源**；Feed 只做投影，不复制状态。
- 最小持久化扩展：append-only 表 `goal_messages`（id、goal_id、actor、kind、content、created_at、related_task_id nullable、related_decision_id nullable；actor=USER/RELAY；kind=USER_MESSAGE/RELAY_MESSAGE）。若审计发现现有表可无歧义承载需求，可复用，不得为设计漂亮强行新增表。
- 职责分离：`goal_messages` = 自由文本会话事实；现有 Core Tables = 软件执行事实。

## 4. 主界面（桌面三层结构）

```text
┌──────────────┬───────────────────────────────┬──────────────┐
│ 项目/任务    │       对话式工作区            │  上下文详情  │
│ + 新建任务   │  用户消息/Relay 回复/执行事件 │  （可折叠）  │
│ 项目 A       │  决策卡片/测试结果/交付结果   │  项目/状态   │
│  ├ 登录优化  │                               │  模型/预算   │
│ 项目 B       │───────────────────────────────│  Git         │
│ 待我决定 1   │ 继续告诉 Relay……       发送  │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

- 主视图不得继续以 Dashboard 卡片墙为中心。
- 左侧栏参考 Pi-Web Session Sidebar 心智模型：`＋ 新建任务` 明显按钮；按项目分组显示任务/会话；状态点（蓝=执行中/黄=等待用户/红=有问题/绿=已完成/灰=空闲历史）；`待我决定 N`。AI资源/数据库/Worker 等系统项移入 `设置/系统状态`，不占主导航高优先级。
- 右侧详情栏默认只放少量（当前项目/任务状态/已运行时间/当前阶段）；点 `技术详情` 才展开 模型/Budget/Run/SHA/Gate/Reviewer/Delivery/Audit。

## 5. 新建任务与 Goal 升级

- 新建任务只需：**选择项目**（受控 Project Registry）+ **大输入框**（"例如：这个登录页面感觉不太好用，你自己检查并改好。"）+ `开始`。不得要求用户填 Task/Run/Scope/Model/Budget/SHA/Branch/Gate。
- `Goal = 一个持续开发会话`：首次消息形成初始 Goal；之后可继续输入（补充要求/改细节/回答 Relay/要求返工/询问为什么/继续优化）。核心验收样例见合同第七节（登录页优化全程对话）。

## 6. 回复、决策与结果直接进对话流

- Relay 回复两类：A 用户可读回复；B 系统事件卡片（✓ 项目分析完成 / ● 正在修改代码（当前阶段模型，已运行 3 分钟）/ ✓ 测试通过 7/7）。底层 tool call 默认隐藏，提供 `查看技术详情`。
- Decision 直接插入 Feed（⚠️ 需要你的决定 + 建议/原因 + [允许本次修改][不允许][稍后决定]）；独立"待我决定"页保留为全局 Inbox，但主操作优先在会话内完成。
- 完成后先显示结果卡（✓ 已完成/修改 N 文件/验证 ✓/交付 ✓ GitHub），再给 [查看修改][查看 Diff][查看测试][查看 GitHub]；输入框仍在，用户可继续说。

## 7. 手机与刷新

- 手机 390×844：主界面=当前会话（≡ 项目名·任务 / 用户消息 / Relay 回复 / 执行状态 / Decision 卡 / 底部输入）；操作=看会话、回复、Decision、Pause/Resume、看结果；项目/系统设置经抽屉。
- 刷新：前台 3–5s polling、后台降频、发消息后立即刷新、Decision 后立即刷新。**本包不引入 WebSocket/Event Bus**；若 SSE 明显更合适，须独立审计提出设计另行裁决。

## 8. 实施顺序（严格）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **03A 产品/架构冻结** | 用户旅程、信息架构、Goal Feed 设计、消息持久化设计、Pi-Web 对照、wireframe；独立 Reviewer 检查架构；**不立即大改前端** | ✅ 完成（9bc80af+c563ee5 Reviewer PF 消化） |
| 03B 后端最小支持 | 仅：Goal messages、Feed projection、follow-up message API、inline Decision API 复用、result projection；不改 Core 生命周期 | ✅ 完成（67f58c9；03B.1 消费闭环 a57a57e） |
| 03C Desktop Shell | 左 Sidebar/中央 Conversation/底部 Composer/Feed Event/Decision Card/Result Card/右侧详情 | ✅ 完成（03C.1 体验收口，Reviewer PASS） |
| 03D Mobile | drawer/chat workspace/composer/Decision/Result | ✅ 完成（Reviewer PASS 八问 8/8；p0-mvp/REVIEW-webux-03d.md） |
| 03E 真浏览器验证 | 进入最终验收 | ✅ 等价覆盖（DEPLOY-03D 32/32+DEPLOY-VERIFY-01 Chromium 17/17）；⑤用户实机验收待 |

## 9. 自动化验收（新增至少）

- J1 新建项目任务：选项目→输需求→Goal 创建→Feed 出现用户消息→Relay 状态出现。
- J2 执行过程：Discovery→Coding→Testing 在同一会话流展示。
- J3 Decision：出现在 Feed→用户点允许→状态继续推进。
- J4 完成：测试→Reviewer→Delivery→Result Card。
- J5 Follow-up：任务完成后继续输入"再优化一下按钮"→形成新的受控执行动作，**不创建脱离当前 Goal 的匿名 Pi Session**（生命周期策略由 03A 裁决）。
- J6 手机 390×844：消息→Decision→Result→输入回复。
- 必须保持既有测试全绿。

## 10. 视觉 Reviewer 新规（任一核心项失败 = UX REWORK）

1. 第一眼是否知道这是 AI 工作区？2. 是否明显知道在哪输入？3. 能否持续对话？4. 是否无需页面跳转完成核心旅程？5. Decision 是否自然出现在会话中？6. 结果是否自然出现在会话中？7. 内部工程术语是否默认隐藏？8. 是否明显接近 Pi-Web 类 Agent 工作区交互习惯？

## 11. 禁止项（全程有效）

- 禁止破坏 Core 链路（Web→API→Core→Pi）；禁止 Web Chat 直连 Pi。
- 禁止复制 Task/Run/Gate/Decision/Delivery 状态机；禁止第二后端/第二生命周期/第二状态模型。
- 禁止 fork pi-web、引入其后端、让 Pi Session 成为 Relay 用户会话 SoT。
- 禁止提前实施 MODEL-POLICY-01；不为"现代化"盲迁 Next.js（现有 Vanilla JS 可完成则继续用）。
- 旧 URL 尽量保持兼容；不删除现有功能（工作台/项目/任务/待决定/验收结果/AI资源/系统状态只重新定位：主交互=对话式工作区，辅助=全部项目/任务/待决策，高级系统=AI资源/系统状态/Evidence/Audit）。

## 12. 验收与用户裁决

- Agent 无权宣布 `WEB-UX-03 UX ACCEPTED`。最终验收五步：①自动化测试通过 ②独立工程 Reviewer PASS ③截图交 ChatGPT 复核产品体验 ④部署 VM80 ⑤用户 Mac 实机操作，用户明确反馈"现在知道怎么用了，可以正常和 Relay 交互"方可 `WEB-UX-03 = ACCEPTED`。
- 完成后停止，不自行进入 REAL-PILOT；等待 ChatGPT + 用户实际 UX 验收。

## 13. 暂缓事项（WEB-UX-03 完成前维持）

REAL-PILOT 正式验收、手机正式验收、MODEL-POLICY-01、复杂多模型动态路由、Push Notification、原生 Mac App、原生手机 App、公网开放。旧 R-3 旁路按既有合同收口，不阻断本包。

## 14. 特别要求：不过度设计

第一版只要真正做到：**选项目 → 说需求 → Relay 在一个对话里持续工作 → 需要决定时问用户 → 完成后给结果 → 用户可以继续说。** Terminal、代码编辑器、复杂多窗格、插件市场等全部不属于本包。

## 15. 最终交付清单

1. WEB-UX-03 ACTIVE 合同（本文件）；2. Pi-Web 对照研究；3. 交互架构设计；4. Goal Feed 设计；5. Desktop 实现；6. Mobile 实现；7. 自动测试；8. Desktop 截图；9. Mobile 截图；10. 独立 Reviewer 报告；11. 安全边界核查；12. CURRENT/CONTINUATION 更新；13. CI；14. live main SHA；15. VM80 部署结果。
