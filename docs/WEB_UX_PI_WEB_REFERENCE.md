# WEB-UX-03 · Pi-Web 对照研究（03A 交付物 2，合同 §18）

- 状态：**设计冻结（03A Reviewer PASS 记录 p0-mvp/REVIEW-webux-03.md）；§8 复核义务状态（2026-11-14）=仍未对照 pi-web 真实源码落档复核结果——03C/03C.1/03D 已实施，五项〔推断〕按实现交付（pi-web 零移植台账保持为空），但"对照真实源码逐项复核并落档"的义务未兑现，保持开放登记，不虚构已复核。**
- 性质：**只借鉴交互模式，零移植代码**。源登记台账见 `docs/PI_WEB_REFERENCE.md`（HEAD `b96b28b`，MIT，移植台账当前为空 = 零移植）。
- 验证级别声明：本仓库无 pi-web 本地克隆；本对照基于 ①2026-11-12 GitHub API 实测的源登记台账（`docs/PI_WEB_REFERENCE.md`）②合同明确的借鉴边界 ③对 pi-web 公开交互模式的工程推断。**标注〔推断〕的条目须在 03C 实现时对照真实源码复核**；与实际不符处按 ADR 修订。

## 1. 对照范围（合同 §2）

只借鉴其：工作区布局、会话交互、项目/会话侧栏、Agent 状态展示、移动端交互、输入区体验。
不得移植：Pi-Web 的 Session 状态模型、后端、Provider 凭据体系、生命周期（合同 §11）。

## 2. App Shell 对照

| pi-web 模式〔推断，03C 复核〕 | Relay 语义重定义 |
| --- | --- |
| 左侧固定/可折叠导航 + 中央工作区 + 右侧信息抽屉 | 左：项目/任务侧栏；中：Goal Feed + Composer；右：上下文详情（默认折叠） |
| 会话列表按时间/状态分组 | 按**项目**分组任务/会话（Relay 权威对象是 `Project → Goal`，不是 Session） |
| 顶部摘要 + 中部时间线 + 细节折叠的信息分层 | Goal 原始需求/Project/状态/阶段/已运行时间 + Timeline（Discovery→Coding→Testing→Reviewing→Gate→Delivery） |
| 系统项（Provider/模型配置）不占主导航 | AI资源/数据库/Worker 移入 `设置/系统状态` |

## 3. 会话交互对照

| pi-web 模式〔推断〕 | Relay 语义重定义 |
| --- | --- |
| 会话时间线连续追加，无"去其他页看状态" | Goal Feed 时间流连续追加；核心旅程零页面跳转（合同 §1） |
| 用户消息/助手回复/工具事件混排一个时间流 | USER_MESSAGE / RELAY_MESSAGE / STATUS / DECISION / RESULT / FAILURE 混排一个 Feed（架构 §4） |
| running / unread / awaiting 的信息密度与状态视觉标记 | Running（蓝●）/ Waiting（黄●）/ Needs Decision（黄●+徽标）/ Failed（红）/ Completed（绿）/ Idle（灰）——Relay 语义重定义 |
| 底部输入区常驻，会话随时可续 | Composer 常驻；follow-up 形成新的受控执行动作，不脱离当前 Goal（合同 §7） |

## 4. Agent 状态展示对照

| pi-web 模式〔推断〕 | Relay 语义重定义 |
| --- | --- |
| running / awaiting 状态点 + 信息密度标记 | 状态点：蓝=执行中/黄=等待用户/红=有问题/绿=已完成/灰=空闲历史；`待我决定 N` 徽标 |
| 工具事件默认折叠，展开看详情 | 底层 tool call 默认隐藏；`查看技术详情` 展开（合同 §6） |
| 状态变化驱动时间线追加 | STATUS 事件由 Core 投影生成，同状态不重复（Goal Feed §6） |

## 5. 移动端交互对照（03D 输入）

| pi-web 模式〔推断〕 | Relay 语义重定义 |
| --- | --- |
| mobile bottom sheet（Decision 单手操作） | Decision 卡单手操作：[允许][不允许][稍后决定] 大按钮 |
| 会话页 = 顶栏 + 时间线 + 底部输入 | 会话页 = 顶栏（≡ 项目名·任务）+ Feed + 底部 Composer |
| 项目/系统设置经抽屉 | 项目/系统设置经抽屉；`待我决定` 全局 Inbox 在抽屉内 |

## 6. 输入区体验对照

| pi-web 模式〔推断〕 | Relay 语义重定义 |
| --- | --- |
| 输入区常驻底部，发送后立即反馈 | Composer 常驻；发送后立即刷新 Feed（合同 §7） |
| 多行输入 + 快捷发送 | 多行输入 + `发送`；follow-up 形成新的受控执行动作，不脱离当前 Goal（合同 §7） |
| 输入区不要求填写技术参数 | 只需选项目 + 大输入框 + `开始`；不得要求填 Task/Run/Scope/Model/Budget/SHA/Branch/Gate（合同 §5） |

## 7. 禁止移植（重申，全程有效；台账 `docs/PI_WEB_REFERENCE.md` §3）

- 不得 fork pi-web 作为 Relay Web 主仓；不得引入 pi-web 后端；
- 不得把 Pi Session 状态模型作为 Relay 状态源（权威对象保持 `Project → Goal → Task → Run → Decision → Gate → Changeset → Delivery`）；
- 不得绕开 Relay Core 直接操作 Pi；不得复制其 Provider 凭据管理体系；不得引入第二 Lifecycle。
- 移植台账（`docs/PI_WEB_REFERENCE.md` §2）当前为空 = 零移植；若 03C 实施发生实质复制，须在该台账逐文件登记并保留 MIT notice。

## 8. 03C 复核清单〔推断项验证义务〕

03C 实现时须对照 pi-web 真实源码（HEAD `b96b28b`）复核以下〔推断〕项，不符处按 ADR 修订：

1. App Shell 三层布局的具体折叠/断点行为（§2）；
2. 会话侧栏的分组/状态点/未读标记具体形态（§3）；
3. running/awaiting 状态点的具体视觉密度（§4）；
4. mobile bottom sheet 的具体交互形态（§5）；
5. 输入区多行/快捷发送的具体形态（§6）。

复核结果以 ADR 或本文件修订记录落档；实现不引入 pi-web 依赖树，移植台账（`docs/PI_WEB_REFERENCE.md` §2）保持登记义务。
