# RELAY-RESULT-TRUTH-16 · 实施报告(结果真实性 / 用户验收闭环)

状态:实施完成,等待独立 Reviewer。合同:`p0-mvp/result-truth-16/CONTRACT.md`(ACTIVE,2026-11-18)。审计:`AUDIT.md`。

## 0. 终态摘要

- 实施提交:见收口提交 SHA(本报告随实施提交入库;CI run id 于 CURRENT/CONTINUATION 由协调方收口核验回填)。
- 变更面:**13 文件**(10 实施 + 3 包文档;实施面 4 src + 3 web + 3 test,+1474/−114,含 biome 门强制整文件格式化 ×2)。
- 本地验证:定向集成 10/10;定向浏览器 E2E 6/6;quality:full 总裁决 PASS(§4)。
- 独立 Reviewer:**PASS(0 Major;2 Minor 登记项)**——全新上下文临时克隆反向补丁红态独立复现(集成恰 9f|1p、浏览器恰 6f、V6 成功文案逐字一致、web-journey J4 红面证明适配为真翻转)+ 绿态亲跑(10/10、6/6、web-journey 7/7)+ **合同 §六 强制反例亲自构造**(task ACCEPTED + delivery_state=NONE:交付行「尚未交付」、全页零「已提交到仓库」、验收区「内部复核已通过/用户尚未验收」;接受快照 deliveryState="NONE"、拒绝零 task/Gate/Run 影响)+ append-only 触发器 UPDATE/DELETE/TRUNCATE 三面 RAISE 实证 + 语义分离审计(端点唯一产出=审计行,失败 500 绝无 201)+ 边界零触碰(主仓 87 行快照前后一致、生产 PID 存活、p01a_* 25 个基线不变)。原文:`REVIEW-RELAY-RESULT-TRUTH-16.md`。Minor-1(15 条 biome warning 均在未变更既有行)与 Minor-2(Run 表 SUCCEEDED「已完成」badge 为既有折叠区行为)登记不改。
- 生产影响=零(零生产读写/迁移/重启/配置/凭据;PID 3242781/3242782 未动)。

## 1. 独立审计结论(§二 五项;详见 AUDIT.md)

| # | 合同审计入口 | live 代码核实 | 裁决 |
| --- | --- | --- | --- |
| 1 | changeset.js 静态"尚未接入 GitHub 推送交付" | `web/changeset.js:197-199` 与 15 包内建 `buildBoundDeliveryFactory` 事实漂移 | 确认;已删,改按 proposal.target/branch + delivery_state 事实口径 |
| 2 | 结果页"成功文案先于事实"路径 | workspace.js 已按最新变更集分档;**新发现** goal.js 时间线第 7/8 步 `cs.some(DELIVERED)` 任意轮语义 | 确认;goal.js 改最新轮口径(cs[0]) |
| 3 | 用户验收写入闭环缺失 | 全仓零 USER_RESULT_*;goal.ts:497/553 已有语义分离文案;audit_events append-only 触发器 + detail->>'goalId' 先例 | 确认;audit_events 可安全承载 ⇒ **零迁移零新表**,不触发停止条件 |
| 4 | "查看修改详情"是否真实可达 | `jump("cs-diff")` 不展开 `#cs-tech`,目标在默认收起 details 内 = dead control | 确认;改为 openTech=true 并钉防回归门 |
| 5 | stub/live 来源可辨识 | runs.model_ref=provider+"/"+model(runner.ts:116)stub 恒 `stub/` 前缀;结果卡第一屏零来源标识 | 确认;服务端单一推导,结果卡显式 |

## 2. 最小实现(零 migration/零 schema/零 Core 状态机改动)

### 后端

- **`src/server/views/shared.ts`**:`deriveExecutionProvenance(runs)`——结果卡执行来源单一推导:coder run(role 缺失或 "coder",与 workspace.js 同口径)按 model_ref `stub/` 前缀分类 stub/live/mixed/none;复用既有 Run 事实,不新增第二套来源。
- **`src/server/views/goal.ts`**:`GoalUserResult{decision,at,reason,changesetId,seq}` + `readGoalUserResult(db,goalId)`(audit_events 最新一条 USER_RESULT_*,detail->>'goalId' 绑定,与 GOAL_PLANNED 同款读法);`GoalStatusView.userResult`、`GoalDetail.userResult + provenance`。
- **`src/server/views/changesets.ts`**:`ChangesetDetail.provenance + userResult`(验收结果页同源事实)。
- **`src/server/api.ts`**:`POST /api/goals/:id/result-acceptance`——decision=accept|reject;reject 必填原因(1~500 字);changesetId 可选且必须属于该 Goal(跨 Goal 400 fail-closed);写入 `USER_RESULT_ACCEPTED/USER_RESULT_REJECTED`(authority=OWNER,actor=会话角色,detail={goalId,changesetId?,reason?,deliveryState 快照})。**审计写入是端点唯一产出 ⇒ 事务内直接 appendAudit,失败即请求失败**(不用 best-effort `audit()` 吞错版)。绝不改 task/Gate 状态、绝不触发 Run、绝不派生任务;重复操作=追加同向事实(append-only,不互相覆盖)。

### 前端

- **`web/changeset.js`**:①结果摘要新增「执行来源」行(`result-provenance`;stub=演示执行(warn 徽章),live=真实模型执行,none=无执行记录);②「查看修改详情」修复为展开技术证据区(与其余三按钮同 `openTech=true`);③deliveryBlock 过期能力声明删除,改"任务 ACCEPTED 只表示内部 Gate 验收通过;「已交付」才表示已按授权写入交付目标(proposal.target[branch])";④新增用户验收区(`result-user-acceptance`):内部复核状态 + 用户验收状态徽章(`user-result-state`)/时间/原因(`user-result-reason`)/拒绝原因输入(`user-reject-reason`)/接受(`user-accept-btn`)与拒绝(`user-reject-btn`)按钮;拒绝后给"新建后续任务"明确指引,不自动改代码。
- **`web/goal.js`**:时间线第 7/8 步改**最新轮**口径(旧轮 DELIVERED 不再冒充本轮成功;最新轮 FAILED ⇒ 第 8 步"最新交付未成功",不再"全部完成")。
- **`web/workspace.js`**:工作区结果卡新增 `ws-result-provenance`(stub=演示执行显式)与 `ws-result-user-acceptance`(用户尚未验收/已接受/已拒绝+原因)两行事实(服务端 GoalDetail 单一推导,纯投影)。

### 测试(先红后绿)

- 新增 `test/integration/result-truth.test.ts`(10):T1 匿名 401 零写入/T2 接受=201+append-only 审计+重载可见+deliveryState 快照/T3 重复接受=追加历史 2 行不覆盖/T4 非法 decision 与缺原因 400 零写入/T5 拒绝原因落审计+task 状态不动+零新 Run/T6 跨 Goal changesetId 400 零写入/T7 未知 Goal 404/T8 无事实=userResult null 不猜测/T9 provenance stub/live/none/T10 goalDetail 同源。
- 新增 `test/e2e/result-truth-browser.test.ts`(6,RELAY_E2E=1 门):真实 PG+Web API+live driver 内建 seed/交付全链(stub 大脑→真实候选 commit→真实交付本地 bare 远端 DELIVERED)→真实浏览器:V1 结果页事实推导+无过期能力声明+内部通过/用户未验收分离/V2 dead-control 防回归(收起态不可见→点击后可见)/V3 接受=审计+刷新保持+零 Run/V4 拒绝原因落审计+刷新保持+task 仍 ACCEPTED+后续指引/V5 工作区结果卡同源/V6 时间线最新轮口径(路由拦截注入旧轮 DELIVERED+最新轮 FAILED,断言零旧轮成功文案)。
- 适配 `test/e2e/web-journey.test.ts` J4:原断言钉住被废止的过期能力声明(「尚未接入」),改为钉住新事实口径(「只表示内部 Gate 验收通过」+「尚未接入」零命中)——测试意图不变(交付面诚实标注),语义随合同翻转。

## 3. 红绿证据

- 红轮:集成 **9 failed | 1 passed**(端点 404/视图字段 undefined;`evidence/red-integration.log`);浏览器 E2E **6 failed**(元素缺失 timeout ×5 + V6 逐字复现 `expected '正在交付已完成修改已交付到仓库' to contain '交付遇到问题'`;`evidence/red-browser-e2e.log`)。
- 绿轮:集成 **10/10**;浏览器 E2E **6/6**;tsc 干净;biome check(10 变更文件)0 error。

## 4. quality:full(总裁决 PASS;`evidence/quality-full.log`)

- lint PASS(481ms)/ format PASS(11 变更文件含既有工作树 scripts/webux11-preview.mjs)/ typecheck PASS(10.3s)。
- unit:**191 passed / 191**(18.9s,与基线一致)。
- 全量非浏览器 [tests]:**511 passed | 99 skipped = 610**(330s)= 本地基线 501p|93s(594)+ 本包 10 个集成真跑 + 6 个新浏览器测试在非浏览器步按 RELAY_E2E 门 skip —— 逐项精确对账,零漂移。
- 浏览器 browser:**81 passed | 2 skipped = 83**(332s)= 基线 75p|2s(77)+ 本包 6 个浏览器真跑(V1~V6 含真实交付链全绿)。

## 5. 边界与影响

- 零 migration/零 schema/零新表;零生产读写/重启/配置/凭据;零真实 GitHub 外部交付(测试全部本地 bare 远端);三目录模型零重构(仅消费冻结绑定既有事实)。
- 保护面原样:config/、soak-r3b/、历史截图/日志、CI 回执零触碰;生产 PID 3242781/3242782 未变。
- 已知登记(非阻断):provenance "external worker" 形态在外部 driver 部署下与 live 同以 model_ref 呈现(workerMode 进程面见 /api/capabilities,结果卡以 Run 事实为准——合同"优先复用已有 Run/worker mode 事实");混合运行 mixed 如实标注。

## 6. 独立 Reviewer

**PASS(0 Major;2 Minor 登记项)**——裁决与全部核验事实见 `REVIEW-RELAY-RESULT-TRUTH-16.md`(原文逐字入库)。Minor-1/Minor-2 均为登记项(既有行为/非本补丁引入),不阻断收口。
