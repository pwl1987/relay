# RELAY-CONTROL-READY-03 最终报告

裁决:**PASS**(独立 Reviewer 第一轮 REWORK[F-1]→修复→第二轮 PASS;exact-head CI 双 job success;真实 SHA 与实测数据)
日期:2026-11-13
合同:bf68a65(用户方案 A 冻结+合同登记,CURRENT.md「RELAY-CONTROL-READY-03」;CI 43416921382 success)

## 1. 基线与 Writer

- 开工冷启动:live main = `bf68a65` 与本地一致 0/0;未跟踪受保护 `config/`、`p0-mvp/soak-r3b/` 全程零触碰;Writer=本窗口唯一,main-only 快进。
- 提交链:`bf68a65(合同)→ 079b97d(实施,18 文件 +2086/-528)→ 6b8dcb1(Reviewer REWORK 消化 F-1,5 文件 +297/-9)→ 7ede3b4(CI 失败修复:时间戳精度)→ 收口提交`。
- 生产影响:零部署/零生产库写入/零模型调用/零真实远端写入;生产 worker 未重启(新语义在重启后生效)。

## 2. 交付内容(三子项)

### P0-1 对话授权方案 A(用户 2026-11-13 裁决;撤销 WEB-UX-03C §0 自动派生)

- **迁移 0008**:`goal_messages.execution_request boolean NOT NULL DEFAULT false`(INSERT 落库,append-only 触发器覆盖——Reviewer 探针 A 实证 UPDATE 被拒)。
- **语义**(设计权威=CURRENT.md 本包合同 + CONTRACTS.md §2 + SEMANTICS-P0A §3):
  - 普通"发送"(false;旧客户端缺省安全降级)⇒ 任何状态只交流/记录,**永不派生、永不写映射**;
  - 显式"交给 Relay 执行"(true)⇒ 服务器端校验后才派生受控 Task(不经模型猜测、不依赖前端):原子幂等防重(同内容未消费或其任务非终态 ⇒ 单语句 INSERT...WHERE NOT EXISTS 拒绝,重复点击单任务;Reviewer 10 并发探针 1 消息/1 任务/9 duplicate);ACTIVE 空闲 ⇒ 立即派生;在途 ⇒ 排队到安全边界;终态后 ⇒ 不派生不重开(goal_closed);**在途排队(先于终态迁移落库)⇒ 边界消费+可审计重激活(GOAL_ACTIVE reason=execute_boundary,SQL µs 精度比较)**;**PAUSED 绝对不自动重激活(含显式执行消息;上包 Reviewer Minor-3 收口,探针 E 实证)**;
  - API 反馈三态:已记录/排队待执行/已创建任务;scope/commands 继承语义不变(不扩大旧 Task 权限与预算);`POST /api/goals` 显式创建入口未动。
- **Web UI**:单输入框保留;任务态双操作(发送=只交流/记录;**「交给 Relay 执行」**=显式请求;空白态仍只有「开始」);≥44px 触控;旧 §0 文案("已收到你的补充/已形成")不回归断言(桌面+移动)。
- **反例留证**:旧代码上 16 用例 9 失败(`p0-mvp/control-ready-03/evidence/counterexample-plan-a-old-derive.log`);真实浏览器旅程 C5/C6/M5/M6 更新并全绿(release browser 步骤)。

### P1-3 停止/接管最小切片

- **迁移 0009**:`tasks.abort_requested_at`(跨进程紧急停止旗标)。
- `ops.requestTaskAbort`:幂等 set-if-null;仅在飞状态(READY/终态 ⇒ 409 语义拒绝,不与 pause/decision 混);OPERATOR 授权 + 可选 state_version;TASK_ABORT_REQUESTED 审计。
- API `POST /api/tasks/:id/abort` 与 `/takeover`(takeover=停止在飞 Run+撤销写入资格+TASK_TAKEOVER_REQUESTED 审计;无 force-revoke 竞争,取消由 runner 以自身租约合法完成)。
- worker:Run 期 1s 心跳轮询旗标 → runner cancelSignal → SIGTERM→SIGKILL → run=CANCELLED → 任务合法转移;TASK_ABORT_CONFIRMED 审计(STOP_CONFIRMED);轮询器随 Run 清理。
- **F-1 修复(Reviewer 第一轮唯一 Major)**:VERIFYING/Gate 窗口 abort 原先"被接受不执行"(Reviewer 可继续烧、Gate 可 ACCEPT、交付可继续写 GitHub)。修复=orchestrateGate **前置(2.4)+后置(4.5,Reviewer 后裁决前)双检查 isAbortRequested** ⇒ VERIFYING→CANCELLED+CONFIRMED 审计+裁决不记录不消费;goal-loop 交付防线(ACCEPTED 分支前置旗标检查 ⇒ DELIVERY_ABORT_SKIPPED);GateOrchestrationResult 新增 status=CANCELLED。反例回归 3 用例(前置拦截 Reviewer 零调用/后置拦截裁决作废/交付防线 propose 零调用)。
- 测试(跨进程真实信号):worker 轮询→SIGKILL→CANCELLED 全链、残余子进程死亡(pid 存活基线→死亡)、旧 fencing 推进拒绝、重复 abort 幂等、API 403/409 语义。
- handback:按合同最小切片=停止后经方案 A 显式执行请求或既有 resume 承载,未新增专端点(M-4 登记后续包)。

### P0-2 生产 Gate 可用性

- `worker-entry` 新增 `RELAY_EVIDENCE_CHECKS_JSON`(CheckSpec[]):严格校验 fail-closed(非法 JSON/非数组/空数组/非功能性 kind[manifest/reviewer_output 拒绝]/坏 argv/越界 timeout ⇒ 启动即抛;解析先于 DB 连接);未配置 ⇒ 不注入 ⇒ Gate 保守停机(SAFETY-CLOSE-02 P0-B 标准未降级;功能检查不可被用户消息/模型文本/manifest 顶替)。
- 生产重启/配置变更不在本包授权(仅提供机制;取值=部署包决策)。

## 3. 独立 Reviewer(两轮)

- **第一轮:REWORK**(1 Major F-1 + 6 Minor):P0-1/P0-2 PASS(独立探针 A~E:append-only 新列/10 并发幂等/8 并发普通消息零派生/403/PAUSED 不重激活);P1-3 F-1 反例实测(VERIFYING abort 200+旗标置位但全链零执行点)。报告=p0-mvp/control-ready-03/REVIEW-CONTROL-READY-03.md。
- **修复**:F-1 闭环(上述)+M-2 消化(pendingConsumptionGoals 预过滤执行消息,语义等价性经 Reviewer 探针验证)。
- **第二轮:PASS**:F-1 真实闭合(REQUESTED→编排拦截→CANCELLED→CONFIRMED;Reviewer 独立探针:阴性对照无过度拦截、原反例修复后 CANCELLED/裁决 0/CONFIRMED 1);无新绕过面(全部新分支失败方向保守);独立复跑 tsc+biome 0 error+7 文件 63/63。残余登记:微窗口 A/B(停止与交付 execute 之间跨系统间隙,归 Reconcile 语义;外部写零发生)。

## 4. 测试与 CI

- `quality:quick` PASS;`quality:release` PASS ×2(实施后+F-1 修复后;evidence=test-evidence/quality-release-2026-11-13T12-41-20/):tests 304 过+52 门控 skip、browser 30 过+2 门控 skip(含四条方案 A 旅程)、backup-restore 13 表一致、github-real 授权门下 2 过 3 skip。
- 定向:goal-message-authorization 16/16(竞争用例 3 连跑)、task-abort 7/7、worker-evidence-checks 5/5、gate 回归+cli 23/23。
- **exact-head CI**:43429519863@6b8dcb1 test job **failure**(真实产品缺陷:时间戳 String(Date) 往返丢毫秒,同秒窗口误判——CI 实测反例);修复 7ede3b4 后 **43430354996@7ede3b4 = success(test 2m39s + e2e 2m6s)**。诚实记录:本轮一次 CI 红→归因→修复→绿(非基础设施抖动,为本包真实缺陷修复)。
- 显式 NOT_RUN:模型门禁 e2e(需授权);真实远端写入(RELAY_GITHUB_REAL_E2E 需授权,零远端写入);生产部署验证(未触碰);abort 在真实模型 Run 上的演练(零模型约束,stub 信号链已实证)。

## 5. 生产影响、回滚与下包登记

- **生产影响**:worker/web 未重启 ⇒ 线上行为不变;重启后:消息方案 A 生效(普通发送不再创建任务——用户已裁决)、abort/takeover API 可用、Gate 在未配置 evidenceChecks 时对代码变更保守停机(P0-2 机制待部署配置)。
- **回滚**:`git revert 7ede3b4 6b8dcb1 079b97d`(迁移为加列,回滚后旧行为恢复;0008/0009 列留存无害)。
- **登记后续包(Reviewer M 项)**:M-1 幂等并发唯一索引兜底(advisory lock/部分索引);M-3 TASK_ABORT_CONFIRMED 审计失败告警;M-4 handback 专端点与 AGENT_CONTROL §4 交还核对流程;M-5 ControlCommand 结构化审计 detail(幂等键/计划版本/控制权版本);微窗口 B 可选收紧(proposeDelivery 事务内再查旗标)。
- **下一包建议**:生产部署配置包(RELAY_EVIDENCE_CHECKS_JSON 取值+重启窗口,需独立授权);E-7 NEEDS_RECONCILE 自愈;ControlCommand 结构化(M-5)。
