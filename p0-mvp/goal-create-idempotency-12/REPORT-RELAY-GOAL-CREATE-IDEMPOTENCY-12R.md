# RELAY-GOAL-CREATE-IDEMPOTENCY-12R 执行报告(项目身份原子持久冻结 + UUID 等价规范化:协调方两反例→最小修复→红绿闭环)

- 合同:`71fd58b`(CURRENT.md 唯一 ACTIVE;协调方独立终裁见 `../COORDINATOR-REVIEW-12-20261116.md`)
- 实施:提交链 `ba70fd0`(实施提交**事故**:内容缺失,见 §0)→ `20dbc07`(实施补全,权威提交;本报告随收口提交回填 CI 时序)
- 结论:合同 A~E 全部完成;执行方红轮恰 4 失败与协调方两反例逐一对应,绿轮 15/15(重建后 verify-recovery 复验),全量回归 61 passed|2 skipped,exact-head CI(`43973895996@20dbc07`)test+e2e 双 success;独立 Reviewer 终裁见 §7。

## 0. 实施提交事故与恢复(如实登记)

- **事故**:首个实施提交 `ba70fd0`(已推送)在回归污染恢复时,执行方以 `git checkout --` 批量回退"全部未暂存改动",误将**未暂存的实施代码**(api.ts/goals.ts/测试 T12~T16)一并回退——该提交只含 12R 证据文件(12 files/694 insertions 全部=证据),不含修复与测试;其提交信息对代码内容的描述失实。CI `43970812655@ba70fd0` 虽双 success,但 e2e job 计数 **58 tests ≠ 本地 63** 暴露异常(webux12 只跑旧 10 测试)——**"仅看 job 绿不计数"的教训由此固化:exact-head CI 核验必须含测试计数口径**。
- **止损与恢复**:当即停止已启动的独立 Reviewer(其审查对象为失效提交);从执行上下文逐字重建三文件(重建后 diff 与事故前同规模:goals.ts +22/api.ts +116/测试 +222,biome format 同口径);全量重验证(verify-recovery 15/15 + e2e 61|2 + quality:quick PASS)后以 `20dbc07` 补全提交(提交信息完整登记事故),推送后 CI `43973895996` 双绿且 **e2e job 61 passed|2 skipped(63)、webux12 CI 真跑 15 tests**,与本地口径逐项一致。
- **教训固化**:①回归污染恢复必须按名精确圈定,实施文件先行 `git add` 免疫;②CI 绿不等于提交内容正确——exact-head 核验必须核对测试计数/口径;③事故提交已推送不可改写(禁强推),以补全提交+本节如实留痕。

## 1. A 冷启动与现行审计(合同 A)

- 快进 `b1ca1a3`→`71fd58b`(本地==origin/main==live;合同提交 CI `43889950919` test+e2e 双 success,**推送前 GitHub check-runs API 亲核**;单 Writer:本地零领先零分叉,未解释脏工作区=无)。
- 保护物 12 项(`config/`、`soak-r3b/`、10 份 CI 回执)mtime 集合 sha256=`675d7a9a…` 记录基线;任务全程后复核一致,零触碰。
- 生产 PID `3242781/3242782`(2026-11-13 02:00:08 启动旧代码进程)前后一致;零生产读写/重启。
- Core 事实先核(读码为准,不凭前端/日志推断):
  - `src/server/views/projects.ts:41-70` `readProjectRegistry()` **无 path 唯一约束**——不同 `name/repo/branch` 注册项可指向同一 `path`(Major-P1 的注册表面真实存在);
  - `src/server/api.ts` `resolveGoalCreateReplay()` 旧重放面=raw_input 等值+GOAL_PLANNED actor+初始 Task `allowed_scope` **目录字符串**比对;响应 `project` 回显**本次请求** boundProject(归属谎报面);
  - `src/core/goals.ts` `planGoal()` 全部写操作在调用方事务;`GOAL_PLANNED` 审计 detail 此前仅 `{goalId,tasks,budget}`(**无项目身份**)——它由 `appendAudit` 在同一事务写入、表级 append-only 触发器保护,是合同 C「现有事务写入的 append-only 审计」的唯一合格载体;
  - `WEB_GOAL_CREATED` 在创建事务**外** best-effort(允许丢失)→ 不可作身份权威(合同 C 明令);
  - `GOAL_CREATE_KEY_RE` 带 `/i` 接受大小写混合 UUID,而 `goalIdForCreateKey` 对原形态 SHA-256(Minor-K1 面);
  - `workspace.js` 客户端 `crypto.randomUUID()` 本就产小写 UUID → 12R **零 web/ 改动**。

## 2. B 反例先红(合同 B;`test/e2e/webux12-goal-idempotency.test.ts` 新增 T12~T16,12 既有 T1~T9 全保留)

红轮 `RELAY_E2E=1 WEBUX12_TAG=audit-red`:**恰 4 failed | 11 passed(15)**;失败集与协调方独立反例逐一对应:

| 用例 | 反例面 | 红轮实测(修复前) | 协调方对应 |
| --- | --- | --- | --- |
| T12 同目录项目别名 | 同键同内容,projectId 换同目录别名(异 name/repo) | **200** 且 `replayProjectId="alias-same-path"`、goalId=项目 A 原 Goal(重放 A 却谎报归属 B),零新建 | Major-P1 |
| T13 UUID 等价表示 | 同一 UUID 大写表示(传输层实测原样送达大小写) | **201** 新 goalId,Goal 恰 +2 | Minor-K1 |
| T14 注册表漂移 | 同 name 注册 repo 事实变更(漂移后重放) | **200**,回显漂移后 project 元数据 | Major-P1 衍生面 |
| T15 绑定边界 | 路径恰等于默认 scope(`/workspace`)的项目,无绑定↔绑定双向 | **双向 200** 误重放(allowed_scope 巧合相等) | Major-P1 衍生面 |
| T16 旧派生格式键 | 规范化前原形态已消费键的等价表示重试 | 409(旧代码恰因 scope 缺失面拒绝)= **防回归门,红轮即绿为设计内,如实登记非红轮失败项** | 历史兼容守卫 |

- 边界空白面实测:Playwright 传输层剥 OWS(`" <uuid> "`→`<uuid>`,探针脚本实证),服务端 trim 双口径一致 → T13 空白面红绿两轮均 200 同 Goal(口径确定性验证,非红面)。
- 红证据:`12R/evidence/12r-goal-idempotency-audit-red.json`(5 步结构化事实)+ `vitest-run-audit-red.log` + `12R/screenshots/audit-red/`(3 图,T1/T1m/T7 同轮留证)。**12 已封存证据(12 包 evidence/screenshots)零触碰**:12R harness 产物独立落 `12R/` 子目录且文件名前缀 `12r-`。

## 3. C 最小修复(合同 C;3 文件,零新表/零 schema/零迁移/零新 API/零 CSS/零 web/)

- **项目身份权威=创建事务内 GOAL_PLANNED 审计冻结 `detail.project{name,path,repo,branch}`**(未绑定显式 `null`):
  - `src/core/goals.ts`:`GoalSpec.projectBinding?` 可选字段(缺省=既有调用方 `src/cli.ts` 等行为完全不变,零 Core 状态机改动);`GOAL_PLANNED` detail 追加 `project` 字段(仅显式传入时);
  - `src/server/api.ts` 创建事务:`projectBinding: boundProject ? {name,path,repo,branch} : null` 随 `planGoal` 与 Goal/Task/预算/首消息/消费映射同事务原子落库。
- **重放比对(`resolveGoalCreateReplay`)四要素**:内容(raw_input 等值)→操作者(GOAL_PLANNED actor)→**项目身份(冻结 `detail.project` 逐字段精确比对)**→初始 Task allowed_scope 兜底(纵深防御,保留):
  - `frozen=null` 仅与本次未绑定相等;审计行/`project` 字段缺失(undefined,12R 前旧事实)或形状损坏 ⇒ **不可证 ⇒ 409 fail-closed**(拒绝而非默默跳过);
  - 绝不只比目录字符串;响应 `project` 回显**冻结事实**(非本次请求元数据);
  - actor/操作者/scope 兜底逻辑保持 12 语义;23505 并发转重放路径、首消息+消费映射同事务原子性零改动。
- **UUID 规范化(Minor-K1)**:`normalizeCreateKey(raw)=raw.trim().toLowerCase()`(RFC 4122 等价语义;边界空白不入键,传输层本剥 OWS,服务端收敛单一口径),校验与派生均在规范化之后。
- **历史兼容探测**:`legacyKeyGoalId`(规范化前原形态派生,仅表示有差异时非空)已有 Goal ⇒ **409 拒绝,绝不重复创建第二个 Goal**(冻结事实按定义不可证,诚实拒绝+指引新键)。兼容风险评估(合同 B/C 要求):现行历史中键派生 Goal 仅存在于一次性测试 schema(用后即毁);生产 Goal 全部 `randomUUID` id 且生产代码早于 12 ⇒ **键派生 Goal 持久存量为零,零迁移需求,无需 STOP+USER_DECISION**;T16 以注入旧格式 Goal 行的方式实证该探测(防「只规范化不带探测 ⇒ 201 重复」的实现回归)。
- 禁令逐条:零新表/零 schema/零迁移/零新 API/零 process-local/零前端改动/不按 rawInput 去重/不 sleep 时间窗——全部不违反;11R 终态/暂停 UI、12 ACK 丢失/并发语义零推倒。

## 4. D 红绿+回归(合同 D)

- 绿轮 `RELAY_E2E=1 WEBUX12_TAG=verify`:**15/15**(T12 别名 409 `goal_create_key_conflict` 零新建零谎报;T13 大写/空白 200 同 goalId `upperReplay=true` Goal 恰+1;T14 漂移 409 回显 null;T15 双向 409;T16 旧格式 409 零新建;T1/T7/T1m ACK 丢失链与 T2/T3/T4/T5/T6/T8/T9 全绿;T9 零真实 console 错误,仅 3 条注入噪声=T1/T7 桌面 2+T1m 手机 1)。
- **绿轮首跑如实登记**:首跑 14/15——T15 测试断言笔误(`mid` 采集点在 b1 创建之前应为 before+1;红轮被 a2 翻红断言短路未触及该行),属测试面笔误非实现缺陷;当即修正重跑全绿;首跑日志入库 `vitest-run-verify-first-attempt-T15-assert-typo.log`。
- 全量回归 `npm run test:e2e`:**61 passed | 2 skipped**(2 skipped=03C/03D 显式视觉证据门,与 CI 同口径;12 原 56+新增 5)。
- `quality:quick` **PASS**(lint 0 error/format 变更集 3 文件/typecheck/unit 182/182);tsc/biome 干净。
- 回归污染处置:52 个历史跟踪证据文件(p0-02c/webux-02/03 链截图与日志)按名精确恢复(历史证据不改写;**首恢复轮因未圈定误回退实施代码=§0 事故**,补全轮实施文件先 stage 免疫+按名恢复 49 文件);可再生 ci 伪影(12R/11R/11 的 ci 截图与 JSON、test-evidence/)当轮清零;保护物 sha256 前后一致。
- 测试库残留核验(Reviewer Minor-R1 口径消化):harness 经 testdb.ts sanitize 将连字符转下划线,实际 schema 形态=`p01a_webux12_e2e_goal_idempotency_<uuid8>`(任务书连字符口径为笔误);本轮两种口径核对均 **0 残留**(自清成立)。测试库中另有 25 个**历史会话**残留 schema(p01a_c1_*/c2_*/dbg_pie2e/p02a/rev1/review_*/webux02_shots,均早于本轮),非本包产物、不在本包清理范围,如实登记不触碰。

## 5. 生产影响与边界(硬边界逐条)

- 零生产读写/DDL(`relay_console` 零触碰);零重启(PID 3242781/3242782 前后一致);零配置/密钥/迁移变更;零 egress/iptables/防火墙/公网端口;零真实模型调用;零外部 GitHub 业务交付(仅 main-only 正常 push);测试全部一次性 `p01a_` schema+合成数据,用后即毁。
- 保护物 12 项零触碰(mtime 集合 sha256 `675d7a9a…` 前后一致)。

## 6. CI 时序(exact-head 如实)

- `43970812655@ba70fd0`:双 success 但**仅证明旧代码回归**(该提交不含实施内容,§0 事故;e2e 计数 58≠63 即异常信号)。
- 权威口径:exact-head Actions **`43973895996@20dbc07` test+e2e 双 job success 一次通过**(GitHub check-runs API 亲核);test job=quality:full 483 passed|85 skipped(568)(变更集 lint/format/typecheck/unit+真 PG 集成;webux12 经 RELAY_E2E 门 15 collected|15 skipped=设计内);**e2e job 61 passed|2 skipped(63)与本地同口径,webux12 CI 真跑 15 tests(1858ms)**。回执留未跟踪循例。

## 7. 独立 Reviewer(合同 D/E)

- 终裁:**PASS(0 Major,2 Minor)**;REVIEW 原文见 `../REVIEW-RELAY-GOAL-CREATE-IDEMPOTENCY-12R.md`(独立临时克隆 detached `20dbc07` 冷启动,与执行方相互独立)。
- 独立红态复现(反向补丁 71fd58b 的 api.ts+goals.ts):恰 **4 failed|11 passed**,失败集与执行方 audit-red 逐字吻合(T12/T14/T15=200→409 翻红断言;T13=201→200;T16 绿=设计内)。
- 独立绿轮:恢复 `20dbc07` 后 **5 次全绿 15/15**;review 证据 JSON 逐步亲核(T12 409 零新建零谎报/T13 三表示同 goalId 恰+1/T14 409/T15 双向 409/T16 409 零新建/T9 零真实错误)。
- 原子冻结事实实证:GOAL_PLANNED 16 行 = 13 行显式 `project:null` + 3 行完整 `{name,path,repo,branch}`(含 ws-alias /workspace 面)。
- 事故面独立复核:`ba70fd0` 只含 12 证据文件、`ba70fd0..20dbc07` 恰 3 代码文件 +573/−32 属实;封存证据与 HEAD 零差分。
- CI 独立核验(gh):`43973895996@20dbc07` 双 success,e2e job 61 passed|2 skipped(63),webux12 CI 真跑 15 tests。
- Minor 两项(登记性,不阻断):Minor-R1=schema 残留口径连字符 vs 下划线 sanitize 形态(两种口径均核对=0;任务书口径笔误已在此消化);Minor-R2=冻结事实抽核方法学(Reviewer 克隆内环境变量门控跳过 dropSchema,仅 SELECT 抽核后手动 DROP CASCADE 并复核残留=0,已如实登记于 REVIEW)。
- 边界核验:生产 PID 前后零变;主仓唯一写入=REVIEW 文件;config/soak-r3b 零触碰;克隆与 /tmp 已清零。

## 8. 如实 NOT_RUN

- 历史兼容探测的「升级前真实旧格式 Goal 存量」在现行持久面为零(见 §3),T16 以注入行模拟该形态实证;生产升级路径的旧键重放行为未经生产数据实测(生产 NO-GO,无生产流量)。
- 全量 quality:full 本地 NOT_RUN,由隔离 CI test job 等价覆盖;2 个 skipped(03C/03D)=显式截图证据门,设计内不冒充 PASS。
- 操作者身份分支(同键异 actor 409)维持 12 的登记:e2e 单操作者环境不可构造第二操作者,由实现审查+单操作者等价性保证。
- 本包不冒充:用户 Mac UX ACCEPTED(唯一归属用户本人按 MAC-ACCEPTANCE-CARD 实机反馈)、生产 GO(预检 NO-GO 维持,D3 须用户单独批准)、真模型 F1/F2、24h Pilot。
