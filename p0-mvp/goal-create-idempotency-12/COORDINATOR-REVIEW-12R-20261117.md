# RELAY-GOAL-CREATE-IDEMPOTENCY-12R 协调方独立复核（2026-11-17）

**独立裁决：PASS（12R 工程范围）。** MVP 仍 REWORK，生产预检 NO-GO，Mac 用户 UX 尚待真实用户本人操作验收。

## 核实事实
- live GitHub main `40279edae03bb0249e52c6f971fdc86ad797f1c7`，合同 `71fd58b` → `ba70fd0`（只含证据，失效的“实施”提交）→ `20dbc07`（真正代码与测试补全）→ `40279ed`（收口）。协调方读 GitHub diff+VM80 `git show --stat` 独立确认 ba70fd0 缺代码；20dbc07 新增 `src/core/goals.ts`、`src/server/api.ts` 与 `test/e2e/webux12-goal-idempotency.test.ts` 真改动，修复被覆盖，不能把 ba70fd0 CI 双绿当实现验收。
- GitHub exact-head [Actions 43977884545@40279ed](https://github.com/pwl1987/relay/actions/runs/43977884545)：**test/e2e 双成功**，协调方使用 `gh run view --log` 独立检出 CI 真正执行数：browser **61 passed / 2 skipped（63）**、`webux12-goal-idempotency.test.ts` **15 tests**；quality:full **483 passed / 85 skipped（568）**。2 个 e2e skipped 为 03C/03D 显式证据门，不能当通过。
- 协调方独立临时克隆固定最终 SHA `40279ed`，运行 `RELAY_E2E=1 WEBUX12_TAG=coordinator npx vitest run test/e2e/webux12-goal-idempotency.test.ts --reporter=verbose`：**15/15 PASS**，4.50s。原生 12 幂等正负矩阵、12R T12 同路径异项目⇒409、T13 UUID 等价⇒200、T14 登记事实漂移⇒409、T15 项目绑定↔未绑定⇒双向 409、T16 历史键检测⇒409 都在真实隔离 Web/API、Chromium/PG 环境通过；独立临时 clone 清理，原工作区状态仅 12 个受保护未跟踪物。
- 源码细核：`src/core/goals.ts` `planGoal` 在调用方创建事务内的 `GOAL_PLANNED` append-only 审计记录项目 `projectBinding`（未绑定显式 null）；`src/server/api.ts` 对重放请求精确比对冻结的 name/path/repo/branch+原 rawInput/actor/scope，事实不可证返回 409，响应回显冻结事实，绝不误报当前注册项目身份；`normalizeCreateKey` 在派生主键前统一 trim+lowercase。无新表/迁移/新 API/Web UI/额外状态机。生产旧代码仍未部署最新修复。
- 独立 VM80 隔离预览冒烟：既有 `scripts/webux11-preview.mjs` 启动于 127.0.0.1 临时端口，未登录工作台 HTTP **302**、未登录 health **401**；随机口令授权登录 `/api/session` **200**、授权 workspace **200**、授权 health **200**、Cookie 正常；退出后端口释放、`p01a_webux11_preview*` schema 零残留；本轮无生产改动。预览里 stub 模型+临时本地 Git，不代表真实模型/外部交付。
- **新发现但非 12R 阻断的预览小问题**：`scripts/webux11-preview.mjs` 通过 `mkdtempSync` 创建临时 registry、bare remote base、stage base、verify scratch；`shutdown` 目前只调用 `t.cleanup`，未收这些临时目录。协调方 `/tmp` 找到多份 `webux11-preview-reg-*`、`remote-base-*`、`stage-*` 残留，属于独立的预览生命周期边界，交给下一包 13 最小修复；**不得擅自清理未知历史目录**。这不涉及 Goal 幂等逻辑，故不判 12R REWORK。
- 生产只读 `node deploy/preflight.ts --json` 仍 **NO-GO**：`db_migrations=FAIL`（0008/0009 未落）、`evidence_checks_config=UNKNOWN`、`process_vs_head=UNKNOWN`（旧 Web/Worker）、`egress_stack=UNKNOWN`。无 D3 用户批准。ADR-0010 真实模型 F1/F2、Mac/手机真机、至少一条真实外部业务交付仍为独立 MVP 必需验收项；Pilot 24h 单独后置，不伪造全局 PASS。

## 后续判定
- 12R **PASS**，不为已解决问题续造 12R.1。下一唯一 ACTIVE `RELAY-MAC-UX-HANDOFF-13` 做隔离预览临时目录收口、正确授权冒烟、中文一页 Mac 使用交接。13 完毕需停等用户本人 Mac 体验结论；是否授权生产 D3 另行明确选择，Agent 无权替代。