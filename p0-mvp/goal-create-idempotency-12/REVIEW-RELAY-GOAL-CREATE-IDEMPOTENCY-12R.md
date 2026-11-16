# REVIEW — RELAY-GOAL-CREATE-IDEMPOTENCY-12R 独立终裁

- Reviewer:独立冷启动上下文(与执行方相互独立,未读取执行方对话)
- 审查对象:实施提交 `20dbc07a39c458608cb2f700ed070c15202bc4e9`(含事故 ba70fd0 面独立复核)
- 合同:`71fd58b`(协调方两反例:Major-P1 同键同内容跨项目身份误重放;Minor-K1 同一 UUID 大小写两表示 201/201 双创建)
- 终裁日期:2026-11-17(VM80)
- 生产影响:零(全程仅 SELECT 级核对;未触碰生产进程、配置、egress、模型)

---

## 一、终裁结论

**PASS**(0 Major,2 Minor)。

合同唯一交付已达成并经独立反向验证:同一 UUID 请求键的所有合法等价表示 = 一个持久创建意图;同键同内容/操作者/**原项目身份**(创建事务内 GOAL_PLANNED 审计冻结的 `detail.project{name,path,repo,branch}`,不只目录字符串)⇒ 200 幂等重放;同键异项目身份 ⇒ 409 fail-closed 零新建;UUID 规范化(trim+lowercase)+ 旧派生格式历史兼容探测(命中 409,绝不重复创建第二个 Goal);12 的 T1~T9 行为与 11R UI 全保留(零 web/ 改动)。零新表/零迁移/零新 API 成立。

## 二、克隆与 SHA

- 临时隔离克隆:`git clone --no-checkout --shared /home/ubuntu/dev/relay /tmp/relay-12r-review2-1794869863`,`git checkout --detach 20dbc07a39c458608cb2f700ed070c15202bc4e9`,`node_modules` 符号链接至主仓。
- 亲核 `git rev-parse HEAD` == `20dbc07a39c458608cb2f700ed070c15202bc4e9`。
- 全部读码、红绿轮、证据核对均在克隆内完成;review/review-red 产物落克隆内 `p0-mvp/goal-create-idempotency-12/12R/`,随克隆销毁。

## 三、事故面独立复核

- `git show ba70fd0 --stat`:恰 12 个文件、694 insertions,**全部**位于 `p0-mvp/goal-create-idempotency-12/12R/evidence|screenshots`(audit-red/verify 两组 JSON+运行日志+3 图、T15 首跑笔误日志、e2e 全量回归日志),零 `src/`、零 `test/` —— "ba70fd0 只含证据不含代码"属实。
- `git diff --stat ba70fd0..20dbc07`:恰 3 个代码文件(`src/core/goals.ts` 22 行、`src/server/api.ts` 116 行、`test/e2e/webux12-goal-idempotency.test.ts` 222 行)+ 5 个 verify-recovery 证据文件(JSON/日志/3 图);shortstat **+573/−32** 与实施声明逐字一致。
- 结论:20dbc07 是对 ba70fd0 事故(实施改动被误回退)的完整代码补全,差分面与"从执行上下文逐字重建三文件"声明吻合;主仓已封存的 audit-red/verify/verify-recovery 证据本轮复核与 HEAD 零差分(`git diff HEAD -- p0-mvp/goal-create-idempotency-12/` 为空),零改写。

## 四、实现逐项亲核(读码)

| # | 声明 | 亲核结果 |
|---|------|----------|
| ① | projectBinding 冻结在创建事务内 | ✅ `api.ts:528` `deps.db.transaction` 内 `planGoal(tx,…)`(api.ts:529)传入 `projectBinding`(绑定四字段对象或显式 `null`,api.ts:544-551);`goals.ts:104-115` 同一 `exec`(=调用方事务)经 `appendAudit` 写 `GOAL_PLANNED` `detail.project`(`projectBinding !== undefined` 才写,缺省调用方不写字段)。Goal 行/预算行/Task 行/首消息/消费映射/该审计全部同事务,原子可见 |
| ② | 比对面 = raw_input→actor→冻结 projectBinding→scope 兜底保留 | ✅ `resolveGoalCreateReplay`(api.ts:241-317):legacy 探测(250-258)→ `raw_input` 不一致 409(259-262)→ GOAL_PLANNED `actor` 不一致 409(263-267)→ 冻结 `detail.project` 经 `projectBindingEqual`(211-220):`frozen===null` 仅匹配本次未绑定;`undefined`(12R 前旧事实)/形状损坏 ⇒ false ⇒ 409(268-275),fail-closed → 初始 Task scope 兜底比对保留(276-295,纵深防御) |
| ③ | 响应 project 回显冻结事实 | ✅ api.ts:300-316:`project` 取自 `frozenProject`(isProjectBindingShape 通过才回显四字段,否则 null),非本次请求元数据;`idempotentReplay:true`、200 |
| ④ | normalizeCreateKey 先于正则校验与派生 | ✅ api.ts:501-506:`originalKey=raw.trim()` → `createKey=normalizeCreateKey(originalKey)`(trim+lowercase,184-186)→ `GOAL_CREATE_KEY_RE.test(createKey)` 400 门 → `goalIdForCreateKey(createKey)` 派生。校验与派生同用规范化形态 |
| ⑤ | legacyKeyGoalId 仅表示有差异时非空、命中 409 | ✅ api.ts:508:`originalKey && createKey !== originalKey` 才派生(仅大小写差异;空白两侧同 trim);api.ts:250-258:旧格式键已有 Goal ⇒ 409 `goal_create_key_conflict`,绝不创建第二个 Goal |
| ⑥ | 零新表/零迁移/零新 API/零 web 改动 | ✅ `git diff --name-status ba70fd0..20dbc07`:仅 3 代码文件(M)+5 证据文件(A);diff 内无 CREATE/ALTER TABLE/迁移;无新路由(仍是 POST /api/goals);`web/` 零触碰 |
| ⑦ | T12~T16 翻红断言与实现严格对应 | ✅ 逐条读断言:T12 期望 `r2.status===409`+`goal_create_key_conflict`+零新建+原 Goal ACTIVE(707-742);T13 期望大小写/空白均 200 同 goalId+`idempotentReplay===true`+恰 +1(744-778);T14 漂移后 409 零新建(780-806);T15 无绑定↔绑定双向 409、恰 +1/+2(808-847);T16 旧格式键 409 零新建(849-879),并如实注明"红轮即绿=防回归门,非红轮失败项" |

附带核对:`planGoal` 全仓仅两调用方 —— `api.ts`(显式传 binding/null)与 `cli.ts:137`(不传,行为不变),Core 状态机零改动。

## 五、独立红态复现(反向补丁)

- 方法:克隆内 `git checkout 71fd58b -- src/server/api.ts src/core/goals.ts`(diff --stat 确认 -115/+23 反向生效),`RELAY_E2E=1 WEBUX12_TAG=review-red npx vitest run test/e2e/webux12-goal-idempotency.test.ts`。
- 结果:**恰 4 failed | 11 passed (15)**,失败集与任务规格逐字一致:
  1. T12 同目录项目别名 —— `AssertionError: expected 200 to be 409`(旧代码同键同内容异项目身份误重放)
  2. T13 UUID 等价表示 —— `AssertionError: expected 201 to be 200`(大写表示派生另一主键,201 双创建)
  3. T14 注册表漂移 —— `expected 200 to be 409`
  4. T15 绑定边界 —— `expected 200 to be 409`(a2 断言处短路)
  - T16 通过(防回归门,设计内);T1~T9 既有 11 项全过。
- 本轮 review-red 证据 JSON(克隆内)逐字复现两反例行为:T12 `status2=200` 且 `replayProjectId="alias-same-path"`(重放 A 的 Goal 谎报归属 B,同 goalId 零新建);T13 `status2=201`、`upperGoalId` 异于 `goalId`、Goal 数 +2;T14 200 且回显漂移后注册事实(repo=moved-repo.example);T15 双向 200。
- 与主仓封存的执行方红轮证据交叉核对:`vitest-run-audit-red.log` = `4 failed | 11 passed (15)`;`12r-goal-idempotency-audit-red.json` T12/T13 行为与我本轮复现一致(数值不同属独立运行预期)。

## 六、独立绿轮

- 恢复:`git checkout 20dbc07… -- src/server/api.ts src/core/goals.ts`,`git diff HEAD -- src/` 零差分后运行。
- 结果:**5 轮绿全部 15/15、exit 0**(TAG=review 共 5 次独立运行,含第 5 次保留 schema 的抽核轮;末轮 `Tests 15 passed (15)`)。
- review 证据 JSON 亲核(我本轮自己产出):
  - T12:`status2=409`、`err2=goal_create_key_conflict`、`after=before+1` 零新建、`replayGoalId/replayProjectId` 为空(**零谎报**);
  - T13:`status2=200`、`status3=200`、三表示同 goalId、`upperReplay=true`、`after=before+1` **恰 +1**;
  - T14:`status2=409`、`replayProject=null`(不按漂移后事实谎报);
  - T15:`a2=409`、`b2=409` **双向拒绝**,计数恰 +1/+2;
  - T16:`409 goal_create_key_conflict`、`after=before+1` 零新建;
  - T9:`desktopReal=0`、`mobileReal=0`(**零真实 console 错误**),注入噪声 desktop 2/mobile 1 与注入次数精确对账。

## 七、原子冻结事实抽核(绿轮后、schema 清理前,仅 SELECT)

- 方法学说明(如实登记):harness 在末次 GOAL_PLANNED 落库后约 100ms 内即 DROP schema(外部轮询三次未及窗口),故抽核轮在 **Reviewer 克隆内**以环境变量门控(`RELAY_REVIEW_KEEP_SCHEMA=1`)跳过 `testdb.ts cleanup()` 的 dropSchema,**测试断言零改动**,绿轮 15/15 后对存活 schema 仅 SELECT 抽核,随后手动 `DROP SCHEMA … CASCADE` 并复核残留=0。
- schema:`p01a_webux12_e2e_goal_idempotency_cfc5eb08`
- `SELECT detail->'project' FROM …audit_events WHERE action='GOAL_PLANNED' ORDER BY seq LIMIT 3` → `null / null / null`(未绑定显式 null)
- `SELECT DISTINCT detail->'project' …` → 三值:
  - `null`
  - `{"name":"p-alpha","path":"/tmp/webux12-proj-1Wfpua","repo":null,"branch":null}`
  - `{"name":"ws-alias","path":"/workspace","repo":null,"branch":null}`
- 聚合核对:GOAL_PLANNED 共 **16** 行;13 行 project=显式 JSON null(未绑定),3 行为绑定对象且 `name/path/repo/branch` 四字段齐全 —— 与实现(api 调用点恒显式传 binding/null)一致,冻结事实原子可证。

## 八、CI 独立核验

- `gh api repos/pwl1987/relay/commits/20dbc07a39c458608cb2f700ed070c15202bc4e9/check-runs`:`e2e=success`、`test=success`(**双 success**)。
- `gh run view 43973895996 --json headSha`:headSha == `20dbc07a39c458608cb2f700ed070c15202bc4e9`,conclusion=success。
- e2e job 日志:`Tests 61 passed | 2 skipped (63)`(2 skipped=03C/03D 显式证据门,与本地全量口径一致);`webux12-goal-idempotency.test.ts (15 tests) 1858ms` —— webux12 在 CI 宿主**真跑 15 项**,非跳过。
- test job:quality:full lint/format/typecheck/单测 182 passed、真 PG 集成 75 passed|17 skipped(92) 等与声明同口径。

## 九、边界与残留

- 生产进程:`ps -o pid,lstart -p 3242781 3242782` 审查前后均为 `Fri Nov 13 02:00:08 2026`,**一致,零触碰**。
- 主仓工作区:全程只读;审查结束时 `git status --porcelain` 与基线一致(既有 `MAC-ACCEPTANCE-CARD.md` 一处已登记修改 + 既有未跟踪循例物),本 REVIEW 文件为唯一新增写入。未 push、未 commit 主仓。
- 保护物:未读取/未修改 `config/`、`p0-mvp/soak-r3b/`;未调用真实模型;测试全走确定性 stub 与一次性合成栈。
- 测试 PG 残留:`p01a_webux12_e2e_goal_idempotency%` 与 `p01a_webux12-e2e-goal-idempotency%` 两种口径均 = **0**(抽核 schema 已手动 DROP CASCADE,19 对象随删)。
- 清理:临时克隆 `/tmp/relay-12r-review2-1794869863` 及 `/tmp/12r-review2-*` 临时文件已全部删除(亲核不存在)。

## 十、发现项

**Major:无。**

**Minor(均为登记性/方法学措辞,不涉及实施缺陷,不阻塞收口):**

- **Minor-R1(schema 残留核对口径)**:任务简报"环境事实"中的残留核对口径写作连字符形态 `p01a_webux12-e2e-goal-idempotency*`,而 harness 实际生成的 schema 名为下划线形态 `p01a_webux12_e2e_goal_idempotency_<uuid8>`(`testdb.ts` sanitize 将非 `[a-z0-9]` 折叠为 `_`)。仅按简报字面口径核对会得到恒 0 的空真结论。本轮已按两种口径分别核对均为 0,无实际残留;建议后续任务书按实际 sanitize 形态书写口径。
- **Minor-R2(冻结事实抽核方法学)**:因 harness 清理窗口(~100ms)短于外部轮询周期,抽核轮在 Reviewer 克隆内以环境变量门控跳过 schema drop(测试断言零改动、被测代码与正式绿轮完全一致),抽核后手动 DROP 并复核残留=0。方法学偏离如实登记,不影响红绿结论。

## 十一、终裁

`20dbc07a39c458608cb2f700ed070c15202bc4e9` 达成合同 `71fd58b` 唯一交付:

1. **独立红态**反向补丁复现恰 4 failed|11 passed,失败集(T12/T14/T15=200 应 409;T13=201 应 200)与协调方两反例逐字对应;
2. **独立绿轮** 15/15(5 次),T12 409 零新建零谎报、T13 等价表示同 goalId 恰 +1、T14/T15 409、T16 旧格式 409 零新建、T9 零真实错误;
3. **原子冻结事实** GOAL_PLANNED `detail.project` 落库实证(13 null + 3 全四字段绑定对象);
4. **CI** exact-head 双 success、e2e 61|2(63)、webux12 CI 真跑 15 项;
5. **边界**生产 PID/主仓/保护物/测试库零触碰,残留=0,克隆与临时文件清零。

事故面(ba70fd0 仅证据、20dbc07 恰 3 代码文件 +573/−32)独立复核属实,事故登记与处置(发现、停止、重建、全量重验证)如实且完整。

**终裁:PASS(0 Major,2 Minor)。** 本 Reviewer 的 DONE 亦非验收,后续仍以用户本人动作与独立复核为准。

---
(REVIEW 原文由 RELAY-GOAL-CREATE-IDEMPOTENCY-12R 独立 Reviewer 撰写;review/review-red 轮产物留存于临时克隆内,已随克隆销毁;主仓封存证据零改写。)
