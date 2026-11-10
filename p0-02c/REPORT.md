# P0-02C 交付报告:最小 Web 控制台与真实用户旅程验证

- 状态:**COMPLETE-WITH-PENDING**(包内合同全部落地;GitHub 真实写入沿用 P0-02B 的 NOT_VERIFIED 口径,随有效 PAT 补录,不需新授权)
- 合同:`git show 0c3aab9:CURRENT.md`(ACTIVE Contract 先于实现独立提交)
- 提交链:`78e4d5e`(P0-02B 终态)→ `0c3aab9`(合同)→ `cb3cceb`(实现)→ `44be756`(证据+P0-02B 文档收敛)→ `4c8118e`(复核处置)→ 收尾提交(本文档/CURRENT/CONTINUATION/REVIEW 终版)
- 独立复核:全新上下文 Reviewer 两轮 —— 首轮 **PASS-WITH-FIXES**(R-1/R-3 必修 + 6 OBS)→ 全部处置 → 复验终版见 `p0-02c/REVIEW.md` §六/§七
- 证据:`p0-02c/e2e-journey.log`、`http-responses.log`、`browser-errors.log`、`db-state.log`、`screenshots/`(8 张,Playwright 真 Chromium);证据内嵌产出 HEAD

## §1 交付物

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| API Server | `src/server/{app,api,auth,redact,capabilities,views,worker,index}.ts` | 仅 Node 内建 `node:http`(D-1 零新运行时依赖);写路径只经 `src/core`(D-3);读模型 `views.ts` 只含 SELECT(35 处逐一核对,D-4) |
| Web 控制台 | `web/`(5 页:登录/Dashboard/Goal/Decision Inbox/ChangeSet-Evidence) | 零构建(D-2);DOM `textContent` 渲染、禁 innerHTML;CSP `script-src 'self'` 无内联 |
| core 增量 | `src/core/decisions.ts: deferDecision` | 唯一 core 改动:仅推迟截止时间、不改状态;乐观并发(expectedStateVersion)+ 审计 |
| 测试 | `test/unit/{redact,capabilities,web-app}.test.ts`、`test/integration/web-api.test.ts`、`test/e2e/web-journey.test.ts` | 合同反例 1..10 逐条专属断言;E2E 由 `RELAY_E2E=1` 门控(常规全量自动 skip,不假装) |
| CI | `.github/workflows/ci.yml` 新增 `e2e` job | Playwright Chromium + PG16 service,与 `test` job 并行(D-10) |

## §2 安全门禁落实(G-1..G-8)

- **G-1 监听面**:默认 `127.0.0.1`;非回环须 `RELAY_WEB_ALLOW_NON_LOOPBACK=1` 否则拒启,拒绝落 `audit_events`(`WEB_BIND_REJECTED`,authority=OWNER)+ stderr + 退出;启动横幅常驻打印绑定地址。(首轮复核指出"拒绝仅 stderr、零测试"→ 已处置:`app.ts` BindRejectedError/ensureLoopbackBind/auditBindRejected + `test/unit/web-app.test.ts` 4 例)
- **G-2 认证**:口令 env 或 0600 文件(FAIL-CLOSED);scrypt 派生 + `timingSafeEqual`;32B 随机会话、服务端存储、HttpOnly + SameSite=Strict;登录失败限速 + 锁定(429 实测);登录/失败/登出均落审计。
- **G-3 CSRF**:会话内 32B token;全部写方法强制 `x-relay-csrf`(`timingSafeEqual`)+ Origin/Sec-Fetch-Site 同源;缺失/失配 ⇒ 403 且 DB 零变更(实测)。
- **G-4 写鉴权**:actor 必过 core `operatorAllowed`(非 operator ⇒ 403,实测);写操作强制 `expectedStateVersion`(失配 ⇒ 409,状态零变更,实测);审计 authority=OPERATOR。
- **G-5 脱敏**:形态(ghp_/gho_/ghs_/ghu_/ghr_/github_pat_/Bearer/user:secret@/x-access-token/查询串凭据/私钥块)+ 敏感字段名双层;递归作用于**所有** API 响应(`finalizeResponse`);错误不回显堆栈;单测 7 例 + 集成实测(证据原文植入 ghp_ ⇒ 响应无明文)。
- **G-6 D3 永不自动批准**:core 超时仅标 `EXPIRED_STILL_BLOCKED`;源码自证(剥注释扫描零自动批准路径)单测锁定;UI 无自动/批量批准入口;推迟仅改截止时间不改状态(实测);e2e J2 全链佐证。
- **G-7 只读事实源**:前端零业务状态,渲染值恒等于 PostgreSQL;断线显示"连接中断,不代表实时状态"(J5 实测三态)。
- **G-8 凭据与预算不扩大**:diff 核实仅新增 devDependency playwright;模型路径全部由确定性桩承担;GitHub 真实写入保持 NOT_VERIFIED。

## §3 真实用户旅程验收(Playwright,真 Chromium + 真 PG)

| 旅程 | 结果 | 证据 |
| --- | --- | --- |
| J1 模糊需求创建 → 系统理解与可验证建议 | ✅ | 分析来源徽章「确定性规则推导(非模型)」;模型分析告示「未实现」;建议含依据+验证方式;j1-goal-created.png |
| J2 D3 长期未审批 → 其他任务推进 | ✅ | D3 任务停留 NEEDS_DECISION、决策 OPEN、零自动批准;无关任务推进 ACCEPTED;UI 三动作(批准/拒绝/推迟);j2-*.png |
| J3 Worker 崩溃 → 原因/证据/恢复 | ✅ | Run FAILED(rpc_disconnect)进 UI 运行记录;任务恢复 READY(attempt=1 有界重试);Dashboard 异常面板 run_failed;j3-*.png |
| J4 候选 → 独立验证 → Gate → 交付 | ✅ | 全链 DELIVERED 到本地 bare 远端;UI 三 SHA 两两不等;Gate PASS 已消费;caveat 明示 GitHub 真实写入 NOT_VERIFIED;j4-changeset-delivered.png |
| J5 刷新/断线重连一致 | ✅ | 三态渲染值 == PostgreSQL;断线横幅不冒充实时;j5-*.png |

## §4 测试账(写者侧终账,HEAD `4c8118e`)

- 全量:`npx vitest run` ⇒ **45 文件 = 44 passed + 1 skipped;196 用例 = 189 passed + 7 skipped**(7 skip = github-real 2 凭据门 + e2e 5 RELAY_E2E 门)。
- E2E:`RELAY_E2E=1 npx vitest run test/e2e` ⇒ **5/5 passed**(真 Chromium + 真 PG + stub worker;证据由本 HEAD 树产出,首版为 cb3cceb、处置后重跑再生——时序在日志首行标注)。
- `npx tsc --noEmit` ⇒ 0 错误。
- 复核人独立复跑(PASS-WITH-FIXES 首轮时点):全量 184 passed + 7 skipped(191)——与本包新增账目吻合;处置后终账 196 见上(新增 web-app 4 例 + web-api 1 例)。

## §5 复核与处置

- 首轮(PASS-WITH-FIXES,HEAD 44be756):**R-1**(G-1 拒绝未落审计_events + 零测试)、**R-3**(stub 注入未在代码面强制标注 stub)必修;R-2/R-4/R-5/R-6/R-7/R-8 OBS。
- 处置(4c8118e):R-1 ✅(BindRejectedError + auditBindRejected + 4 单测);R-3 ✅(stubInjection ⇒ 强制 mode:"stub" + 断言);顺手修复 R-6(删除误导字段)与 R-8(501 语义)+ web-api 1 例。
- OBS 登记(不修,留档):
  - **R-2**:登录限速键盲信 `X-Forwarded-For`(非回环部署且无可信代理时可绕过锁定;默认回环面无影响)——留给非回环放行需求出现时与可信代理配置一起做。
  - **R-5**:`Origin: null` 放行(有 CSRF 头 + SameSite=Strict + Sec-Fetch-Site 三层兜底)。
  - **R-4**:合同 D-4 写 `queries.ts`,实现为 `views.ts` —— 命名偏差,实质满足(35 SQL 全 SELECT)。
- 复验终版:见 `p0-02c/REVIEW.md` §六/§七(由 Reviewer 落盘)。

## §6 未验证项与诚实声明

1. **GitHub 真实写入:NOT_VERIFIED**(合同既定口径)。宿主 `~/.relay/credentials/github-sandbox-pat` 仍非有效 GitHub 令牌 ⇒ 真实写入/漂移实验诚实 skip;本包 J4 的交付目标为**本地 bare 远端**,不冒充 GitHub。有效细粒度 PAT(仅 `pwl1987/relay-delivery-sandbox` Contents RW)就位后运行 `npx vitest run test/integration/github-real.test.ts` 即闭环,不需要新授权。
2. **真实模型链路:本包 0 次调用**(合同约定)。所有模型路径由 `test/helpers/stub-pi.mjs` 确定性桩承担;UI/API 已显式标注 worker=stub;真实模型执行语义已在 P0-01B/02A/02B 验证(账本经 budget_ledger 计数,本包 stub 亦走真实 core 预算路径)。
3. **CI e2e job 首跑**:推送前无法验证(GitHub Actions 未见远端新提交);推送后以 CI 结果为最终门。
4. **浏览器错误日志口径**:`browser-errors.log` 中的 `Failed to load resource: net::ERR_INTERNET_DISCONNECTED` 与对应 fetch 失败为 **J5 有意断线制造**(预期);除该类外无浏览器错误。
5. 生产部署/RSI/其他仓库/其他分支/强推:均未发生(diff 可证;`src/server/` 无 child_process 面)。
6. **R-9(复核登记,环境型)**:复核人两次全量 vitest 在宿主并发活动窗口中仅 `gate-e2e.test.ts`(P0-02A 真实模型链,与 server 层处置无因果)45s 壁钟超时;隔离单跑绿(57.3s)。写者侧 196=189+7 全绿账取自无并发窗口。**"全量绿"的权威口径 = GitHub CI 隔离运行(test job)**,已列入退出条件;经验与 P0-02B §8.5 未消除风险并档(见 `REVIEW.md` §6.4)。

## §7 模型与凭据边界

- 真实模型调用:0 次(本包);stub 走真实 core 预算账本(FAIL-CLOSED 语义被 e2e 佐证:无模型配置 ⇒ tick 返回 IDLE_PROVIDER_DOWN,不领取任务)。
- GitHub 权限:零扩大;无新增任何凭据面;`src/server/` 不读取任何令牌(脱敏出口则覆盖既有证据原文)。
