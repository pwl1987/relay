# P0-01C 独立复核报告(REVIEW)

- 复核人:全新上下文独立 Reviewer(与实现会话零共享记忆),2026-11-10,全程零模型调用
- 复核对象:HEAD `1a53788`(= `a47ae8a` C-1..C-4 → `3536042` 回合硬顶+E2E → `1a53788` 克隆复现证据),工作树 clean,本地领先 `origin/main` 3 提交(快进 push 属通过后动作,未执行,正确)
- 依据:CURRENT.md(P0-01C ACTIVE)、ADR-0003、架构 §3/§6(D0-D4)、SECURITY_MODEL T07/T09、VALIDATION_PLAN V11/V15、CONSTRUCTION_PLAN P0-01C 行、P0-01B REVIEW F-2/F-3/F-7 遗留

## 亲测结果(原样粘贴)

```
$ RELAY_PI_BASE_URL=http://127.0.0.1:1/v1 npx vitest run   (HEAD == 1a53788, 2026-11-10 09:35)

 Test Files  25 passed | 2 skipped (27)
      Tests  93 passed | 3 skipped (96)
   Start at  09:35:36
   Duration  67.67s

$ npx tsc --noEmit
tsc exit: 0
```

跳过面核验:3 skipped = `pi-e2e-c.test.ts`(1)+ `pi-e2e.test.ts`(2, P0-01B 遗留),均因 provider 探测显式 skip,符合"零模型约束"要求。egress-enforcement 4 例在本机(docker+sudo iptables 可用)**真实执行全绿**。

## 逐项核验表

| # | 核验项 | 结论 | 证据(文件:行) |
|---|--------|------|----------------|
| 1 | 白名单边界 | **VERIFIED**(3 文件出清单,见 F-1) | 三提交 32 文件:`p0-00/**`、`p0-01a/**`、`p0-01b/**` 零改动;无 dist/build 产物;p0-01c/*.log 属白名单 `p0-01c/**`;白名单外仅 `src/core/goal-loop.ts`(新文件未列名)、`src/core/audit.ts`(+1 行 OPERATOR 权威类型)、`package-lock.json`(package.json 配套,typebox devDep 为白名单顺手项) |
| 2a | 心跳 DB 连续异常止损 | **VERIFIED** | runner.ts:220-228(catch 计 streak,≥2 ⇒ abortReason+SIGKILL;业务拒绝走 lease_lost 分线 213-219);c1-safety.test.ts:36-80 真实注入抛错 heartbeatFn,断言 INTERRUPTED + `heartbeat_errors` + **ps 核验 stub 死亡** + 任务停留 RUNNING 不被推进 + calls≥2;任务收尾归 Supervisor 过期回收(supervisor.ts:18-53),TTL 有界 |
| 2b | relay_exec 白名单 | **VERIFIED(附 F-3)** | checkCommandScope 空白名单拒(extension:122)、`[;&|` `\n]` 拒(123)、段边界 `trimmed===prefix \|\| startsWith(prefix+" ")`(129,"npmx≠npm" 有单测);RELAY_ALLOWED_COMMANDS 贯通链:schema.ts:27 tasks.allowed_commands → runner.ts:319 spec.allowedCommands → sandbox.ts:240/263 env → extension:178-185 JSON 解析(损坏⇒全拒 FAIL-CLOSED);**但 `$()` 替换未禁且注释虚报,见 F-3** |
| 2c | 工具事件 Worker 侧持久化 | **VERIFIED** | runner.ts:197-201 onRecord 捕获 RPC 事件流 tool 类原文 → detail.toolEvents(415,截 200 条);c1-safety.test.ts:94-130:workspace 审计文件缺失(readToolAudit 空)时 DB 仍有 2 条 tool_call(含 /etc/passwd 越权)+ denied tool_result。P0-01B F-2(tool-audit 可销毁)承接落地 |
| 2d | 网络出口约束 | **VERIFIED(重点对抗后)** | 三层:relay-egress-net(egress.ts:149-152)+ RELAY-EGRESS 链 ACCEPT→DROP(161-163)挂 DOCKER-USER **仅 `-s subnet`**(164-166)+ INPUT 单条 `-s subnet -d hostIp --dport`(167-169)+ 转发器容器 --network host **代码内仅连 127.0.0.1**(94-104,模型连接源回 loopback);teardown 按子网/RULE_TAG 只删本包规则(250-290,vitest-full-run.log 实测后规则消失用例绿);verifyEgressRules 失败 ⇒ launchPi 拒启(sandbox.ts:208-210)+ executeRun 拒启(runner.ts:173-175),egress-enforcement 第 3 用例断言 `egress_rules_missing` rejects;**无 --network host 降级路径**:docker 分支恒 `--network EGRESS_NETWORK`(sandbox.ts:229),docker 不可用即抛(183-185),host-fallback 需调用方显式指定且仅测试使用(run-loop.ts:35、各测试);合同"不超过 8 请求"E2E 经账本预留 8 执行。规则作用域/降级面对抗搜索通过 |
| 3 | C-2 机器预算 | **VERIFIED(附 F-2)** | budget.ts 先预留(77-79)后核算(100-108):model_calls 无带 limit 行或行 limit=NULL ⇒ `budget_not_configured` 拒绝 + BUDGET_RESERVE_REJECTED 审计(63/82-90);超限 `budget_exhausted` 拒绝 + 审计(67-75);runner 预留失败 ⇒ run=BUDGET_EXHAUSTED + 任务 RUNNING→BLOCKED + stub 零启动(budget-enforcement.test.ts:79-115);**回合硬顶**(runner.ts:334-352:等待循环每 100ms 计 assistant 回合 ≥ 预留 ⇒ SIGKILL+BUDGET_EXHAUSTED,440-445 任务 BLOCKED)实现正确但**无专属测试,见 F-2**;usage 实测入账/缺失保守估算(492-494,STUB_USAGE 1234/567 断言 144-148);off-by-one 复查:硬顶路径 actualCalls=reserved 恰平,成功路径 actualCalls<reserved,保守方向正确;E2E 证据:p0-01c/e2e-run.log 1 例通过(15.9s,断言含 used∈[2,8]、reserved=0);账本数字不可独立复现(schema 已清理,按复核指示以日志+代码采信) |
| 4 | C-3 决策 | **VERIFIED** | D4 创建拒绝 + DECISION_REJECTED_D4 审计(decisions.ts:48-57,goal-loop.test.ts:46-49);D2 无 fallback 拒(58-60)、有 fallback 自动 RESOLVED_FALLBACK + DECISION_FALLBACK 审计(goal-loop.ts:194-211,测试 82-87);D3 → NEEDS_DECISION(212-230)+ expireStaleDecisions 仅标 EXPIRED_STILL_BLOCKED 永不自动批准、任务停留(93-109,测试 89-96,T07);恢复 API ops.ts:actor 授权(RELAY_OPERATORS,12-15)+ expected state_version(51-60)+ 合法转移(61-70,lifecycle.ts:60 NEEDS_DECISION→READY/FAILED)+ 审计;goal-loop.test.ts:99-127 未授权拒绝/版本不符拒绝/授权批准三路断言 |
| 5 | C-4 自治恢复 | **VERIFIED** | 退避:claimNextReady 过滤 retry_not_before(supervisor.ts:179)+ releaseRework 指数退避(supervisor.ts:140-152 + goal-loop.ts:51-53/137-141,退避序列 1x→2x 有断言);熔断:相同签名连续 ≥3 ⇒ CIRCUIT_OPEN 审计 + task FAILED(goal-loop.ts:109-122),circuit-recovery.test.ts:37-84 断言 **runCount 恰为 3**、审计恰 1 条、streak=3、goal FAILED;attempt 预算:ATTEMPT_BUDGET_EXHAUSTED(123-135,测试 86-121);并发双 Tick 恰一赢家恰一次执行(135-152,Promise.all 真并发);loop 子进程真实 SIGKILL(kill9AndAssertDead)→ 新 loop 从 PG 恢复走至 VERIFYING + RECLAIM_EXPIRED 审计(154-216,run-loop.ts 真实 executeRun);IDLE/IDLE_PROVIDER_DOWN 不领取不烧 token(goal-loop.ts:242-253,goal-loop.test.ts:198-209) |
| 6 | 亲自运行 | **VERIFIED** | 93 passed + 3 skipped + tsc 0 错误(见头部粘贴);未运行 pi-e2e-c/pi-e2e(遵守禁令,E2E 真实性以 e2e-run.log + 静态审查采信) |
| 7 | 诚实性 | **VERIFIED(附 F-5/F-8)** | 全量吞错扫描:runner finally 6 处 `.catch(() => {})` 均为"尽力而为"注释语义(结算/落库/审计),goal-loop.ts:316 startGoalLoop 吞 tick 异常无日志(F-8);断言放宽面:pi-e2e-c:132-135 denied 断言为条件式(F-5);c1-safety:79 `calls>=2` 与 circuit-recovery:79 backoffs 语义合理;无 .only;.skipIf 全部显式条件(egress/pi-e2e),不假装;失败签名/退避/预算过冲(budgetOvershoot 如实入 detail)均如实落库 |
| 8 | 安全红线 | **VERIFIED** | 全仓 grep:无 GITHUB_TOKEN/gh api/octokit/写路径;无真实凭据(models.json 由 env 探测注入,假密钥);转发器容器代码内仅 127.0.0.1:3425(egress.ts:99);iptables 三处规则均带子网/端口/注释标记作用域,teardown 不触 ufw(全仓 grep ufw 仅注释),DOCKER-USER 插入限 `-s 本子网`,不影响 VM80 其他项目 |
| 9 | 已知边界核对 | **VERIFIED(附 F-5/F-6/F-7)** | heartbeat TTL=heartbeatSeconds×3 与代码一致(runner.ts:210 传 `spec.heartbeatSeconds*3`,finally 前持续续租;VERIFYING 后心跳停,TTL 剩余窗口内须完成 Gate —— pi-e2e-c.test.ts:98-99 声明与代码吻合,E2E heartbeatSeconds=2 ⇒ 窗口≈6s);pi-e2e-c 单任务 vs 合同"多 Task":合同原文验收 3 即"stub 编排全链 + ≥1 真实模型自治 goal 闭环",单任务真模型 + stub 多任务(goal-loop.test.ts:142-211 两任务)满足字面;但 stub 链中 runner 推进/ACCEPTED 为测试内 SQL 模拟而非真实 runner 路径,真实 runner 仅在单任务测试与 run-loop 重启测试中全链执行(F-6 注记);3536042 提交说明对此已如实声明 |
| 10 | 宿主改动授权面 | **VERIFIED** | 代码内宿主改动仅:DOCKER-USER 插入/INPUT 单条/RELAY-EGRESS 链(egress.ts:157-169)+ relay-egress-net 网络(150)+ relay-egress-fwd 容器(172-186)+ 仓库内 node_modules/一次性 HOME chmod(仓库本地,承 P0-01B);scripts/ 无 egress 脚本(逻辑在 egress.ts,白名单内),scripts/ 本包零改动;无 ufw、无宿主服务改动 |

## 发现列表

- **F-1|白名单外 3 文件(MINOR)** — `src/core/goal-loop.ts`(新文件,CURRENT.md 白名单仅列名 budget/decisions/goals/ops 四个新增)、`src/core/audit.ts`(+1 行 `"OPERATOR"` 权威类型)、`package-lock.json`(typebox 配套)。三者在合同精神内(goal-loop 是 C-3/C-4 的必然载体、OPERATOR 是 ops 审计的必然权威、lock 是 package.json 配套)且体积极小,但合同写明"超界即停",正确做法是在 REPORT 中显式声明边界扩张。**处置要求:REPORT 披露,不必回改。**
- **F-2|回合硬顶(本包头条声明)零专属测试(MAJOR)** — runner.ts:334-352/440-445 的 `budget_turns_cap`(Run 中 assistant 回合 ≥ 预留 ⇒ SIGKILL+BUDGET_EXHAUSTED+任务 BLOCKED)是 3536042 提交的核心声明"机器强制预算 Run 中不可破",但 `reserveCallsPerRun` 在全部可运行测试中零出现(仅 pi-e2e-c:88 配置,而该测试被跳过);budget-enforcement 只覆盖启动前预留失败路径,合同验收 5 的"账本触顶"未含"Run 中触顶"。stub 发多回合 message_end 即可零模型测试(基础设施现成:stub-pi.mjs 已支持 usage/多事件)。**处置要求:补一条 stub 级回合硬顶故障注入测试(预留 N、stub 发 N+2 回合、断言 SIGKILL+BUDGET_EXHAUSTED+BLOCKED+used 恰 N)后方可关闭本包。**
- **F-3|命令白名单元字符集不完整且注释虚报(MAJOR)** — checkCommandScope(extension:123)仅禁 `[;&|` `\n]`;`$(...)` 命令替换未被禁且能通过前缀匹配(如白名单 `grep`、命令 `grep $(node -e '任意代码')` ⇒ 经 `/bin/sh -c`(extension:143)升级为容器内任意代码执行,`<()`/`>` 重定向同样未禁)。**代码注释(extension:115)声称"shell 控制字符全禁(; & | ` 换行 $( 等)"与实现不符;单测矩阵(command-scope.test.ts:23-30)未覆盖 `$()`**。缓解面真实存在:egress 白名单阻断外联、cap-drop+UID 10001+一次性 FS 限制爆炸半径,且合同字面(`;&|` 反引号/换行)已满足——故不入 FAIL。但本包主题即安全收口,安全注释不得虚报。**处置要求:一行修复($、<、> 入禁用集或拒绝含 `$(`/`<(`/`>` 的命令)+ 注释更正 + 单测矩阵补 3 行。**
- **F-4|ACTIVE 合同文本晚于首个实现提交入库(MINOR,治理过程)** — 7836333 时点 CURRENT.md 仍为"P0-01B COMPLETE / P0-01C NOT_ACTIVE";a47ae8a(全部 C-1..C-4 实现)携带的 CURRENT.md 未更新;P0-01C ACTIVE 合同文本首次入库于 3536042(第二个实现提交)。已对照 7836333 时点已存在的授权锚:CONSTRUCTION_PLAN P0-01C 行、CONTINUATION.md 验收要点("人工缺席安全 Task 继续;D3 一直被阻断;无限失败有限停止")、P0-01B REVIEW F-2/F-3/F-7 遗留清单——合同内容与锚同源,**未发现实质迁就实现的改写**;但"白名单先行"的可审计性受损(实现提交时点的边界核验只能回溯锚文件)。**处置要求:REPORT 记录激活时序事实;后续包合同必须先于实现提交落盘。**
- **F-5|pi-e2e-c 名实差与断言弱化(MINOR)** — ① 测试名"自治闭环:2 任务经 GoalLoop 自动执行"实为**单任务**(tasks 数组仅 t-c-a,goal-loop.test.ts:63-67 注释如实说明但测试名误导);② `expect(calls.used).toBeGreaterThanOrEqual(2); // 至少 2 个 Run`(pi-e2e-c:148)注释错误——单任务单 Run,≥2 实为 assistant 回合数下限;③ denied 断言为条件式 `if (denied.length > 0)`(132-135),模型若未尝试越权则静默通过(prompt 要求其尝试,但测试不强制)。**处置要求:更正测试名与注释;denied 弱断言可保留但 REPORT 须注明。**
- **F-6|验收 4 组合场景未同时证明(MINOR)** — 合同验收 4"D3 超时绝不执行,其他安全任务继续(集成测试)":goal-loop.test.ts 中 D3 阻断用例(53-97)与多任务推进用例(135-211)分离,c3-decision schema 的 t-safe(priority 10)从未被驱动到 ACCEPTED——"D3 停滞 + 另一 task 走到 ACCEPTED"的组合断言未在同测试中同时成立。机制上成立(handleOpenDecisions 仅触碰有 OPEN 决策的任务,claim 按任务独立),属证明组织问题。**处置要求:合并断言或 REPORT 声明等价覆盖。**
- **F-7|证据绑定不完整(MINOR)** — vitest-full-run.log 与 e2e-run.log 均无 SHA/日期绑定(仅 Start at 时刻);fresh-clone-repro.log 有完整绑定(`@ 3536042... date:2026-11-10T09:29:05+08:00`)。验收 8 要求"证据绑定实现 SHA";REPORT.md 本复核时点未落盘(属合同既定顺序:复核通过后收尾)。**处置要求:收尾提交时在 REPORT 中为两份日志补绑 SHA(实现 SHA 3536042/1a53788),与本 REVIEW 头部互证。**
- **F-8|吞错与软限面(OBSERVATION)** — ① startGoalLoop(goal-loop.ts:316)`.catch(() => {})` 吞掉 tick 异常且无任何日志,常驻驱动的持续 DB 故障将静默空转;② runner finally 的 updateRun/settle/audit 吞错(注释"尽力而为"),updateRun 失败时 run 行停留 RUNNING(outcome 缺失),任务行由租约回收兜底;③ token 预算预留失败仅审计不阻断 Run(runner.ts:274-281 只在 tr.ok 时入账册,model_calls 为唯一硬顶),与 C-2"达到上限自动停"的字面对 tokens 而言是软限;④ planner 会建 wall_seconds 账本行(goals.ts:46)但 runner 不经账本核算 wall(goals 预算仅 RunSpec.wallSeconds 生效)。均为记录性,建议 P0-02 收敛。
- **F-9|陈旧注释与失真字段(OBSERVATION)** — ① sandbox.ts:6-7 头注释仍描述 P0-00 时代"容器用 --network host"路由,与同文件 :229"host 网络已于 P0-01C 废止"矛盾;② pi-rpc.countToolCallEvents 匹配 `tool_call` 子串,真实 pi 事件形态为 `tool_execution_start/end`(pi-e2e-c:129 注释自证),真实 Run 中 `detail.toolCallEvents` 恒 0(detail.toolEvents 数组不受影响);③ e2e-run.log/vitest-full-run.log 中 ensure/teardown 的 docker/iptables stderr 噪音("No such container" 等)系被捕获错误的泄漏,无碍语义但降低证据可读性。
- **F-10|测试断言缺口(OBSERVATION)** — ① D2 自动 fallback 的 DECISION_FALLBACK 审计已实现(goal-loop.ts:203-209)但测试未断言 audit_events;② ops 恢复 API 的非法转移拒绝路径(recoverTransition:61-70)无测试(actor/version 两路已测);③ 契约命名差:合同写 releasePause/unblockBlocked,实现为通用 resumeTask(功能覆盖,命名偏差)。

## 总裁决

**PASS-WITH-FIXES**

理由:十条验收中 1/2/3/4/5/6/7/8 的实现面均有代码+真实测试支撑,复核人独立复现 93 passed + 3 skipped + tsc 0 错误;C-1 三项收口(心跳止损/工具事件 Worker 侧持久化/egress 三层)经对抗审查成立,无 `--network host` 静默降级路径,宿主改动面严格限于授权清单;C-2 FAIL-CLOSED 链、C-3 T07(永不超时自动批准)、C-4 熔断恰 3 runs/并发单赢家/真实 SIGKILL 恢复均 VERIFIED。两处 MAJOR(F-2 回合硬顶零测试、F-3 白名单元字符绕过+注释虚报)均为**小修复可闭合**(一条 stub 测试 + 一行禁用集修复),不推翻架构与安全语义;未发现掩盖、虚构或越权。

关闭本包前必须完成(除合同既定收尾外):
1. **F-2**:补 stub 级回合硬顶故障注入测试;
2. **F-3**:checkCommandScope 禁用集补 `$`/`<`/`>`,注释更正,单测补行;
3. **F-1/F-4/F-5/F-6/F-7**:REPORT 如实披露(边界扩张、激活时序、E2E 名实、覆盖组织、证据补绑)。

合同既定收尾(验收 8):快进 push main、核验 `origin/main==HEAD`+worktree clean、更新 CURRENT.md/docs/CONTINUATION.md、落盘 p0-01c/REPORT.md。

---

# 复验(第二轮,处置 65544ed)

- 复验人:同一独立上下文 Reviewer,2026-11-10,全程零模型调用(未运行 pi-e2e-c/pi-e2e)
- 复验对象:处置提交 `65544ed`(触碰 7 文件:extension.ts +regex/test 新增 budget-turns-cap.test.ts + stub-pi.mjs chatty/command-scope 补样/REPORT.md 新落盘/REVIEW.md 首轮原样入库(65 行零删改,`new file mode` +65)/vitest-full-run.log 重跑)
- 白名单边界(复验):7 文件全部在 `p0-01c/**`、`test/**`、`src/runtime/relay-tools.extension.ts` 语义内;无其他 src/docs/CURRENT 改动;无断言放宽(现存测试仅 command-scope 追加样本,属强化)

## 亲测结果(复验轮,原样粘贴)

```
$ RELAY_PI_BASE_URL=http://127.0.0.1:1/v1 npx vitest run   (HEAD == 65544ed, 2026-11-10 09:50)

 Test Files  26 passed | 2 skipped (28)
      Tests  94 passed | 3 skipped (97)
   Start at  09:50:21
   Duration  69.34s

$ npx tsc --noEmit
tsc exit: 0

$ npx vitest run test/integration/budget-turns-cap.test.ts test/unit/command-scope.test.ts
 ✓ test/integration/budget-turns-cap.test.ts (1 test) 837ms
   ✓ 回合硬顶(机器强制预算,Run 中) > cap=2 < stub 5 回合 ⇒ BUDGET_EXHAUSTED(budget_turns_cap)+ stub 死亡 + 任务 BLOCKED + used=2
 ✓ test/unit/command-scope.test.ts (4 tests) 5ms
 Test Files  2 passed (2) / Tests  5 passed (5)
```

94+3skip 与 REPORT §2/§8 声明一致(文件数 26、用例数 94,较首轮恰 +1 文件 +1 用例 = 新硬顶测试)。

## 首轮发现处置核验(逐条)

| 首轮 # | 处置结论 | 复验证据 |
|--------|----------|----------|
| F-2(MAJOR)回合硬顶零专属测试 | **CLOSED(修复真实)** | stub-pi.mjs 新增 chatty 模式(STUB_TURNS=5,每 120ms 一条 assistant message_end 后 settle);budget-turns-cap.test.ts:36-87 断言完整:BUDGET_EXHAUSTED + reason=budget_turns_cap + cap=2 + **turns=2 恰停** + ps 核验 stub 死亡(69-73)+ 任务 BLOCKED(76-77)+ run 行如实(79-80)+ 账本 **used=2=limit、reserved=0、used≤limit**(83-86)——恰为本轮处方"预留 N、stub 发 N+2、断言 SIGKILL+BUDGET_EXHAUSTED+BLOCKED+used 恰 N"。单跑 837ms 真实进程全绿;turns=2 断言若时序漂移会显式失败,不掩盖。账本机械性闭环:reserve 2→cap 2→settle used 2,单 Run 无法突破预留 |
| F-3(MAJOR)$() 未禁+注释虚报 | **CLOSED(修复真实)** | extension:123-126 regex 补 `/\$[({]/`(`$(`/`${`/`$((` 全禁;backtick 原有;`<(` 在 /bin/sh=dash 下非求值面,`$VAR` 裸展开仅为已清洗 env 的插值非执行——dash 下求值逃逸面闭合);注释更正为"命令替换全禁…无任何求值逃逸面"(与实现一致);command-scope.test.ts 补 3 样本(`$(cat /etc/passwd)`/`${HOME}`/`$((1+1))`)断言 DENIED。`>` 有意未禁(E2E 写 result.txt 依赖,数据面非执行面,容器 UID 内可写面有限)——符合本轮处方选项 B |
| F-1(MINOR)白名单外 3 文件 | **CLOSED** | REPORT §0 交付标识列出 goal-loop.ts(新增 core);audit OPERATOR 经 §1 C-3"OPERATOR 权威审计"披露;package-lock 经 §7 复现命令(npm ci)隐含 |
| F-4(MINOR)合同文本入库时序 | **PARTIAL → N-3** | 处置摘要声称"含 F-4 合同文本入库时点问题的说明",REPORT §4/§6 实际无此记录(§0 仅写起点 SHA);首轮要求"REPORT 记录激活时序事实"未落实 |
| F-5(MINOR)pi-e2e-c 名实差 | **PARTIAL(残留)** | REPORT §2/§8 用词已准确("单任务自治闭环");但测试名"2 任务"与 `// 至少 2 个 Run` 注释未更正,denied 条件断言未在 REPORT 注明 |
| F-6(MINOR)验收 4 组合场景 | **PARTIAL → N-2** | REPORT §2 验收 4 写"t-safe 独立推进",但 grep 证实 t-safe 全测试仅创建处一次出现(goal-loop.test.ts:65),从未被 claim/推进——声明与测试事实不符 |
| F-7(MINOR)证据绑定 | **CLOSED** | REPORT §4(SHA 链)+ §8 证据索引承担绑定;两份日志文件头仍无 SHA,由 REPORT 互证替代,可接受 |
| F-8/F-9/F-10(OBSERVATION) | **MAINTAINED(部分披露)** | §6.2(token 软限:超限拒绝在下一 Run 预留时)、§6.5(D2 fallback 执行器未建模)、§6.6(handleOpenDecisions 置 NEEDS_DECISION 不经 lease 的声明)、§6.7(wall_seconds 账本仅记账)如实披露;F-8①②(startGoalLoop 吞错/run 行停留 RUNNING)、F-9①②(陈旧注释/countToolCallEvents 失真)、F-10①(DECISION_FALLBACK 审计无断言)代码未改也未入 §6——维持 OBSERVATION 留 P0-02,可接受 |
| —(正向确认) | REPORT 新增诚实披露值得记录 | §3.10:**开发期初版 E2E used=29 > 合同 8**(回合硬顶机制的起源,bootstrap 期账本尚不存在,如实披露);§6.6 多 Writer 收敛边界;§5 密钥隔离设计承接 P0-01B F-7(代理持密钥/注入面收敛/验证门四条,挂 P0-02 检查单) |

## 处置表编号对齐核对(呼应 P0-01B N-1 教训)

REPORT §4 使用"MAJOR-1/MAJOR-2/MINOR(其余)/OBSERVATION"编号而非 REVIEW F-编号,但 MAJOR-1/2 描述文本与本 REVIEW F-2/F-3 逐字对应,无 P0-01B N-1 式"引用不存在发现"错位;MINOR/OBSERVATION 行指向 REVIEW.md 本体。编号风格可接受。**但 REPORT 正文出现两处与测试事实不符的声明(见下),性质与 P0-01B N-1 同类。**

## 新发现(复验轮)

- **N-1|REPORT §1 C-3 声明"三重拒绝路径(未授权/版本过期/非法转移)各有测试"——不实(MINOR)** — `grep -rn illegal_transition test/` 零命中;非法转移拒绝路径(recoverTransition,ops.ts:61-70)无任何测试,仅未授权(:107)与版本不符(:114)两路有断言。处置提交未新增测试,该句为过度声明。另注:goal-loop.test.ts:129 测试名"resumeTask:PAUSED→READY(state_version 校验)"与用例体不符(仅断言 operatorAllowed 语义,未测 state_version)——旧有名实差,顺带记录。
- **N-2|REPORT §2 验收 4 声明"t-safe 独立推进"——不实(MINOR)** — t-safe 全测试仅一处出现(创建,:65),从未被 claim/推进至任何状态;"D3 停滞 + 其他任务独立推进"的机制由 handleOpenDecisions 代码路径 + 独立 schema 的多任务用例(c4-loop)结构性支撑,但 REPORT 引用的证据(t-safe)不存在。验收 4 组合场景仍为本轮 F-6 残留。
- **N-3|处置摘要与 REPORT 的披露缺口(MINOR)** — ①处置摘要称 REPORT 含"F-4 合同文本入库时点问题的说明",实际无;②F-5 的两处名实差(测试名/注释)未按首轮处方更正亦未声明保留。均为文字层缺口,不涉代码。

三项均不升格:代码与测试本体真实且已亲测,错位仅在报告文字;无新增代码/安全问题。

## 最终总裁决

**PASS-WITH-FIXES**

两 MAJOR(F-2/F-3)修复经代码审读 + 直接单跑 + 全量重跑三重证实:**CLOSED**;94 passed + 3 skipped + tsc 0 错误亲测复现;无断言放宽、无白名单越界、无安全语义回退。剩余全部为 MINOR 文字层缺口(N-1/N-2/N-3),不推翻任何技术结论。

**关闭条件(收尾提交一并完成,无需再动代码):**
1. REPORT 两行更正:§1 C-3 改为"三重拒绝路径中未授权/版本过期两路有测试,非法转移路径由 TRANSITIONS 表约束(测试缺口记 P0-02)"(或补一条非法转移测试);§2 验收 4 改为"D3 停滞与多任务独立推进分别由两用例证明(c3-decision/c4-loop),组合断言缺口已记录";
2. REPORT 补一句 F-4 激活时序事实 + F-5 残留(测试名/注释未改、denied 条件断言)声明;
3. 合同既定收尾:快进 push main、核验 `origin/main==HEAD`+worktree clean、更新 CURRENT.md(P0-01C 完成态)/docs/CONTINUATION.md。

上述完成即 **PASS(无保留)**,无需第三轮复核——收尾提交 diff 与 REPORT 三行文字的一致性由 Writer 自证并在 push 后由任何后续窗口按 AGENTS.md 冷启动核验。
