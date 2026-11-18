# RELAY-RESULT-TRUTH-16R · 实施报告(验收绑定结果版本纠偏)

状态:实施完成,等待独立 Reviewer。合同:`p0-mvp/result-truth-16/16R/CONTRACT.md`(ACTIVE,2026-11-18)。协调方 REWORK 裁决:`../COORDINATOR-REVIEW-20261118.md`(Major-1 + Minor)。

## 0. 终态摘要

- 基线:`fe8eeaf1464bc70c63c297d25e18bbc1de9e64ad`(ff-only 自 df3ff59,协调方治理提交)。
- 变更面:**16 文件**(实施 8:3 src + 2 web + 3 test;包文档 8:REPORT/REVIEW + evidence 6 份),实施面 +212/−31 级别(详见提交 stat;web 两文件为合同范围内的最小功能性 hunk,无整文件重排)。
- 独立 Reviewer:**PASS(0 Major / 0 Minor 阻塞;2 条非阻塞 Observations 登记)**——临时克隆反向补丁红态独立复现(集成恰 7f|1p、浏览器恰 2f、T1 逐字 " 用户已接受结果")+ 绿态亲跑(16R 8/8、2/2;16 原 10/10)+ **协调方原始反例经 Reviewer 自建测试独立闭合**(自建集成脚本 6/6:显式 created_at 排序控制、换代/冻结/409/单源快照/append-only UPDATE·DELETE·TRUNCATE 三面 RAISE;自建浏览器脚本 3/3:真实执行链→UI 接受 A→注入 B→B 页"尚未验收该结果"/workspace"尚未验收当前结果"/回看 A"已接受接受"+仓库交付标签)+ 语义审计(投影零 Goal 级残留、写入面唯一、排序口径四处一致)+ 边界零触碰(主仓快照前后一致、暂存恰 8 条目、PID 2/2、p01a_* 25)。原文:`REVIEW-16R.md`。Observations:①最新 changeset 判定无次级 tiebreaker(与 16 既有口径一致,留加固点);②changesetIdSource 为新增字段无兼容影响。

## 1. Major-1 红复现(修复前缺陷逐字证明)

- 集成(`evidence/red-integration.log`,7 failed | 1 passed):
  - R1:`changesetDetailView(B).userResult` = **A 的 accepted 对象**(expected {decision:'accepted',…} to be null)——B=FAILED 仍显示"用户已接受结果",协调方反例逐字复现;
  - R2:goalStatusView/goalDetailView 当前投影同样继承 A 的验收;
  - R5:A 页被 B 的验收覆盖(changesetId 显示 B);R6:A 页显示 rejected(B 的拒绝覆盖 A 历史投影);
  - R7:省略 changesetId ⇒ 审计无版本身份(漂浮验收);R8:无 changeset 竟 201(应 409);R9/R10:changesetIdSource 缺失、deliveryState 快照混用"Goal 最新"来源;
  - R4(回归门,红轮即绿如实登记):A 自身页在旧实现下恰因"Goal 最新事件=A"而显示 accepted —— 该绿非修复效果,仅钉住"回看 A"能力。
- 浏览器(`evidence/red-browser-e2e.log`,2 failed):
  - T1:B 页 `user-result-state` 逐字显示 **" 用户已接受结果"**(A 的验收冒充 B 当前事实);workspace 继承同败;
  - T2:`result-delivery` testid 不存在(旧标签硬编码"GitHub")。

## 2. 最小实现(零 migration/零 schema/零状态机/零三目录改动)

- **`src/server/views/goal.ts`**:`readChangesetUserResult(db,goalId,changesetId)`(audit_events 精确匹配 `detail->>'changesetId'`);`readLatestChangesetId`(最新 changeset,ORDER BY created_at DESC 与视图同口径);**`readGoalUserResult` 语义改为"最新 changeset 自身的验收"**——无 changeset ⇒ null;最新 changeset 无对应 USER_RESULT_* ⇒ null("用户尚未验收当前结果"),旧版本验收只在旧版本页可见。历史审计行零删除零改写。
- **`src/server/views/changesets.ts`**:changeset 详情 userResult 改按**自身 changesetId** 投影。
- **`src/server/api.ts`**(result-acceptance):
  - 显式 changesetId:属该 Goal 校验不变(400 changeset_not_in_goal);
  - 省略 changesetId:冻结到**请求时最新 changeset**,解析后的 id 与 `changesetIdSource:"resolved_latest"` 写入审计;
  - Goal 无任何 changeset:**409 result_not_available**(不产生漂浮验收);
  - deliveryState 快照恒取**被验收 changeset 本身**(单一来源,消除与"Goal 最新"两套来源混用)。
- **`web/changeset.js`**:摘要字段标签 "GitHub"→**"仓库交付"**(testid `result-github`→`result-delivery`;target/branch 仍由 proposal 事实展示);验收区 null 文案 →"用户尚未验收该结果"(验收属结果版本)。
- **`web/workspace.js`**:当前结果验收行 →"用户尚未验收当前结果/已接受当前结果/已拒绝当前结果"(最新 changeset 投影,旧验收不冒充当前)。
- 适配:`test/e2e/web-journey.test.ts` J4 selector `result-github`→`result-delivery`(断言语义不变:DELIVERED ⇒ "已提交到仓库")。

## 3. 验收矩阵对照(合同 §四 12 项)

| # | 反例 | 测试 | 结果 |
| --- | --- | --- | --- |
| 1 | A accepted → B FAILED:B.userResult=null | 16R 集成 R1 + 浏览器 T1 | 绿 |
| 2 | 同场景 Goal status/detail=null | 16R 集成 R2 | 绿 |
| 3 | workspace"尚未验收当前结果" | 16R 浏览器 T1 | 绿 |
| 4 | 回看 A 仍 accepted | 16R 集成 R4/R5/R6 + 浏览器 T1 | 绿 |
| 5 | A accepted → B accepted:当前只显 B | 16R 集成 R5 | 绿 |
| 6 | A accepted → B rejected:当前=B+原因 | 16R 集成 R6 | 绿 |
| 7 | 省略 changesetId 冻结最新+审计写解析 id | 16R 集成 R7 | 绿 |
| 8 | 无任何 changeset ⇒ 拒绝零审计 | 16R 集成 R8 | 绿 |
| 9 | 显式旧 A:历史事实保留,当前投影不变 | 16R 集成 R9 | 绿 |
| 10 | deliveryState 快照=被绑 changeset | 16R 集成 R7/R9(R10) | 绿 |
| 11 | 摘要无硬编码"GitHub" | 16R 浏览器 T2 | 绿 |
| 12 | 16 原套件/three-dirs/dirty-project/goal 幂等/web journey 不退化 | 定向 32/32 + quality:full(§4) | 绿 |

## 4. quality:full(总裁决 PASS;`evidence/quality-full.log`)

- lint PASS(494ms)/ format PASS / typecheck PASS(10.4s)。
- unit:**191/191**。
- 全量非浏览器 [tests]:**519 passed | 101 skipped = 620**(336s)= 16 本地基线 511p|99s(610)+ 本包 8 个集成真跑 + 2 个新浏览器测试门控 skip —— 逐项精确对账。
- 浏览器 browser:**83 passed | 2 skipped = 85**(334s)= 16 基线 81p|2s(83)+ 本包 2 个浏览器真跑(T1 版本化验收/T2 中性标签)。
- 合同点名定向回归(`evidence/regression-4suites.log`):three-dirs 4 + dirty-project 6 + webux12 Goal 幂等 15 + web journey 7 = **32/32 全绿**。

## 5. 边界与影响

零 migration/零 schema;零生产读写/重启/凭据;零真实外部交付;Goal/Task 状态机零改动;三目录模型零重构;保护面 75 项工作树脏文件原样;生产 PID 3242781/3242782 未动。

## 6. 独立 Reviewer

**PASS(0 Major / 0 Minor 阻塞;2 Observations 登记不改)**——原文逐字入 `REVIEW-16R.md`。协调方 REWORK Major-1 原始反例由 Reviewer 自建测试独立验证闭合(DB+API+chromium 全链)。
