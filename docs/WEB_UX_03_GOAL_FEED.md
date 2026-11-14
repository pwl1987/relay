# WEB-UX-03 · Goal Feed 设计（03A 交付物；设计冻结）

- 状态：**设计冻结，已实施**（03A Reviewer PASS 记录 p0-mvp/REVIEW-webux-03.md）。**实现偏离（如实登记）**：游标采用"消息 id 单游标+决策卡/状态快照整体替换"（src/server/api.ts feed 路由），非本文 §4 的 (occurred_at,seq) 二元组逐事件增量；resolve 端点现位于 src/server/api.ts ~L705 起（语义不变）。
- 上游：`docs/WEB_UX_03_CONTRACT.md`（合同 §3/§8）；`docs/WEB_UX_03_ARCHITECTURE.md`（§4–§8）。

## 1. 定位与不变量

Goal Feed 是**读模型（Read Model）**：把现有事实投影成统一时间流，供对话式工作区渲染。

不变量（合同 §3）：

1. Task/Run/Gate/Decision/Delivery 状态**仍以现有 Core/DB 为唯一事实源**；Feed 只做投影，不复制状态机。
2. `goal_messages` = 自由文本会话事实（append-only）；现有 Core Tables = 软件执行事实。二者职责严格分离。
3. Feed 投影层**无自己的持久化状态**（游标由客户端持有），重启/刷新后可从 Core + `goal_messages` 完整重建同一时间流。

## 2. 事件流组成（两源合并）

```text
Feed(goal_id) = merge(
    goal_messages WHERE goal_id = ?        -- 自由文本会话事实
    core_projection(goal_id)               -- 软件执行事实投影
) ORDER BY occurred_at ASC, seq ASC
```

- `occurred_at`：事件发生时刻（`goal_messages.created_at` 或 Core 事件时间戳）。
- `seq`：同刻事件的稳定次序（投影层按源内序号生成，保证同刻事件顺序稳定）。
- 合并规则：两源按 `occurred_at ASC, seq ASC` 归并排序；同刻时 `goal_messages` 事件优先于 Core 投影事件（用户消息先于状态行，符合对话直觉）。

## 3. Feed 事件类型（投影规则）

| kind | 渲染 | 数据来源（唯一事实源） | 投影规则 |
| --- | --- | --- | --- |
| USER_MESSAGE | 用户气泡（右对齐） | `goal_messages` WHERE actor='USER' | 直接映射 |
| RELAY_MESSAGE | Relay 气泡（左对齐，Markdown） | `goal_messages` WHERE actor='RELAY' | 直接映射 |
| STATUS | 状态行（● 正在分析项目 / ● 正在修改代码 / ✓ 测试通过 7/7） | Task/Run 状态投影 | 状态变化时生成一条；同状态不重复 |
| DECISION | 决策卡（⚠️ + 建议/原因 + [允许][不允许][稍后决定]） | Decision 表投影 | pending→生成卡片；resolved→卡片更新为已决状态（不重复生成） |
| RESULT | 结果卡（✓ 已完成 + 修改 N 文件 + 测试 ✓ + 交付 ✓ + [查看修改][Diff][测试][GitHub]） | Task/Run/Delivery 投影 | Run 终态时生成一条 |
| FAILURE | 失败卡（✗ + 原因 + [重试][查看详情]） | Run/Gate 投影 | Run 失败/Gate 拒绝时生成一条 |

- 底层 tool call 默认隐藏；Feed 事件只做投影，**不复制状态机**。
- DECISION 卡状态跟随 Decision 表：pending→可操作卡片；resolved→卡片显示已决结果（已允许/已拒绝/已推迟），不重复生成新事件。

## 4. 投影算法（GET /api/goals/:id/feed?after=<cursor>）

```text
输入：goal_id, after（cursor = (occurred_at, seq) 二元组，客户端持有）

1. rows_msgs   = SELECT * FROM goal_messages
                WHERE goal_id = ? AND (created_at, seq) > (after)
                ORDER BY created_at ASC, seq ASC
2. rows_core   = core_projection_since(goal_id, after)   -- 只读投影，无写
3. events      = merge(rows_msgs, rows_core) ORDER BY occurred_at ASC, seq ASC
4. 返回 events（游标 = 最后一条事件的 (occurred_at, seq)）
```

- `core_projection_since(goal_id, after)`：只读投影 Task/Run/Decision/Gate/Delivery 状态变化，生成 STATUS/DECISION/RESULT/FAILURE 事件。**无写副作用**（纯读投影）。
- 游标语义：`(occurred_at, seq)` 二元组，客户端持有；服务端无 Feed 持久化状态，重启后可从 Core + `goal_messages` 完整重建同一时间流（不变量 3）。

## 5. inline Decision 流程（合同 §6）

```text
1. Core 产生 Decision（pending）→ core_projection 生成 DECISION 卡（pending 状态）
2. Feed 渲染决策卡：⚠️ 需要你的决定 + 建议/原因 + [允许本次修改][不允许][稍后决定]
3. 用户点 [允许] → POST /api/decisions/:id/resolve {taskId, expectedStateVersion, approve:true}（复用现有 Decision resolve 语义；expectedStateVersion 不匹配→409；内联透传，不向用户暴露版本号）
4. Core 更新 Decision（resolved）→ core_projection 更新该卡片为已决状态（已允许）
5. 状态继续推进（STATUS 事件随之而来）
```

- 独立"待我决定"页保留为全局 Inbox（二级入口），但主操作优先在会话内完成（合同 §6）。

## 6. STATUS 事件生成规则（core_projection）

| Core 状态变化 | 生成的 STATUS 事件 |
| --- | --- |
| Goal 创建 / 首条消息 | （无 STATUS；Goal 创建由 USER_MESSAGE 隐含） |
| Discovery 开始/完成 | ● 正在分析项目 / ✓ 项目分析完成 |
| Run 开始（Coding） | ● 正在修改代码 |
| Run 开始（Testing） | ● 正在测试 |
| 测试完成 | ✓ 测试通过 N/N 或 ✗ 测试失败 |
| Reviewer/Gate | 相应状态行（不展开细节，技术详情展开才见） |
| Delivery | ✓ 已交付 |
| Run 终态（成功） | RESULT 卡 |
| Run 终态（失败）/Gate 拒绝 | FAILURE 卡 |

- 同状态不重复生成（状态未变不产生新事件）。
- 技术细节（Run/model_ref/SHA/Budget/Gate 详单）默认隐藏，`技术详情` 展开才见（合同 §6：用户不需要看到底层所有 tool call）。

## 7. 与 03B 的边界（合同 §8）

本设计为**纯读投影 + append-only 会话事实**，不改 Core 生命周期（03B 只做：Goal messages、Feed projection、follow-up message API、inline Decision API 复用、result projection；不改 Core 生命周期）。

## 8. 验收挂钩（合同 §9 自动化验收）

- J1（新建项目任务）：Goal 创建 → Feed 出现 USER_MESSAGE → Relay 状态出现（STATUS 事件）。
- J2（执行过程）：Discovery→Coding→Testing 在同一会话流展示（STATUS 事件序列）。
- J3（Decision）：Decision 出现在 Feed → 用户点允许 → 状态继续推进（DECISION 卡 resolved + STATUS）。
- J4（完成）：测试→Reviewer→Delivery→RESULT 卡。
- J5（Follow-up）：任务完成后继续输入"再优化一下按钮"→形成新的受控执行动作，**不创建脱离当前 Goal 的匿名 Pi Session**（合同 §5/§9-J5）。
- J6（手机 390×844）：消息→Decision→Result→输入回复。
