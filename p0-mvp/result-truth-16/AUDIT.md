# RELAY-RESULT-TRUTH-16 · 独立审计(live 代码逐项核实)

日期:2026-11-18;基线:`32670d124bd7db07e36035157df65cada6ad6aae`(ff-only 自 b50ba29);生产 PID 3242781/3242782 未变;保护面(config/、soak-r3b/、74 项工作树脏文件)原样。

## 合同 §二 五项核实结论(全部经 live 代码确认,非照单采信)

### 1. 静态能力声明漂移 —— 确认

`web/changeset.js:197-199` deliveryBlock caveat:「当前 Console 部署尚未接入 GitHub 推送交付(将在 REAL-PILOT 阶段接入)…」。15 包后内建 `buildBoundDeliveryFactory`(src/server/project-binding.ts:262)已按冻结绑定 repo@branch 交付:凭据在场即真实推送远端(含 GitHub),本地 bare=演练远端。该静态句为**过期能力声明**,必须删除,改为按 proposal/delivery 事实推导的口径文案(「任务 ACCEPTED 只表示内部复核通过;『已交付』才表示已按授权写入目标仓库」语义保留)。

### 2. 成功文案先于事实路径 —— 确认一处(workspace.js 已修,goal.js 漏改)

- workspace.js `deriveWork`(151-272 行)已按**最新变更集**(`csList[0]`,13 包 Reviewer Minor-2 口径)分档:NONE→「交付未完成」/FAILED·CONFLICT→「交付未成功」/DELIVERED→「已交付到仓库」,事实推导正确。
- **新发现**:`web/goal.js:86,88,91` 时间线第 7/8 步用 `cs.some(DELIVERED)` **任意轮语义**:旧轮 DELIVERED + 最新轮 FAILED ⇒ 第 7 步显示「passed 修改已交付到仓库」、第 8 步显示「全部完成,可到『验收结果』查看」= 与最新轮事实相反的成功文案(与 workspace 同类缺陷,goal 页漏改)。修复=对齐最新轮口径。

### 3. 用户验收写入闭环缺失;audit_events 载体审计 —— 可安全承载(不触发停止条件)

- 全仓零 `USER_RESULT_*`;语义分离文案已存在(`src/server/views/goal.ts:497-498,553`「任务 ACCEPTED ≠ Goal 已被用户验收」),但无任何用户验收事实写入/展示。
- **audit_events 可安全承载用户验收事实**:①append-only 三重守卫(`src/core/db.ts:43-59`:UPDATE/DELETE/TRUNCATE 全 RAISE EXCEPTION);②列齐备:seq/ts/actor/authority/action/task_id/detail(jsonb);③绑定 Goal 的先例即 `GOAL_PLANNED.detail->>'goalId'`(12R 冻结绑定读法,project-binding.ts:43);④`appendAudit` 助手现成(src/core/audit.ts:20)。零新表/零迁移/零 schema 变更即可落地。
- **关键差异**:WEB_* 事件经 api.ts:125 `audit()` 写,失败被 `.catch(()=>{})` 吞(best-effort 副作用);USER_RESULT_* 事件是端点的**唯一产出**,审计失败必须令请求失败(事务内直接 appendAudit,不用 swallow 版)。

### 4. 「查看修改详情」dead control —— 确认

`web/changeset.html:37-47`:`#cs-diff` 位于默认收起的 `<details id="cs-tech">` 内部;`web/changeset.js:58` 「查看修改详情」`jump("cs-diff")` 不传 `openTech`(其余三按钮均传 `true`)⇒ 点击后 scrollIntoView 作用于不可见元素,**无任何可见效果**。修复=同其余按钮展开技术证据区。

### 5. stub/live 来源辨识缺口 —— 确认

- 来源事实已在库:`runs.model_ref = provider + "/" + model`(`src/runtime/runner.ts:116`)——stub 执行 provider=「stub」⇒ model_ref 恒以 `stub/` 前缀;`runs.sandbox` 列记录沙箱形态。
- 展示面:goal.js/changeset.js **技术区**(默认折叠)已显示 `modelRef · sandbox`;goal.js hero 有小字「模型 <ref>」。但**结果卡第一屏**(changeset.js summaryBlock)与**工作区结果卡**(workspace.js ws-result-card)**零来源标识**——用户在结果卡上无法分辨桩演示与真实模型执行。合同要求结果卡可辨识 ⇒ 需在结果卡面增加事实推导的来源行(不新增第二套来源,复用 runs.model_ref)。

## 审计裁决

五项全部属实;修复全部可在**零 migration/零 schema/零生产**内完成;audit_events 承载用户验收安全可行。**不触发合同 §七任何停止条件,继续执行。**

## 最小实现设计(随后续 red→green 验证)

- 后端:`readGoalUserResult(db, goalId)`(views/goal.ts;读最新 USER_RESULT_* 审计行)→ `goalStatusView.userResult` / `goalDetailView.userResult` / `changesetDetailView.userResult`;`POST /api/goals/:id/result-acceptance`(decision=accept|reject;reject 必填原因≤500 字;changesetId 可选、须属该 Goal;事务内 appendAudit authority=OWNER;审计失败=请求失败;绝不改 task/Gate 状态、绝不触发 Run)。
- 前端:changeset.js(stale 文案删除+事实口径;dead button 修复;结果卡来源行;用户验收卡=当前事实+接受/拒绝按钮+拒绝原因输入);goal.js(时间线最新轮口径);workspace.js(结果卡来源行+验收状态事实行)。
