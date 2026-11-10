# Relay 当前执行契约

- 状态:**P0-02C COMPLETE-WITH-PENDING / IDLE(下一包 NOT_ACTIVE,待用户授权)**。完成:2026-11-10。终态以远端 `main` 为准(收尾提交后 fast-forward 推送)。
- 写者:**无 ACTIVE Writer**(P0-02C 写者已释放)。
- 本包交付:**最小 API Server + Web 控制台与真实用户旅程验证**——以现有 PostgreSQL/Goal Loop/Decision/Gate/Delivery 为唯一业务事实源,零新运行时依赖(node:http)、零构建前端:
  - **安全门禁**:G-1 默认仅监听 `127.0.0.1`(非回环须显式放行,拒绝落 `audit_events` WEB_BIND_REJECTED);G-2 口令 scrypt+timingSafeEqual/会话服务端存储/HttpOnly+SameSite=Strict/失败限速锁定;G-3 全部写方法强制 CSRF 头 + 同源校验;G-4 actor 必过 core `operatorAllowed` + `expectedStateVersion` 失配 409;G-5 全响应双层脱敏(形态+字段名,错误不回显堆栈);G-6 **D3 永不超时自动批准**(源码自证单测 + UI 无自动入口,推迟仅改截止时间);G-7 前端零业务状态,断线显示"连接中断"不冒充实时;G-8 凭据/预算零扩大。
  - **四页面**:Dashboard(健康/预算/阻塞/异常/审计/能力登记表)、Goal(一句创建 + 规则推导理解与可验证建议,**模型分析显式未实现**)、Decision Inbox(D0–D4 展示与授权)、ChangeSet/Evidence(三 SHA 分列 + Gate + 交付状态 + 证据时效)。
  - **core 增量仅一处**:`decisions.ts: deferDecision`(乐观并发 + 审计;不改状态)。
  - **E2E**:Playwright 真 Chromium 五旅程(J1 模糊创建→理解建议;J2 D3 卡住不影响他人;J3 崩溃原因/恢复;J4 候选→Gate→DELIVERED(本地 bare 远端);J5 刷新/断线/重连恒等于 PostgreSQL),证据落 `p0-02c/`(journey/http/browser-errors/db-state + 8 截图,内嵌产出 HEAD)。
- 独立复核:全新上下文 Reviewer 两轮——首轮 **PASS-WITH-FIXES**(R-1/R-3 必修 + 6 OBS)→ 处置(4c8118e)→ 复验 **PASS**(见 `p0-02c/REVIEW.md`;R-2 XFF 限速键、R-5 Origin:null 为登记遗留,R-4 命名偏差注明,R-9 环境型并发争用并档)。
- 测试:**196 用例 = 189 passed + 7 skipped**(45 文件;7 skip = github-real 2 凭据门 + e2e 5 RELAY_E2E 门);E2E 5/5(真 Chromium);`tsc` 0。**"全量绿"权威口径 = CI 隔离运行**(R-9:宿主并发窗口下 gate-e2e 可能壁钟超时,隔离绿)。
- CI:`test` job(P0-02B 既有)+ 新增 `e2e` job(Playwright Chromium + PG16 service,`RELAY_E2E=1`);双绿后快进推送。
- 模型预算:本包**真实模型调用 0 次**(合同约定);全部模型路径由确定性桩承担并经真实 core 预算账本(FAIL-CLOSED 语义被 e2e 佐证);gate-e2e/pi-e2e 既有测试固有消耗属回归面,如实沿用既有披露口径。

## 遗留检查单(结转 + 本包新增)

1. **真实远端写入 + 漂移实验(NOT_VERIFIED,随 PAT 补录,无需新授权)**:宿主凭据文件仍非有效 GitHub 令牌 ⇒ github-real 两例诚实 skip;有效细粒度 PAT(仅 `pwl1987/relay-delivery-sandbox` Contents RW)置 `~/.relay/credentials/github-sandbox-pat`(0600)后运行 `npx vitest run test/integration/github-real.test.ts` 闭环并补录 p0-02b/ 证据。
2. **R-2(P0-02C 登记)**:登录限速键盲信 `X-Forwarded-For`——默认回环面无影响;待非回环放行需求出现时与可信代理配置一起加固(auth.ts clientIp/app.ts)。
3. **R-5(P0-02C 登记)**:`Origin: null` 放行(CSRF 头 + SameSite=Strict + Sec-Fetch-Site 三层兜底;维持登记)。
4. base 一致性纵深(`executeDelivery` 不复校 commit 绑定;P0-02B F-12)。
5. 候选 base 仅存 reflog 时的阻断边界(P0-02B)。
6. 经典 `ghp_*` 令牌仅限开发者 infra,严禁进入任何 Relay Operator 路径(P0-02B 源码自证延续)。
7. 候选 stage 仓库无自动回收(P0-02B;量级小,ops 清理)。
8. **R-9(P0-02C 登记)**:全量 vitest 须在无并发活动窗口运行;宿主并发下 gate-e2e 可能壁钟超时(隔离绿)——与 P0-02B §8.5"首次克隆瞬时未捕获异常"同档管理,CI 隔离运行为权威口径。
9. worker 生产模式(`RELAY_WEB_WORKER=live`)与 external relay-worker 进程的编排属部署包,本包未实施(控制台已支持 external 口径:tick 501)。

## 下一唯一建议:P0-ACCEPT(独立复核设计/实现一致性 + 长稳报告,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-ACCEPT 行起草激活合同(需新的明确授权):P0 端到端可复现验证矩阵、故障注入核对、独立复核设计/实现一致性。入口 `docs/CONTINUATION.md`。
- 边界:不生产部署、不 RSI、不扩大 GitHub 权限或模型预算;接受之前不开展 RSI 自改。
