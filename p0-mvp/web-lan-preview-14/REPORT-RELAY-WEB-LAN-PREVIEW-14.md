# RELAY-WEB-LAN-PREVIEW-14 交付报告(2026-11-18)

合同:CURRENT.md 顶部 **RELAY-WEB-LAN-PREVIEW-14 🔵 ACTIVE**(合同提交 `feacc99`,CI 44193131384 test+e2e 双 success)。授权=用户 2026-11-18 直接指令「直接开发局域网访问权限」。
本包边界:**生产零变化;LAN≠公网(公网暴露禁止不变)**;工程阶段结论仅认 **LAN_READY / REWORK / BLOCKED**;`WEB-UX-03 UX ACCEPTED` 唯一归属用户本人实机操作与明确反馈,Agent 不代宣布。

## 0. 结论(工程面)

**LAN_READY(独立 Reviewer 终裁 PASS:0 Major / 1 Minor 非阻断)**:13 的隔离预览新增显式 `--lan` 局域网访问开关——Mac(及同网段手机)可在**可信局域网**内免 SSH 隧道直接浏览器访问预览并完成全旅程;缺省(无旗标)行为不变仍仅 127.0.0.1;server 层 G-1「非回环绑定必须显式放行」机制原样使用,零 src/ 改动。等待用户本人按 `MAC-ACCEPTANCE-CARD.md`(2026-11-18 版,含局域网直访节)实机体验;生产 D3 与 MVP 口径不变。

## 1. 冷启动/事实先核(全部亲核)

- live main=HEAD=origin `5cb5e8f`(13 收口,CI 44157235981 双 success)→ 快进登记 14 合同 `feacc99`;无分叉、无 stash、单 worktree;生产 PID **3242781/3242782**(2026-11-13 02:00:08 启动)前后未变。
- VM80 主网卡实测 `ens33 10.30.5.80/16`(与 MAC 卡 SSH 提示一致;另有 docker0/br-* 等容器网桥多张,`--lan` banner 如实全列)。
- **server 层事实先核(决定零 src/ 路线)**:`src/server/app.ts` `ensureLoopbackBind` 已内建非回环显式放行机制(`RELAY_WEB_ALLOW_NON_LOOPBACK=1`,app.ts:61-69,启动即拒+可审计);会话 Cookie 无 `Secure` 旗标(auth.ts:256 明注「本地 HTTP 隧道场景」,HttpOnly+SameSite=Strict);CSRF=会话绑定双提交、host 无关(auth.ts:193-195);web UI 轮询无 WebSocket、零硬编码 localhost(web/*.js 仅注释提及轮询)⇒ **LAN 直访纯脚本面可达,无需动任何 src/**。
- 测试库基线口径(13 收口教训):`p01a_*` 25 个历史残留全程在场未清(查询必须 `docker exec relay-p000-pg psql -U postgres -d relayp000`);`/tmp/webux11-preview-*` 基线 71 条(23 套 69 目录+2 旧日志)零触碰。

## 2. B 项先红(缺陷/缺口复现)

- 缺口:preview 脚本硬编码 `listen(port,"127.0.0.1")`,无任何局域网访问形态;用户 Mac 只能走 SSH 隧道。
- `test/e2e/webux13-preview-lifecycle.test.ts` 新增 **T3/T4**(T1/T2 13 既有逐字保留),TAG=audit-red **恰 1 failed|3 passed**:
  - **T3 红**=`--lan` 未实现:经本机非回环 IPv4(10.30.5.80)探针 `connect ECONNREFUSED 10.30.5.80:<port>`(红态证据 JSON+运行日志入库);
  - **T4 红轮即绿(如实登记,设计内)**=「缺省模式经 LAN IP 必须连接拒绝+回环仍正常」的防回归门在红轮本就通过——缺省绑定面语义早已正确,非缺陷,只是把它钉成回归门。
- **红态重放**(防证据歧义):以 `git checkout feacc99 -- scripts/webux11-preview.mjs` 精确还原父版本脚本(实施文件已先 stage 免疫,12R 教训),重跑恰 **1 failed|3 passed**,日志入库 `preview-lifecycle-audit-red-replay.log`;完毕即恢复实施版。

## 3. C 项最小实现(仅 scripts/webux11-preview.mjs +38/-7;零 src/、零 web/、零 Core、零迁移、零新依赖)

1. **`--lan` 显式旗标**:缺省(无旗标)**绑定面/listen 参数/shutdown 清理路径逐字段不变**(仍 `127.0.0.1`,T1/T2 绿实证);带 `--lan` ⇒ 设 `RELAY_WEB_ALLOW_NON_LOOPBACK=1`(server 层 G-1 显式放行机制按其设计用途使用)+ `listen("0.0.0.0")` + `createRelayServer({host:"0.0.0.0"})` 同源。
2. **banner**:`--lan` 时打印全部非内部 IPv4 访问 URL(`lanIPv4List()` 多网卡如实全列,本机=10.30.5.80+四张 docker 网桥)+⚠ 安全提示(仅限可信局域网/严禁端口映射或反向隧道到公网);缺省分支**新增一行**「局域网直接访问(可选):重启并加 --lan 旗标」提示——属输出面提示,绑定/清理/生命周期行为不变(T1/T2 绿证明),执行方如实登记此项输出差异。
3. **harness 证据目录迁移**:`webux13` 证据缺省落 `p0-mvp/web-lan-preview-14/evidence/`(`WEBUX13_OUT_DIR` 可覆盖;13 封存证据在 `mac-ux-handoff-13/` 原样零改写,M2/m3 教训应用)。
4. 安全属性(零改动、亲核沿用):一次性随机口令仅启动打印一次;Cookie HttpOnly+SameSite=Strict(无 Secure=纯 HTTP 局域网可用);CSRF 会话绑定;未登录业务页 302、/api 401;执行链仍为确定性 stub+一次性本地 bare(局域网访问者无口令进不去,进去了也只触达合成环境)。

## 4. D 项红绿+真实冒烟

- **绿轮**:TAG=verify **4/4 passed**(T1=登录面 302/401→200/200+SIGTERM exit 0+端口释放+schema 删除+/tmp 零新增;T2=启动窗口 SIGTERM 同面;T3=`--lan` 经 10.30.5.80 真实探针全绿+banner 断言+退出零泄漏;T4=缺省 LAN 拒绝+回环 401)。quality:quick **PASS**(182/182;首跑 format 2 文件漂移即修+typecheck `e?.name` TS2339 即修=过程如实登记,修复后复验同绿)。
- **真实 --lan 冒烟两轮**(真实脚本子进程+真实 HTTP/CSRF+隔离 PG,18890/18891):经 10.30.5.80 未授权 `/workspace` **302**→`/login.html`、`/api/health` **401**;随机口令 `POST /api/session` **200**;授权 `/workspace` **200**+`/api/health` **200**;`SIGTERM` **exit 0**、端口释放、preview 临时目录 **69→69 零新增**(only-own 同 13 口径)、`p01a_*` **25→25 零残留**(查询带 `-d relayp000`)。facts 证据入库 `preview-lan-smoke.log`(口令/Cookie 零落盘;冒烟用的临时 log/cookie 文件 mktemp+trap 即时删除,第一轮曾短暂计入 /tmp 计数的 +2 即此两文件、脚本自身零泄漏,已在终端核实 71 恢复)。
- **凭据卫生**:evidence 三份 JSON+2 日志零 16+ hex、零 csrfToken/set-cookie/bodyHead/pwHead(13 Major-2 教训应用);口令全程仅本机终端显示。

## 5. F 项 MAC 卡与交接

`p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md` 校订(2026-11-18 版):顶部口径+14(可选局域网直访,LAN≠公网);新增「**局域网直接访问(可选,`--lan`,免 SSH 隧道)**」节:VM80 `node scripts/webux11-preview.mjs --lan --port 8790` → banner 打印的 `http://10.30.5.80:8790/workspace` 在 Mac(或同网段手机)浏览器**直接打开**;安全口径(仅限可信局域网/严禁公网映射/一次性口令/退出清理一致/缺省仍 127.0.0.1)逐条写入;既有 SSH 隧道路径原样保留;手机节更新=同网段可经 `--lan` 直访最新版 B(真机 VPN/刘海/软键盘仍 NOT_TESTED 如实标注)。

## 6. CI 核验(exact-head,含计数口径)

- 合同提交 **44193131384@feacc99 test+e2e 双 success**(仅 CURRENT/CONTINUATION 两文件,零代码)。
- 实施提交 **44194276677@e72c6ce test+e2e 双 success 一次通过**;job 日志亲读含计数:e2e **65 passed|2 skipped(67)**=基线 63+新增 T3/T4,`webux13-preview-lifecycle` **4 tests 真跑(3719ms)**,Test Files 8 passed|2 skipped(10);test job quality:full **484 passed|85 skipped(569)/76 files**=13 基线不变(该文件无 RELAY_E2E 时仍恰 1 个门测试),quality:quick 182 不变;**变更面与计数逐项精确对账**。计数摘录 `ci-counts-e72c6ce-excerpt.log` 入库;回执 `ci-checkruns-e72c6ce.json` 留未跟踪循例(13 口径)。

## 7. 独立 Reviewer 终裁(回填)

- **独立 Reviewer(全新上下文,临时克隆 detached `e72c6ce` 冷启动亲测,非执行方工作区)终裁=PASS(0 Major / 1 Minor 非阻断)**;REVIEW 原文逐字入库 `REVIEW-RELAY-WEB-LAN-PREVIEW-14.md`(§一~§十一),执行方消化附 §十二。
- 九项判定全过:diff 面(零 src/ 零 web/ 零 Core)/红态独立复现(TAG=review-red 恰 1 failed=T3 `ECONNREFUSED 10.30.5.80` 逐字一致)/绿态 TAG=review 4/4(T1/T2 断言体逐字未动)/真实 --lan 冒烟(302→/login.html、401、口令登录 200、双 200、banner 5 个 LAN IPv4+⚠、SIGTERM exit 0、tmp 69→69、p01a_ 25→25 带 `-d relayp000`、口令零落盘)/**缺省不变性(env 条件赋值+bindHost 三元+shutdown/signal 行逐字节 IDENTICAL;缺省仅新增 1 行输出面提示判可接受)**/CI 独立核验(44194276677 双 success 含计数 65p|2s[67]、webux13 4 tests 真跑、484p|85s[569]、quick 182)/证据卫生(零 16+ hex/csrfToken/set-cookie 值/口令原文)/边界(生产 PID 常在/执行方工作区零改动/保护物在场零触碰/零 iptables/基线 25 schema+69 目录未清算)/MAC 卡逐条对照。
- **Minor-1(非阻断)=证据 JSON `contract` 字段硬编码 "RELAY-MAC-UX-HANDOFF-13"(元数据陈旧)**:消化=**登记未实施列入后续 harness 加固候选**(修复面 1 行字符串;目录+TAG+时间戳三重可消歧;收口提交不触碰代码面,使收口 CI 与被审 e72c6ce 测试行为完全同口径)。
- Reviewer 观察项如实登记:T4 红轮即绿属设计内;缺省 banner 新增 1 行属输出面已登记;执行方红态重放产生于自有工作区(实施过程证据)与 Reviewer 克隆红态(本审证据)并存互证;Reviewer 自身脚手架误杀包装层曾留短暂残留、对真实 node PID 补发 TERM 仍优雅收尾=清理健壮性反证(其 REVIEW §六已登记)。

## 8. 边界/生产影响/未验证项

- 生产影响=**零**:零生产读写/迁移/DDL/重启/配置/egress/防火墙/路由器/**公网暴露**/模型付费/外部 GitHub 交付;全部真实读写=一次性 p01a_ schema+本地 bare+合成数据,用后即毁;现役 relay-web/worker(PID 3242781/3242782,生产 8787 绑定面)未动;保护物 12 项零触碰;/tmp 基线 71 条零增删;p01a_* 25 个零清理。
- 未验证/限制(如实):`--lan` 绑定 `0.0.0.0` ⇒ docker 网桥地址(172.x)同样可达(容器网桥仅宿主本机可达面,如实登记不做额外收敛);局域网内**无口令者**仅能触达登录面(302/401),有口令者触达合成环境(stub 执行链,零真实副作用);手机真机(刘海/软键盘/VPN)=NOT_TESTED;**用户 Mac/手机实机体验=NOT_RUN(本包唯一剩余门=USER_DECISION)**;SIGKILL 强杀不可清理(设计限制沿 13);真实模型 F1/F2、24h、生产切换均维持既有口径未动。
- 生成物:`p0-mvp/web-lan-preview-14/`(REPORT+REVIEW;evidence 6 件入库=2 生命周期 JSON[audit-red+verify]+红态重放 JSON+重放日志+真实冒烟 facts 日志+CI 计数摘录,另 CI 回执留未跟踪循例);变更面=preview 脚本+测试+MAC 卡,合计零 src/、零 web/、零迁移、零新依赖。
