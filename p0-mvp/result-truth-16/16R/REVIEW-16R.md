# RELAY-RESULT-TRUTH-16R · 独立 Reviewer 复核裁决

**裁决:PASS**(零 Major、零 Minor 阻塞;2 条非阻塞 Observations 见 Findings)

Reviewer 声明:全新上下文,与实施方零共享记忆;主仓全程只读;全部实验在 `mktemp -d /tmp/rv16r-XXXX` 临时克隆进行并于结束前自清;零 push、零 commit、零生产连接、零 PID 触碰。

## §逐项核验事实

**1. 补丁面审计** — 做了: `git -C /home/ubuntu/dev/relay diff --cached --name-status`(恰 8 条:3 src + 2 web + 3 test,含 2 个新增测试文件);`git diff --cached` 全量导出与 `/tmp/r16r-review.patch` 做 `diff -q` 比对;逐行通读 729 行补丁。看到: 补丁与暂存区**逐字节一致**;`web/changeset.js` 功能性 diff 仅 2 处 hunk(标签 "GitHub"→"仓库交付"、testid `result-github`→`result-delivery`、null 文案→"用户尚未验收该结果"),`web/workspace.js` 仅 1 处 hunk(验收文案版本化),无大面积无关重排;`src/server/api.ts` 限于 result-acceptance 端点;`goal.ts`/`changesets.ts` 限于验收投影函数;无 `config/`、`soak-r3b/`、截图日志夹带。

**2. 临时克隆隔离** — 做了: `git clone /home/ubuntu/dev/relay /tmp/rv16r-Fbsd/clone`(HEAD=fe8eeaf1464bc70c63c297d25e18bbc1de9e64ad)→ `ln -s /home/ubuntu/dev/relay/node_modules clone/node_modules` → `git apply /tmp/r16r-review.patch`。看到: apply 成功无 reject。

**3. 绿态** — 计数逐字记录:
- `npx vitest run test/integration/result-truth-16r.test.ts` → **8 passed (8)**
- `RELAY_E2E=1 npx vitest run test/e2e/result-truth-16r-browser.test.ts` → **2 passed (2)**
- `npx vitest run test/integration/result-truth.test.ts` → **10 passed (10)**(16 原套件不退化)

**4. 红态独立复现** — 做了: 克隆内 `git checkout HEAD -- src/server/api.ts src/server/views/goal.ts src/server/views/changesets.ts web/changeset.js web/workspace.js`(保留全部新测试),复跑两套件。看到:
- 16R 集成:**恰 7 failed | 1 passed (8)**;唯一绿的是 R4 回归门(红轮即绿,与实施方登记一致);失败集 R1/R2/R5/R6/R7/R8/R9 与 `evidence/red-integration.log` 完全一致。
- 16R 浏览器:**恰 2 failed (2)**;T1 断言失败逐字 `expected ' 用户已接受结果' to contain '尚未验收'`——B 页显示 A 的"已接受结果",与协调方反例及 `evidence/red-browser-e2e.log` 逐字一致;T2 因 `result-delivery` testid 不存在超时 30s 失败。
- 完毕后以 `git apply --include=<5 文件>` 重放补丁恢复绿态,复跑确认 8/8。

**5. 协调方原始反例闭合验证** — 见下节(我亲自构造,非复用实施方代码)。

**6. 语义审计** — 做了: 全库 grep + 通读克隆内最终实现。看到:
- 投影零 Goal 级残留:全库仅 3 个读取方——`changesets.ts:311` 用 `readChangesetUserResult(db, goalId, changeset.id)`(自身版本精确匹配 `detail->>'changesetId'`);`goal.ts:416`(goalStatusView)与 `goal.ts:853`(goalDetailView)用 `readGoalUserResult` → 先 `readLatestChangesetId`(无 changeset ⇒ null)再按该版本读;历史无 changesetId 的漂浮审计行匹配不到任何版本,不投影。
- 唯一写入面 = `src/server/api.ts:893`(result-acceptance);16R 起审计 detail 恒含 `changesetId` + `changesetIdSource`("request"|"resolved_latest")+ `deliveryState`(恒取被绑 changeset 本身,R9 场景实证快照=DELIVERED 而非最新 B 的 FAILED)。
- 接受/拒绝零副作用:我的 S1 场景对 accept 前后 tasks/runs/task_gate_verdicts 三表行做快照 `toEqual` 比对,零变更。
- "最新 changeset" 排序口径四处一致:goal.ts:219(时间线)、changesets.ts:326(列表)、goal.ts:747、api.ts:884 均 `ORDER BY created_at DESC`。
- append-only 触发器实测:我的 S6 在测试 schema 内对 `USER_RESULT_ACCEPTED` 行执行 UPDATE / DELETE / TRUNCATE,三者**均 RAISE `audit_events is append-only`**(经原始 pg 连接断言错误消息)。

**7. 质量门** — 克隆内:`npx tsc --noEmit` 退出码 **0**;`npx biome check <8 变更文件>` 退出码 **0**(14 条 warning;在主仓 HEAD 内容上同命令复跑同样 14 条,即**全部既有、补丁零新增**)。

**8. 边界终核** — 开工/收工 `git status --porcelain` 快照 `diff` **完全一致**(85 行,含既有 75 项保护面脏文件原样);暂存区仍恰 **8** 条目;PID 3242781/3242782 存活(2/2);relayp000 库 `p01a_*` schema 收工计数 **25**(=开工基线,我全部测试 schema 由 createTestDb 自建自清);临时目录与快照文件已删除(`/tmp/rv16r-*` 余 0)。

**9. 证据卫生** — 对 `16R/evidence/*.log` 与 REPORT-16R.md 扫描 set-cookie/csrf 值/连接串口令/私钥样式:零命中;唯二凭据样式是仓库自身 backup fail-closed 校验器输出的已脱敏 `postgres:***`;测试固定口令(如 result-truth-16r-pw)属允许项。

## §协调方反例闭合验证细节(全部亲自构造)

**A. 集成面(自建脚本 A,真实 PG schema + Web API,6/6 passed)** — 我自写 `zz-rv16r-review-a.test.ts`(不复制实施方测试;显式 created_at 控制排序、不同 ID/sha/tag):同 Goal 先插 A(DELIVERED,60 分钟前)→ API 显式 accept A(断言 201、审计恰 1 条、detail `{changesetId:A, changesetIdSource:"request", deliveryState:"DELIVERED"}`)→ 后插 B(FAILED,5 分钟前)→ 断言:`changesetDetailView(db,B).userResult === null`(反例核心:修复前此处=A 的 accepted)、`goalStatusView/goalDetailView.userResult === null`、`changesetDetailView(db,A).userResult.decision==="accepted"` 且 `changesetId===A`。附加:S2 换代(B accepted→当前=B 的 changesetId;再 reject B+原因→当前=rejected+原因+changesetId=B,且审计 3 条 append-only 并存、每条含 changesetId,A 页恒 accepted);S3=R7(省略 changesetId ⇒ 冻结最新,审计 `changesetIdSource:"resolved_latest"`);S4=R8(零 changeset ⇒ accept 与 reject 均 409 `result_not_available`,审计零新增);S5=R9/R10(显式旧 A ⇒ source="request"、快照=DELIVERED 而非最新 B 的 FAILED、当前投影仍 null);S6(跨 Goal 绑定 400 `changeset_not_in_goal` + append-only 三类触发器 RAISE)。

**B. 浏览器面(自建脚本 B,全真实链 + chromium,3/3 passed)** — 我自写 `zz-rv16r-review-b.test.ts`:一次性 PG schema + 一次性 bare 远端 + 合成项目注册表 + stub 大脑 live driver,真实执行链产出 changeset A=DELIVERED → chromium 真浏览器登录并**点击"接受结果"按钮**(UI 写入面显式 changesetId,已核实 changeset.js 载荷)→ DB 注入 B(FAILED,created_at 晚于 A)→ 断言:B 页 `user-result-state` 含"尚未验收该结果"且不含"已接受结果"、页面不含"已提交到仓库"与"GitHub";workspace `ws-result-user-acceptance` 含"尚未验收当前结果"且不含"已接受";回看 A 页含"已接受结果"、`result-delivery` 标签含"仓库交付"与"已提交到仓库"。

协调方 REWORK Major-1 的原始反例(A accepted → 新 B FAILED 曾错误显示"用户已接受结果")在红态被逐字复现,在绿态经我独立构造的 DB+API+chromium 全链验证**已闭合**。

## §Findings

1. **(Observation,非阻塞)** "最新 changeset" 判定(`ORDER BY created_at DESC LIMIT 1`)无次级 tiebreaker;同微秒双写时理论上取序不定。四处口径一致且与 16 既有列表/时间线同款,真实链每 attempt 串行落库,风险极低;不构成本包 REWORK 事由,留作未来加固点。
2. **(Observation,非阻塞)** 16R 起 API 响应与审计新增 `changesetIdSource` 字段;既有消费方(web UI)不读该字段,无兼容性影响;历史无 changesetId 审计行按设计不再投影(仅历史追溯),语义符合合同 §二。
3. 未独立复跑 quality:full 全量(非浏览器 620 + browser 85,约 11 分钟)——超出任务书 9 项范围;已独立复核其中 unit 191/191 及全部合同点名定向回归(16R 集成 8/8、16R 浏览器 2/2、16 集成 10/10、16 浏览器 6/6、web-journey 7/7、three-dirs+dirty-project 10/10、webux12 goal 幂等 15/15)。REPORT-16R §0/§6 中"变更面/独立 Reviewer 待回填"与本次复核状态一致。

**结论**:补丁面与合同范围严格一致;修复语义(验收绑定结果版本、写入冻结、换代失效、标签中性化)全部落地且有我独立构造的红/绿双向证据;边界零触碰。16R 可收口。
