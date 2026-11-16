# RELAY-WEB-UX-ACCEPTANCE-11R 协调方独立审计（2026-11-16）

**终裁：REWORK（Major-R2：创建 Goal 后 ACK 丢失再重试会重复创建）。** 11R 的终态/暂停态执行按钮纠偏本身已实测正确；本次新增重大可靠性问题使整个交接不能宣称通过。

## 独立核验事实
- GitHub live `main=3e38ab5a839434c62e38db499f84503411e9846a`，实施 `bb6c6cb`，exact-head [Actions 43825151762](https://github.com/pwl1987/relay/actions/runs/43825151762) test/e2e 双 SUCCESS，实施 [43823828852](https://github.com/pwl1987/relay/actions/runs/43823828852) 同样双 SUCCESS。真实 diff `web/workspace.js`+`web/workspace.html`、03C/03D/11 测试适配与新 11R 真浏览器测试，Core 后端代码未改；Agent/Reviewer 报告与截图可查。
- 协调方本人在 VM80 独立临时 clone 固定 `3e38ab5`，使用合成测试 schema、真实 Web/API/Chromium 和确定性 stub 运行原版 `RELAY_E2E=1 WEBUX11R_TAG=coordinator npx vitest run test/e2e/webux11r-terminal-execute.test.ts`：**10/10 PASS，120.79s**。亲读 `web/workspace.js` 与 `src/server/api.ts`，亲看 11R 最新截图 `r03/r04/r08/m01`：终态蓝色执行按钮已退场、出现真实新建后续需求按钮、新 Goal 进入新视图、PAUSED 有中文指引；旧 Goal 不重启，Core 原安全门无变化。
- 只读 `deploy/preflight.ts --json`：**生产 NO-GO**，`db_migrations` FAIL(0008/0009)、`evidence_checks_config` UNKNOWN、`process_vs_head` UNKNOWN、`egress_stack` UNKNOWN；生产切换 D3 仍未批准。VM80 本地 HEAD==origin/main==live main；Writer auto/released，10 个未跟踪保护物内容未触碰，生产未重启。

## 新增 Major-R2：响应丢失后的重复创建（协调方亲自复现）
- 原 `test/e2e/webux11r-terminal-execute.test.ts` T2 只验证**双击同步**产生 1 次 POST，及 `page.route` 在请求抵达上游前直接 `abort('failed')` 后的草稿保留与恢复重试。这**不等价**于上游已提交、客户端没得到确认；`src/server/api.ts POST /api/goals` 每次均执行 `planGoal`，生成独立随机 `goal-UUID`，无跨请求幂等键/事务唯一约束；`web/workspace.js createFromComposer` 的 `state.creatingGoal` 仅限制并发点击，网络失败后复位，重试发出第二个 POST。
- 在单独临时克隆的该测试用例中**只修改临时拷贝**，把拦截改成 `const committed=await route.fetch()`（真正把 POST 送进服务端并获得 **HTTP 201**）之后 `await route.abort('failed')`（只对浏览器丢弃响应），再按当前 UI 提示重试。增补只读 Goal 计数断言：真正控制台输出 **`COORD_ACKLOSS_UPSTREAM_COMMIT_STATUS 201`**、**`COORD_ACKLOSS_GOALS_BEFORE_AFTER 4 6`**，断言“只应新建一个” `expect(6).toBe(5)` **红**；实际多创建一个 Goal 与对应初始任务。测试全部在 `p01a_*` 合成数据库/本地 bare Git；绝不读写生产。
- 测试过程先用 `-t T2` 运行，因为既有套件隐含 T1 前置导致 `ws-input` 等待超时，**这轮不是产品反例**；随后以 `-t 'T1 COMPLETED|T2 终态'` 同时带入必要 fixture，T1 通过，T2 精准红于新增单 Goal 断言（1 passed / 1 failed / 8 skipped）；准确区分了夹具依赖与真实缺陷。
- 风险：若用户按界面提示在未知结果时重试，产生两个看似不同的新 Goal，后续会重复尝试代码修改、消耗预算或引发双交付；这一点比 B1 按钮表象更接近 P0 的结果未知 Reconcile 原则。源端确实已创建而客户端不知道时，“失败恢复草稿”不能等同事务幂等。

## 最小处置与授权边界
- ACTIVE `RELAY-GOAL-CREATE-IDEMPOTENCY-12`：补真 ACK 丢失反例、稳定请求键/服务端持久幂等边界与并发事务验证，优先复用既有 Goal 唯一主键和 `planGoal(id)`，避免新表、第二状态机；不影响用户明确创建另一个不同 Goal 的权利，冲突/跨项目必须 fail-closed。若需重大 schema/身份方案先停 USER_DECISION，不能擅自执行生产 DDL。
- `MAC-ACCEPTANCE-CARD.md` 顶部残留“11R 修复前、11R ACTIVE”警告是过时文件漂移，应同步修正。后续用户 Mac UX ACCEPTED 仍需用户本人实机反馈，D3 生产 NO-GO；MVP 总体 REWORK，模型 F1/F2、Pilot 仍未完成。

**结论：11R 基础 UI 纠偏 PASS，但整体交接 REWORK，12 必须先关闭 Major-R2。**