# P0-02C 独立复核报告(REVIEW.md 终版)

- 复核对象:P0-02C「最小 Web 控制台与真实用户旅程验证」(合同:`git show 0c3aab9:CURRENT.md`)
- 提交链:`78e4d5e`(P0-02B 终态)→ `0c3aab9`(合同)→ `cb3cceb`(实现)→ `44be756`(证据+D-11)→ `4c8118e`(复核处置)
- 复核人:独立 Reviewer(全新上下文,仅依据仓库内事实,不采信写者口头声明)
- **声明:§一..§五 为 Reviewer 首轮输出(首轮裁决 PASS-WITH-FIXES,复核时 HEAD `44be756`);§六/§七 为同一 Reviewer 的处置复验输出(复核时 HEAD `4c8118e`)。写者未代写本报告任何章节**(首轮报告以 `REVIEW.draft.md` 形态交付,处置后由 Reviewer 本人扩写为终版并删除 draft)。

---

## §一 复核范围与方法(首轮)

**范围**:合同符合性(G-1..G-8 / D-1..D-12 / 反例 1..10 / J1..J5)、代码面(server 8 文件 + core/decisions.ts 唯一改动 + web/ 前端)、测试面(4 个新测试文件)、证据面(4 个日志 + 8 张截图)、P0-02B 文档修正(44be756)、以及复核人本机亲测。

**方法**(全部只读;唯一写入物为复核报告):
1. `git show 0c3aab9:CURRENT.md` 取合同原文,逐条与实现/测试/证据对照。
2. 通读实现:`src/server/{auth,redact,capabilities,views,api,worker,app,index}.ts`、`src/core/decisions.ts`(仅 deferDecision 增量)、`web/` 全部 11 个前端文件。
3. 对 `views.ts` 做 SQL 面全量提取:35 处 `exec.execute(sql\`...\`)` 的模板首词逐一核对。
4. 剥注释后对服务端源码做 D3 自动批准/定时器模式扫描。
5. 逐张查看 8 张 PNG 截图,并与 db-state.log / http-responses.log 中的 ID、SHA、时间戳交叉比对。
6. 本机亲测(见 §四):typecheck、三个指定测试文件、RELAY_E2E=1 全部 e2e、全量 vitest、grep 自证。
7. 亲测 e2e 会重写 `p0-02c/` 证据文件;复核人在跑前对全部证据做了 sha256 快照,跑后 `git checkout -- p0-02c/` 还原并逐一校验通过(工作区恢复 clean)。**这一过程同时反向佐证:被复核的证据文件确为该测试的真实产物(结构、产出路径、覆盖 journeys 与被提交文件一致)**。

**证据真实性判断(首轮)**:e2e-journey.log / http-responses.log / browser-errors.log / db-state.log 内嵌产出 HEAD cb3cceb;四份日志与 8 张截图的时间戳(2026-11-10 12:05:5xZ = 本地 20:05)一致;screenshot 中可见的 goal/task/decision/run/commit ID 与 db-state.log 完全对应(goal-fac2736a…、goal-d620e7d5…、task-978500b6…、dec-e2e-d3=OPEN、run-f100eda9=FAILED/rpc_disconnect、commit 75920270bba4=DELIVERED 远端头);browser-errors.log 仅含 J5 有意断线的预期 fetch 失败;http-responses.log 197 行全部 2xx(断线请求不产生 HTTP 响应,与 browser-errors 吻合)。**未发现伪造迹象**。

---

## §二 合同逐条对照表(首轮,HEAD 44be756)

### 安全门禁 G-1..G-8

| 条款 | 结论 | 证据位置 |
| --- | --- | --- |
| G-1 监听面 | **部分覆盖** | `app.ts:85-90`(默认 127.0.0.1;非回环且无 `RELAY_WEB_ALLOW_NON_LOOPBACK=1` ⇒ 构造即抛错拒启);`index.ts:84-87` 启动横幅打印绑定地址。缺口:拒绝时"落审计"仅为 stderr `console.error`(index.ts:102),无 audit_events 行;且无任何测试覆盖拒绝/显式放行两分支 → R-1 |
| G-2 身份认证 | **已覆盖** | `auth.ts`(scrypt 派生 + timingSafeEqual:94-100/142-144;会话 32B 随机:66-68;服务端 Map 存储 + TTL:153-161/176-185;HttpOnly+SameSite=Strict+Path=/:253-255;失败限速+锁定:103-128);`index.ts:15-30`(口令 env 或 0600 文件,FAIL-CLOSED);登录/失败/登出审计:api.ts:144/152/205;限速锁定有测试(web-api:306-321,429 实测)。口令文件 0600 校验无专门单测 → R-1 附注 |
| G-3 CSRF | **已覆盖** | `auth.ts:188-213`(verifyCsrf timingSafeEqual + Origin/Sec-Fetch-Site 同源);`api.ts:172-191`(全部写方法强制,缺失/失配 ⇒ 403);测试:web-api 反例2(缺头+错头 403,且 DB 计数零变更、无泄漏行);前端 app.js:108-136 统一带头 |
| G-4 写操作鉴权 | **已覆盖** | `api.ts:187-190` operatorAllowed(session.role);resolve/defer/resume 均强制 expectedStateVersion,失配 ⇒ 409(api.ts:282-300/307-327/332-343);测试:web-api 反例3(RELAY_OPERATORS 改名 ⇒ 403+零变更,恢复后同会话可写)、反例4(v6 失配 409 且任务/决策状态零变更,v7 通过 ⇒ READY);审计 authority=OPERATOR(decisions.ts deferDecision、api.ts audit 助手) |
| G-5 脱敏 | **已覆盖** | `redact.ts`(ghp_/gho_/ghs_/ghu_/ghr_/github_pat_ 形态:14-15;Bearer:17;user:secret@:19;x-access-token:21;查询串凭据:23;私钥块:25;敏感字段名整词:29/57-60;递归:63-83;safeErrorMessage 不回显堆栈:86-89);统一出口 `finalizeResponse`(api.ts:369-381)全部 API 响应过 redactSecrets;单测 redact 7 例(含计量字段不误伤 tokensIn/tokensOut);集成反例6:向 gate_evidence.raw_output 植入 ghp_ 令牌 ⇒ /api/dashboard 响应不含明文 |
| G-6 D3 永不自动批准 | **已覆盖** | 源码面:core/decisions.ts expireStaleDecisions 仅标 `EXPIRED_STILL_BLOCKED`(93-108),任务状态未触碰;deferDecision 仅 UPDATE deadline(唯一 core 改动,78e4d5e..44be756 diff 核实);服务端无 setTimeout/setInterval/自动批准(剥注释扫描,唯一命中是 capabilities.ts:69 显式登记"永不存在");测试:capabilities 源码自证用例 + web-api 反例5(超时后决策仍 EXPIRED_STILL_BLOCKED、verdict NULL、任务仍 NEEDS_DECISION)+ 推迟用例(状态不变);UI:decisions.html `d3-policy-notice` + decisions.js 仅批准/拒绝/推迟三键,无批量/自动入口;e2e J2 全链佐证 |
| G-7 只读事实源 | **已覆盖** | 前端无业务状态,每渲染必 fetch(app.js:162-175 guarded;各页 refresh 全量重取);断线 ⇒ `conn-banner`"连接中断…不代表实时状态"(app.js:138-155);e2e J5:刷新/断线/重连三态渲染值 == PostgreSQL 事实(API 直查对照),截图 j5-offline-banner.png/j5-reconnected.png |
| G-8 凭据与预算不扩大 | **已覆盖** | diff 78e4d5e..44be756:package.json 仅新增 devDependency playwright;无新 GitHub 凭据面;模型路径全部由 `test/helpers/stub-pi.mjs`(stdin/stdout 确定性 RPC 桩,零网络)承担,e2e 栈 baseUrl 指向不可达地址 + argv 注入桩;capabilities 登记 delivery.github.real=NOT_VERIFIED(截图 j3-dashboard-anomaly.png 可见);changeset 页 caveat 明示 NOT_VERIFIED(j4 截图) |

### 交付条款 D-1..D-12

| 条款 | 结论 | 证据位置 |
| --- | --- | --- |
| D-1 零新运行时依赖 | **已覆盖** | package.json dependencies 零变化;server 仅 node:http(node:crypto/fs/path);playwright 在 devDependencies |
| D-2 零构建前端 | **已覆盖** | web/ 原生 HTML/CSS/JS,无打包链;静态资源同一 server 提供(app.ts:159-196);CSP script-src 'self' 无内联 |
| D-3 写路径只经 core | **已覆盖** | api.ts 写端点全部经 core:planGoal(250)/resolveDecision(285)/resumeTask(334)/deferDecision(313)/goalLoopTick(worker.tick→core,worker.ts:126-211);HTTP 层无业务 SQL 写(仅 SELECT 1 健康检查与 core appendAudit);views.ts 仅 SELECT |
| D-4 读模型只读投影 | **已覆盖(命名偏差)** | 实现文件为 `src/server/views.ts`(合同原文写 queries.ts → R-4/OBS);35 处 SQL 模板逐一核对均为 SELECT,无 INSERT/UPDATE/DELETE |
| D-5 能力登记表 | **已覆盖** | capabilities.ts 13 项,IMPLEMENTED/NOT_IMPLEMENTED/STUB/NOT_VERIFIED 四态;`/api/capabilities` + Dashboard 表格(j3 截图可见全部条目与状态徽章);goal 页 model-analysis-notice 标注未实现 |
| D-6 页面最小集 | **已覆盖** | web/ 仅 index/goal/decisions/changeset/login 五个 HTML;无流程图/编排视图 |
| D-7 Worker 可注入 | **部分覆盖** | worker.ts live/stub/external 三模式,FAIL-CLOSED(无模型配置不领取任务:117-125);测试/生产注入路径正确且 e2e 显式 workerMode:"stub" 标注;缺口:createLiveWorkerDriver 恒报 mode:"live",stubInjection 时未在代码面强制改标/校验,仅注释约定 → R-3 |
| D-8 证据落盘 | **部分覆盖(流程位置)** | 4 个日志 + 8 张截图已落盘且内嵌 HEAD cb3cceb;`REPORT.md`/`REVIEW.md` 尚未在 p0-02c/(分别属 D-12 收尾与本复核后续步骤)→ R-7/OBS |
| D-9 独立复核 | **进行中** | 首轮报告即 D-9 产物(draft);写者未代写复核结论(diff 可证) |
| D-10 CI | **代码已落地,首跑待推送** | ci.yml 新增独立 e2e job(Chromium + PG16 service + RELAY_E2E=1),与 test job 并行;origin/main 仍在 78e4d5e ⇒ 该 job 尚未在 GitHub 实跑 → R-7 |
| D-11 P0-02B 文档一致性 | **已覆盖** | 44be756 diff:REPORT §1 测试行改为指向 §8.4/§8.5 终态口径(163=161+2),143/158 标注过程数;§8.5 新增"未消除风险"段(根因未定位,不得以重跑变绿替代归因);CONTINUATION 测试基建行更新 163/40 文件。未掩盖风险(风险被升格登记而非删除) |
| D-12 收尾 | **待完成(流程位置在后)** | CURRENT.md 仍为 P0-02C ACTIVE(待复核后收尾更新)、CONTINUATION 终态行、p0-02c/REPORT.md 均未落 → R-7 |

### 验收反例 1..10(首轮)

| 反例 | 结论 | 断言证据 |
| --- | --- | --- |
| 1 未认证 401/302 无业务数据 | **已覆盖** | web-api 反例1:401 且 body.dashboard/goals undefined;`/` 302→/login.html(redirect:manual) |
| 2 CSRF 缺失/错误 403 零变更 | **已覆盖** | web-api 反例2:缺头/错头均 403;目标计数不变 + 无"不该被创建"行 |
| 3 非 operator 403 零变更 | **已覆盖** | web-api 反例3:改 RELAY_OPERATORS ⇒ 403 actor_not_authorized,无泄漏行;恢复后同会话 201 |
| 4 expectedStateVersion 失配 409 | **已覆盖** | web-api 反例4:v6 ⇒ 409 state_version_mismatch,任务仍 NEEDS_DECISION/版本 7、决策仍 OPEN;v7 ⇒ 200 且任务 READY |
| 5 D3 超时不自动批准 | **已覆盖** | web-api 反例5(expireStaleDecisions 后 EXPIRED_STILL_BLOCKED + verdict NULL + 任务 NEEDS_DECISION)+ capabilities 源码自证单测 + e2e J2(DB 断言 + UI 三键无自动入口) |
| 6 疑似令牌脱敏 | **已覆盖** | redact 7 单测 + web-api 反例6(证据原文注入 ghp_ ⇒ API 响应无明文) |
| 7 刷新+断线重连等于 DB | **已覆盖** | e2e J5(渲染值 == API == DB;断线横幅明示快照非实时) |
| 8 Worker 崩溃显示失败 | **已覆盖** | e2e J3(exit-mid 桩 ⇒ Run FAILED/rpc_disconnect 于 UI 运行记录可见;任务回 READY attempt=1;Dashboard 异常面板 run_failed;截图 j3-*) |
| 9 GitHub 无 PAT 保持 NOT_VERIFIED | **已覆盖** | capabilities 单测 + UI 徽章/changeset caveat(J4 断言 caveat 含 NOT_VERIFIED + GitHub);交付目标为本地 bare 远端(j4 截图 target=/tmp/p02c-e2e-remote-…) |
| 10 未实现能力显式标记 | **已覆盖** | capabilities 5 单测 + e2e J1(model-analysis-notice 含"未实现";分析来源=确定性规则推导;建议含依据/验证方式) |

### 真实验收 J1..J5(首轮)

| 旅程 | 结论 | 证据 |
| --- | --- | --- |
| J1 模糊需求创建 | **已覆盖** | e2e + j1-goal-created.png(UI 真实输入/点击;分析来源徽章、模型未实现告示、建议含依据/验证方式) |
| J2 D3 长期未审批 | **已覆盖** | e2e + j2-decision-inbox-d3.png / j2-goal-a-blocked.png(dec-e2e-d3 保持 OPEN、任务 NEEDS_DECISION;无关任务推进到 ACCEPTED;UI 三动作) |
| J3 Worker 崩溃 | **已覆盖** | e2e + j3-crash-recovery.png / j3-dashboard-anomaly.png(FAILED 原因/恢复状态/异常面板) |
| J4 候选变更→交付 | **已覆盖** | e2e + j4-changeset-delivered.png(三 SHA 两两不等;Gate PASS 已消费;DELIVERED 且远端头==commit;本地 bare 目标;NOT_VERIFIED 口径) |
| J5 刷新断线重连 | **已覆盖** | e2e + j5-offline-banner.png / j5-reconnected.png(三态与 PG 一致;断线横幅) |

---

## §三 发现(首轮,R-1..R-8)

### R-1(MINOR,首轮定为必修)G-1 的"落审计"未落 audit_events,且非回环拒绝/显式放行零测试覆盖
- 复现:`grep -rn "refuse_non_loopback\|ALLOW_NON_LOOPBACK" test/ src/` — 仅 app.ts:86-88 一处实现,无任何测试引用;拒绝路径为构造函数抛错 → index.ts:101-104 `console.error` 输出 stderr,不写 audit_events(合同原文:"启动即拒**并落审计**")。
- 影响:默认回环面下安全影响为零;但合同字面要求未满足,拒绝事件不留仓库内可追溯审计行,回归无护栏。
- 首轮建议:拒绝时写一条 audit_events 行;补两条单测(非回环无 env ⇒ 抛;显式放行 ⇒ 可构造)。

### R-2(MINOR,OBS)登录限速键盲信 X-Forwarded-For,可被伪造绕过锁定
- 复现:app.ts:64-68 `clientIp` 优先取 `x-forwarded-for` 首段;auth.ts 按 clientKey(=IP)计数。攻击者每次带不同 XFF 即获得全新失败计数,锁定窗口失效。
- 影响:默认仅回环监听(无代理场景)时实际风险低;一旦显式放行非回环(G-1 允许的配置)且前面无可信代理,口令爆破防护被削弱。

### R-3(MINOR,首轮定为必修)createLiveWorkerDriver 恒报 mode:"live",stubInjection 未在代码面强制标注为 stub
- 复现:worker.ts:114 `return { mode: "live", ... }`;stubInjection(71-76)仅由注释约束"注入时 workerMode 必须显式标 stub",无断言/强制。当前 e2e 正确(显式传 workerMode:"stub"),生产 index.ts 不注入 stub ⇒ 现网路径无实际错标;但该约束一旦被新调用方遗漏,UI/API 将以"live"名义展示桩执行,违反 D-7 精神。

### R-4(OBS)D-4 文件名偏差:合同写 `src/server/queries.ts`,实现为 `src/server/views.ts`
- 实质满足(35/35 条 SQL 均为 SELECT,零写操作);属合同文字与实现的命名不一致,建议在收尾文档注明。

### R-5(OBS)verifySameOrigin 对 `Origin: null` 放行
- auth.ts:202 `if (origin && origin !== "null")`。风险由 CSRF 头 + SameSite=Strict + Sec-Fetch-Site 三层兜底(沙箱 iframe 取不到会话 Cookie);现状可接受,记录在案。

### R-6(OBS)buildGoalAnalysis 的 derivedTasks[].goalText 填的是任务 id 而非目标文本
- views.ts:824 `goalText: t.id`。页面未渲染该字段(goal.js 只展示 taskId/gate 徽章/作用域),无用户可见影响;若未来渲染会显示误导性文本。

### R-7(OBS)收尾项尚未发生(流程位置在首轮复核之后,非虚报)
- p0-02c/ 无 REPORT.md、REVIEW.md;CURRENT.md 未做包终态更新;origin/main == 78e4d5e ⇒ cb3cceb/44be756 未推送,新增 e2e CI job 尚未在 GitHub 首跑(D-10 的 CI 绿、退出条件的前置检验均待完成)。首轮复核人未验证 GitHub CI 结果,属如实未验证项。

### R-8(OBS)external 模式下 `/api/worker/tick` 返回 500 而非明确不可用码
- api.ts:355-361 仅 worker 为 null 时 501;index.ts 默认挂 createExternalWorkerDriver,其 tick 抛错 ⇒ 走通用 catch ⇒ 500 internal_error(message 为 external_worker_mode:…)。前端提示可读,仅状态码语义略糙。

---

## §四 亲测记录(首轮;复核时 HEAD:`44be7562ab97a231dea6dc0eba0d41076f61e2cc`,工作区 clean)

| 命令 | 结果(真实输出摘要) |
| --- | --- |
| `npx tsc --noEmit` | **0 错误**(exit 0,无输出) |
| `npx vitest run test/unit/redact.test.ts test/unit/capabilities.test.ts test/integration/web-api.test.ts` | **23 passed / 23**(redact 7 + capabilities 5 + web-api 11),3 files passed,3.60s;真 PG(127.0.0.1:55433 可达) |
| `RELAY_E2E=1 npx vitest run test/e2e` | **5/5 passed**(J1 654ms / J2 2510ms / J3 1607ms / J4 1685ms / J5 657ms),9.54s,真 Chromium。运行过程重写了 p0-02c/ 证据文件(佐证其为测试真实产物),复核人事后 `git checkout -- p0-02c/` 还原,12 个文件 sha256 与提交态逐一 OK,工作区恢复 clean |
| `npx vitest run`(全量,后台 246s) | **44 files:43 passed + 1 skipped;191 tests:184 passed + 7 skipped**(7 skip = github-real 2 凭据门 + e2e 5 RELAY_E2E 门),与"P0-02B 终态 163 + 本包新增 28 = 191"账目吻合 |
| grep 自证:D3 自动批准 | 剥注释后扫描 src/server/*.ts + src/core/decisions.ts + goal-loop.ts:`auto-approve|approve-on-timeout|setTimeout|setInterval` **零命中**;唯一命中为 capabilities.ts:69 的登记 id `decision.d3.auto_approve`(显式声明"永不存在",NOT_IMPLEMENTED) |
| grep 自证:web/ innerHTML | `innerHTML` 仅 2 处:app.js:4 注释、app.js:33 防御性 throw;`insertAdjacentHTML/outerHTML/document.write/eval/new Function` 零命中 |
| grep 自证:服务端强推面 | src/ 中 `--force` 仅 2 处注释(刻意不带 --force,V10 语义);src/server/ 无 child_process/execFile/spawn |
| grep 自证:views.ts 只读 | 35 处 `exec.execute(sql\`)` 模板首词逐一核对,**全部 SELECT**;无 INSERT/UPDATE/DELETE/DROP/TRUNCATE |

环境事实:本机 PG 127.0.0.1:55433 可达;vitest 3.2.7;首轮复核全程未修改任何源代码与测试(唯一写入物为 REVIEW.draft.md;e2e 亲测产生的证据改动已还原并校验)。

**未验证项(首轮,如实披露)**:GitHub Actions 上新增 e2e job 的实际运行结果(推送未发生,无法验证);真实模型链路(本包合同明确为 0 次,全部桩执行);GitHub 真实写入(合同既定 NOT_VERIFIED,凭据门 skip)。

---

## §五 首轮结论

**首轮裁决:PASS-WITH-FIXES**(HEAD `44be756`)。

依据:G-2..G-8 全部满足且断言真实;反例 1..10 逐条有专属断言;J1..J5 有真实浏览器证据且与 DB 日志交叉一致;复核人独立复跑全部绿;证据无伪造迹象。必修项:R-1(G-1 审计+测试)、R-3(stub 标注代码面强制)。处置情况见 §六。

---

## §六 处置复核(复验轮,Reviewer 第二轮输出;HEAD `4c8118e52fff4414071ac54677430452cd33942a`)

### 6.1 处置 diff 审阅(`git diff 44be756..4c8118e`,7 文件,+185/−21)

| 项 | 处置内容(diff 核实) | 复验结论 |
| --- | --- | --- |
| **R-1(必修)** | `app.ts` 新增 `BindRejectedError`(含 host)与 `ensureLoopbackBind`(127.0.0.1/::1/localhost 放行;否则非 `RELAY_WEB_ALLOW_NON_LOOPBACK=1` 即抛);`createRelayServer` 改调 `ensureLoopbackBind`(拒绝语义与首轮完全一致);新增 `auditBindRejected`(db.transaction + core appendAudit,action=`WEB_BIND_REJECTED`、authority=`OWNER`、actor=`relay-web`、detail{host,reason,note},**try/catch 尽力而为:库不可达时 stderr+退出兜底**);`index.ts` 把 `createRelayServer` 包进 try/catch:BindRejectedError ⇒ 先 `await auditBindRejected` 再 stderr + `closeDb` + `exit(1)`。`OWNER` 为 `AuditAuthority` 联合类型首成员(audit.ts:7),类型合法 | **满足必修标准**。审计行真实落 audit_events(新单测断言 authority/actor/detail.host/note);两条拒绝路径(ensureLoopbackBind + createRelayServer)与显式放行均有测试;best-effort 语义正确(主防线=退出,审计失败不阻断拒绝);index.ts 退出路径闭环(closeDb 后 exit,不悬挂句柄) |
| **R-3(必修)** | `worker.ts:114` 改为 `mode: options.stubInjection ? ("stub" as const) : "live"` — 代码面强制,不再依赖调用方自觉 | **满足必修标准**。新断言:stubInjection ⇒ `stubbed.mode==="stub"`;无注入 ⇒ `live.mode==="live"`(web-api 新用例);e2e 原有显式 `workerMode:"stub"` 传参保持一致(现在冗余但无害) |
| **R-6(OBS,顺手修)** | `views.ts` GoalAnalysis 接口与实现删除 `goalText` 字段;全仓 grep 确认无任何消费者引用该字段(web/、tests、server 均无;剩余 goalText 命中属 runtime/其他测试的无关 API) | **已修复,无回归** |
| **R-8(OBS,顺手修)** | `api.ts` `/api/worker/tick`:`!worker || worker.mode === "external"` ⇒ 501 `worker_not_available` | **已修复**。新集成用例经真实 HTTP(登录+CSRF)实测 external server tick ⇒ 501 + worker_not_available |
| **R-2/R-5(OBS,不修)** | 登记于 `p0-02c/REPORT.md` §5(XFF 限速键加固留待非回环需求出现时与可信代理配置同做;Origin:null 三层兜底说明) | **登记属实**(REPORT.md 已落盘,内容与首轮发现一致,无弱化) |
| **R-4(OBS,注明)** | REPORT.md §5 注明"合同 D-4 写 queries.ts,实现为 views.ts——命名偏差,实质满足(35 SQL 全 SELECT)" | **登记属实** |

### 6.2 新增测试真实性

- `test/unit/web-app.test.ts`(4 例):回环三地址放行;非回环无放行 ⇒ `ensureLoopbackBind` 与 `createRelayServer` 双路径均抛 `BindRejectedError`(并断言 err.host 与 message 含 refuse_non_loopback_bind,`expect.unreachable()` 防恒真);显式 `RELAY_WEB_ALLOW_NON_LOOPBACK=1` 放行(测后还原 env);审计行断言(SELECT audit_events WHERE action='WEB_BIND_REJECTED',authority=OWNER、actor=relay-web、detail.host、note 含"非回环")。**断言真实,无恒真**。
- `test/integration/web-api.test.ts` 新增 1 例(第 12 例):mode 断言 + external 501 实测(HTTP+CSRF 全链)。

### 6.3 复验亲测(HEAD `4c8118e`;真 PG 127.0.0.1:55433)

| 命令 | 结果(真实输出摘要) |
| --- | --- |
| `npx tsc --noEmit` | **0 错误**(exit 0) |
| `npx vitest run test/unit/web-app.test.ts test/integration/web-api.test.ts` | **16 passed / 16**(web-app 4 + web-api 12),2 files passed,4.31s |
| `RELAY_E2E=1 npx vitest run test/e2e` | **5/5 passed**(J1 648ms / J2 2438ms / J3 1623ms / J4 1571ms / J5 666ms),9.57s,真 Chromium,处置树产出。跑前备份写者再生产物(sha256 + 副本),跑后按副本还原;还原后 `e2e-journey.log` 首行仍为 `# produced on commit 4c8118e52fff…(P0-02C 处置树…;首版证据产自 cb3cceb,处置后重跑再生)` — **写者声称的证据时序标注属实**(首版 cb3cceb、处置树再生,两代证据均在日志首行内嵌产出 HEAD) |
| `npx vitest run`(全量,第一次,20:32) | **1 failed(gate-e2e)/ 188 passed + 7 skipped(196)** |
| `npx vitest run`(全量,第二次,20:38) | 同上:仅 `test/integration/gate-e2e.test.ts` 1 例 45s 壁钟超时失败,其余全绿 |
| `npx vitest run test/integration/gate-e2e.test.ts`(隔离,20:42) | **1 passed**(自治闭环 57.3s,总 71.7s)— 失败可复现性消除 |

### 6.4 复验中发现的新事实(登记为 R-9)

**R-9(OBS,不阻塞)全量 vitest 在宿主并发活动下 gate-e2e(P0-02A 真实模型链)可壁钟超时;隔离复跑绿。**
- 事实:复验两次全量运行中 `gate-e2e.test.ts`(P0-02A 真实模型全闭环,依赖本地 magpie 模型路由 + 宿主 egress 栈,环内壁钟 45s)均在 45.0s 超时失败;两次运行期间写者正在同一工作树活动(REPORT.md 于 20:35 落盘,介于两次全量之间;`docs/CONTINUATION.md` 明文记载"vitest 全量与克隆复现共享宿主 egress 栈,不可并行…人工并行跑两份会互踩")。隔离单跑该文件 ⇒ 通过(57.3s)。
- 判定:该文件不引用 `src/server/*`(处置 diff 仅涉 server 层),与处置无因果;失败形态与 P0-02B 已登记的"瞬时/环境型未消除风险"同源(并发争用 ⇒ 模型路由变慢 ⇒ 环壁钟超时)。**不构成处置回归**。
- 要求:包退出条件的"全量绿"以 CI(GitHub test job,隔离环境)为准;若本地补验,须在无并发活动的窗口单跑。此项与 P0-02B §8.5 未消除风险一并留档,不新开启修复义务。

### 6.5 收尾状态核对(复验时点)

- `p0-02c/REPORT.md` 已落盘(写者,20:35):COMPLETE-WITH-PENDING 口径、R-2/R-4/R-5 OBS 登记、未验证项如实(NOT_VERIFIED / 0 次真实模型)。写者侧终账声明:全量 196 = 189 passed + 7 skipped(45 文件)+ tsc 0 + e2e 5/5 — **复核人因 6.4 所述并发窗口未能独立复得一条全绿全量,以隔离复跑(gate-e2e 绿)+ 分套件全绿(web-app/web-api 16/16、redact/capabilities 23/23 首轮已验、e2e 5/5 复验已验)覆盖;最终全量绿由 CI 隔离运行确认**。
- 尚待收尾提交(合同 D-12,流程位置在复核之后):本 REVIEW.md 终版落盘(本次完成)、REPORT.md/evidence(4c8118e 再生产物)入提交、CURRENT.md 与 docs/CONTINUATION.md 包终态更新、快进推送 `origin/main`、GitHub CI `test` + `e2e` 两 job 双绿。

---

## §七 最终裁决(复验轮)

**终版裁决:PASS**

依据:
1. **两项必修全部处置到位并经亲测验证**:R-1(绑定拒绝落 audit_events + 拒绝/放行双路径 + createRelayServer 路径共 4 单测全绿)、R-3(stubInjection ⇒ 代码面强制 mode:"stub" + 双向断言)。处置 diff 干净,未引入新问题(index.ts 退出路径闭环;auditBindRejected 尽力而为语义正确,主防线为退出;`OWNER` 为合法 AuditAuthority)。
2. **顺手处置 R-6/R-8 均验证通过**(goalText 字段删除无消费者、external tick 501 实测);R-2/R-4/R-5 已如实登记于 REPORT.md,无弱化、无掩盖。
3. **复验亲测**:`tsc` 0 错误;web-app+web-api **16/16**;`RELAY_E2E=1` e2e **5/5**(处置树,真 Chromium);首轮已验的反例 1..10 断言面未因处置变动(处置不触及 auth/redact/core 决策路径)。
4. **证据链完整且时序诚实**:首版证据(cb3cceb)与处置树再生产物(4c8118e)均在日志首行内嵌产出 HEAD 并标注再生时序;复核人以自身重跑反复佐证证据为测试真实产物。
5. gate-e2e 全量并发超时为环境型现象(R-9,隔离复跑绿,与处置无因果),按 CI 隔离结果为准。

**随 PASS 附带的退出条件清单(写者收尾提交时逐项落实,不构成复审触发)**:
- [ ] 收尾提交:p0-02c/(REPORT.md + 处置树再生产物证据 + 本 REVIEW.md)、CURRENT.md 与 docs/CONTINUATION.md 包终态更新;
- [ ] 快进推送 `origin/main == HEAD`,worktree clean;
- [ ] GitHub CI `test` job 与新增 `e2e` job 双绿(D-10;全量绿的权威口径);
- [ ] R-9 所记"全量须无并发窗口"经验与 P0-02B §8.5 未消除风险并档;R-2/R-5 维持登记,待非回环放行需求出现时处置。

---

- 首轮复核:HEAD `44be7562ab97a231dea6dc0eba0d41076f61e2cc`,2026-11-10 20:20(+08:00),裁决 PASS-WITH-FIXES
- 复验裁决:HEAD `4c8118e52fff4414071ac54677430452cd33942a`,2026-11-10 20:44(+08:00),裁决 **PASS**
- 复核人工作树状态:证据文件为处置树再生产物(未提交,待收尾提交纳入);本报告为复验轮唯一新增文件(draft 已由复核人删除)
