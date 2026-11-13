# RELAY-SAFETY-CLOSE-02 独立 Reviewer 复核报告

- Reviewer:隔离上下文独立 Agent(未沿用开发自述,全部结论基于亲手读码与亲手复跑)
- 复核时点:2026-11-13
- 被审实施提交:`d04eae54253e17504217d2eaf936d7b720321512`(父提交=合同登记 `3033c1403403a5803a162f9e674205c5fd0c503e`,单一实施提交,21 文件 +2042/-571)
- 复核方法:`git diff 3033c14..d04eae5` 与 `git diff -w` 对照区分语义 hunk 与 biome 机械格式 hunk(两清单文件集完全一致 ⇒ 格式对齐仅发生在触达文件内,未触达文件零改动,符合合同"仅在触达文件内对齐");对全部语义变更逐 hunk 读码;关键声明(updated_at 唯一更新源、INSERT INTO tasks 路径、guard 覆盖面、残留门禁变量)全部由本人 grep 独立验证;测试亲手复跑。
- 纪律:零模型调用;未触碰 `config/` 与 `p0-mvp/soak-r3b/`;未改变 git 状态(无 commit/push/checkout);未跑 quality:release;测试复跑后核对 `git status` 无任何受跟踪文件被再生(无需 restore)。

## 一、逐项裁决表

| 项 | 裁决 | 核心依据(独立验证) |
| --- | --- | --- |
| P0-A 消息授权与终态 Goal | **PASS** | 见 §1.1~§1.5 |
| P0-B Gate 功能验证区分 | **PASS** | 见 §2.1~§2.5 |
| P0-C 测试库守卫 | **PASS** | 见 §3.1~§3.4 |
| P1-D 质量语义与外部副作用 | **PASS** | 见 §4.1~§4.4 |
| P1-E GAP-REGISTER 纠偏附录 | **PASS** | 见 §5.1~§5.2 |

### 1. P0-A:PASS

**1.1 漏洞真实、反例真实。** `counterexample-terminal-goal-derived.log` 为修复前真实运行输出:终态四态(COMPLETED/FAILED/EXHAUSTED/PAUSED)+ 未消费 USER 消息全部 `consumed=true`(测试断言 `expect(r.consumed).toBe(false)` 反向失败即漏洞实证),与 SEMANTICS-P0A §1 描述一致。本人 grep 确认:`INSERT INTO tasks` 全仓仅 `src/core/goals.ts:75`(planGoal,唯一调用方 api.ts:348 `/api/goals` 显式意图)与 `goals.ts:129`(planFollowUpTask,唯一调用方 consumption.ts:133)——修复前漏洞面与登记一致,修复后派生路径全部处于守卫之下。

**1.2 两级守卫语义确定性(逐条对照)。** consumption.ts:76-93:
- 终态/暂停 Goal + 任一待消费消息 `created_at > goals.updated_at` ⇒ 整批 `goal_closed` 只记录不派生(混合批次整批保守 held,测试 `混合批次…整批保守 held` 钉住);
- 全部待消费消息先于终态迁移 ⇒ `setGoalState(ACTIVE, reason=followup_supplement_boundary_consumption)` 可审计重激活后边界消费(测试钉住 GOAL_ACTIVE 审计 + 消费映射);
- 闭环核实:`aggregateGoals`(goal-loop.ts)只聚合 ACTIVE,重激活后补充轮执行完重新聚合回终态,无孤儿执行。

**1.3 时间戳基准本人独立验证成立。** `UPDATE goals` 全仓唯一出现 = `setGoalState`(goals.ts:159,同时写 state+updated_at);无 drizzle `update(goals)` 调用;migrations/ 与 db.ts 触发器仅覆盖 audit_events,goals 表无任何触发器;`updated_at` 仅 INSERT 时 defaultNow(仅 ACTIVE 基线,守卫只在非 ACTIVE 态读取,此时必已经过至少一次 setGoalState)。声明属实。

**1.4 API held 反馈/审计完整。** api.ts intake 非 ACTIVE ⇒ `held:true` + `followUpTaskId:null` + RELAY 确认"已记录……不会自动创建新执行任务"(不含误导性"已形成") + `GOAL_MESSAGE_HELD` 与 `WEB_GOAL_MESSAGE` 双审计 + 201 响应。测试逐项断言。竞态窗口分析:goal 在 intake 读态与消费之间 ACTIVE→终态时,消息必为"先于终态迁移"⇒ 走边界消费路径而非 goal_closed,API 响应语义无缺口。

**1.5 ACTIVE-goal 消息分类确实未实施、决策请求已登记。** api.ts/consumption.ts 无任何消息分类逻辑;SEMANTICS-P0A §3 登记方案 A/B/C 并默认 C(维持 WEB-UX-03C §0 冻结语义),符合合同停止条件,未越权实施冻结流程变更。e2e C5/M5 忠实钉住新语义(终态 follow-up ⇒ held 反馈+零新任务+零消费映射+held 审计,截图 c5/mj5-followup-terminal-held 再生);C6 保留在途 follow-up(§0.1 冻结面);ACTIVE 派生回归测试钉住拦截未扩大。

### 2. P0-B:PASS

**2.1 四类证据区分在 record/consume 双侧一致。** gates.ts 新增 `FUNCTIONAL_EVIDENCE_KINDS = {deterministic_test, api_behavior}`;recordGateVerdict(gates.ts:131-134)与 consumeGateVerdict(gates.ts:293-299)对 PASS+有候选+非 docs-only 同规则要求 ≥1 条功能性证据,否则 `functional_evidence_missing`。`candidate_manifest_verify` 保留为完整性硬门(MACHINE_EVIDENCE_KINDS 语义注释明确其降格),reviewer_output 永不充当机器证据。

**2.2 编排器预检保守停机且不烧 Reviewer。** gate-orchestrator.ts §2.5:代码变更 + 无功能性检查 ⇒ 先跑完整性硬门(失败=`candidate_manifest_verify_failed` 停机),通过后**仍然**保守停机 `functional_evidence_unconfigured`——Reviewer 零启动。§3.5:任一必需检查 FAILED ⇒ `evidence_failed:<kind>` 在 Reviewer 之前停机。测试以"零 reviewer_output 证据/零 PASS 裁决行/零 reviewer run 行"三重机器断言证明未烧 Reviewer。

**2.3 豁免面与绑定面未破坏。** docs-only 确定性规则保留(空清单 fail-closed 按代码变更);gate_required=false 对代码变更仍强制(GATE_REQUIRED_OVERRIDE 审计),docs-only/无变更集 SKIPPED 保留(审计留痕);attempt/candidateSha/requirementSha/coderRunId/Reviewer 独立性/testEnv/证据 digest 全部绑定并消费时二次校验,stale_candidate/stale_attempt 拒绝不变。

**2.4 绕过面排查(本人逐条推演):** ①直录 gate:仅 reviewer_output 或 manifest+reviewer 组合均被 record 拒绝(测试 2 例);②旧格式 PASS:consume 复验功能性,旧格式在消费时被拒 + GATE_CONSUME_REJECTED 审计;③candidateSha=null 逃逸:recordGateVerdict 在变更集存在时拒绝 null 候选(candidate_sha_mismatch),null 豁免仅覆盖无变更集纯分析(既有设计);④consume 侧全部复验(证据存在/绑定/passed/digest/种类)。未发现可达 ACCEPTED 的绕过面。`counterexample-manifest-reviewer-accepted.log` 真实记录修复前"manifest+Reviewer ⇒ ACCEPTED"路径(旧测试断言 ACCEPTED 于 18:00 通过)。

**2.5 生产影响面(如实登记,非缺陷)。** `src/worker-entry.ts` 与 `src/server/index.ts` 构造 live driver 均不传 evidenceChecks ⇒ 生产代码变更候选在 P0-B 后将保守停机 NEEDS_DECISION(完整性复验仍执行)。方向与合同"无功能证据或证据不足保守阻断"一致,属 fail-closed;运维影响须在最终报告显式登记(见 Minor-5)。

### 3. P0-C:PASS

**3.1 守卫先于任何连接/写。** `createTestDb` 首行 `assertAuthorizedTestDatabaseUrl(url)`,在 `new pg.Pool`/CREATE SCHEMA 之前同步抛错;故障注入测试以"守卫错误文本(而非 ENOTFOUND/DIAL)"证明拒绝发生在连接之前。

**3.2 授权三元组与 test-db-up.sh 一致。** scripts/test-db-up.sh:容器 relay-p000-pg、`-p 127.0.0.1:55433:5432`、POSTGRES_DB=relayp000;守卫三元组(hosts={127.0.0.1,localhost,::1}, port=55433, db=relayp000)逐项一致;quality.mjs 前置校验重复同一三元组(两层防线,exit 2 在任何测试之前)。

**3.3 redactDbUrl 覆盖面经全仓 grep 核实。** testdb.ts 全部错误路径经 redactDbUrl;守卫测试断言生产假密码与测试凭据均零打印;其余 RELAY_DB_URL 触点(worker-entry/cli/server/test helpers)均不打印 URL(helpers 仅打印"required"缺失消息;db.ts 仅打印 err.message);quality.mjs 错误消息不含 URL。共享实例事实(生产 relay_console 与测试同实例仅 schema 隔离)如实写入注释,p01a_ 前缀钉死并有守卫,`relay_console` 目标被拒绝(测试钉住)。

**3.4 故障注入真实。** REACHABLE_WRONG_DB_URL 指向同一测试容器的 postgres 管理库(真实可达),拒绝后以 `pg_namespace` 探测该库 p01a_ schema 计数=0 作为零写入机器证据。测试文件自身的 env 改动在 afterAll 恢复,无泄漏。残留面:run-loop/push-execute/run-worker/hold-worker 四个 helper 裸读 env,但仅由已过 createTestDb 守卫的测试文件启动(文件级守卫有效)——记录为观察,非缺陷。

### 4. P1-D:PASS

**4.1 release 必需项 NOT_RUN⇒INCOMPLETE。** quality.mjs:release 计划步骤(除 format)任一 NOT_RUN ⇒ verdict=INCOMPLETE + exit 1;FAILED 仍 FAILED。format NOT_RUN 例外合理:format 是变更集作用域只读检查,无变更文件时 NOT_RUN(reason=no_changed_files)语义正确且如实落证,不降低任何必需验收面。full 模式 browser NOT_RUN ⇒ 仍 PASS 但证据 JSON 强制携带 releaseReadiness 警示"必须由独立 e2e job 真实结果补足",与 CI 现状(test job SKIP_BROWSER=1 + 独立 e2e job,本人已核对 workflow)匹配并显式登记。

**4.2 release 禁继承 RELAY_QUALITY_SKIP_BROWSER。** 前置校验 `mode==="release" && SKIP_BROWSER==="1"` ⇒ exit 2 拒绝执行,发生在任何步骤之前,fail-closed 成立。

**4.3 github-real 授权门默认安全。** 写入 describe 条件 `!credential.present || !REAL_WRITE_AUTHORIZED`(RELAY_GITHUB_REAL_E2E==="1"),默认零远端写入;固定沙箱仓库 `pwl1987/relay-delivery-sandbox`,不触碰生产仓库;无授权时保留两组零写入安全用例(夹具自证+凭据门事实,含只读 /user 探测)。quality 管线 childEnv delete 循环实证剥离 RELAY_GITHUB_REAL_E2E(全量剥离清单含全部模型门变量),full/release 证据登记 `github-real-write` NOT_RUN 及原因。

**4.4 残留扫描无发现。** 全测试面 grep:模型消耗用例全部由显式 env 门(RELAY_A4_E2E/GATE/EGRESS/DISCOVERY/F1/F2/F3)控制且被 quality 剥离;git push 用例(delivery/intent-drift/backup-restore)全部指向本地 bare 夹具(零网络);api.github.com 仅 github-real.test.ts 且已被授权门覆盖。不存在"本地凭据存在即写远端/消耗模型"残留。

### 5. P1-E:PASS

**5.1 附录纠偏与代码一致。** E-1/E-2 纠偏结论与本人读码一致(见 §1.1),原文保留未改写;处置登记与 SEMANTICS-P0A §3 一致。

**5.2 E-3/E-4/E-7 复核属实。** 本人 grep:`steer/takeover/handback` 在 src/server+src/core 零命中,`abort` 仅内部 AbortController/AbortSignal(无用户入口);runner.ts:69/377-380 取消信号为内部轮询;verify-lease.ts 为验证租约非人工接管;worker.ts IDLE_PROVIDER_DOWN 三处 fail-closed;expireStaleDecisions 确定性路径存在。E-7 精确化(NEEDS_RECONCILE 不自愈)与 DEPLOY-03D 既有登记一致。

## 二、独立复跑命令与结果(本人亲手执行)

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0,PASS |
| `npx biome lint --reporter=summary src test scripts` | exit 0;0 error(63 warnings=上包登记基线,3 infos) |
| 测试库可达性 `127.0.0.1:55433` | reachable(无需拉起) |
| `npx vitest run test/integration/goal-message-authorization.test.ts test/integration/testdb-guard.test.ts test/integration/gate-machine-evidence.test.ts test/unit/goal-message-consumption.test.ts test/unit/goal-messages.test.ts test/integration/cli.test.ts` | **6 文件 49/49 全绿**:gate-machine-evidence 10/10、cli 13/13、goal-message-authorization 9/9、testdb-guard 5/5、goal-message-consumption 6/6、goal-messages 6/6 |
| `git show d04eae5 --stat` / `git log --format="%H %P" -1 d04eae5` | 单一实施提交,父=合同登记 3033c14,21 文件与被审 diff 完全一致 |
| 复跑后 `git status` | 无受跟踪文件被再生修改;未跟踪仅受保护 `config/`、`p0-mvp/soak-r3b/` 与 2 张开发侧 e2e 再生截图(见 Minor-6) |

抽查的语义 hunk 上下文正确性:consumption.ts 守卫块(置于事务内、在途守卫之前,重激活与派生同事务原子)、gate-orchestrator §2.5/§3.5(完整性与功能预检先于 Reviewer,失败证据留档)、api.ts intake held 分支(置于消费调用之前,反馈与审计成对)——上下文位置均正确,无顺序倒置。

## 三、发现列表

**Major(必须修复才能 PASS):无。**

四项 REWORK 触发条件逐一排查均为否:①普通消息仍可派生任务——无(ACTIVE Goal 派生为 WEB-UX-03C §0 冻结语义,分类决策已按合同请求用户裁决,未越权实施);②manifest+Reviewer 仍可 ACCEPTED——无(record/consume 双侧+编排预检三重关闭,反例测试钉住);③生产 URL 可写入测试——无(两层守卫+可达目标故障注入+零写入机器证明);④quality 可继承跳过浏览器——无(release exit 2 拒绝,full 显式登记)。

**Minor(须记录,不阻断):**

- **Minor-1(P0-A 时间戳等值边)**:`gm.created_at > terminalAt` 为严格大于,消息 created_at 与终态迁移 updated_at 同微秒相等时被归为"先于终态"⇒ 走重激活边界消费而非 held。intake 插入与终态迁移分属不同事务,碰撞窗口为亚毫秒级;如需绝对保守可改 `>=`(语义=相等视为终态后)。不构成可利用路径。
- **Minor-2(P0-A held 消息永久驻留)**:held 消息保持未消费 ⇒ `pendingConsumptionGoals` 每 tick 重扫这些 Goal(goal_closed 短路返回,无派生无审计刷屏,开销与 held 消息数线性且有界)。可接受的保守代价,建议在后续包考虑终态后一次性标记以停止重扫。
- **Minor-3(P0-A 未来 PAUSED 语义地雷)**:当前无任何路径把 Goal 置 PAUSED(SEMANTICS §4 已核实);若未来引入 Goal 级暂停,"先于暂停的待消费消息 ⇒ 自动重激活"会自动恢复被用户暂停的 Goal。现属防御性死代码;**未来实施 Goal 级暂停的包必须把"PAUSED 不自动重激活"列为验收项**。
- **Minor-4(P0-B 文档性小疵)**:提交信息写"gate-machine-evidence 9/9",实际该文件 10 用例(本人复跑 10/10);gate-machine-evidence.test.ts 头注第 12 行仍指向 `p0-mvp/quality-local-01/evidence/counterexample-prefix-run.log`(上包反例路径),而本包 manifest 反例现位于 safety-close-02/。均为文字级,不影响行为。
- **Minor-5(P0-B 生产运维影响须登记)**:生产 worker-entry 不传 evidenceChecks ⇒ P0-B 后生产代码变更候选一律保守停机 NEEDS_DECISION(完整性复验仍执行,永不自动批准)。方向正确且合同授权;**最终收口报告必须把"生产 Gate 放行需先配置功能性机器检查或经 ops 人工恢复"登记为运维影响与下一步准入建议**,不得留待用户自行发现。
- **Minor-6(证据打包)**:e2e 再生截图 `p0-webux-03c/screenshots/c5-followup-terminal-held.png`、`p0-webux-03d/screenshots/mj5-followup-terminal-held.png` 当前未跟踪未入库;C5/M5 的 e2e 断言已改但截图证据未随提交。收口提交时决定是否入库(沿用上包证据入库惯例)或登记为未入库原因。
- **Minor-7(P0-C helper 面,观察)**:4 个子进程 helper 裸读 RELAY_DB_URL 不再守卫;因仅由已过守卫的测试文件启动,现无暴露面。若未来允许 helper 独立运行需补守卫。

## 四、最终裁决

**PASS**

依据:五个实现面全部通过独立复核;两项反例证据真实记录修复前漏洞;关键安全声明(updated_at 唯一更新源、INSERT INTO tasks 路径封闭、守卫先于连接、授权门剥离、release NOT_RUN 语义)全部经本人 grep/读码/复跑证实;四项 REWORK 触发条件均不存在;49/49 定向测试 + tsc + biome(0 error)亲测全绿;零模型消耗、受保护目录零触碰、git 状态零变更。7 项 Minor 全部不阻断,其中 Minor-3/Minor-5 为后续包/收口报告的登记义务(非本实施缺陷)。

Reviewer 边界声明:本裁决基于本工作树 d04eae5 的静态读码与本地测试复跑;未执行 quality:release(避免再生证据文件)、未触碰生产实例、未验证 CI(exact-head CI 以推送后实际运行为权威终验,收口时须核对)。
