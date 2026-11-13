# RELAY-SAFETY-CLOSE-02 最终报告

裁决:**PASS**(独立 Reviewer 终裁 PASS;exact-head CI 双 job success;真实 SHA/实测数据,无虚构项)
日期:2026-11-13
合同:CURRENT.md「RELAY-SAFETY-CLOSE-02 ACTIVE」(登记提交 3033c14,CI 43405022833 success)
前置收口:RELAY-QUALITY-LOCAL-01(06f9b5a)

## 1. 基线与 Writer

- 开工冷启动:live main = `06f9b5a` 与本地一致 0/0;exact-head CI 43398839610 success;工作区仅受保护未跟踪 `config/`、`p0-mvp/soak-r3b/`(全程零触碰)。
- Writer:本窗口唯一;main-only 快进推送;提交链 `06f9b5a → 3033c14(合同登记)→ d04eae5(实施)→ b7fe040(Reviewer Minor 消化)→ 收口提交(见 CURRENT.md)`。
- 生产影响:零代码部署、零生产库写入、零模型调用、零真实远端写入(github-real 写入用例全程授权门关闭)。

## 2. 独立审计与差距纠偏(P1-E,反例先行)

上包 GAP-REGISTER 两项结论与代码不符,本包推翻并留证:

- **E-1 纠偏**("已符合设计,无自动派生"为**错误**):`consumeGoalMessages` 原仅有 task 在途守卫、**无 Goal 状态守卫**;`POST /api/goals/:id/messages` 对任何未消费 USER 消息经 `planFollowUpTask` 派生 READY Task(scope/commands 继承旧 Task)。反例实证(修复前真实运行):`p0-mvp/safety-close-02/evidence/counterexample-terminal-goal-derived.log`(COMPLETED/FAILED/EXHAUSTED/PAUSED 四态全部派生)。
- **E-2 纠偏**("终态消息静默沉淀无处消费"为**错误**且方向相反):终态 Goal 消息同样被消费派生;Goal 终态后 aggregateGoals 不再聚合 ⇒ 派生任务=孤儿执行(状态机外)。
- E-3/E-4(steer/abort/takeover 零命中)、E-5/E-6/E-8 复核维持;E-7 复核维持并精确化(离线可执行确定性维护清单;NEEDS_RECONCILE 自愈缺口维持)。纠偏附录= GAP-REGISTER.md 末节(原文保留未改写)。

## 3. 修改范围(逐文件点名;d04eae5 = 21 文件 +2042/-571,b7fe040 = +5/-3)

**P0-A 消息授权与终态 Goal**
- `src/core/consumption.ts`:两级确定性 Goal 状态守卫 —— 终态/暂停 Goal + 终态后新消息(created_at >= 终态迁移时刻,Minor-1 消化)⇒ `goal_closed` 只记录不派生;消息全部先于终态迁移(在途窗口活会话补充,§0.1 冻结语义)⇒ 可审计重激活(`GOAL_ACTIVE`)后边界消费,aggregateGoals 恢复聚合、无孤儿执行;混合批次整批保守 held。
- `src/core/goals.ts`:`planFollowUpTask` 非 ACTIVE Goal fail-closed 抛错(纵深防御,直呼不可绕过)。
- `src/server/api.ts`:intake 层 held 反馈 —— 非 ACTIVE Goal 发消息 ⇒ 201 + `held:true` + `followUpTaskId:null` + RELAY 确认"已记录……请新建需求" + `GOAL_MESSAGE_HELD` 审计;ACTIVE 路径反馈词不变。
- `test/integration/goal-message-authorization.test.ts`(新增 9 用例):终态四态反例、API held 全链、ACTIVE 派生保留、边界消费重激活、混合批次、消息事实保留。
- `p0-mvp/safety-close-02/SEMANTICS-P0A.md`(新增):最小交互语义方案;**ACTIVE Goal 内消息分类(普通交流/补充反馈/明确执行请求)涉及 WEB-UX-03C §0 冻结语义 ⇒ 按合同停止条件未实施**,方案 A/B/C 与决策请求登记于 §3(本包默认维持 C)。
- e2e 旅程更新:`test/e2e/webux03-workspace.test.ts` C5(完成后继续说 ⇒ 只记录不派生)、`test/e2e/webux03-mobile.test.ts` M5(同语义);C6/M6 在途补充由边界消费路径保留(真实浏览器验证)。

**P0-B Gate 功能验证区分**
- `src/core/gates.ts`:新增 `FUNCTIONAL_EVIDENCE_KINDS = {deterministic_test, api_behavior}`(功能性;证明行为);`candidate_manifest_verify` 降格为完整性硬门(不证明行为);record/consume 双侧同规则:代码变更候选 PASS 必须含 ≥1 功能性证据,否则 `functional_evidence_missing`。
- `src/core/gate-orchestrator.ts`:预检改为功能性判定 —— 无功能性检查 ⇒ 先跑完整性硬门(失败 `candidate_manifest_verify_failed`),通过后仍保守停机 `functional_evidence_unconfigured`(Reviewer 零启动);新增 §3.5 必需检查 FAILED ⇒ `evidence_failed:<kind>` 在 Reviewer 之前停机。
- `src/core/evidence.ts`/`src/server/worker.ts`:四类证据语义注释;manifestVerify 注入保留(完整性硬门)。
- `test/integration/gate-machine-evidence.test.ts`:manifest+Reviewer 误放行用例翻转(修复前 ACCEPTED=反例,证据 `counterexample-manifest-reviewer-accepted.log`)+新增 manifest-only 直录拒绝/功能性放行/功能性失败停机,共 10 用例。
- `test/integration/cli.test.ts`:单拍 CLI 旅程夹具跟随新生产语义(无 evidenceChecks ⇒ NEEDS_DECISION + 零 Reviewer run + D3 行)。

**P0-C 本地测试环境安全**
- `test/setup/testdb.ts`:`assertAuthorizedTestDatabaseUrl`(授权三元组 loopback:55433/relayp000,任何连接/写之前同步拒绝)+ `redactDbUrl`(密码脱敏,全部错误路径)+ schema 钉死 `p01a_` 前缀(生产 relay_console 与测试共享实例仅 schema 隔离 —— 2026-11-13 只读核实)。
- `test/integration/testdb-guard.test.ts`(新增 5 用例):假生产 URL 拒绝、**可达但未授权目标**(同容器 postgres 管理库)拒绝 + pg_namespace 零 p01a_ schema 零写入机器证据、密码零打印、三元组逐项单元、默认路径放行。
- `test/integration/circuit-recovery.test.ts`:DB_URL 经守卫解析。

**P1-D 质量语义与外部副作用**
- `scripts/quality.mjs`:①release 前置拒绝继承 `RELAY_QUALITY_SKIP_BROWSER`(exit 2 fail-closed);②RELAY_DB_URL 前置校验(非授权三元组 exit 2,任何测试之前);③release 必需项 NOT_RUN ⇒ 裁决 `INCOMPLETE` + exit 1(format 例外=变更集作用域检查语义正确);④full 模式浏览器 NOT_RUN ⇒ 证据强制携带"检查完成 ≠ 发布就绪,须独立 e2e job 补足"警示;⑤`RELAY_GITHUB_REAL_E2E` 剥离(quality 管线零外部副作用)+ full/release 显式登记 `github-real-write` NOT_RUN;⑥FAILED 时 releaseReadiness 不再显示 READY。
- `test/integration/github-real.test.ts`:显式授权门 `RELAY_GITHUB_REAL_E2E=1` —— 默认(仅凭本地凭据存在)零远端写入,写入用例 skip 名称如实标注;零写入安全用例(夹具自证+凭据门事实含只读探测)保留;固定沙箱仓库与生产仓库禁入清单不变。

**P1-E**:`p0-mvp/quality-local-01/GAP-REGISTER.md` 纠偏附录(原文保留)。
**格式对齐**:被触达的历史基线文件(cli/mobile/workspace/circuit-recovery/github-real 等)由 biome 机械整文件对齐 —— 合同"仅在触达文件内对齐";未触达文件零改动(`git diff -w` 与全量 diff 文件集一致,独立 Reviewer 核实)。

## 4. 质量命令实测(阶段 F;本地 release,树脏标志如实记录)

- `quality:quick`:**PASS**(lint 0 error / format 变更集 0 差异 / typecheck / 单测)。
- `quality:release`:**PASS**(evidence=`test-evidence/quality-release-2026-11-13T10-27-58/`,gitDirty=true 已由证据字段标注):lint 0.5s / format 0.4s / typecheck 9.2s / unit 11.0s / pg PASS / tests **288 过 + 52 门控 skip**(340)/ browser **30 过 + 2 门控 skip**(32,含 C5 新语义真实浏览器验证)/ backup-restore 7.9s(13 表全实体核对一致)。
- github-real:2 过(零远端写入安全用例)+ 3 授权门 skip;`github-real-write` 显式 NOT_RUN 登记。
- 故障注入实测:quality 前置校验(RELAY_QUALITY_SKIP_BROWSER=1 → exit 2;假生产 RELAY_DB_URL → exit 2);testdb-guard 5/5;testdb-guard 可达目标零写入证明。
- NOT_RUN 显式登记:performance(无实测基线,不虚构阈值)、model-gated-e2e(RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E/pi-e2e 需独立授权)、real-deploy-verify(未授权触碰生产)、github-real-write(需显式 RELAY_GITHUB_REAL_E2E=1)。
- 有界修复记录:①CLI 夹具跟随 P0-B 生产语义(夹具缺陷非产品缺陷);②biome format 触达文件对齐;③releaseReadiness FAILED 时误显 READY(逻辑 bug,当轮修复)。

## 5. Gate 反例前后对照(P0-B)

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 代码变更 + manifest 复验通过 + Reviewer PASS(无功能性证据) | **ACCEPTED**(反例实证入库) | NEEDS_DECISION `functional_evidence_unconfigured`(完整性证据留档,Reviewer 零启动) |
| 代码变更 + 零检查 + Reviewer PASS | ACCEPTED(上包已修,本轮保持拦截) | NEEDS_DECISION `functional_evidence_unconfigured` |
| 必需功能性检查 FAILED | 仍烧 Reviewer 后 record 拒绝,任务滞留 VERIFYING | Reviewer 之前 `evidence_failed:<kind>` 保守停机(D3 行,ops 可恢复) |
| manifest 复验失败 | NEEDS_DECISION(上包语义) | 不变(完整性硬门保留) |
| docs-only / 无变更集 | 豁免保留 | 不变 |
| 直录 record(仅 manifest+reviewer 证据) | ok:true | 拒绝 `functional_evidence_missing` |

## 6. 消息授权与终态 Goal 证据(P0-A)

- 反例(修复前):四终态 + 未消费消息全部派生(日志入库);API 返回 followUpTaskId + 误导性"已形成新一轮执行"。
- 修复后:终态后新消息 ⇒ `held:true` + RELAY"已记录……请新建一个需求" + `GOAL_MESSAGE_HELD` 审计 + 零新任务零映射;在途窗口补充(§0.1 承诺)⇒ 重激活边界消费(测试钉住 GOAL_ACTIVE 审计 + 消费映射);真实浏览器 C5/M5 旅程按新语义通过(release browser 步骤)。
- 明确反馈词三态:已记录(held/in-flight)/已创建任务(ACTIVE 派生)/待确认(分类决策待用户裁决,SEMANTICS §3 方案 B)。

## 7. 数据库隔离证据(P0-C)

- 守卫三元组 = 测试容器实际形态(relay-p000-pg,127.0.0.1:55433,POSTGRES_DB=relayp000;test-db-up.sh 逐项一致)。
- 生产事实(只读核实,零凭据打印):生产 relay_console 与测试**共享同一 PG 实例**,仅 schema 隔离 ⇒ 守卫双层:URL 三元组精确匹配 + 测试 schema 钉死 `p01a_` 前缀;`relay_console` database 形 URL 被拒(测试钉住)。
- 故障注入:可达但未授权目标(postgres 管理库)拒绝后,pg_namespace 探测零 p01a_ schema = 零写入机器证据;假生产 URL(远程 host)守卫错误而非连接错误 = 拒绝发生在连接之前。
- 密码零打印:守卫与不可达错误均经 redactDbUrl(测试断言明文密码与测试凭据均不出现在错误消息)。

## 8. 提交与 CI

- 实施提交:`d04eae54253e17504217d2eaf936d7b720321512`;Minor 消化:`b7fe040`;合同登记:`3033c14`。
- exact-head CI:**run 43412391302 @ b7fe040 = success**(test job 2m14s ✓ = quality:full 除浏览器;e2e job 1m56s ✓ = 浏览器旅程;https://github.com/pwl1987/relay/actions/runs/43412391302)。合同登记 CI 43405022833 @ 3033c14 = success。
- 推送方式:main-only 快进(直连正常,未用代理);未输出任何凭据。

## 9. 独立 Reviewer(阶段 G)

- 终裁:**PASS**(0 Major,7 Minor;报告=p0-mvp/safety-close-02/REVIEW-SAFETY-CLOSE-02.md)。
- 方法:隔离上下文;亲手读码逐 hunk + grep 独立验证关键声明(updated_at 唯一更新源/INSERT INTO tasks 路径/门禁变量残留)+ 亲手复跑(tsc + biome 0 error + 6 文件 49/49)。
- 四项 REWORK 触发条件逐一排查为否(普通消息派生/manifest+Reviewer 误放行/生产 URL 写入/继承跳浏览器均不存在残留路径)。
- Minor 消化:Minor-1(时间戳 `>`→`>=` 更保守,已修 + 复验)、Minor-4(注释指针,已修);Minor-2/6/7 记录不阻断;**Minor-3 登记义务**:未来实施 Goal 级暂停的包必须把"PAUSED 不自动重激活"列为验收项;**Minor-5 登记义务**:见 §10 生产影响。

## 10. 生产影响、回滚与准入建议

- **生产运维影响(Minor-5,如实登记)**:生产 worker-entry 不传 evidenceChecks ⇒ P0-B 后生产代码变更候选将保守停机 NEEDS_DECISION(完整性复验仍执行,Reviewer 不烧)。方向=合同要求的 fail-closed;**生产恢复 Gate 放行需:为任务配置功能性机器检查,或经 ops 对 D3 行人工处置**。本包未触碰生产进程/部署(生产 worker 为旧进程,重启后才加载新语义)。
- **行为变更面(用户可见)**:终态 Goal 发消息不再自动创建任务(改为"已记录+指引新建需求");ACTIVE Goal 在途补充语义不变。
- **回滚**:整包两提交(`git revert b7fe040 d04eae5`)即回滚;Gate 行为回退到 manifest+Reviewer 可放行语义,消息派生回退到全量派生。
- **未验证项**:真实模型 E2E(门禁关闭,零模型消耗);真实远端写入验证(需 RELAY_GITHUB_REAL_E2E=1 独立授权);生产部署行为(未触碰);性能专项(无基线)。
- **下一包准入建议**:①用户裁决 ACTIVE Goal 消息分类(SEMANTICS-P0A §3 方案 A/B/C;影响 WEB-UX-03C §0 冻结语义);②"用户控制面最小实现"(E-3 abort + E-4 takeover,共享 ControlCommand 审计面;含 Minor-3 的 PAUSED 不自动重激活验收项);③生产 worker evidenceChecks 配置策略(解除 Minor-5 的保守停机运维影响);④E-7 NEEDS_RECONCILE 自愈 supervisor executor。
