# RELAY-CONTROL-READY-03 独立对抗式复核报告

- **Reviewer**:独立隔离上下文(未沿用开发自述;关键声明均亲手 grep/读码/运行时探针验证)
- **复核对象**:本地 main `079b97d`(实施提交);合同冻结基线 `bf68a65`
- **被审 Diff**:`git diff bf68a65..079b97d`(18 文件,+2086/-528;语义 hunks 与 biome 机械对齐 hunks 已区分,`git diff -w` 辅助确认;未触达文件零改动,对齐仅发生在 18 个被触达文件内 —— 符合"仅触达文件内对齐"的合同允许范围)
- **裁决日期**:2026-11-13
- **第一轮裁决**:**REWORK**(1 Major,6 Minor;反例见 F-1,实测复现)
- **第二轮裁决(F-1 修复 `6b8dcb1` 复核)**:**PASS**(见文末第二轮复核节;M-1/M-3/M-4/M-5 登记后续包,M-2 已消化,M-6=推送+exact-head CI 为收口前置义务)

---

## 0. 治理与工作区核验

- 本地 main = `079b97d`;`git fetch` 后 origin/main = `bf68a65`(合同冻结提交),**实施提交未推送(ahead 1)** ⇒ exact-head CI 对 `079b97d` **不存在(NOT_RUN)**。开发提交信息所称 "quality:release PASS(304+30 过)" 本 Reviewer **无法独立复核**(纪律禁止运行 quality:release;且该声明对应的 CI/推送链尚未发生)。此为流程事实登记,不影响代码级裁决。
- 工作区仅受保护未跟踪 `config/` 与 `p0-mvp/soak-r3b/`(与冻结时点一致,零触碰);本次复核零修改受跟踪文件、零 commit/push/checkout。
- 合同链已亲读:CURRENT.md 顶部 RELAY-CONTROL-READY-03 块、CONTRACTS.md §2(用户决策 2026-11-13 行)、p0-mvp/safety-close-02/SEMANTICS-P0A.md §3(方案 A 权威表述)、docs/AGENT_CONTROL_LOCAL_QUALITY.md §3/§4、ADR/0012。
- 复核纪律:零模型调用;测试仅用隔离库(127.0.0.1:55433,relayp000 / p01a_ 前缀 schema);探针脚本置于 `/tmp/review-probe/`(仓库外),仅读仓库源码、写隔离测试 schema。

## 1. 独立复跑结果(全部亲手执行)

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **PASS(exit 0,零错误)** |
| `npx biome lint --reporter=summary src test scripts web` | **0 error**(93 warnings + 3 infos = 已登记历史基线;171 文件) |
| `npx vitest run test/integration/goal-message-authorization.test.ts test/unit/goal-message-consumption.test.ts test/integration/task-abort.test.ts test/integration/worker-evidence-checks.test.ts test/unit/goal-messages.test.ts test/integration/gate-machine-evidence.test.ts test/integration/cli.test.ts` | **7 文件 60/60 全绿**(16.3s;task-abort 跨进程真实信号用例含在内) |
| 测试库 | `bash scripts/test-db-up.sh` 报 `test PG already running: relay-p000-pg (127.0.0.1:55433)` |
| e2e(C5/C6/M5/M6 真实浏览器) | **NOT_RUN(Reviewer 未复跑)**;仅静态审读断言(见 §2);开发声称浏览器绿,本报告不背书 |
| exact-head CI @079b97d | **NOT_RUN(未推送,不存在)** |
| quality:release | **NOT_RUN(纪律禁止;开发声称 PASS,未独立复核)** |

grep/运行时验证结果见 §5。

## 2. 逐项裁决表

### 子项 1:P0-1 对话授权方案 A —— **PASS(附 Minor M-1/M-2)**

| 检查点 | 证据 | 裁决 |
| --- | --- | --- |
| 普通发送任何状态零派生零映射 | `api.ts` ACTIVE+无 intent 路径:仅 INSERT(execution_request=false)+ RELAY 反馈 + 审计,**不调用 consumeGoalMessages**;消费层 `pendingExecRows` 仅取 `execution_request = true`(consumption.ts)。非 ACTIVE 路径同零派生。**运行时探针 C**:8 条并发普通消息 ⇒ totalTasks=1(仅旧任务),零派生 | PASS |
| 显式执行服务器端校验(不经模型猜测/不依赖前端隐藏) | `executionRequest === true` 严格布尔;缺省=false(旧客户端安全降级,单测 `旧客户端缺省安全降级` 钉住:INSERT 无字段 ⇒ false ⇒ no_execution_request);授权判定为确定性 SQL 规则,无关键词猜测;前端 `payload` 仅显式点击才携带字段 | PASS |
| 幂等防重原子性 | 单语句 `INSERT ... SELECT ... WHERE NOT EXISTS(同 Goal+USER+execution_request=true+同内容 且 [未消费 OR 映射任务非终态(∉ACCEPTED/FAILED/CANCELLED)])`;重复点击返回 duplicate=true+原 messageId/taskId(单测钉住 sequential 重复;**运行时探针 B:10 并发同内容请求 ⇒ 1 条消息、恰 1 个新任务、9 次 duplicate 响应,未复现双建**)。并发窗口理论分析见 M-1 | PASS(M-1 登记) |
| 在途排队到安全边界 | ACTIVE+在途 ⇒ 消息落库、consumeGoalMessages 返回 in_flight、反馈"已记录执行请求;…结束后将自动创建执行任务"、queuedExecute=true;goalLoopTick 前置步在 Run 结束后消费(e2e C6/M6 三段式钉住:排队期零新任务→边界消费派生) | PASS |
| 终态后执行请求不派生不重开 | 终态 Goal+终态后送达 ⇒ goal_closed(单测+e2e C5/M5 held 断言+taskCount 不变) | PASS |
| 在途排队(先于终态迁移)边界消费 | 消费层:`queued = pendingExecRows.filter(created_at < terminalAt)`(严格小于,等值归入终态后=held,延续 Minor-1 保守语义)⇒ setGoalState(ACTIVE, reason=execute_boundary)+ GOAL_ACTIVE 审计 + 仅消费该显式子集;e2e C6/M6 断言 `GOAL_ACTIVE.reason=execute_boundary` | PASS |
| **PAUSED 绝对不自动重激活(含显式执行消息)** | 消费层第一守卫:`if (goalState === "PAUSED") return goal_closed`(先于 queued 例外判断 ⇒ 暂停前遗留的显式执行同样不重激活)。**运行时探针 E**:PAUSED Goal + created_at 早于 updated_at 2 小时的显式执行消息 ⇒ goal_closed,state 保持 PAUSED,零 GOAL_ACTIVE 审计。单测 `PAUSED 绝对不重激活` 同语义 | PASS(Minor-3 收口属实) |
| 反馈三态 | 已记录(普通/终态/暂停)/排队待执行(在途)/已创建任务(空闲派生)——API 三分支+e2e 断言逐态钉住 | PASS |
| 权限/预算继承不扩大 | 派生经 planFollowUpTask:scope/commands 继承该 Goal 最近 Task(单测断言 `allowed_scope == ["/workspace"]` 不变);planFollowUpTask 非 ACTIVE fail-closed 保留(单测 rejects /非 ACTIVE/);origin=explicit-execute 仅审计字段,不改变 Task 形状(与 planGoal 完全一致) | PASS |
| append-only 触发器覆盖新列 | 0006 触发器 `BEFORE UPDATE OR DELETE ON goal_messages FOR EACH ROW`(无列限定 ⇒ 新列同被拦截);**运行时探针 A:UPDATE goal_messages SET execution_request=true ⇒ 抛错被拒** | PASS |
| 旧客户端兼容 | 缺 intent 字段 ⇒ false ⇒ 只记录;迁移列默认 false(旧行安全降级) | PASS |
| POST /api/goals 未被误改 | diff 无 hunks 触达该 handler;前端空白态"开始"仍走 `POST /api/goals`(rawInput),执行按钮空白态隐藏 | PASS |
| 绕过面排查 | 全仓 grep `INSERT INTO tasks`:生产代码仅 `src/core/goals.ts:75(planGoal)/132(planFollowUpTask)` 两处;消费面唯一入口 consumeGoalMessages | PASS |
| 双建(消费×2)防护 | intake 同步消费与 goalLoopTick 每拍消费共用同一事务+`UNIQUE(message_id)` 映射 ⇒ at-most-once;单测 `at-most-once:重启/重复 tick` 钉住 | PASS |
| e2e C5/C6/M5/M6 忠实性 | 三段式(普通发送零派生→显式执行排队→边界消费)+ 映射归零断言(普通消息零映射)+ `expect(feed).not.toContain("已收到你的补充")`(旧 §0 文案不回归断言,双端均有) | PASS |
| SEED 单元测试如实改方案 A | goal-message-consumption.test.ts:原始需求预映射(false 已消费)+ 两条显式执行(true)⇒ 断言 messageIds=2、"已创建执行任务" | PASS |

### 子项 2:P1-3 停止/接管最小切片 —— **REWORK(Major F-1;余项 PASS)**

| 检查点 | 证据 | 裁决 |
| --- | --- | --- |
| abort 旗标跨进程闭环(主链路) | ops.requestTaskAbort 置旗(与 TASK_ABORT_REQUESTED 审计同事务)⇒ worker Run 期间 1s 心跳轮询(worker.ts:204 唯一读者)⇒ abortFlag.cancelled ⇒ runner cancelSignal(冻结提交已内建:SIGTERM→raceExit 2s→SIGKILL,outcome=CANCELLED,reason=cancelled_by_caller)⇒ runner 以自身租约合法推进 RUNNING→CANCELLED。**跨进程真实进程测试绿**(stub hang + pid 存活→死亡断言) | PASS(仅 RUNNING 主链路) |
| **abort 在 VERIFYING(及 Run 成功后至 Gate 编排窗口)被接受但不被强制** | **反例实测(见 §5 探针 2)**:VERIFYING 任务 POST /api/tasks/:id/abort ⇒ **200** + 旗标置位 + note 承诺"执行端确认生效后任务进入 CANCELLED";但 `abort_requested_at` 全仓唯一读者是 Run 期轮询(worker.ts:204,finally 已清理),**gate-orchestrator.ts / reviewer.ts 零 abort/cancelSignal 处理(亲手 grep 证实)** ⇒ reviewer Run 继续烧模型、Gate 可走到 ACCEPTED、**delivery 可在"紧急停止已请求"之后继续写 GitHub**、TASK_ABORT_CONFIRMED 永不产生、任务终态为 ACCEPTED 而非承诺的 CANCELLED。违反 AGENT_CONTROL §4 紧急停止"立即撤销后续执行资格";命中本次复核探针项「abort 后 gate/delivery 是否可能继续」= **是**;对应 REWORK 触发项「abort 后 Run 未死/任务未终态」在该窗口成立 | **MAJOR(F-1)⇒ REWORK** |
| 幂等 set-if-null | `UPDATE ... WHERE abort_requested_at IS NULL` + 先读判断;重复请求 alreadyRequested=true 且不重复审计(单测断言 REQUESTED 恰 1 条) | PASS |
| 仅在飞状态(READY/PAUSED/终态拒绝混语义) | ABORTABLE={LEASED,RUNNING,SUBMITTED,VERIFYING};READY ⇒ 409 `abort_requires_in_flight:READY`;终态 ⇒ `state_terminal:*`;单测钉住 | PASS(但 VERIFYING 的"在飞"接受与执行缺口即 F-1) |
| 回执三分不混淆 | REQUESTED=置旗+审计;APPLIED=旗标生效(轮询翻转);STOP_CONFIRMED=TASK_ABORT_CONFIRMED(run=CANCELLED 后);三者独立审计动作,单测断言 REQUESTED/CONFIRMED 各恰 1 条 | PASS(F-1 窗口内 CONFIRMED 永缺,已并入 F-1) |
| 旧 fencing 推进拒绝 | 终态后 advanceTask(RUNNING→SUBMITTED, 旧 token) ⇒ ok=false state_terminal(单测钉住) | PASS |
| 残余子进程死亡断言真实性 | 测试用真实 stub 进程 hang + pid 文件 + `process.kill(pid,0)` 存活基线 → abort 后轮询死亡;SIGTERM/SIGKILL 链在 runner.ts:377-382 亲手核实 | PASS |
| takeover 无越权(不 force-revoke 租约) | takeover=abort 旗标+TASK_TAKEOVER_REQUESTED 审计;取消由 runner 以自身租约合法完成,无 fencing 强夺;旧 Run 终态后推进被拒 | PASS |
| abortPoller 清理/轮询失败保守 | setInterval 于 finally clearInterval(异常路径也清理,无定时器泄漏);`.catch(() => {})` 轮询失败不翻转旗标(不误停) | PASS |
| API 错误码语义 | 409=版本失配/非在飞/终态;403=非授权(**探针 D:RELAY_OPERATORS 收窄后 abort ⇒ 403 actor_not_authorized**);400=兜底 | PASS |
| CANCELLED 任务重复 abort/重复消费 | 终态 ⇒ 409;消费映射已存在 ⇒ consumeGoalMessages nothing_pending;无重开路径 | PASS |
| handback | 未实现独立端点(以"终态后方案 A 显式执行/既有 resume"承载);AGENT_CONTROL §4 交还 AI 的核对语义未实现 ⇒ M-4 登记(最小切片边界内可辩护,但须登记为下包义务) | M-4 |

### 子项 3:P0-2 生产 Gate 可用性 —— **PASS**

| 检查点 | 证据 | 裁决 |
| --- | --- | --- |
| 严格校验 fail-closed | resolveEvidenceChecks:非法 JSON/非数组/空数组/非功能性 kind/空 command/非字符串元素/timeout<1000 或 >600000 ⇒ 全部抛错(单测逐例断言) | PASS |
| 解析先于 DB 连接 | `resolveEvidenceChecks(...)` 位于 `connectDb` 之前(worker-entry.ts);单测以 startWorkerEntry+坏配置断言抛错 | PASS |
| 未配置 ⇒ 不注入 ⇒ Gate 保守停机 | undefined/空串 ⇒ undefined ⇒ 不注入 driverOptions ⇒ gate-orchestrator.ts:180 `hasFunctionalChecks=false` ⇒ NEEDS_DECISION(SAFETY-CLOSE-02 P0-B 语义未降级);单测 startWorkerEntry+合法配置 tick=IDLE_PROVIDER_DOWN 横幅 `evidenceChecks=2` / 未配置横幅 `未配置(Gate 保守停机)` | PASS |
| kind 白名单仅功能性 | 复用 `FUNCTIONAL_EVIDENCE_KINDS`(gates.ts,仅 deterministic_test/api_behavior);单测断言 reviewer_output/candidate_manifest_verify 均拒;与 gates.ts 既有规则同源(用户消息/模型文本/manifest 顶替路径不存在 —— 证据只能经 CheckSpec 沙箱执行落库) | PASS |
| 生产重启/配置变更边界 | 注释与代码仅提供机制与校验("实际取值=部署包决策"),未触碰生产进程 | PASS(如实标注) |

## 3. 发现列表

### Major(必须修复)

**F-1(P1-3)abort/takeover 在 VERIFYING 阶段(含 Run 成功后至 Gate 编排完成窗口)被 API 接受并承诺停止,但全链无任何执行点 —— "紧急停止"后 Gate/交付仍可继续,STOP_CONFIRMED 永不产生。**
反例(实测复现,隔离测试库):
1. 造 VERIFYING 任务 → `POST /api/tasks/t-v/abort` ⇒ **HTTP 200** `{ok:true, fromState:"VERIFYING", note:"已请求紧急停止;执行端确认生效后任务进入 CANCELLED…"}`,`abort_requested_at` 置位,TASK_ABORT_REQUESTED 审计落库(RECEIVED/APPLIED 均已"发生");
2. 此后无任何组件消费该旗标:全仓 `abort_requested_at` 唯一读者 = worker.ts:204 的 Run 期轮询(该轮询在 executeRun 的 finally 中已清理);`grep -n "abort|cancelSignal" src/core/gate-orchestrator.ts src/runtime/reviewer.ts` = **零命中**;
3. 后果链:reviewer Run 继续执行并消耗模型预算 → Gate 可 ACCEPTED → goal-loop 的 delivery 分支(`options.delivery && gateReport?.status === "ACCEPTED"`)继续 proposeDelivery/execute,**GitHub 写入可发生在操作者已收到"已请求紧急停止"回执之后**;TASK_ABORT_CONFIRMED 永不落审计;任务以 ACCEPTED 终态收束,与回执承诺的 CANCELLED 矛盾;
4. 同窗口变体:Run 成功返回(SUCCEEDED)后任务仍 RUNNING、轮询已清理、Gate 尚未推进 ⇒ 该瞬间 abort 同样被接受(200)且不被强制。
违反:AGENT_CONTROL_LOCAL_QUALITY.md §4"紧急停止:立即撤销后续执行资格";CURRENT.md 本包"RECEIVED、APPLIED、STOP_CONFIRMED 不能混淆"(此处 APPLIED 语义被旗标置位冒充,而真正的执行资格撤销从未发生)。
修复建议(二选一,均为最小改动):① `requestTaskAbort` 将 VERIFYING(及非 runner 覆盖窗口)按不可停止处置 ⇒ 409 指向既有 decision/pause 语义(与本切片"不混语义"原则一致);② 在 gate 编排/审核链路接入旗标检查(verification lease 心跳或 reviewRun cancelSignal),使 VERIFYING abort 也有 APPLIED→STOP_CONFIRMED 闭环。

### Minor(记录,不阻断本轮)

- **M-1(P0-1)幂等防重的并发窗口为"单语句 NOT EXISTS",无数据库级唯一约束兜底**:READ COMMITTED 下两条并发 INSERT..WHERE NOT EXISTS 可互不可见(经典并发插入竞态;需"双方快照均先于对方提交+消费交错"三重窄窗口)。缓解实证:10 并发同内容请求实测 1 消息/1 任务/9 duplicate(探针 B);前端发送期间双按钮禁用进一步压缩窗口。建议下包以部分唯一索引(如 `(goal_id) WHERE execution_request AND 未消费` 等价谓词物化)或 SERIALIZABLE/advisory lock 收口。不构成实际"重复点击双任务"路径。
- **M-2(P0-1)`pendingConsumptionGoals` 不区分意图**:仅含普通未消费消息的 Goal 将每拍被扫描并各开一个空转事务(no_execution_request,零副作用但永不清出)。语义正确,纯卫生/性能项;建议扫描层预过滤 `execution_request=true` 或消费后降频。
- **M-3(P1-3)TASK_ABORT_CONFIRMED 审计为尽力而为**(`appendAuditSafe` 吞异常):STOP_CONFIRMED "以审计为准"的表述下,审计写失败时仅剩 `runs.outcome=CANCELLED + detail.reason=cancelled_by_caller` 可追溯(持久事实仍在)。建议失败时至少计数/告警;REQUESTED 审计与旗标同事务原子,权威事件无损。
- **M-4(P1-3)handback 未实现独立端点与核对流程**:AGENT_CONTROL §4"交还 AI:核对人工修改的 Git 状态、计划版本、测试证据和权限,再授权新 Run"未实现;现以"任务终态后方案 A 显式执行/既有 resume(PAUSED)"承载(当前无人工写权工具,风险可控)。须登记为后续包义务,不得视为已完成。
- **M-5(P1-3)takeover/abort 审计未承载 ControlCommand 结构**:幂等键/计划版本/控制权版本等 AGENT_CONTROL §4 要求的持久审计字段未入 detail(现有 detail 仅 fromState/note)。最小切片边界内可接受,登记为下包结构化补齐项。
- **M-6(流程)实施提交未推送 ⇒ exact-head CI 缺位**:裁决时 origin/main=bf68a65(ahead 1),开发所称 quality:release PASS 与"四条方案 A 旅程真实浏览器绿"均无 Reviewer 可复核的 CI/日志佐证(本 Reviewer 亦未复跑 e2e/quality)。按合同流程 Reviewer 先于推送属可接受顺序,但收口前**必须**完成推送+exact-head CI 复核,且 CI 结果不得低于本报告 §1 独立复跑口径。

## 4. REWORK 触发项核查结论(逐条)

| 触发项 | 结论 |
| --- | --- |
| 普通消息仍可派生 | **不存在**(消费层 intent 过滤+API 零消费路径+探针 C 并发实证+反例日志 9 用例失败留证) |
| PAUSED 可自动重激活 | **不存在**(消费层第一守卫+探针 E:连"暂停前排队的显式执行"也不重激活) |
| 重复点击双任务 | **无实际路径**(sequential 幂等+10 并发实证 1 任务;理论窗口见 M-1) |
| abort 后 Run 未死/任务未终态 | **存在(F-1 反例)**:VERIFYING 窗口 abort 被接受后 reviewer Run 不死、承诺的 CANCELLED 终态永不达成、交付可继续 ⇒ **直接触发 REWORK** |
| 非法检查配置可启动 | **不存在**(resolveEvidenceChecks 全 fail-closed+解析先于连接+单测逐例) |

## 5. 独立验证手段明细(可复跑)

1. **grep 验证**:`INSERT INTO tasks` 生产路径仅 goals.ts 两处;`UPDATE goals SET state` 唯一出现于 setGoalState(goals.ts:162,唯一更新源);`abort_requested_at` 读者仅 worker.ts:204;gate-orchestrator/reviewer 零 abort 处理;FUNCTIONAL_EVIDENCE_KINDS=deterministic_test/api_behavior。
2. **运行时探针(隔离测试库,/tmp 脚本,零仓库改动)**:
   - A:UPDATE goal_messages.execution_request ⇒ 触发器拒绝(新列不可改);
   - B:10 并发同内容显式执行 ⇒ 1 消息/1 新任务/9 duplicate;
   - C:8 并发普通消息 ⇒ 零派生;
   - D:RELAY_OPERATORS 收窄后 abort ⇒ 403 actor_not_authorized;
   - E:PAUSED + 暂停前排队显式执行 ⇒ goal_closed、状态保持 PAUSED、零 GOAL_ACTIVE 审计;
   - F(即 F-1 反例):VERIFYING abort ⇒ 200+旗标置位,无执行点。
3. **反例日志出处核验**:`p0-mvp/control-ready-03/evidence/counterexample-plan-a-old-derive.log` 为真实 vitest 输出(16 用例 9 失败,失败模式与旧代码行为一一吻合:普通消息 consumed=true、混合批次双派生、无 explicit-execute 审计等),"先失败后修复"证据链成立。

## 6. 最终裁决

**REWORK。**

- P0-1(对话授权方案 A)与 P0-2(生产 Gate 可用性)两子项实现质量高、语义忠实、测试钉住充分,独立复跑全绿,无 REWORK 级残留;
- P1-3 存在 **1 Major(F-1)**:紧急停止在 VERIFYING/Gate 窗口"被接受不执行",停止链未闭合且交付可在 abort 后继续 —— 命中预设 REWORK 触发项,必须修复后复验;
- 修复面小且收敛(建议 ①409 拒绝或 ②gate 链路接入旗标),修复后仅需补:VERIFYING abort 用例(拒绝或闭环二选一的对应断言)+ 全量回归 + 推送后 exact-head CI,再交独立 Reviewer 复核 F-1 修复与 M-1~M-6 登记状态。
- 收口前义务(不论修复轮):推送 079b97d(或修复提交)⇒ exact-head CI 双 job 复核;`CURRENT.md`/`docs/CONTINUATION.md` 按真实 SHA 收口;M-4/M-5 登记入下包合同。

---

# 第二轮复核:F-1 修复验证(2026-11-13)

- **复核对象**:修复提交 `6b8dcb1`(基于 `079b97d`;5 文件 +297/-9:src/core/gate-orchestrator.ts、src/core/ops.ts、src/core/goal-loop.ts、src/core/consumption.ts、test/integration/task-abort.test.ts;goal-loop.ts 内另含触达文件内 biome 机械对齐 hunks,`git diff -w` 确认无语义漂移)
- **最终裁决(第二轮)**:**PASS**(F-1 真实闭合,无新绕过面;M-1/M-3/M-4/M-5 已如实登记为后续包义务;M-6=推送+exact-head CI 为收口前置义务,当前 ahead 2 未推送)

## R2-1. F-1 修复逐点验证

| 验证点 | 证据 | 裁决 |
| --- | --- | --- |
| Gate 前置拦截(2.4) | 租约+变更集核验后、机器证据预检前调用 `isAbortRequested`(ops.ts 新导出单点)⇒ `abortStop`:advanceTask(verifierId, 验证租约 fencingToken, VERIFYING→CANCELLED;**lifecycle.ts:57 VERIFYING 转移数组含 CANCELLED,合法**)⇒ expireVerificationLease(verify-lease.ts:82,租约显式终止+VERIFY_LEASE_EXPIRED 审计)⇒ TASK_ABORT_CONFIRMED 审计(STOP_CONFIRMED)⇒ 返回 status=CANCELLED/abort_requested | PASS |
| Gate 后置拦截(4.5) | Reviewer Run(含重试循环)后、recordGateVerdict 前 ⇒ 命中旗标 ⇒ 同 abortStop:PASS 裁决**不记录不消费**,Reviewer 证据留档(已烧事实),任务 CANCELLED | PASS |
| 交付不可能在停止回执后发生 | ①Gate 非 ACCEPTED ⇒ goalLoop 交付分支(`gateReport?.status === "ACCEPTED"`)整体不进入;②纵深防线:ACCEPTED 分支内前置 `isAbortRequested` 再查 ⇒ DELIVERY_ABORT_SKIPPED 审计 + propose/execute 双 skipped(覆盖"旗标在 Gate 消费与交付之间置位"的跨进程窗口) | PASS |
| 新状态无破坏性消费方 | `GateOrchestrationResult.status` 增 "CANCELLED";全仓消费方仅 goalLoop(只分支 ACCEPTED)与 worker.ts:324(透传 tick 报告);无穷举 switch;`npx tsc --noEmit` exit 0 | PASS |
| 无新绕过面(修复引入面检查) | ①abortStop advance 被拒(如验证租约已被 supervisor 回收)⇒ 返回 FAILED/abort_advance_rejected,**不产假 CONFIRMED**(保守方向:无交付无 ACCEPTED,旗标持续存在,后续任一执行点再查);②recordGateVerdict(唯一 ACCEPTED 生产者)位于后置检查之后,微窗口(旗标在 4.5 与裁决落库间到达)⇒ 裁决可记录但交付防线拦截 propose ⇒ 最坏=ACCEPTED 无交付+DELIVERY_ABORT_SKIPPED(外部写零发生,安全方向);③旗标在交付 execute 途中到达 ⇒ 跨系统不可消除窗口,归既有 DELIVERING/CONFLICT/FAILED Reconcile 语义(修复注释已声明)——窗口已从"整个 VERIFYING 阶段"收敛至"相邻两次 DB 检查之间";④docs-only/gate SKIPPED 路径:gate_required 快速通道在租约获取前返回 ⇒ 不经 abortStop,但 SKIPPED 永不交付(仅 ACCEPTED 交付),旗标由后续 coder Run 轮询兜底 | PASS |
| 反例回归真实性 | task-abort.test.ts 新增 3 用例全部为真实链路(真 runner stub-ok 写候选至 VERIFYING、真 orchestrateGate、真 goalLoopTick):前置拦截断言 reviewer 零调用(reviewRun 被调即抛)+零裁决行+CONFIRMED=1;后置拦截在 reviewRun 回调内置旗(模拟另一进程)⇒ PASS 裁决不记录;交付防线断言 report.gate=CANCELLED/report.delivery=undefined/propose 被调即抛+零调用 | PASS |
| **Reviewer 独立探针(非开发测试)** | probe3(隔离库):**阴性对照**(无旗标 VERIFYING 任务)⇒ 编排越过前置检查、reviewer 被调用=1(无过度拦截;正常 ACCEPTED 路径由 gate-machine-evidence "功能性证据合法放行⇒ACCEPTED" 用例钉住);**原反例复现(修复后)**:真 runner 至 VERIFYING → `POST /api/tasks/t-pos/abort` ⇒ 200 → orchestrateGate ⇒ **CANCELLED/abort_requested、任务 CANCELLED、裁决行=0、TASK_ABORT_CONFIRMED=1、VERIFY_LEASE_EXPIRED=1**;isAbortRequested 单点可读;**M-2 等价性**:仅普通未消费消息的 Goal 不入扫描、含执行消息 Goal 仍入扫描(与原扫描对该类 Goal 只返回 no_execution_request/goal_closed 零副作用等价) | PASS |
| M-2 语义等价性 | pendingConsumptionGoals 增 `AND gm.execution_request = true`;-held(终态后执行请求)Goal 仍每拍扫描(goal_closed 零副作用,行为不变);仅普通消息 Goal 退出扫描(原本零副作用) | PASS |

## R2-2. 独立复跑(第二轮,全部亲手执行)

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **PASS(exit 0)** |
| `npx biome lint --reporter=summary src test scripts web` | **0 error**(93 warnings = 历史基线不变) |
| 七个指定测试文件 vitest | **7 文件 63/63 全绿**(task-abort 4→7:新增 3 个 F-1 用例全绿;goal-message-authorization 16/16、goal-message-consumption 6/6、worker-evidence-checks 5/5、goal-messages 6/6、gate-machine-evidence 10/10、cli 13/13) |
| 工作区 | 零受跟踪文件修改(仅受保护未跟踪 config/、soak-r3b/ 与本报告文件) |
| quality:quick / quality:release | NOT_RUN(开发声称双 PASS;纪律约束 + 与第一轮同口径不背书) |
| exact-head CI @6b8dcb1 | NOT_RUN(未推送;origin/main 仍 = bf68a65,本地 ahead 2) |

## R2-3. M 登记状态核验

- **M-1/M-3/M-4/M-5**:已在 `6b8dcb1` 提交信息中逐条登记为后续包义务(并发唯一索引兜底/CONFIRMED 审计尽力而为+告警/handback 专端点与 §4 核对流程/ControlCommand 结构化 detail)——核验属实,按登记义务携带,不阻断本轮。
- **M-6**:仍开放——`079b97d` 与 `6b8dcb1` 均未推送(ahead 2),exact-head CI 不存在。**收口前置义务**:推送后必须复核 exact-head CI 双 job success,方可更新 CURRENT/CONTINUATION 并释放 Writer。
- **M-2**:本轮已消化(见 R2-1)。

## R2-4. 残余风险登记(不阻断,如实记录)

1. 微窗口 A(4.5 与裁决落库之间置旗)⇒ 裁决记录+任务 ACCEPTED,但交付被防线拦截(DELIVERY_ABORT_SKIPPED);外部写零发生。
2. 微窗口 B(交付 execute 途中置旗)⇒ 跨系统不可消除;归 Reconcile 语义(CONTRACTS §4"原子保证仅覆盖本地 DB 事务");可选收紧=proposeDelivery 事务内再查旗标。
3. abortStop advance 被拒 ⇒ FAILED+旗标留存(无假 CONFIRMED;后续执行点兜底)——保守失败方向正确。

## R2-5. 最终裁决

**PASS。** F-1(第一轮唯一 Major)修复真实闭合:VERIFYING/Gate 阶段紧急停止全链 REQUESTED→编排拦截→CANCELLED→CONFIRMED,Reviewer 停止后零烧、裁决不记录不消费、交付在停止回执后不可能发生(双防线);修复未引入新绕过面(全部新分支失败方向保守);M-2 消化语义等价;反例回归真实且经 Reviewer 独立探针交叉验证。按合同流程收口条件:**推送 079b97d+6b8dcb1 并复核 exact-head CI 双 job success(M-6)→ 更新 CURRENT.md/docs/CONTINUATION.md(真实 SHA)→ 释放 Writer**;M-1/M-3/M-4/M-5 按登记转入后续包。
