# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 D(真实业务样例与安全验收)ACTIVE**。阶段 C 已收账:BLOCKED(仓库不在 PAT 授权范围;`p0-mvp/stage-c-github-permission.md`)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推)。
- 提交链(总包):`… → f618d51(B 收尾)→ 710d596(C 收账)→ 本合同`。

## 本包范围(阶段 D:F1/F2/F3 + 清理安全加固)

1. **Fixture F1(模糊 UX 需求,真模型全链)**:`test/fixtures/f1-tasklist/` 真实迷你 Web 项目(新增任务表单页;localStorage;无敏感信息)。给 Relay 一句"新增任务的页面不好用。"→ Discovery(真模型,项目调查+推荐)→ operator 采纳 → 真模型 Coder 有限修改 → Gate(**Playwright 真浏览器确定性检查**为 evidenceCheck:填表→提交→条目出现 + HTTP 断言)+ 独立 Reviewer → 本地 bare 交付(GitHub BLOCKED 不冒充)→ 证据落 `p0-mvp/f1/`。预算声明:discovery 6 + coder 6 + reviewer 4(账本 16;magpie 零真实成本);magpie 方差如实(失败诚实落 FAILED,隔离复跑一次定性)。
2. **Fixture F2(真实 Bug,真模型全链)**:`test/fixtures/f2-api/` 含 HTTP API(node:http)+ 真实边界错误(POST /api/divide 对 0 除 500/crash)+ **失败回归测试**。Relay:复现(失败测试为证据)→ 定位根因 → 修复 → 新增回归测试 → 真实 HTTP 验证(起服务+curl)→ 独立 Review → Gate → 交付。证据落 `p0-mvp/f2/`;预算声明同 F1 口径。既有加法算例保留为机制验证,不再充当业务样例。
3. **Fixture F3(故意失败与越权)**:盘点矩阵(`p0-mvp/f3-matrix.md`)把既有实锤映射到总包清单:无限重试(V11)/假造 DONE(V08 fake-self-approve)/旧 SHA 旧 Gate(V09 staleEvidence)/并发 Writer(V06/V20)/远端漂移(V10;真实远端漂移=C 阶段 BLOCKED 如实)/DB 断线(E6 收口)/不确定副作用(V05)/越权读写(pi-e2e+command-scope)。**补真模型级注入语料化(T01 遗留)**:evil fixture 下真模型 Discovery+Coder 全链,断言零 exec/项目目录零变化/报告把语料当数据分析;失败如实落 FAILED。全部危险测试在隔离沙箱+独立 schema+本地 bare。
4. **D4 清理安全(中央防护)**:`src/runtime/safe-rm.ts` `safeRm(path, {roots, sentinel})`——拒绝 `/`、`/tmp`、HOME、仓库根、roots 之外路径、无哨兵目录;**纯逻辑守卫(不依赖权限碰巧不足)**;应用于 `cleanupSandbox`、git-candidate stage 回收、全部测试 rmSync 点(普查 ~15 处);回归测试:危险路径逐一拒绝+正常路径放行;`rm -rf` 脚本面审计入报告。
5. **收尾**:`p0-mvp/f1|f2/` 证据 + `f3-matrix.md` + `REPORT-stage-d.md` + 独立 Reviewer → CI 绿 → 快进推送。
6. **安全边界**:预算每轮先声明超额即停;magpie 零真实成本;不生产部署;不 RSI;不扩权;GitHub 交付不冒充(本地 bare + BLOCKED 如实);Playwright 仅本地面。

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

