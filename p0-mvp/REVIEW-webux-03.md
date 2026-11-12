# WEB-UX-03 · 03A 产品/架构冻结 · 独立工程复核记录

- 复核人：独立 Reviewer（未参与 03A 设计编写）。
- 复核日期：2026-11-12。
- 复核对象：03A 阶段全部设计交付物（只读），佐证核查现有代码与 schema（只读）。
- 复核性质：静态文档复核 + 代码/schema 佐证。零设计文档修改、零代码修改、零模型调用、零测试执行（03A 本身零产品代码，无运行时验证对象）。

## 结论：PASS-WITH-FINDINGS

零 Major；共 7 项 Minor（F-1～F-7），均不违反合同约束/权威链/禁止项，不影响架构方向正确性，但须按台账修复要求在 03B 实施前或实施中消化。03B 启动前置条件（"03A Reviewer PASS"）**满足**，附带条件见"03B 启动前置条件确认"一节。

---

## 一、复核范围与方法

### 1. 通读的设计/治理文件（只读）

| 文件 | 用途 |
| --- | --- |
| `docs/WEB_UX_03_CONTRACT.md` | 合同（ACTIVE；逐条对照基准） |
| `docs/WEB_UX_03_ARCHITECTURE.md` | 交互架构设计（03A 交付物） |
| `docs/WEB_UX_03_GOAL_FEED.md` | Goal Feed 设计（03A 交付物） |
| `docs/WEB_UX_PI_WEB_REFERENCE.md` | Pi-Web 对照研究（03A 交付物） |
| `docs/PI_WEB_REFERENCE.md` | pi-web 源登记台账（HEAD b96b28b、MIT、移植台账） |
| `CURRENT.md` | 治理登记（WEB-UX-03 行与状态线） |

### 2. 代码/schema 佐证核查（只读，用于验证设计断言）

| 佐证点 | 结果 |
| --- | --- |
| `migrations/0002_tricky_roulette.sql` | `goals.id` 为 **text** PRIMARY KEY；`decisions` 表已有 `goal_id text` 列 |
| `migrations/0000/0001/0005` | 全部现有表：action_intents / audit_events / leases / task_gate_verdicts / tasks / action_proposals / budget_ledger / decisions / goals / candidate_changesets / gate_evidence / runs / sessions / discoveries（共 14 张）；`runs` 有 `started_at/ended_at/outcome`；`discoveries` 有 `created_at/outcome/run_id` |
| 全仓 grep `goal_messages` | 零命中 → 确认为真新增，尚无实现 |
| `src/server/api.ts:399-418` | `POST /api/decisions/:id/resolve` **已存在**，调用 `core.ops.resolveDecision` |
| `src/core/ops.ts:89` | `resolveDecision` 签名：`{decisionId, taskId, approve: boolean, actor, expectedStateVersion, verdict?}`；走 `operatorAllowed` + audit + recoverTransition |
| `src/server/api.ts:9-12` | 现有 Goal API：GET/POST `/api/goals`、GET `/api/goals/:id`、POST `/api/goals/:id/discovery`（operator 显式）→ 四项 03B API 中 messages/feed/status 为真新增，resolve 为既有复用 |
| `web/` 目录 | 扁平结构（app.js / dashboard.js / goal.js / decisions.js / projects.js / models.js / system.js / *.html / style.css），**无 `web/src/`** |
| `find -iname "*pi-web*"` | 仓库内仅两份登记文档与无关的 `.p0-00-lab/pipkg` pip 产物；无 agegr/pi-web 源码克隆 → 对照研究"本仓库无 pi-web 本地克隆"声明成立 |

---

## 二、逐项复核结果

### 1. 合同符合性 —— **符合**（带 F-1/F-3 注记）

| 子项 | 判定 | 依据 |
| --- | --- | --- |
| 三层桌面结构（左=项目/任务侧栏、中=Goal Feed+Composer、右=上下文详情默认折叠） | **符合** | 架构 §3：左 240–280px（＋新建任务/按项目分组/五色状态点/待我决定 N 徽标/系统项移入设置·系统状态）、中弹性（Feed+常驻 Composer，Feed 唯一主视图）、右 280–320px **默认折叠**，`技术详情` 才展开 模型/Budget/Run/SHA/Gate/Reviewer/Delivery/Audit。与合同 §4 逐项对应，wireframe（ASCII）齐备 |
| Goal Feed 纯读投影（不复制状态机） | **符合** | Goal Feed §1 不变量 1/3：Core/DB 唯一事实源、投影层无自身持久化（游标客户端持有）、重启可从 Core+goal_messages 完整重建；§4 算法明确 `core_projection_since` "只读投影，无写副作用"。DECISION 卡状态跟随 Decision 表（pending→resolved 更新同一卡，不重复生成），无状态复制。注记：投影确定性细节待 03B 固化（见 F-5） |
| goal_messages 最小 append-only 扩展 | **符合**（带 F-1/F-3） | 架构 §7：6 字段 + actor/kind CHECK 约束，append-only；全仓零现有实现。现有 14 张表无一可无歧义承载自由文本会话事实（audit_events=权威审计流、sessions=Pi 运行时、runs/discoveries/decisions=执行事实），**新增正当**——本复核代补了合同 §3 要求的复用审计，结论支持新增。注记：SQL 中 `goal_id INTEGER` 与 `goals.id text` 类型不符（F-1）；相对合同 §3 枚举 schema 去掉两个 nullable 关联列的偏离未按规范登记（F-3） |
| 权威链 Web→API→Core→Pi 不变 | **符合** | 架构头部与合同 §0 权威链逐字一致；四项 API 全部落在现有 API 层语义内（resolve 直接复用既有端点与 `core.ops` 语义，已由代码佐证）；无任何直连 Pi 通道 |
| Chat UI 只做 Core 操作界面 | **符合** | 架构 §5 组件边界全部为渲染/投影层（feed/composer/sidebar/detail），唯一写路径 `event-decision.js "含 inline resolve 调用"` = 调用现有 API，不引入第二生命周期 |

### 2. 禁止项核查（合同 §11）—— **全部符合**

| 禁止项 | 判定 | 依据 |
| --- | --- | --- |
| 不破坏 Core 链路 | 符合 | 全部新 API 走现有 API→Core；不改 Core 生命周期（Goal Feed §7 明示 03B 边界） |
| Web 不直连 Pi | 符合 | 设计中无任何 Web→Pi 通道 |
| 不复制状态机 | 符合 | Feed 六类事件全部标注唯一事实源（goal_messages / Task/Run / Decision / Delivery / Run/Gate 投影）；投影层无持久化（Goal Feed §1 不变量 3） |
| 无第二后端/第二生命周期/第二状态模型 | 符合 | §6 API 面明确"不新增第二后端"；生命周期维持现有 Goal/Task/Run |
| 不 fork pi-web | 符合 | `PI_WEB_REFERENCE.md` §2 移植台账为空（"(暂无)"）；对照研究 §7 重申禁止 |
| 不引入 Pi Session 为 Relay 用户会话 SoT | 符合 | 权威对象保持 `Project → Goal → Task → Run → Decision → Gate → Changeset → Delivery`（对照研究 §7） |
| 不提前 MODEL-POLICY-01 | 符合 | 设计中无模型路由/策略实施内容；右栏"模型"仅为既有观察态展示（WEB-UX-02 已立） |
| 不盲迁 Next.js | 符合 | 架构 §5 明示"现有 Vanilla JS 可完成则继续用，不引入重型框架" |
| 不删除现有功能（只重新定位） | 符合 | 架构 §2 信息架构：旧页面（工作台/项目/任务/待决定/验收结果）保留降为二级入口；系统项移入设置/系统状态 |
| 旧 URL 兼容 | 符合（方向性） | 架构 §2："旧 URL 保持兼容（重定向或保留原视图挂到二级导航）"。注记：具体方案（重定向 vs 挂二级导航）二选一未定，属 03C 落地义务，非缺陷 |

### 3. 架构完整性（合同 §3/§4/§8）—— **符合**（带 F-1/F-4/F-5 注记）

- 三层布局：完整（见清单 1）。
- 六类事件（USER_MESSAGE/RELAY_MESSAGE/STATUS/DECISION/RESULT/FAILURE）投影规则：清晰且不复制状态机——Goal Feed §3 给出每类的渲染/事实源/投影规则（STATUS 同状态不重复、DECISION 单卡状态迁移、RESULT/FAILURE 终态一次），§6 给出 Core 状态变化→STATUS 事件映射表。
- goal_messages schema：最小 append-only（6 字段 + CHECK），复用审计结论支持新增（本复核代补，见清单 1）。
- 03B 最小 API 四项：
  - `POST /api/goals/:id/messages`、`GET /api/goals/:id/feed`、`GET /api/goals/:id/status`：真新增（现仓无此三端点，佐证 api.ts:9-12）。
  - `POST /api/decisions/:id/resolve`：**已存在于现仓**（api.ts:399-418 → `core.ops.resolveDecision`），"复用现有 Decision resolve 语义"断言为真——03B 该项实际工作量可能为零或仅微小扩展。不造第二状态机成立。
  - 注记：inline resolve 的三按钮到现有 `approve:boolean + expectedStateVersion` 语义的映射未设计（F-4）。
- 刷新策略：明确——前台 3–5s polling feed、后台（标签页隐藏）15–30s、发消息即刷、Decision 后即刷；"不引入 WebSocket/Event Bus"在架构 §6/§8 两处重申，且保留 SSE 须独立审计另行裁决的出口。与合同 §7 一致。

### 4. 用户旅程完整性（合同 §1/§7）—— **符合**

- 新建任务三步：架构 §10 = 选择项目（受控 Project Registry）→ 大输入框（占位文案与合同 §5 示例逐字一致）→ `开始`；明示"不得要求填 Task/Run/Scope/Model/Budget/SHA/Branch/Gate"。**符合**。
- follow-up 持续对话：Composer 常驻 + `POST /api/goals/:id/messages` + Goal=持续会话定义；J5 验收挂钩明确"不创建脱离当前 Goal 的匿名 Pi Session"。**符合**（生命周期映射细化义务见 F-6）。
- Decision 出现在 Feed 内：DECISION 卡投影 + inline resolve 五步流程（Goal Feed §5）；独立"待我决定"页保留为全局 Inbox、主操作在会话内。**符合**。
- 结果卡出现在 Feed 内：RESULT 卡（✓ 已完成 + 修改 N 文件 + 测试 ✓ + 交付 ✓ + [查看修改][Diff][测试][GitHub]），与合同 §6 逐项对应。**符合**。
- 核心旅程零页面跳转：架构 §1 全旅程图末尾明示"全程零页面跳转"，且 DECISION/RESULT/STATUS 全部内嵌 Feed。**符合**（最终须 03E 真浏览器验证）。
- J1–J6 验收挂钩：Goal Feed §8 六项全部映射到事件类型。**符合**。

### 5. 视觉 Reviewer 八问（合同 §10，设计层面）

设计层面可判定项给出判定；实现/源码依赖项标注"需 03C 实现后验证"，按复核口径不算失败。

| # | 问题 | 判定 | 依据 |
| --- | --- | --- | --- |
| ① | 第一眼是否知道这是 AI 工作区 | **判定：符合（设计层面）** | 默认视图即对话式工作区（Feed+Composer），非 Dashboard 卡片墙（合同 §4 明令禁止）；左栏任务分组+状态点。最终视觉判定需 03C |
| ② | 是否明显知道在哪输入 | **判定：符合（设计层面）** | Composer 常驻底部（对照研究 §6"输入区常驻底部"）；新建任务大输入框+示例占位文案 |
| ③ | 能否持续对话 | **判定：符合（设计层面）** | Composer 常驻 + follow-up API + Goal=持续会话；J5 挂钩。需 03C/03E 实测 |
| ④ | 是否无需页面跳转完成核心旅程 | **判定：符合（设计层面）** | 架构 §1 明示零跳转；Decision/Result/STATUS 全在 Feed。需 03E 真浏览器验证 |
| ⑤ | Decision 是否自然出现在会话中 | **判定：符合** | DECISION 卡投影内嵌 Feed + inline resolve（Goal Feed §5）；全局 Inbox 降为二级 |
| ⑥ | 结果是否自然出现在会话中 | **判定：符合** | RESULT 卡内嵌 Feed，完成后"输入框仍在，用户可继续说" |
| ⑦ | 内部工程术语是否默认隐藏 | **判定：符合（设计层面）** | STATUS 行用用户可读文案（● 正在分析项目 / ✓ 测试通过 7/7）；技术细节（Run/model_ref/SHA/Budget/Gate 详单）默认隐藏、`技术详情` 展开才见（Goal Feed §6）；与 WEB-UX-02 已立的"禁内部术语直显"原则衔接 |
| ⑧ | 是否明显接近 Pi-Web 类 Agent 工作区交互习惯 | **存疑——需 03C 实现后验证** | 对照研究全部条目为〔推断〕级（本仓库无 pi-web 源码克隆，已由 find 佐证）；布局/侧栏/状态点/输入区映射齐全但未经真实源码对照。对照研究 §0 已如实声明、§8 已列五项 03C 复核义务。不算失败 |

### 6. Pi-Web 边界（合同 §2/§11）—— **符合**（带 F-2 引用错误注记）

- 零移植：`docs/PI_WEB_REFERENCE.md` §2 移植台账为空（"(暂无)"）→ 零移植成立；对照研究 §7 重申"若 03C 实施发生实质复制，须逐文件登记并保留 MIT notice"的登记义务。
- 验证级别如实：对照研究 §0 明确声明"本仓库无 pi-web 本地克隆；基于 GitHub API 台账 + 合同边界 + 工程推断"，〔推断〕逐表标注，§8 列出五项 03C 对照真实源码（HEAD b96b28b）复核义务。**声明诚实、义务闭环**。
- 注记：对照研究标题引用"合同 §18"不存在（注册合同仅 15 节），见 F-2。
- 佐证：仓库内无 agegr/pi-web 克隆（find 佐证；`.p0-00-lab/pipkg/bin/pi-web` 为无关 pip 产物，非参考源）。

---

## 三、发现台账

### Major：无

### Minor（7 项）

| 编号 | 级别 | 描述 | 修复要求 | 位置 |
| --- | --- | --- | --- | --- |
| **F-1** | Minor | **goal_messages.goal_id 类型与真实 schema 不符**：架构 §7 SQL 写 `goal_id INTEGER NOT NULL REFERENCES goals(id)`，而真实 `goals.id` 为 **text** PRIMARY KEY（migrations/0002），照抄将导致迁移失败；同仓 `decisions.goal_id`/`tasks.goal_id` 均为 text。附带建议：`id SERIAL` 与仓内 text id 惯例不同，可保留但应写明差异理由 | 03B 首个 schema 迁移提交前修正设计 SQL（goal_id 改 TEXT）；id 生成约定写明理由 | `docs/WEB_UX_03_ARCHITECTURE.md` §7 |
| **F-2** | Minor | **合同引用与交付物编号错误（多处）**：①架构 §7 称 related_task_id/related_decision_id 为"合同 §9 备选字段"——合同 §9 是自动化验收，字段枚举在合同 §3；②架构 §10 与对照研究 §3/§6 引"合同 §7 生命周期策略"——注册合同 §7 是"手机与刷新"，生命周期表述在合同 §5 与 §9-J5，且 §9-J5 写"生命周期策略由 03A 裁决"而架构称"合同已裁决"，归属矛盾（实质内容与 J5 方向一致）；③对照研究标题引"合同 §18"不存在（注册合同仅 15 节）；④交付物自编号混乱：合同 §15 列 2=Pi-Web 对照、3=交互架构、4=Goal Feed，实际架构自称"交付物 2"、对照研究自称"交付物 2"、Goal Feed 自称"交付物 3" | 统一修正全部条款引用与交付物编号；建议在合同登记头加注"摘录节号与用户指令原文对位说明"（根因：注册合同为摘录，其自身 §5 引"合同第七节"亦与注册节号不对位） | 架构 §7/§10；对照研究标题/§3/§6；Goal Feed 头部 |
| **F-3** | Minor | **对合同 §3 枚举 schema 的偏离未按规范登记**：合同 §3 将 related_task_id/related_decision_id（nullable）列为最小扩展的一部分；架构 §7 宣布第一版不加。复核**认可偏离的技术理由**（状态关联由投影层按 goal_id+时间序组装、避免双写漂移；且 decisions 表本身已有 goal_id 列，关联可由投影直接建立），但现仅在错误条款引用下写"作为 03B 修订记录"，未构成对合同的显式偏离声明 | 在架构文档以"对合同 §3 的显式偏离声明"落档：写明偏离内容、理由、回填触发条件；修正条款引用（联动 F-2）。**无需恢复字段** | `docs/WEB_UX_03_ARCHITECTURE.md` §7 |
| **F-4** | Minor | **inline Decision 与现有 resolve 语义的集成细节缺失**：现有 `resolveDecision` 要求 `{taskId, approve: boolean, actor, expectedStateVersion}`（ops.ts:89）。设计的 [允许][不允许][稍后决定] 三按钮：a) 到 approve:true/false 的映射未写；b) [稍后决定] 的语义未定义（建议 = 不调用 resolve、卡片保持 pending，纯客户端延迟）；c) `taskId` 与 `expectedStateVersion`（tasks.state_version）必须由 feed/status 投影携带并透传，且不得以内部术语暴露给用户（WEB-UX-02 已立原则）——feed/status 投影负载是否含此二项未设计 | 03B 实施前在架构文档补一小节"inline resolve 集成约定"：三按钮映射、稍后决定语义、state_version/taskId 的携带与透传方式（对用户不可见）、actor 沿用 operatorAllowed | 架构 §6；Goal Feed §5 |
| **F-5** | Minor | **投影确定性细节待 03B 固化**：a) goal_messages 表无 seq 列，架构 §7 伪代码 `(created_at, seq) > (after)` 与表结构不符——源内序号应落到 `id`；b) STATUS 六类事件未逐一登记确切事实源列（现有 runs.started_at/ended_at/outcome、discoveries.created_at/outcome、decisions.created_at/decided_at 等足以支撑，但"同状态不重复/重启可重建"两不变量须逐事件可证）；c) 两源时间戳须同一时钟基准（同一 PG now()）否则归并排序不稳定；d) 左栏状态点与"待我决定 N"徽标的数据源未指明（现存 /api/goals、dashboard/projects API 可承载，应明示复用） | 作为 03B 设计输入固化：游标=(occurred_at, id) 语义、每类 STATUS 事件的事实源列清单、时钟基准声明、侧栏数据源指定 | 架构 §7/§8；Goal Feed §2/§4/§6 |
| **F-6** | Minor | **follow-up 生命周期映射未具体化**：合同 §9-J5 明言"生命周期策略由 03A 裁决"；架构 §10 仅复述方向（受控执行动作、不创建匿名 Pi Session）。"受控执行动作"如何落到现有管线未写：同 Goal 下新建 Task？是否重走 Discovery（现有 POST /api/goals/:id/discovery 为 operator 显式动作）？Budget/Policy 是否重估？J5 自动化验收直接依赖此映射 | 03B 启动前在架构文档补"follow-up 生命周期映射"一节：follow-up 消息→现有 Goal→Discovery→Task→Run 管线的触发路径（不改 Core 生命周期），Budget/Policy 计账口径 | 架构 §10 |
| **F-7** | Minor | **web/src/ 路径基线与现状不符**：架构 §5 组件树写 `web/src/goal-feed/...`，实际 `web/` 为扁平结构（app.js/dashboard.js/goal.js 等），无 src/ 子目录 | 修正为与现状衔接的路径（如 web/goal-feed/），或明确声明引入 src/ 组织的迁移说明；同时写明旧文件归属，保证"不删除现有功能"可核查 | `docs/WEB_UX_03_ARCHITECTURE.md` §5 |

---

## 四、03B 启动前置条件确认

合同 §8：03B"待 03A Reviewer PASS"。本复核结论 **PASS-WITH-FINDINGS（零 Major）** → **满足，03B 可启动**，附带条件：

1. **F-1（SQL 类型错误）必须在 03B 首个 schema 迁移提交前修正设计文档**——否则迁移照抄即失败。此为 03B 内的硬顺序约束，不阻断启动。
2. F-4（inline resolve 集成约定）、F-5（投影确定性）、F-6（follow-up 生命周期映射）作为 03B 设计输入，须在对应实现提交前补节落档。
3. F-2/F-3/F-7 为文档修正，随下次设计文档修订一并处理即可，不阻断 03B。
4. 修复责任在设计文档作者（本复核不修改任何设计文档）。

## 五、未验证项与 03C 复核义务

1. **Pi-Web 对照〔推断〕五项**（对照研究 §8）：App Shell 折叠/断点、侧栏分组/状态点形态、状态点视觉密度、mobile bottom sheet 交互、输入区多行/快捷发送——03C 须对照 pi-web 真实源码（HEAD b96b28b）复核，不符处按 ADR 修订。
2. **视觉八问最终判定**：本复核仅设计层面；①–⑦ 的最终判定与 ⑧ 全部须 03C 实现后由视觉 Review 交付、03E 真浏览器验证。
3. **移动端 wireframe 未出**：架构 §9 为文字描述，无 390×844 wireframe；建议 03D 启动前补（合同 §8 03A 交付物"wireframe"未明确区分端，本项不计缺陷）。
4. **旧 URL 兼容具体方案**（重定向 vs 保留原视图挂二级导航）：03C 定。
5. **左栏状态点/待我决定徽标数据源**：本复核推断可复用现有 /api/goals 与 dashboard/projects API，03C 实装时确认（联动 F-5d）。
6. **本复核为静态复核 + 代码/schema 佐证**：无运行时 E2E 对象（03A 零产品代码）；不得将本复核替代 03E 真浏览器验证，也不得替代合同 §12 五步验收中的用户实机裁决。
7. **append-only 落证**：goal_messages 的 append-only 目前为设计声明，03B 须以"无更新/删除端点 + 迁移无 UPDATE 路径"落证。
