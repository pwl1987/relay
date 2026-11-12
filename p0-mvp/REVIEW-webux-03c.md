# WEB-UX-03C 独立工程 Reviewer 验收复核报告

- 日期:2026-11-12
- Reviewer:独立工程 Reviewer(冷启动 live main;未参与本包实现)
- 复核对象:WEB-UX-03C(对话式桌面工作区实施大包)+ 03B.1 硬前置
- 复核基线:本地 HEAD `073589d`(=live main 交付链末端 a57a57e → b01cfce → bca2ffd → 073589d;03B=`67f58c9`)
- 方法:亲自读合同/代码/迁移、跑 typecheck+单测+C1-C6 e2e、逐张读截图、查 CI;未只依赖任何报告。
- 本 Reviewer 未修改任何实现代码;唯一产出为本报告。(复核中重跑 journey e2e 使本地工作区 `p0-webux-03c/screenshots/c2~c5.png` 出现字节级重生成差异,内容与已入库证据同场景,属复核痕迹,已如实记录。)

---

## 结论:**PASS-WITH-FINDINGS**

- §17 七问全部 PASS(无任一 FAIL,不触发 REWORK)。
- a-g 语义验证全部有代码级证据支撑,未发现合同禁止项违例(无第二状态机、无 Web 直连 Pi、无 Core 生命周期变更、无 innerHTML/CSP 变更、旧功能零删除)。
- 1 项 Major(首载竞态错误横幅,证据截图中可见)+ 2 项 Minor;不阻断 03C 验收,建议作为 03C 收尾修复或并入 03D 前置清单。

---

## 一、§17 视觉 Reviewer 七问(逐项)

| # | 问题 | 结论 | 依据(截图+代码) |
| --- | --- | --- | --- |
| 1 | 第一眼:用户是否明显知道应该在底部输入? | **PASS** | Composer 常驻底部且为唯一输入位:`web/workspace.html:57-61`(占位"继续告诉 Relay……(Enter 发送,Shift+Enter 换行)"+发送按钮);空白态引导"今天想让 Relay 做什么?/用一句话描述"(ws16-01,`workspace.html:41-52`)。ws16-01/02/04/05 中 Composer 在所有状态(空白/执行中/完成后)始终可见。注:c1/c6 证据截图首载瞬间出现"无法核实当前状态(Cannot read properties of null…)"横幅(见发现 F-1),但输入区仍清晰可辨,不影响本问结论。 |
| 2 | 连续交互:能否不跳页面持续告诉 Relay 做事? | **PASS** | C1 新建→C2 执行→C4 结果→C5 follow-up 全部发生在同一 `/workspace` 会话页(e2e `test/e2e/webux03-workspace.test.ts:208/231/251/271/309` 全绿);Composer 常驻无禁用态(仅发送瞬间禁用,`workspace.js:351/360`);Decision 三按钮内联解决不跳页(`workspace.js:190-212`);仅"查看修改"为可选链接到 /changeset.html。 |
| 3 | 工作过程:是否自然看到 Relay 当前在干什么? | **PASS** | Feed 内联确定性事件流:●正在修改代码/正在验证/✓代码修改完成/✓N项验证通过/独立复核通过(deriveEvents `workspace.js:82-131`;截图 c2、ws16-02);左侧状态点(蓝执行中,ws16-02)+右栏"当前阶段:正在处理";运行中可继续输入(c6、ws16-02)。 |
| 4 | Decision:是否直接在 Conversation 中解决? | **PASS** | Decision 卡内联于 Feed(⚠ 需要你的决定+建议/风险/截止+三按钮,ws16-03;无版本号暴露,`workspace.js:163-215`);批准后同页显示"✓ 已批准,Relay 继续执行"回执且卡消失(c3;feed.decisions 整体替换 `workspace.js:439`);复用现有 resolve/defer 端点零新状态机(§6 兑现)。 |
| 5 | Result:是否直接在 Conversation 中看到? | **PASS** | Result 卡内联于同一 Feed:"✓ 本轮工作完成 + 修改 N 个文件/验证 ✓/复核 ✓/交付 ✓ 已提交 GitHub + [查看修改][技术详情]"(ws16-04/c4;`workspace.js:225-252`);数据来自明细快照确定性统计,非伪造。 |
| 6 | Follow-up:完成后是否可以继续说? | **PASS** | Result 卡下方 Composer 仍在且已输入"按钮还是太浅,再明显一点。"(ws16-05);C5 证明完成后发送→同 Goal 新受控 Task+消费映射+同会话呈现;C6 证明运行中发送→消息不丢,安全边界后消费并显示"已收到你的补充(共 1 条),已形成同任务流的新一轮执行。"(c6)。 |
| 7 | 技术信息:是否默认弱化? | **PASS** | 右栏默认仅 4 行(当前项目/当前阶段/已运行时间/是否等待用户)+"技术详情"折叠按钮(c2/ws16-02;`workspace.js:304-317`);Goal ID/Run/Gate/SHA/预算仅在展开后出现(c4/ws16-06,`workspace.js:318-335`,§11 允许);Feed/侧栏用户可见文案经术语 grep 零命中禁词(见 §三.g)。注:D3 交付失败卡的 question 直出内部 git 错误文本(c5,见发现 F-2),属默认视图技术信息弱化的局部瑕疵,未达 FAIL。 |

---

## 二、自动化验收 C1-C6(§15)

本人真实运行(`RELAY_E2E=1 npx vitest run test/e2e/webux03-workspace.test.ts`,真 PG 127.0.0.1:55433 + 真浏览器 + stub 全链):

```
 ✓ test/e2e/webux03-workspace.test.ts (7 tests) 16277ms
   ✓ C1 新任务 671ms / C2 执行状态 2406ms / C4 Result 976ms
   ✓ C3 Decision 1521ms / C5 Follow-up 2693ms
   ✓ Journey 全程零浏览器错误
   ✓ C6 运行中 Follow-up 硬门 7217ms
 Test Files 1 passed (1)   Tests 7 passed (7)
```

C6 硬门断言逐条核实(测试 `test/e2e/webux03-workspace.test.ts:359-446`):RUNNING 中发送→消息落库 1 条(不丢);此刻 tasks 数仍=1(在途不派生);task1 ACCEPTED 后下一拍 tasks=2,消费映射恰好 1 行且 task_id=task2(at-most-once);GOAL_MESSAGES_CONSUMED 审计恰好 1 条;goals 总数不变+task2 同 Goal(不建匿名会话);Feed 含原消息与 RELAY 确认(上下文可见)。stderr 中 2 行 "failed to push some refs" 为交付用例对 /tmp 本地远端 push-reject 场景的预期产物,断言全绿。

§16 截图:c1-c6(1440×900 journey)+ ws16-01~06 × 2 视口(1440×900/1512×982)共 18 张,均真实工作区内容(真实项目分组 LAMICE/WPS 插件/未分组、真实状态点、内联 Decision/Result、展开态技术详情),非夹具后台页。

---

## 三、语义验证清单(a-g)

### a. at-most-once — **PASS**
- `migrations/0007_goal_message_consumptions.sql:7` `UNIQUE("message_id")`;:17-24 append-only 触发器拒绝 UPDATE/DELETE。
- 消费全程单事务:`src/core/consumption.ts:57`(db.transaction)内依次 在途守卫(61-64)→取未消费消息(67-74)→派生 follow-up Task(90,`planFollowUpTask`)=Task+TASK_PLANNED+GOAL_FOLLOWUP_REQUESTED 审计 →逐消息映射(93-98)→GOAL_MESSAGES_CONSUMED 审计(100-106)→RELAY 确认消息(109-113)。任一步失败(含 UNIQUE 冲突)整事务回滚,无部分 Task/映射/审计/确认。
- 测试证明:`test/unit/goal-message-consumption.test.ts:37-51`(同 message_id 第二条映射必拒+UPDATE/DELETE 必拒);:78-85(重复消费⇒nothing_pending,Task 数不变)。
- 首条消息防重复:POST /api/goals 创建时首条 USER_MESSAGE 同时登记消费映射绑定首 Task(`src/server/api.ts:352-364`),防 loop 首拍重复派生同义 Task。

### b. 在途守卫 + 安全边界位置 — **PASS**
- `src/core/consumption.ts:18` IN_FLIGHT=LEASED/RUNNING/SUBMITTED/VERIFYING;:61-64 查询命中即在途⇒`{consumed:false,reason:"in_flight"}`,消息不动。
- loop 前置步位置:`src/core/goal-loop.ts:284-285`(expireStaleDecisions+handleOpenDecisions=决策处置)之后、:297 supervisorTick(领取)之前调用 consumeAllPendingGoals(:290-295);Run 结束后下一拍自动消费(注释 :287-289;C6 e2e 实证)。
- 状态集对齐 server:单元测试 :87-95 逐态(与 `src/server/views/shared.ts` IN_FLIGHT_STATES)断言 in_flight;API 侧 POST messages 走同一 consumeGoalMessages(`api.ts:403`),在途只记录语义不变(:405/:416)。

### c. §0.2 后续 Run 上下文真正包含用户补充 — **PASS**
- `src/server/worker.ts:154-157`:runTask 前查 `taskFollowUpMessagesView(db, claim.taskId)`,非空则拼 `# 用户后续补充…` 为 extraInstructions;:169 注入 executeRun。
- `src/runtime/runner.ts:322` spec.extraInstructions → `src/runtime/context.ts:51-54` buildRunPrompt 渲染追加段;`runner.ts:324-326` `contextDigest(prompt)` 经 insertSession 落 sessions.context_digest(`src/core/schema.ts:209`)。
- `src/server/views/goal.ts:775-787` taskFollowUpMessagesView 经消费映射回查(仅 USER 消息,按 id 序)。
- 测试:`goal-message-consumption.test.ts:109-127` 断言 prompt 含 goal 原文+补充原文+追加段标题;C5/C6 e2e 断言下一 Run 完成且 Feed 呈现消费确认。

### d. 权威链 — **PASS**
- Core 生命周期零变更:`git diff 67f58c9..HEAD -- src/core/lifecycle.ts` 为空;lease.ts/supervisor.ts/db.ts 零变更;67f58c9^..HEAD 的 src/core 全部变更仅 +consumption.ts(新增 135 行)/goal-loop.ts(+14,前置消费步与报告字段)/goals.ts(+43,planFollowUpTask)。
- Web 不直连 Pi:`web/workspace.js` 全部请求经 apiGet/apiPost 打 /api/*(app.js:173-222);无任何 Pi/模型端点。
- Feed 纯投影:`src/server/views/goal.ts:729-772` goalFeedView 仅 SELECT(messages 增量/decisions 全量快照/status 快照),无写副作用、无状态机复制;状态事实仍以 Core/DB 为唯一事实源(decisions 卡整体替换自 decisions 表,state='OPEN')。

### e. 安全 — **PASS**
- 浏览器零 scope 提交:POST /api/goals 仅读 rawInput+projectId,scope 唯一来源=项目注册表(`api.ts:305-317/:327`);POST messages 仅 content(`api.ts:389`);follow-up scope 继承该 Goal 最近 Task(`consumption.ts:80-87`)。
- CSP 不变:`git diff 67f58c9..HEAD -- src/server/app.ts` 中 CSP 行零差异;现行 CSP `app.ts:231-232`(default-src 'none'; script-src 'self')。
- 无 innerHTML:`web/app.js:36` h() 对 "html" 属性直接 throw;`web/workspace.js` 全部 DOM 经 h()+textContent(text 属性走 textContent,app.js:35);C1-C6 journey 断言零 pageerror/console.error。
- CSRF:写操作统一在路由前校验同源+x-relay-csrf(`api.ts:197-217`),覆盖 messages/goals/resolve/defer 全部新写端点;前端 apiPost 统一带 `x-relay-csrf`(app.js:194-204),工作区登出 DELETE 亦带(workspace.js:510)。

### f. 旧功能不删除 — **PASS**
- `src/server/app.ts:45` PAGE_ROUTES 完整保留 `/index.html /goal.html /decisions.html /changeset.html /projects.html /models.html /system.html`;`web/` 目录对应 html/js 全部在位(ls 核实)。
- `/` 已登录 302→/workspace(`app.ts:209-214`),未登录 302→/login.html(:203-206);/workspace 别名 workspace.html(:48)。
- 导航重排:工作区居首,旧总览降级"总览(旧)"入次区(`web/app.js:264-276` NAV_MAIN/NAV_SUB);workspace 侧栏底部同样保留 旧总览/项目/AI资源/系统状态 链接(workspace.html:21-27)。
- 旧 journey 测试已适配 / 302(登录等待 /\/workspace/、createGoal 导航 /index.html),隔离复跑全绿(bca2ffd 提交记录;CI 073589d 绿佐证)。

### g. 术语(§11) — **PASS**
- `web/workspace.html`:用户可见文案零禁词(仅 id/data-testid 含 "goal-input",非可见文本)。
- `web/workspace.js`:技术详情块(318-335 行,默认折叠)之外的用户可见字符串 grep `Goal|Run|Changeset|Gate|model_ref|READY|RUNNING|REWORK` 零命中;内部状态全部映射为用户语言("已纳入执行队列/正在修改代码/正在验证/等待你的决定/本轮执行未成功",:93-99;状态点文案 :29-35)。
- 技术详情展开区含 Goal ID/Run(最近)/Gate / Reviewer/交付 SHA — 属 §11 明示允许区域。
- 局部瑕疵(见 F-2):Core 产生的 D3 交付失败 decision question 与 run 失败 reason 文本可经 Feed 原样呈现内部错误细节,不含枚举禁词但偏工程向。

---

## 四、测试运行结果(真实输出摘要)

| 项 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `npx tsc --noEmit` | exit 0 |
| 单测 | `npx vitest run test/unit/goal-message-consumption.test.ts test/unit/goal-messages.test.ts test/unit/workspace-sidebar.test.ts` | **13/13 passed**(3.83s;消费语义 6+消息/Feed 6+侧栏 1) |
| e2e | `RELAY_E2E=1 npx vitest run test/e2e/webux03-workspace.test.ts` | **7/7 passed**(16.3s;C1-C6+零浏览器错误) |
| 全量回归 252 passed + github-real 4 passed | 主窗口已跑 | 本 Reviewer 未重复全量(按任务说明),以主窗口口径引用 |

## 五、CI 状态(gh run list,代理 env 已剥离)

| run | 提交 | 结果 | 说明 |
| --- | --- | --- | --- |
| 43212350532 | **073589d(HEAD)** | **success**(2m27s) | 当前交付链末端 CI 绿 |
| 43211836832 | bca2ffd | failure | typecheck:`webux03-screenshots.test.ts` TS2584/TS2304(document/Element/HTMLElement,CI tsconfig 无 DOM lib;本地 tsc 早于该编辑未捕获) |
| 43206871360 | b01cfce | failure | e2e web-journey 登录 waitForURL 未适配 / 302→/workspace(经 bca2ffd 提交信息与失败日志双重印证) |
| 43197889490 | a57a57e | success | 03B.1 CI 绿 |

即:b01cfce 红(e2e 适配)→ bca2ffd 红(截图测试 DOM 类型)→ **073589d 绿**。红均与实现语义无关且已在后继提交修复;无未解释的持续红。

---

## 六、发现列表

### F-1 【Major】Goal 会话页首载竞态:用户可见原始 JS 异常横幅(证据截图受影响)
- 描述:`web/workspace.js:291` `renderFeed()` 无守卫调用 `resultCard(state.detail)`;`resultCard` 首行即访问 `g.changesets`(:225-232)。`refreshAll`(:466-472)中 `refreshFeed(immediate=true)` 与 `refreshDetail` 并行,feed 响应先到时 `state.detail` 仍为 null ⇒ renderFeed 在追加完消息后 throw ⇒ refreshAll catch ⇒ 顶部横幅显示原始英文异常:"无法核实当前状态(Cannot read properties of null (reading 'changesets'))…"。detail 查询更重⇒竞态通常输,几乎每次带 `?goal=` 首载都会闪现,下一拍(≤4s)自愈。
- 证据:官方验收截图 `p0-webux-03c/screenshots/c1-new-task-conversation.png` 与 `c6-inflight-followup.png` 顶部均出现该横幅;代码路径如上,HEAD 仍在。
- 影响:第一印象出现英文异常文本(§17 Q1 未致 FAIL:Composer/引导仍清晰;功能自愈),但属用户可见缺陷且进入正式证据。
- 建议:`renderFeed`/`resultCard` 对 `state.detail===null` 返回空(或仅渲染消息部分);同时 `setConn` 不直出 `err.message` 原文,改为人话+细节入 console。一处守卫即可,建议 03D 前收口。

### F-2 【Minor】内部错误细节经 Feed 直出(交付失败 Decision 卡 question / run 失败 reason)
- 描述:c5 截图中 D3 卡 question 原样显示 `delivery_propose_failed(交付装配失败;人工处置,永不自动批准):propose_failed:Command failed: git -C /tmp/… push --quiet …` 含英文 git 输出与临时路径(来源 Core `src/core/goal-loop.ts:364-367` 拼接的 reason);workspace.js:112 run 失败事件亦拼接 `r.reason` 内部码。两者均不属 §11 枚举禁词,决策位置/按钮语义正确,故不构成 §17 FAIL;但默认视图技术信息弱化(Q7)在失败路径上打折。
- 建议:Core 侧为 D3 question 提供用户语言摘要层,或 workspace 渲染 decision 卡时对 question 做用户文案映射、原始细节折叠进技术详情。

### F-3 【Minor】CI 中间两次红(已闭环,记录在案)
- 描述:b01cfce(e2e 登录断言未适配 / 302)与 bca2ffd(截图测试 evaluate 回调内 document/Element 类型在 CI 无 DOM lib 的 tsconfig 下报错)各自 CI 红,均于后继提交修复,073589d 绿。无遗留动作;提示"本地全绿≠CI 绿"(无 DOM lib 的 typecheck 差异)已由提交信息自省,维持现状即可。

---

## 七、停止条件核对(§18)

交付链止于 073589d;无 03D/MODEL-POLICY-01/REAL-PILOT 的自动推进痕迹;CURRENT.md/CONTINUATION.md 更新随 b01cfce 提交(本次复核未发现越权状态系统或分支操作;工作区另存有与本案无关的旧证据目录未提交改动与未跟踪 `config/`、`p0-mvp/soak-r3b/`,属仓库现存事项,提请所有者按单写者规则自行处置)。
