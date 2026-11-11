# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 B(REWORK-1 Discovery)CLOSED / 阶段 C(GitHub 补验)进行中**。阶段 B 终态:远端 `main` == `a1707af`(CI `42976375094` 双绿)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推)。
- 提交链(总包):`3069aa1 → 382edf7(A 合同)→ f748441(A 实现)→ 9b87e69(A 复核处置)→ 70b94c5(A CI 处置)→ 3a4b10a(A 收尾)→ 8880528(B 合同)→ 49edffe(B 实现)→ 20e0662(B 复核处置)→ a1707af(B CI 处置)`。

## 阶段 B 终账(REWORK-1;证据见 `p0-rework1/`)

- **交付**:`discoveries` 表(迁移 0005,结果持久化不依赖聊天上下文)+ `src/runtime/discovery.ts`(role=discovery 只读会话:禁 exec 仅 relay_read、docker 只读挂载、同一账本、双限、relay-discovery 结构化围栏+最小 schema 校验)+ `src/core/discovery.ts`(FAIL-CLOSED 预算/SUCCEEDED 落 report+SHA/FAILED 落 reason 不伪造)+ CLI `relay goal analyze` + API `POST /api/goals/:id/discovery`(均 ensureEgress 同 worker)+ Goal 页 Discovery 区块来源徽章(规则面兜底不冒充)+ capabilities 两行 IMPLEMENTED(公网搜索 P1 仍 NOT)。
- **真模型验收**(magpie;预算声明 reserveCalls=6/轮、账本 8):模糊 UX 调查 ✓ / 不合理方案可核查反驳 ✓ / 不完整需求→可判定验收 ✓ / 预算耗尽 budget_turns_cap 诚实止损实锤 ✓;**sources 可核查断言**(指向项目内真实文件)。方差如实登记:prompt 文件清单修复后终轮 3/3 绿(125s);magpie 间歇方差仍存,失败路径诚实止损零伪造。
- **独立复核**:`p0-rework1/REVIEW.md` PASS-WITH-FIXES;Major-1(入口恒 egress_rules_missing)→ ensureEgress 接入;Major-2(真模型不可复现+断言不足)→ prompt 文件清单+assertSourcesReal;Major-3(host-fallback 审计链断裂)→ 按模式判定路径+读回清理;Minor 修复(Web 徽章 SHA/runId)+ E2E J1 口径更新。
- **测试**:discovery.test.ts 9 例(6 stub 常跑 + 3 真模型门控);全量 225=213+10skip+2fail(2fail=github-real 403);tsc 0;E2E 5/5;CI 双绿。**US-01 模型面/US-02 P0 最小:VERIFIED(含方差披露)**。

## 阶段 C(GitHub 真实交付补验;进行中)

1. 逐一核查 PAT 权限(owner/仓库范围/Contents RW/凭据隔离/git 干扰;不打印 token、不用宽权限 gh token、不自建 Token)。
2. 有权限 ⇒ 跑 `npx vitest run test/integration/github-real.test.ts` 全套验收;仍 403 ⇒ 如实 BLOCKED(用户侧单点:为 PAT 补 `pwl1987/relay-delivery-sandbox` Contents RW),继续阶段 D。
3. 不反复等待、不扩权。

## 阶段 A 终账(REWORK-2 CLOSED;证据见 `p0-rework2/`)

- Core `pauseTask`(READY 状态门)+ `src/cli.ts` + bin(七组命令;零新依赖)+ API pause 对等 + doctor(逐项容错,凭据零明文)+ 确定性退出码;V03 全程真实 CLI 演练;独立复核 PASS-WITH-FIXES 两 Major 已修(pauseTask READY 门/defer 授权下沉 Core);cli.test.ts 13 例全绿;CI 双绿。**US-04/V03:VERIFIED**。

