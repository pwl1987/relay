# RELAY-GOAL-CREATE-IDEMPOTENCY-12 执行报告(Goal 创建幂等:ACK 丢失反例→最小持久幂等→红绿闭环)

> 合同:CURRENT.md「RELAY-GOAL-CREATE-IDEMPOTENCY-12 🔵 ACTIVE」(登记于 **809291f**,2026-11-16;基线=11R 收口 3e38ab5;协调方对 11R 整体裁决 REWORK,唯一 Major-R2=POST /api/goals 已提交 201 后响应丢失,客户端按界面提示重试 ⇒ 重复 Goal+初始 Task)。
> 结论口径:**工程面(A 冷启动→B 先红反例→C 最小实现→D 红绿+回归→E 独立 Reviewer)完成与否以 Reviewer 终裁为准**;WEB-UX-03 用户 Mac 实机 UX ACCEPTED 仍唯一归属用户本人;生产预检 NO-GO 维持,零生产触碰。

## 1. A 冷启动与差距审计(合同 A)

- **快进**:live main 3e38ab5→**809291f**(合同提交;推送前核对其 exact-head Actions **43829665976** test+e2e 双 success,GitHub check-runs API 亲核);本地=origin=809291f。唯一 Writer:工作区零脏改动(10 项未跟踪物=保护基线)。
- **保护物 10 项零触碰**:`config/`、`p0-mvp/soak-r3b/`、CI 回执 8 份(backup bacc849/fbf32f0、cutover 02348b6、deploy 27e9259/c22d23f、egress e28c386、11 收口 48efc19、11R 收口 3e38ab5)——执行前后 mtime 集合 sha256 **2b75973b… 前后一致**(§5 边界)。
- **生产只读核对**:relay-web/relay-worker PID **3242781/3242782 未变**(systemctl --user 只读);现役=旧 Web 进程,本包全部验证跑在隔离栈。
- **合同 A 指定文档/代码逐项亲读**:AGENTS/CURRENT/ARCHITECTURE_BASELINE/ADR-0012/`src/server/api.ts POST /api/goals`/`src/core/goals.ts planGoal`/`web/workspace.js createFromComposer`/11 与 11R 测试及控制报告/MAC 卡。**先核 Core 事实(不凭前端推断)**:
  - **`GoalSpec.id?` 已支持显式 goal id**(`goals.ts:21,38`:`spec.id ?? goal-${randomUUID()}`);TaskSpec 同(`t.id?`)——协调方"PlanGoal 可显式 id"属实,**零 Core 改动即可派生主键**。
  - `goals.id` = text 主键(schema.ts:220);planGoal 全部写操作( goals+预算账本+tasks+TASK_PLANNED/GOAL_PLANNED 审计)都在**调用方事务**内执行(api.ts 包 `deps.db.transaction`);goals.id PK 是并发同键时首个唯一约束拦截点。
  - 创建面既有副作用链:planGoal(事务)→ WEB_GOAL_CREATED 审计(**best-effort,失败被吞,不保证存在** api.ts:137)→ 首消息 goal_messages+消费映射 goal_message_consumptions(原在事务外)。消费映射有 `UNIQUE(message_id)`(at-most-once 派生,append-only)。
  - `deriveDefaultPlan(rawInput).rawInput` = 原文(仅 trim),重放内容比对可用 goals.raw_input 直接等值比较;未绑定 Goal 的默认作用域=`deps.defaultAllowedScope ?? ["/workspace"]`。
  - **身份模型**:`Auth` 单操作者(`config.operators[0] ?? "owner"`);会话角色 session.role 即创建 actor;GOAL_PLANNED 审计(与 Goal 同事务,必然存在)记录 actor ⇒ 重放时可证操作者一致性。
  - 前端:`A.apiPost` 固定 headers(2 参);CSRF=x-relay-csrf 双提交;11R `state.creatingGoal` 在途旗标只限**同页并发点击**——网络失败后复位、重试=第二个 POST ⇒ 正是 Major-R2 缺口。
- **关键工程发现(app.js 既有 format 漂移)**:HEAD 的 `web/app.js` **本就不能过 `biome format`**(exit 1);quality format 门按**变更文件**整文件检查(C5),CI 因 clean checkout 无变更文件而 format NOT_RUN 从未暴露——**任何 app.js 改动都会让本地与推送区间 CI 的 format 步红**。处置:完全不改 app.js(循 11R 对 style.css 的同款先例"绕开漂移文件,不在其上叠加"),创建请求在 workspace.js 内自持 fetch(语义与 A.apiPost 一致,注释说明原因)。此发现如实登记,为后续任何要改 app.js 的工作包前置排雷。

## 2. B 先红反例(合同 B;新增 `test/e2e/webux12-goal-idempotency.test.ts`,RELAY_E2E 门,706 行)

隔离合成栈(独立测试 schema p01a_ + 确定性 stub[baseUrl=127.0.0.1:1 不可达层,零付费] + 每任务一次性本地 bare 交付远端 + `RELAY_PROJECTS_FILE`=一次性合成注册表[绝不读受保护 config/];真实 Chromium 双视口 1440×900 + 390×844)。**协调方实证技术正式化为可回归用例**:拦截 POST /api/goals ⇒ `route.fetch()` **真实送达服务器取得 201(事务已提交)** ⇒ `route.abort("failed")` 只丢弃浏览器侧回执;`route.abort` 发生在上游调用之前的旧形态(11R T2)只覆盖"请求未送达",本 harness 不假称 ACK 丢失。10 测试=7 翻红 + 3 控制:

- **红轮(修复前代码,`WEBUX12_TAG=audit-red`)恰 7 失败**(`evidence/webux12-red-first.log`;JSON 逐步事实):
  - **T1 桌面 ACK 丢失**:亲点「开始」⇒ 拦截器转发,**`committedStatus=201`**、界面「创建失败,请稍后重试」+草稿保留;按提示重试 ⇒ **第二个 Goal**(lost `goal-739df239…` vs retry `goal-9ac98f2a…`,sameGoal=false;Goal 数 13→**15**)+1 重复——协调方 `COORD_ACKLOSS_*` 同型行为的持久反例(截图 `t1-d01` 同屏直证:报错+草稿+侧栏成对重复 Goal);
  - **T7 刷新后重试**:15→**17**(+2,新 id);**T1m 手机 390×844**:17→**19**(sameGoal=false);
  - **T2 并发同键**:`Promise.all` 两请求 ⇒ **[201,201] 两个不同 id**(+2);**T3 同键异 payload/项目绑定/跨会话**:全部 201 新建(应 409),9→13;**T4 键格式门**:非法键被忽略照常 201 创建(应 400 零创建);**T8 重放确定性**:同键重试=201 新 id、replayFlag 缺失、DB 出现两套 Goal/Task/消费/预算/审计。
- **同轮通过=控制组(红绿轮均须过)**:**T5 旧客户端无键**:同文案两次=201×2 两个独立 Goal、响应形状不变(兼容边界);**T6 不同键同文案**:两个独立新需求(反"纯文本永久去重");**T9 浏览器错误分类门**(0 真实错误)。
- **执行记录(如实)**:①首轮 T1m 因**夹具缺陷**失败(手机页未登录 ⇒ ws-input 30s 超时)——非翻红断言,修 startStack 双页登录后重跑;②T9 首版零容忍门被注入性 `net::ERR_FAILED`(ACK 丢失注入的本意信号)误伤,改为**分类门**:真实错误零容忍+注入噪声计数与注入次数对账(控制台消息到达时序不定 ⇒ 计数只设上界,如实登记);③T4 的非 ASCII 键用例在 HTTP 传输层不可达(任何合规客户端 API 拒发非 ASCII header)⇒ 换纯 ASCII 非法形态,服务端字符集校验保留为纵深防御。红证据=3 图亲看亲核(`screenshots/audit-red/`)+ JSON 10 步。

## 3. C 最小实现(合同 C;`src/server/api.ts` +195/-40 与 `web/workspace.js` +103/-16 两文件,零 CSS、零 schema/迁移、零新表、零新 API、零 Core 生命周期改动)

**设计=键 ⇒ 确定性派生 Goal 主键,复用既有 PK 唯一约束(协调方首选路径;零新持久状态)**:

| # | 处置 | 内容 |
| --- | --- | --- |
| 键解析与格式门 | api.ts | `x-relay-idempotency-key` 可选;空/缺省=旧客户端行为**完全不变**;非 UUID 形态(`GOAL_CREATE_KEY_RE`,8-4-4-4-12 hex)⇒ **400 idempotency_key_invalid 零创建**(格式+容量双重受限;字符集校验为纵深防御——非 ASCII 在传输层已不可达) |
| 派生主键 | api.ts `goalIdForCreateKey` | `goal-` + SHA-256(`relay:goal-create:v1:<key>`)前缀 UUID 形态。确定性 ⇒ 同键重试落到同一 PK ⇒ **持久幂等的唯一载体就是 goals 行本身**(零新表/零迁移/服务端零 process-local 状态 ⇒ 天然跨重启);SHA-256 碰撞 ⇒ 内容比对不一致 ⇒ 409 fail-closed,绝不错误重放 |
| 顺序重放面 | api.ts `resolveGoalCreateReplay` | 创建前先查派生 id:无行 ⇒ null 走正常创建;有行 ⇒ **内容(goals.raw_input 等值)/操作者(GOAL_PLANNED 审计 actor 比对,与 Goal 同事务必然存在)/项目绑定(初始 Task allowed_scope vs 期望作用域,同一表达式防口径漂移)** 逐项一致 ⇒ **200 幂等重放**(同 GoalId/同初始 Task/`idempotentReplay:true`,与首次响应同形状);任一不一致 ⇒ **409 goal_create_key_conflict**(fail-closed,零新建) |
| 并发面 | api.ts 事务+唯一约束 | 创建事务内 INSERT 撞 PK(赢家已提交)⇒ drizzle 包装错误经 **Error.cause 链识别 23505**(实测发现,两级都查)⇒ 本事务回滚(零部分状态)⇒ 转同一重放/冲突判定;赢家回滚(崩溃)⇒ 输家 INSERT 自然成功(键未被消费,语义正确) |
| 原子创建 | api.ts | **首消息+消费映射并入 planGoal 同一事务**(原在事务外)——Goal+初始 Task+预算+消息+消费原子可见:ACK 丢失重放读到的必是完整初始事实,失败整体回滚绝不留半创建;WEB_GOAL_CREATED 审计保持既有 best-effort 语义(事务后,失败不影响请求结果;重放路径对缺失该审计有注册表反查兜底,响应 project 块在重放面直接来自请求自身——绑定一致已证) |
| 客户端键 | workspace.js | `goalCreateKey`:一次「用户明确创建」意图=一个高熵 UUID(crypto.randomUUID,含降级);**sessionStorage 持久**(跨刷新,标签页隔离=各自意图);同草稿(同内容+同项目)重试复用同键;内容/项目变更 ⇒ 新键(用户明确要另一个需求);成功确认 ⇒ 清键闭环;存储不可用(隐私模式)退化每次新键=不差于旧客户端。**服务端权威判定,前端不冒充唯一性**(11R 在途旗标保持,只管同页并发) |
| 冲突提示 | workspace.js | 409 ⇒ 中文「请求标识冲突:该标识已绑定其他内容,请直接重试」+清键;网络失败/5xx(结果未知)⇒ 保留键+「创建失败,请稍后重试」+草稿保留 ⇒ 重试同键交服务端幂等判定 |
| 创建请求通道 | workspace.js `createGoalRequest` | 自持 fetch(带键头);**不扩展 `A.apiPost` 的原因见 §1 app.js 既有 format 漂移发现**(11R style.css 同款先例);语义与 A.apiPost 一致(credentials/CSRF/401 跳转/err.status+err.payload 错误形状) |

- **明确不做(合同 C 禁令逐条)**:不把创建状态仅放前端内存(服务端持久)、不按 rawInput 去重(键才去重,T6 反证)、不靠 sleep/时间窗(唯一约束瞬时报决)、不用 process-local Map(纯函数派生)、不吞 5xx(未知结果保留键重试,500 照常上抛);无新表/无生产迁移 ⇒ 无需 USER_DECISION 升级;零 Core/Operator Policy/Registry/CSRF/终态禁重开触碰。
- **11R UI 功能零推倒**:终态「新建后续任务」/PAUSED 指引/ACTIVE 双操作全部保持(createFromComposer 为共用入口,回归全绿实证)。

## 4. D 红绿+回归(合同 D)

- **绿轮(`WEBUX12_TAG=verify`)10/10 全绿**(`evidence/webux12-verify-green.log`;3 图+11 步 JSON 亲核):T1 桌面重试 ⇒ **sameGoal=true**、Goal 数 8→9 恰 +1、原 Goal ACTIVE 未重启;T7 刷新后重试 ⇒ 同一 Goal;T1m 手机 ⇒ sameGoal=true;T2 并发 ⇒ **[201,200] 同 goalId**(goal-21173519 双方一致);T3 ⇒ 三重 409 `goal_create_key_conflict` 零新建、原 Goal 未动;T4 ⇒ 五种非法键全 400 零创建+合法 UUID 201;T8 ⇒ 200 重放同 id 同初始 Task、DB 恰一套(1 Goal/1 Task/1 消息/1 消费/1 预算/审计 GOAL_PLANNED=1+TASK_PLANNED=1+WEB_GOAL_CREATED=1,重放零新副作用);T5/T6 控制保持(无键两建/异键同文案两建);T9 零真实浏览器错误。
- **旧链全量回归**:test/e2e **56 passed | 2 skipped**(2 skipped=03C/03D 显式截图证据门,与 CI 同口径;46+10=56,11R T1~T7、11 全旅程、03 链全绿;`evidence/webux12-e2e-regression.log`)+ **quality:quick PASS**(lint 0 error/format[变更 3 文件]/typecheck/unit 182/182;`evidence/webux12-quality-quick.log`)+ tsc/biome 干净(workspace.js 仅既有级 warning,与文件既有 catch(e) 风格一致)。
- **证据与污染纪律**:红/绿证据独立目录 `12/{screenshots/{audit-red,verify},evidence/}`;回归轮 webux11/webux11r/webux12 产物走缺省 `ci` tag 当轮即清(可再生,不入库);当轮回归弄脏的历史跟踪证据已按名精确恢复至 HEAD(保留自有 src/server/api.ts、web/workspace.js 两文件);`test-evidence/` 质量证据按可再生清零。harness 缺省 `WEBUX12_TAG=ci`(回归安全缺省,M2 教训);绿轮日志与入库 harness 版本一致(红轮三次运行演进=夹具登录缺陷修复+T9 分类门+T4 ASCII 化,最终红轮以入库版本生成恰 7 失败,如实登记)。

## 5. 生产影响与边界(硬边界逐条)

生产影响=**零**:零生产 DB DDL/DML(隔离栈+一次性 schema,用后即毁)/零生产进程触碰(PID 未变)/零配置/重启/迁移/egress/防火墙/端口/零真实模型(stub 不可达层)/零外部 GitHub 业务交付(一次性本地 bare 远端)/保护物 10 项 mtime 集合 sha256 前后一致(2b75973b…)。测试 schema `webux12-e2e-goal-idempotency` 已随 stopStack 清理,零容器/端口残留。

## 6. 如实 NOT_RUN

- **同键异操作者(第二操作者)的 e2e 反例**:NOT_RUN——Auth 单操作者配置,隔离栈无法构造第二操作者会话;服务端 actor 比对逻辑已实现(经 GOAL_PLANNED 审计),其行为由实现审查与代码走查保证,单操作者等价路径由 T8(同操作者重放)覆盖。
- **非 ASCII 键的传输面**:HTTP 头不可携带非 ASCII(任何合规客户端 API 拒发)——服务端字符集校验保留为纵深防御,不可经 e2e 构造。
- **真服务重启演练**:幂等持久性=派生纯函数+goals 行,零 process-local 状态 ⇒ 跨重启成立为结构性结论;隔离栈单进程未做 kill -9 中断注入(NOT_RUN,如实登记)。
- 用户 Mac 实机 UX 验收/手机真机/真实模型/真实 GitHub 业务写入/Pilot-24H/生产迁移重启/D3:硬禁令,NOT_RUN;MODEL-POLICY-01 未启动。
- quality:full 本地未跑(由隔离 CI test job 全量覆盖,推送后以 exact-head 为权威)。
