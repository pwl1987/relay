# RELAY-GOAL-CREATE-IDEMPOTENCY-12 协调方独立复核（2026-11-16）

**结论：REWORK（Major-P1 项目真实身份未绑定 + Minor-K1 UUID 等价表示未规范化）。** 12 包的 ACK 丢失后重试、并发幂等、数据原子性基础修复已得到独立 PASS，未推倒。

## Live SCM/CI/本地现场
- GitHub live `main=b1ca1a32ab4b70b72ddcf0893149f259a1040c6d`，12 实施 `854204b`、收口 `b1ca1a3`。exact-head [Actions 43842110343](https://github.com/pwl1987/relay/actions/runs/43842110343) **test/e2e 双 SUCCESS**，实施 [43839187535](https://github.com/pwl1987/relay/actions/runs/43839187535) 同样双 SUCCESS。真实 diff 核心为 `src/server/api.ts` + `web/workspace.js` 和新 12 真浏览器测试；无 schema/迁移/Core 状态机改动。
- 协调方独立在 VM80 `git clone --shared --no-checkout` 创建临时克隆，固定 live `b1ca1a3`，链接只读 node_modules、使用真实 Web/API、一次性 `p01a_*` PG 与 Chromium 测试 `RELAY_E2E=1 WEBUX12_TAG=coordinator npx vitest run test/e2e/webux12-goal-idempotency.test.ts`：**10/10 PASS，4.54s**（含已提交 201 后浏览器 ACK 丢失、并发同 key [201,200]、非法键、重放无重复 Task/预算/审计、旧无键客户端兼容）。原始 main HEAD==origin/main==live，Writer auto/无 active；受保护未跟踪 config/、soak-r3b/、10 份 CI 回执均在，原仓零修改。生产 NO-GO 和 D3 未授权维持。

## Major-P1（真实 API 红反例：同目录异项目误重放）
- 源码 `src/server/views/projects.ts` `readProjectRegistry()` 允许不同 `name/repo/branch` 注册项指向**同一 `path`**（无路径唯一约束）。服务端 `src/server/api.ts` 的 `resolveGoalCreateReplay()` 仅比对 `goals.raw_input`、`GOAL_PLANNED.actor`、初始 Task `allowed_scope`，不比对不可变 projectId/name/repo/branch；回放响应的 `project` 使用**本次请求** boundProject，而非首次创建原始项目事实。
- 协调方临时克隆只扩展**合成**注册表为 `{name:PROJECT_NAME,path:projectDir}` 和 `{name:'alias-same-path',path:projectDir,repo:'different-repo.example'}`。加 T10：同 `randomUUID()` + 同 rawInput，项目 A 首次 `POST /api/goals` → **201**；改 `projectId='alias-same-path'` → **200（错误）**，`goalId` 相同，`projectReplay='alias-same-path'`，数据库 Goal `0→1`。断言第二请求 409 **红**：`expected 200 to be 409`。真实 API/隔离 PG 独立核实，违反合同 12“同键异项目绑定必须拒绝”。虽然没有重复创建，却造成项目归属事实与返回信息不一致，可能影响后续用户判断/授权。即使两个项目同一物理目录，也不能推定业务项目相同。

## Minor-K1（真实 API 红反例：UUID 等价大小写）
- `GOAL_CREATE_KEY_RE` 使用不区分大小写 `/i` 接受合法 UUID，但 `goalIdForCreateKey()` 对未规范化 key SHA-256；同一 UUID 的大写/小写按通常 UUID 语义是相同标识。协调方临时克隆新增 T11：相同 rawInput，首 POST key=`randomUUID()` → **201**，随后 key=`toUpperCase()` → **201** 且不同 goalId，Goal `0→2`；预期第二次是 200、同 id、Goal 只 +1；断言红：`expected 201 to be 200`。该问题不影响 12 Web 默认生成小写 UUID 的常规路径，但 API 合法输入和幂等合同未一致，宜与 Major-P1 一次性修复。

## 专业判定与后续准入
- 12 原定红→绿、并发和普通 ACK 丢失均为真实工程成果，独立验收范围内保留；新增两反例**不在现有 10 测试覆盖面**，故“双绿 CI”不等于同项目身份语义全覆盖。
- 唯一 ACTIVE 定为 **RELAY-GOAL-CREATE-IDEMPOTENCY-12R**，仅对身份项目精确比对与 UUID 规范化作原子/持久最小修复；原本 `WEB_GOAL_CREATED` 在创建事务外 best-effort，不能单独作为必要身份权威，优先利用既有事务的 append-only 审计或可证原子事实，严禁新增第二控制面。Mac 用户 UX 仍须本人体验；不批准 D3、模型 F1/F2 和 Pilot。

**协调方终裁：12 REWORK（12R 最小闭环），生产仍 NO-GO。**