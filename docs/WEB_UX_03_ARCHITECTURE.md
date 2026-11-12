# WEB-UX-03 · 交互架构设计（03A 交付物 2）

- 状态：**ACTIVE · 设计冻结候选**（待独立 Reviewer 检查）。
- 上游：`docs/WEB_UX_03_CONTRACT.md`（合同）；`docs/PI_WEB_REFERENCE.md`（借鉴边界，零移植）。
- 权威链不变：`Relay Web → Relay API → Relay Core → Goal/Task/Run、Policy/Budget/Lease、Reviewer/Gate、Delivery/Evidence → Pi Runtime`。Chat UI 只是 Relay Core 的操作界面。

## 1. 用户旅程（验收基准即由此推导）

```text
打开 Relay
  → 看到左侧"项目/任务"侧栏 + 中央"继续告诉 Relay……"输入区
  → 选一个项目（或新建）
  → 输入："这个登录页面感觉不太好用，你自己检查并改好。"
  → 按"开始" → Goal 创建，Feed 出现用户消息 + Relay 状态（● 正在分析项目）
  → 会话流中依次出现：✓ 项目分析完成 → ● 正在修改代码 → ✓ 测试通过 7/7
  → ⚠️ 需要你的决定（修改 src/styles/）：[允许本次修改][不允许][稍后决定]
  → 点"允许" → 状态继续推进 → ✓ 已完成 → 结果卡（修改 3 文件 / 测试 ✓ / 交付 ✓）
  → 输入框仍在 → 用户继续说："再把按钮颜色调亮一点。"
```

全程**零页面跳转**完成核心旅程。

## 2. 信息架构（三层重定位）

| 层 | 内容 | 变化 |
| --- | --- | --- |
| 主交互 | 对话式工作区（Goal Feed + Composer） | **新增，成为默认视图** |
| 辅助 | 全部项目 / 全部任务 / 待我决定（全局 Inbox） | 保留，降为二级入口 |
| 高级/系统 | AI 资源 / 系统状态 / Evidence / Audit / 设置 | 移入 `设置 / 系统状态`，不占主导航 |

旧页面（工作台/项目/任务/待决定/验收结果）**不删除**，只重新定位入口；旧 URL 保持兼容（重定向或保留原视图挂到二级导航）。

## 3. 桌面布局（三层结构）

```text
┌──────────────┬───────────────────────────────┬──────────────┐
│ 项目/任务    │       对话式工作区            │  上下文详情  │
│ ＋ 新建任务  │  ┌─────────────────────────┐  │  （可折叠）  │
│ 项目 A       │  │ 用户：登录页不好用…      │  │  当前项目    │
│  ├ 登录优化 ●│  │ Relay：● 正在分析项目    │  │  任务状态    │
│ 项目 B       │  │ ✓ 项目分析完成           │  │  已运行 12m  │
│ 待我决定 1   │  │ ● 正在修改代码           │  │  当前阶段    │
│  （黄点）    │  │ ✓ 测试通过 7/7           │  │──────────────│
│              │  │ ⚠️ 需要你的决定 [允许]   │  │  技术详情 ▸  │
│              │  │ ✓ 已完成 [查看修改][Diff]│  │ （默认折叠） │
│              │  └─────────────────────────┘  │              │
│              │ 继续告诉 Relay……       [发送] │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

- **左栏**（240–280px，可折叠）：`＋ 新建任务` 突出按钮；按项目分组任务列表；状态点（蓝=执行中/黄=等待用户/红=有问题/绿=已完成/灰=空闲历史）；`待我决定 N` 徽标。系统项（AI资源/数据库/Worker）移入 `设置/系统状态`。
- **中栏**（弹性）：Goal Feed 时间流 + 底部 Composer。Feed 是唯一主视图。
- **右栏**（280–320px，默认折叠）：默认只显示 当前项目/任务状态/已运行时间/当前阶段；点 `技术详情` 才展开 模型/Budget/Run/SHA/Gate/Reviewer/Delivery/Audit。

## 4. Goal Feed 事件类型（Read Model 投影）

| kind | 渲染 | 数据来源（唯一事实源） |
| --- | --- | --- |
| USER_MESSAGE | 用户气泡（右对齐） | `goal_messages` |
| RELAY_MESSAGE | Relay 气泡（左对齐，Markdown） | `goal_messages` |
| STATUS | 状态行（● 正在分析项目 / ● 正在修改代码 / ✓ 测试通过 7/7） | Task/Run 状态投影 |
| DECISION | 决策卡（⚠️ + 建议/原因 + [允许][不允许][稍后决定]） | Decision 表投影 |
| RESULT | 结果卡（✓ 已完成 + 修改 N 文件 + 测试 ✓ + 交付 ✓ + [查看修改][Diff][测试][GitHub]） | Task/Run/Delivery 投影 |
| FAILURE | 失败卡（✗ + 原因 + [重试][查看详情]） | Run/Gate 投影 |

底层 tool call 默认隐藏；Feed 事件只做投影，**不复制状态机**（合同 §3）。

## 5. 组件边界（03C 实现范围）

```text
web/src/
  goal-feed/           # 新增：Feed 渲染层（纯投影，无状态机）
    feed.js            #   时间流容器 + 事件分发
    event-user.js      #   USER_MESSAGE 气泡
    event-relay.js     #   RELAY_MESSAGE 气泡（Markdown 渲染）
    event-status.js    #   STATUS 行
    event-decision.js  #   DECISION 卡（含 inline resolve 调用）
    event-result.js    #   RESULT / FAILURE 卡
  composer/            # 新增：底部输入区（follow-up 发送）
  sidebar/             # 改造：项目/任务侧栏（Pi-Web Sidebar 心智模型）
  detail/              # 改造：右栏（默认折叠，技术详情展开）
```

现有 Vanilla JS 可完成则继续用（合同 §11 禁止盲迁 Next.js）。新增代码沿用现有模块模式（无构建步骤或最小构建），不引入重型框架。

## 6. API 面（03B 最小支持，仅此四项）

| API | 方法 | 语义 | 事实源 |
| --- | --- | --- | --- |
| `POST /api/goals/:id/messages` | POST | follow-up 用户消息（追加 `goal_messages`，触发 Relay 处理） | `goal_messages` |
| `GET /api/goals/:id/feed?after=<cursor>` | GET | Feed 增量投影（游标分页） | `goal_messages` + Core 投影 |
| `POST /api/decisions/:id/resolve` | POST | inline 决策（复用现有 Decision resolve 语义） | Decision 表（唯一事实源） |
| `GET /api/goals/:id/status` | GET | 轻量状态轮询（3–5s 前台 / 15–30s 后台） | Task/Run 投影 |

**不新增**第二后端、不新增 WebSocket/Event Bus（合同 §7：若 SSE 明显更合适须独立审计另行裁决）。inline Decision 复用现有 Decision resolve 语义，不造第二状态机。

## 7. 消息持久化（03B 最小扩展）

append-only 表 `goal_messages`：

```sql
CREATE TABLE goal_messages (
  id                  SERIAL PRIMARY KEY,
  goal_id             INTEGER NOT NULL REFERENCES goals(id),
  actor               TEXT NOT NULL CHECK (actor IN ('USER','RELAY')),
  kind                TEXT NOT NULL CHECK (kind IN ('USER_MESSAGE','RELAY_MESSAGE')),
  content             TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- 合同 §9 备选字段（related_task_id / related_decision_id nullable）**第一版不加**——状态关联由 Feed 投影层按 goal_id + 时间序组装，避免双写漂移。若实施中发现必须回填，作为 03B 修订记录。
- 职责分离（合同 §3）：`goal_messages` = 自由文本会话事实；现有 Core Tables = 软件执行事实。Feed 投影层按 `goal_id` 合并两源，按时间序输出统一事件流。

## 8. 刷新策略（合同 §7）

- 前台：3–5s polling `GET /api/goals/:id/feed?after=<cursor>`；
- 后台（标签页隐藏）：降频 15–30s；
- 用户发送消息后：立即刷新一次；
- Decision 提交后：立即刷新一次。
- **不引入 WebSocket/Event Bus**（合同 §7：若 SSE 明显更合适，须独立审计提出设计另行裁决）。

## 9. 移动端（390×844，03D）

- 主界面 = 当前会话：顶栏（≡ 项目名·任务）+ Feed + 底部 Composer；
- 操作 = 看会话、回复、Decision、Pause/Resume、看结果；
- 项目/系统设置经抽屉进入；`待我决定` 全局 Inbox 保留在抽屉内。

## 10. 新建任务流程（合同 §5）

只需三步：**选择项目**（受控 Project Registry）→ **大输入框**（占位文案："例如：这个登录页面感觉不太好用，你自己检查并改好。"）→ `开始`。不得要求用户填 Task/Run/Scope/Model/Budget/SHA/Branch/Gate。首次消息形成初始 Goal；之后继续输入即为 follow-up（合同 §7 生命周期策略已裁决：follow-up 形成新的受控执行动作，**不创建脱离当前 Goal 的匿名 Pi Session**）。

## 11. 禁止项回指（合同 §11，全程有效）

不破坏 Core 链路；不复制状态机；不 fork pi-web；不提前 MODEL-POLICY-01；不盲迁 Next.js；旧 URL 兼容；不删除现有功能（只重新定位）。

## 12. 视觉 Reviewer 八问（合同 §10，任一失败 = UX REWORK）

1. 第一眼是否知道这是 AI 工作区？2. 是否明显知道在哪输入？3. 能否持续对话？4. 是否无需页面跳转完成核心旅程？5. Decision 是否自然出现在会话中？6. 结果是否自然出现在会话中？7. 内部工程术语是否默认隐藏？8. 是否明显接近 Pi-Web 类 Agent 工作区交互习惯？
