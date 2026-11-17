# RELAY-MAC-UX-HANDOFF-13 交付报告(2026-11-18)

合同:CURRENT.md 顶部 **RELAY-MAC-UX-HANDOFF-13 🔵 ACTIVE**(合同提交 `5457922`,CI 44012161445 test+e2e 双 success)。
本包边界:**生产零变化**;工程阶段结论仅认 **UX_HANDOFF_READY / REWORK / BLOCKED**;`WEB-UX-03 UX ACCEPTED` 唯一归属用户本人实机操作与明确反馈,Agent 不代宣布;生产 D3 与 MVP 口径不变。

## 0. 结论(工程面)

**UX_HANDOFF_READY(独立 Reviewer 两轮复核:Round 1 REWORK(2 Major/3 Minor,登记与证据面)→ 执行方全部消化 → Round 2 PASS(0 阻断;REVIEW 原文+消化记录+Round 2 终裁全文入库)**:最新 main 的隔离 Web 预览已可安全起停、正确登录并完成首次使用全旅程;启动脚本临时目录泄漏已按「只清自有」口径修复并有红/绿与三次真实交付链实证;Mac 一页操作卡已按 13 口径校订。等待两件用户本人动作:①按 `MAC-ACCEPTANCE-CARD.md` 在 Mac 实机体验并反馈(**USER_DECISION:用户 Mac UX 体验反馈**=工程阶段唯一剩余门,Agent 不代宣布 UX ACCEPTED);②生产 D3 是否另行授权(与本包无关,未动,预检 NO-GO 维持)。

## 1. 冷启动/现状先核(A 项,全部亲核)

- live main `40279ed` → 快进 `5457922`(13 合同提交;仅 CURRENT/CONTINUATION/协调方 12R Review 三文件,零代码);本地无分叉、无 stash、单 worktree;唯一 Writer,生产 PID **3242781/3242782**(2026-11-13 02:00:08 启动)前后未变=现役旧进程未被触碰。
- 合同提交 CI **44012161445@5457922** test+e2e 双 success;job 日志亲读含计数口径:e2e **61 passed|2 skipped(63)**、webux12 **15 tests 真跑**、test job quality:full **75 passed|17 skipped(92 files)**。
- 受保护 12 项(config/、soak-r3b/、10 份历史 CI 回执)零触碰零纳提交;权威文档 README/ARCHITECTURE_BASELINE/ADR-0010/WEB_UX_03_CONTRACT/MAC 卡/preview 脚本逐读。
- **基线登记(实施提交曾失实,经独立 Reviewer Major-1 指认后按 13 收口更正)**:测试库 relayp000 中 **25 个历史 `p01a_*` 残留 schema 全部在场、一个未清**(经授权测试三元组 127.0.0.1:55433/**relayp000** 实测;名单=c1_hb_err×4/c1_toolev×4/c2_budget×3/c2_runner×2/dbg_pie2e×5/p02a×1/rev1×1/review_f_cli×1/review_probe_f1×1/webux02×3,与合同"25 个不得清理"吻合)。**口径教训如实登记**:`docker exec relay-p000-pg psql -U postgres` 不带 `-d relayp000` 时默认连 postgres 库 ⇒ 该查询恒得假 0——实施提交 b78b8ac 的 REPORT/提交信息曾据此误记"冷启动实测 0 个、已被 12R 协调方清理",系**错误查询口径假象**,本轮从未清理任何 schema。正确口径:`psql -U postgres -d relayp000 -Atc "SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'p01a_%';"`。`/tmp/webux11-preview-{reg,remote-base,stage}-*` 历史泄漏目录冷启动实测 **各 4 套(12 个)+2 个旧日志**(11 轮以来每次预览运行遗留;verify 类 0 个)——按硬禁令**不清算、不归咎本轮**,仅作修复前基线。

## 2. B 项缺陷复现(先红)

缺陷(合同 B 原文逐条属实):preview 的 `reg/remoteBase/stageBaseDir` 及每次交付 verify scratch 均 `mkdtempSync`,而 shutdown 仅 `t.cleanup()`(只 DROP schema)⇒ **每次运行在 /tmp 泄漏一套目录**,且 SIGTERM 处理器在 `listen` 之后才注册(启动窗口收到信号=默认终止,全漏),SIGHUP(SSH 会话断开)未处理。

- 手工冒烟(修复前脚本,18881 端口):未登录 `/workspace` **302**、`/api/health` **401**;随机口令登录 `/api/session` **200**;授权后 **200/200**——登录面与协调方实证一致。SIGTERM 退出:端口释放 ✓、schema 删除 ✓、**新增泄漏恰 3 目录**(reg-XzCwgh/remote-base-KdKhuC/stage-F9r1zo;verify=0 因本轮无交付)。
- focused 生命周期测试 `test/e2e/webux13-preview-lifecycle.test.ts`(RELAY_E2E 门,证据落本包 evidence/):TAG=audit-red **恰 2 failed|0 passed**,失败集与缺陷逐字对应——T1(就绪后 SIGTERM)红于「退出后 /tmp 零新增」断言(实测 +3 目录);T2(启动窗口 SIGTERM)红于同一断言(+3 目录)。
- **测试自身笔误如实登记**(红轮迭代中发现即修,均有日志):①口令行正则未转义括号 ⇒ `(仅打印一次)` 被当捕获组,永不匹配(两次假红);②转义后恰 1 个捕获组仍取 `m[2]` ⇒ 口令=undefined ⇒ JSON.stringify 省略键 ⇒ 服务端空口令 401 假失败(教训=非空断言不能替代组号核对;独立复刻用 `m[1]` 即 200 定位);③断言失败路径未杀子进程 ⇒ 曾遗留 5 个孤儿预览进程+schema(当即 TERM 清零,并固化 try/finally 防孤儿)。孤儿/笔误均属测试面,脚本缺陷本体(泄漏)自始至终真实在场。

## 3. C 项最小修复(只动 1 个脚本+1 个新测试)

`scripts/webux11-preview.mjs`(+80/-30 量级,零 src/、零 web/、零 Core):

1. **自有目录登记+哨兵清理**:`newTemp()`=`markTemp(mkdtempSync())`+登记 `tempRoots`;退出经 `safeRm(dir,{roots,sentinel:RUN_SENTINEL})`(中央守卫:禁面/归属/哨兵/symlink 逃逸 fail-closed)——**只清本进程自己创建的目录**,历史/他人目录绝不触碰。
2. **信号处理器前置**:SIGINT/SIGTERM/**SIGHUP**(SSH 会话断开)在创建任何目录**之前**注册 ⇒ 任何时刻终止都走收尾;`process.on("exit")` 同步兜底未捕获异常路径。SIGKILL 无法拦截=诚实限制(卡内已注明)。
3. **启动窗口 schema 收尾**:`createTestDb` 以 promise 登记,早到信号的 shutdown 会 `await` 它并正常 DROP——启动窗口终止零 schema 残留。
4. **verify scratch 即时清理**:每次交付核验 `finally` 中 safeRm 自删(原先每核验留一个目录)。
5. **evidenceChecks 绿路径配置**(冒烟实证后补,与 webux11 e2e 夹具同款 deterministic_test):**修复前实测**——无功能证据配置时每个任务都走 D3 `functional_evidence_unconfigured` 保守停机(NEEDS_DECISION),批准后 fallback=null ⇒ **FAILED**,预览永远到不了 MAC 卡承诺的「已完成」绿路径(REAL API 冒烟亲证,changeset/交付已发生,GIT_COMMIT_BOUND+CHANGESET_RECORDED 在审计);配置后 stub 交付物 `delivered.txt:ok` 恰可通过 ⇒ Gate PASS ⇒ COMPLETED。纯脚本面配置,零 src/ 改动。
6. 测试 harness 凭据脱敏(**实施提交曾失实,经独立 Reviewer Major-2 指认后按 13 收口更正**):口令本体全程零入库(stdoutTail 口令行 `***REDACTED***`、pwHead 前缀移除)✓;但实施提交的 harness 曾自创 `bodyHead: loginBody.slice(0,120)` 诊断字段,**其内嵌登录响应体含 csrfToken 值前缀(60 hex)随两份证据 JSON 入库**——违反合同硬禁令字面(口令/Cookie/CSRF 禁止提交),且实施提交信息"CSRF 零入库"声明与事实相反。收口更正:①harness 移除 bodyHead 字段(任何响应体片段不再进证据);②入库 `preview-lifecycle-verify.json` 以修复后 harness 重生成(零 hex);③入库 `preview-lifecycle-audit-red.json` 的 csrf 前缀原地脱敏为 `***CSRF-REDACTED***`;④如实登记:b78b8ac 历史提交中仍含该截断前缀(一次性进程已退出即失效的内存 token,截断前缀,实质泄露风险≈0,口令本体确零入库;不 rewrite 已推送历史,以本收口提交为净化版本)。

## 4. D 项绿轮+真实交付链实证

- focused 测试 TAG=verify **2/2 passed**×2 次(biome 格式化后复验同绿):T1=登录面 302/401→200/200+exit 0+端口释放+schema 删除+**/tmp 零新增**;T2=启动窗口(reg 目录已现=处理器已装)SIGTERM ⇒ exit 0+零泄漏+零 schema 残留。
- **三次真实交付链冒烟**(真实脚本子进程+真实 HTTP/CSRF+隔离 PG):①无 evidenceChecks 轮=真实走通「创建→进度→D3 决策→批复」全链并如实记录 FAILED 结果(fail-closed 设计面);②有 evidenceChecks 轮=创建→COMPLETED(任务 ACCEPTED、Gate PASS、changeset 1);③截图轮=8 张双视口截图。**三次退出差分均为「恰删自建 3 目录、零新增」**(only-own 语义实证);verify scratch 全程 0 残留;孤儿进程 0;p01a_webux11_preview schema 残留 0。
- 红态轮泄漏总量(Reviewer Minor-m1 指认后按 13 收口补登):实施窗口(2026-11-18 02:11~02:22)内,修复前脚本的手工冒烟 1 套+测试迭代(假红×2 轮/独立复刻/audit-red 证据轮/交付冒烟轮)共 **17 套 51 目录**泄漏(每轮 3 目录;修复后运行即自清);加历史 4 套 12 目录,实施提交时点 /tmp 实有 **21 套 63 目录+2 旧日志**(Reviewer 亲测分组与执行方 mtime 分组一致)。全部无哨兵、归属不可证 ⇒ **如实登记、不清算**(遵守「不得粗暴删 /tmp」),与 12 个历史目录一并留作基线;Reviewer 红态复现另产生 2 套 6 目录(其 REVIEW 已自行登记,亦不清算)。

## 5. E 项真浏览器验收预演(C 项全旅程)

既有套件新鲜跑(TAG=macux13,不覆盖任何已封存轮次证据;日志入本包 evidence/):

| 套件 | 结果 | 覆盖合同 C 项 |
| --- | --- | --- |
| webux11-firstuse-audit | **6/6**(83s) | 首次登录/空白态/创建 Goal/Feed 进度/内联 Decision/失败链/Result/追问/刷新;桌面 1440×900+手机 390×844 |
| webux12-goal-idempotency | **15/15**(2.6s) | ACK 丢失重试同 Goal/并发同键/同键异 payload·绑定·跨会话 409/同目录项目别名/UUID 大小写/旧格式键防回归 |
| webux11r-terminal-execute | **10/10**(119s) | 终态「新建后续任务」/PAUSED 指引/暂停不暗启/双击防重/≥44px 触控 |
| webux13-preview-lifecycle(新增) | **2/2** | 预览安全起停+只清自有(合同 B/C 缺口,恰 1 个新增 focused harness=合同上限内) |

真实 preview 脚本截图 8 张(本包 screenshots/preview/,Playwright+Chromium,零控制台错误,manifest 入库):01 登录页、02 桌面空白态(唯一主按钮+零项目引导)、03 进度块、04 绿色结果卡(代码修改/4 项测试/独立复核/已提交 GitHub+查看修改)、05 **「新建后续任务」真实创建新需求**(ACTIVE 态恢复双按钮=方案 A 语义)、06 手机空白态、07 手机进度、08 手机结果卡——**逐张亲核**。空草稿行为实测:空输入点「开始」⇒ 无请求/无导航/零页面错误,空白态保持。网络断开恢复=11R abort 注入草稿保留重试成功覆盖;浏览器刷新=11 D2/11R 覆盖。SIMULATED(模型/Git/交付=确定性 stub+本地 bare)×REAL(Web/Chromium/API/隔离 PG)边界全程如实区分,不声称生产模型或真 GitHub。

## 6. F 项 Mac 一页操作卡(D 项)

`p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md` 校订:顶部口径按 13 刷新(12R 协调方已 PASS;重试安全=同一意图·同项目·同键);A/B 差异表更新(B=11~13 全部修复;生产 PID 未变);启动方法保留前台一条命令+新增**可选限时后台** `timeout 30m node scripts/webux11-preview.mjs`(到点自动退出并清理,不长期占用);退出与清理保证(含 SIGHUP=关终端场景)如实写入并注明 SIGKILL 例外;截图指针指向本包 8 张真实预览截图;三条测试需求与旅程表按绿路径实证刷新;口令/凭据零出现于卡面。

## 7. G 项独立 Reviewer 与 CI(E 项)

- **独立 Reviewer 终裁原文入库** `REVIEW-RELAY-MAC-UX-HANDOFF-13.md`(临时克隆 detached b78b8ac,隔离冷启动亲测:变更面 22 文件恰在合同范围零 src/零 web/零 migrations;红态=父版本脚本恰 2 failed 均泄漏各 +3 目录;绿态 lifecycle 2/2+webux11 6/6+webux12 15/15;真实起停 SIGTERM 与 SIGHUP 两轮均 exit 清理/恰删自建 3 目录/仅绑 127.0.0.1/零孤儿/schema 零残留;脚本修复面与 safe-rm 守卫逐条亲读;MAC 卡逐条对照;CI 独立核验;生产 PID/保护物/零 commit 边界全过)。**终裁=REWORK(2 Major/3 Minor)**,范围=登记与证据面、不涉修复逻辑本体;**执行方按上列 §1/§3⑥/§4 补登与脱敏全部消化**(本收口提交即净化版本),消化记录附于 REVIEW 文末。
- **exact-head CI(实施提交)**:**44150658655@b78b8ac test+e2e 双 success 一次通过**;job 日志亲读含计数口径:e2e **63 passed|2 skipped(65)**=基线 61+新增 2,webux13-preview-lifecycle **2 tests 真跑**(1896ms,T1/T2 具名),webux12 15、webux11 6(81.5s)、webux11r 10;test job quality:full **76 passed|17 skipped(93 files)/Tests 484 passed|85 skipped(569)**=基线 75|17(92)+新文件 1(其 RELAY_E2E 未开启分支的门测试 1 test 真实断言通过),quality:quick 21 files/182 tests 不变——**变更面与计数逐项精确对账,无 ba70fd0 式「绿而不全」**;biome format 覆盖两个新增文件。回执 ci-checkruns-b78b8ac.json+ci-e2ejob-b78b8ac-excerpt.log 留未跟踪循例。收口提交自身 CI 推送后核验。

## 8. 边界/生产影响/未验证项

- 生产影响=**零**:零生产读写/迁移/DDL/重启/配置/egress/防火墙/公网暴露/模型付费/外部 GitHub 交付;全部真实读写=一次性 p01a_ schema+本地 bare+合成数据,用后即毁;现役 relay-web/worker(PID 3242781/3242782)未动;保护物 12 项零触碰。
- 未验证/限制(如实):SIGKILL 强杀不可清理(进程内无法拦截,设计限制);手机真机(VPN/刘海/软键盘)=NOT_TESTED;**用户 Mac 实机体验=NOT_RUN(本包唯一剩余门=USER_DECISION)**;真实模型 F1/F2、24h、生产切换均维持既有口径未动。Reviewer 观察项(登记不实施):harness 指定 TAG 字面复跑会覆盖同名 TAG 的既有封存证据(Minor-m3,非 13 引入,列入后续 harness 加固候选)。
- 生成物:`p0-mvp/mac-ux-handoff-13/`(REPORT+REVIEW;**evidence 9 文件**[5 日志+2 生命周期 JSON+2 CI 计数日志,另 2 份 CI 回执留未跟踪循例——实施提交 §8 曾笔误「evidence×10」,经 Reviewer Minor-m2 指认更正];screenshots 8 png+manifest);变更面=preview 脚本+新测试+MAC 卡+REPORT/REVIEW,合计零 src/、零 web/、零迁移、零新依赖。
