# RELAY-MAC-UX-HANDOFF-13 交付报告(2026-11-18)

合同:CURRENT.md 顶部 **RELAY-MAC-UX-HANDOFF-13 🔵 ACTIVE**(合同提交 `5457922`,CI 44012161445 test+e2e 双 success)。
本包边界:**生产零变化**;工程阶段结论仅认 **UX_HANDOFF_READY / REWORK / BLOCKED**;`WEB-UX-03 UX ACCEPTED` 唯一归属用户本人实机操作与明确反馈,Agent 不代宣布;生产 D3 与 MVP 口径不变。

## 0. 结论(工程面)

**UX_HANDOFF_READY(工程自评,待独立 Reviewer 终裁)**:最新 main 的隔离 Web 预览已可安全起停、正确登录并完成首次使用全旅程;启动脚本临时目录泄漏已按「只清自有」口径修复并有红/绿与三次真实交付链实证;Mac 一页操作卡已按 13 口径校订。等待两件用户本人动作:①按 `MAC-ACCEPTANCE-CARD.md` 在 Mac 实机体验并反馈(USER_DECISION:用户 Mac UX 体验反馈);②生产 D3 是否另行授权(与本包无关,未动)。

## 1. 冷启动/现状先核(A 项,全部亲核)

- live main `40279ed` → 快进 `5457922`(13 合同提交;仅 CURRENT/CONTINUATION/协调方 12R Review 三文件,零代码);本地无分叉、无 stash、单 worktree;唯一 Writer,生产 PID **3242781/3242782**(2026-11-13 02:00:08 启动)前后未变=现役旧进程未被触碰。
- 合同提交 CI **44012161445@5457922** test+e2e 双 success;job 日志亲读含计数口径:e2e **61 passed|2 skipped(63)**、webux12 **15 tests 真跑**、test job quality:full **75 passed|17 skipped(92 files)**。
- 受保护 12 项(config/、soak-r3b/、10 份历史 CI 回执)零触碰零纳提交;权威文档 README/ARCHITECTURE_BASELINE/ADR-0010/WEB_UX_03_CONTRACT/MAC 卡/preview 脚本逐读。
- **新事实如实登记**:测试库 `p01a_*` schema 冷启动实测 **0 个**(12R 收口时登记的 25 个历史会话残留 schema,已被 12R 协调方按其抽核方法学清理;本轮零清理动作,非本轮所为)。`/tmp/webux11-preview-{reg,remote-base,stage}-*` 历史泄漏目录冷启动实测 **各 4 套(12 个)+2 个旧日志**(11 轮以来每次预览运行遗留;verify 类 0 个)——按硬禁令**不清算、不归咎本轮**,仅作修复前基线。

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
6. 测试 harness 永久脱敏:证据 JSON 不落口令前缀/全文(stdoutTail 口令行 `***REDACTED***`);红态 JSON 中已有口令字段原地脱敏并在此如实登记(硬禁令:口令/Cookie/CSRF 禁止提交)。

## 4. D 项绿轮+真实交付链实证

- focused 测试 TAG=verify **2/2 passed**×2 次(biome 格式化后复验同绿):T1=登录面 302/401→200/200+exit 0+端口释放+schema 删除+**/tmp 零新增**;T2=启动窗口(reg 目录已现=处理器已装)SIGTERM ⇒ exit 0+零泄漏+零 schema 残留。
- **三次真实交付链冒烟**(真实脚本子进程+真实 HTTP/CSRF+隔离 PG):①无 evidenceChecks 轮=真实走通「创建→进度→D3 决策→批复」全链并如实记录 FAILED 结果(fail-closed 设计面);②有 evidenceChecks 轮=创建→COMPLETED(任务 ACCEPTED、Gate PASS、changeset 1);③截图轮=8 张双视口截图。**三次退出差分均为「恰删自建 3 目录、零新增」**(only-own 语义实证);verify scratch 全程 0 残留;孤儿进程 0;p01a_webux11_preview schema 残留 0。
- 红态轮测试自身造成的泄漏目录(无哨兵、归属不可证)**如实登记、不清算**(遵守「不得粗暴删 /tmp」),与 12 个历史目录一并留作基线。

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

## 7. G 项独立 Reviewer 与 CI(E 项,收口提交回填)

- 独立 Reviewer:临时克隆 detached 实施提交,隔离冷启动亲测(红态复现方法=取实施提交父版本的脚本;绿态全套件;起停/只清自有/CSRF/回环绑定/HTTPS 禁令/历史 UI 回归/卡准确性),终裁原文入库 `REVIEW-RELAY-MAC-UX-HANDOFF-13.md`。
- exact-head CI:见收口提交回填(实施提交 SHA+run id+双 job 计数,必须含测试数量核对,防 ba70fd0 式「绿而不全」)。

## 8. 边界/生产影响/未验证项

- 生产影响=**零**:零生产读写/迁移/DDL/重启/配置/egress/防火墙/公网暴露/模型付费/外部 GitHub 交付;全部真实读写=一次性 p01a_ schema+本地 bare+合成数据,用后即毁;现役 relay-web/worker(PID 3242781/3242782)未动;保护物 12 项零触碰。
- 未验证/限制(如实):SIGKILL 强杀不可清理(进程内无法拦截,设计限制);手机真机(VPN/刘海/软键盘)=NOT_TESTED;**用户 Mac 实机体验=NOT_RUN(本包唯一剩余门=USER_DECISION)**;真实模型 F1/F2、24h、生产切换均维持既有口径未动。
- 生成物:`p0-mvp/mac-ux-handoff-13/`(REPORT/REVIEW/evidence×10/screenshots×9);变更面=preview 脚本+新测试+MAC 卡,合计零 src/、零 web/、零迁移、零新依赖。
