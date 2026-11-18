# RELAY-RESULT-TRUTH-16 · 独立 Reviewer 复核报告

**裁决:PASS**(0 Major;2 Minor 登记项见文末)

复核人:独立 Reviewer(全新上下文,与实施方零共享记忆)。复核日期:2026-11-18。基线 HEAD=32670d1(`32670d124bd7db07e36035157df65cada6ad6aae`)。全部实验在临时目录 `/tmp/rv16-tQVIQ8`(已销毁)内完成,主仓全程只读。

## §逐项核验事实

### 1. 补丁面审计 — 通过

- `git -C /home/ubuntu/dev/relay diff --cached --name-status`:恰 **10 文件**(4 src:`api.ts`/`views/changesets.ts`/`views/goal.ts`/`views/shared.ts`;3 web:`changeset.js`/`goal.js`/`workspace.js`;3 test:2 新增 + `web-journey.test.ts` 适配)。
- 自行导出暂存区补丁与实施方 `/tmp/rt16-review.patch` 比对:`diff -q` 零差异,均 2091 行。
- 逐文件通读 2091 行补丁:**无夹带**——config/、soak-r3b/、历史截图/日志/CI 回执零出现。`web/changeset.js`(+444/-114)与 `web/goal.js`(+360)的大 diff 主体确为 biome 换行重排(单行 `h(...)` 多参数调用与对象字面量改多行);biome check 10 文件退出码 0 佐证重排后文件为 biome 规范形态。功能性改动逐项对照合同 §四:①changeset.js 执行来源行 + `acceptanceBlock` 验收区;②`jump("cs-diff", true)` 修复 dead control;③delivery caveat 过期能力声明删除、改事实口径;④goal.js 时间线第 7/8 步 `cs.some(DELIVERED)` 任意轮语义 → `cs[0]` 最新轮口径;⑤workspace.js +28 行两投影字段。均在授权范围内。

### 2. 临时克隆隔离复现 — 全部独立复现

环境:`mktemp -d /tmp/rv16-XXXXXX` → 克隆主仓(HEAD=32670d1)→ 软链主仓 node_modules → `git apply /tmp/rt16-review.patch` 成功。

**绿态**:
- `npx vitest run test/integration/result-truth.test.ts`:**10 passed (10)**,1.93s。
- `RELAY_E2E=1 npx vitest run test/e2e/result-truth-browser.test.ts`:**6 passed (6)**,3.76s(真实 PG + chromium)。

**红态独立复现**(反补丁:`git checkout HEAD -- src/server/api.ts src/server/views/ web/changeset.js web/goal.js web/workspace.js`,保留新测试与 web-journey 适配):
- 集成:恰 **9 failed | 1 passed**——T1 匿名 401 仍过(T2~T7 端点 404 面、T8 `userResult` undefined、T9 `provenance` undefined、T10 败)。失败集与实施方 `evidence/red-integration.log` 逐条一致。
- 浏览器:恰 **6 failed**——V1/V3/V4/V5 30s 选择器 timeout、V2 `expected false to be true`(收起态点击后不可见)、V6 逐字复现 `expected '正在交付已完成修改已交付到仓库' to contain '交付遇到问题'`。与实施方 `evidence/red-browser-e2e.log` 逐字一致(含 V6 反例文本)。
- 附加:对被适配的 `web-journey.test.ts` J4 也做了红面——仅还原 `web/changeset.js` ⇒ J4 失败,逐字 `expected '...只表示结果被验收...' to contain '只表示内部 Gate 验收通过'`;绿态全量 web-journey **7/7**(12.7s)。适配是真翻转,非放松。
- 红态后以 `git apply --include` 恢复,终态复跑两定向套件 10/10、6/6。

### 3. 语义分离代码审计 — 通过

- **唯一产出=审计行**:端点(api.ts 补丁段)仅含 SELECT goals / SELECT candidate_changesets(只读校验)+ `db.transaction(appendAudit)` INSERT;**零** UPDATE/INSERT/DELETE 于 tasks/goals/gates/decisions;零 Run 触发路径。
- **审计失败不静默 201**:端点未用 api.ts:123-140 的 best-effort `audit()`(该助手 `.catch(()=>{})` 吞错,仅供 WEB_* 事件);事务内直接 `appendAudit`,抛错 → `handleRequest` catch → **500**(app.ts:151-155),绝无 201 可能。
- **authority=OWNER(字面量)、actor=session.role**;拒绝必附原因 1~500 字;跨 Goal changesetId 400 fail-closed;快照 delivery_state 来自该 Goal 最新变更集(无则 null)。
- views 侧 `readGoalUserResult`:纯 `SELECT ... FROM audit_events WHERE action IN (...) AND detail->>'goalId' = ... ORDER BY seq DESC LIMIT 1`,与 GOAL_PLANNED 同款读法。
- 附带核验:前端 `h()` 支持数组子节点(app.js:42-48)、`A.apiPost`/`refresh` 存在;鉴权在路由解析前(api.ts:333-341)——解释了红态 T1 匿名 401 仍过。

### 4. 边界核验 — 通过

- 复核结束主仓 `status --porcelain` 终态 **87 行 = 复核前快照**(50 未暂存 + 27 未跟踪 + 10 暂存),HEAD 未变,暂存区仍恰 10 条目。
- 生产进程 `ps -p 3242781,3242782` 存活(uptime 5 天 19 小时,`src/server/index.ts` / `src/worker-entry.ts`)。
- 测试库 `p01a_*` schema 复核后仍 25 个(= 历史基线),本次复核遗留 **0**(全部自建 schema 由测试自清)。
- 临时目录 `/tmp/rv16-tQVIQ8` 与比对用补丁已删除;主仓 node_modules(经软链只读复用)完好。

### 5. 质量门与证据卫生 — 通过

- 克隆内 `npx tsc --noEmit`:退出码 **0**。
- 克隆内 `npx biome check`(10 变更文件):退出码 **0**;15 条 warning 全部位于未变更的既有代码行(`use strict` 冗余 ×3、catch 未用变量 ×12),非本补丁引入。
- 本报告仅含固定测试口令(`result-truth-pw`/`result-truth-e2e-pw`/`rv16-reviewer-pw`);测试库连接串口令不写出;零 cookie/csrf/凭据。

## §强制反例构造细节(合同 §六,亲自构造)

构造方式:克隆内一次性 vitest 测试(真实 PG `createTestDb` 一次性 schema + 真实 Web API + chromium 真实浏览器登录;已随临时目录销毁)。最少代价路径 = **DB 夹具砍掉交付环节**:`POST /api/goals` 真实创建 Goal → 直插 task 置 **ACCEPTED**、run(`stub/stub/gm`)、candidate_changesets **delivery_state='NONE'**(有候选 commit、无交付)。验证全部走真实 UI:

1. **打开验收结果页(NONE + ACCEPTED)**:交付行=「尚未交付」;全页**零**「已提交到仓库」;首屏标题=「进行中」非「已完成」;验收区=「**内部复核已通过**」+「**用户尚未验收**」;来源行显式「演示」。
2. **点「接受结果」**:`audit_events` 出现 USER_RESULT_ACCEPTED,`detail.deliveryState == "NONE"`(接受时点真实事实)、`authority=="OWNER"`;task 仍 ACCEPTED;runs 计数前后相等(**零新 Run**);刷新后仍「已接受」。
3. **带原因拒绝**:USER_RESULT_REJECTED `detail.reason` 逐字落库、`detail.deliveryState=="NONE"`;task 仍 ACCEPTED;runs 零增;刷新后「已拒绝」+原因可见+「新建后续任务」指引在。

**append-only 实证**:同一克隆一次性探针对 USER_RESULT_* 形状行真实执行——`UPDATE` ⇒ RAISE `audit_events is append-only: UPDATE is not allowed`(行未被改);`DELETE` ⇒ 同 RAISE(行未被删);`TRUNCATE` ⇒ 语句级触发器 RAISE;行数不变。注:drizzle 包装错误消息,RAISE 原文在 `cause` 链,探针透传后断言。

## §Findings

- **Minor-1**:`biome check` 10 变更文件报 15 条 warning(`noRedundantUseStrict` ×3、`noUnusedVariables` ×12)。全部位于未变更的既有代码行,退出码 0,不阻断;登记供后续清理包参考。
- **Minor-2**:changeset 页技术区 Run 表把 outcome `SUCCEEDED` 经共享字典渲染为「已完成」badge——在交付失败场景下与结果区诚实文案并存,理论上可能被快速浏览误读。属既有行为(非本补丁引入),且位于默认折叠区;登记不改。

**结论**:红→绿双向独立复现、强制反例、append-only 实证、质量门、边界与语义分离审计全部通过,零 migration/零 schema/零生产触碰。裁决 **PASS**。
