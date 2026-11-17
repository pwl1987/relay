# REVIEW-RELAY-MAC-UX-HANDOFF-13(独立 Reviewer 终裁原文)

- Reviewer:RELAY-MAC-UX-HANDOFF-13 独立 Reviewer(全新上下文,与执行方互不隶属)
- 复核对象:实施提交 `b78b8acadf74d90af630af00bfc2d21bbc5f05cc`(已推送 origin/main;合同提交 `5457922`)
- 复核方式:隔离冷启动亲测。`git clone /home/ubuntu/dev/relay /tmp/p13-review-b78b/clone && git checkout --detach b78b8ac`,`node_modules` 符号链接复用主工作区(未 npm ci 联网);全程零 commit、零 push、未改动主工作区任何文件、未清理任何 /tmp 历史目录或任何他人 schema、未触碰生产、零真实模型调用、零公网暴露。
- 复核时间:2026-11-18 02:44 ~ 03:05(+0800)

---

## 一、终裁结论

## **REWORK**(2 Major / 3 Minor;代码修复本体亲测有效,REWORK 范围=证据与登记面,不需要改动 scripts/webux11-preview.mjs 修复逻辑)

**判定依据摘要**:13 包的核心工程目标——预览安全起停+临时目录"只清自有"修复+focused 生命周期测试——全部亲测成立(红态恰 2 failed 均为泄漏;绿态 2/2;TERM/SIGHUP 真实起停零泄漏零 schema 残留;CI 双 job success 且计数精确对账)。但以下两点为亲测不符的登记/合规失实,按"不得美化"原则如实判 REWORK:

1. **Major-1**:REPORT §1 声称"测试库 `p01a_*` schema 冷启动实测 **0 个**(12R 登记的 25 个历史残留已被 12R 协调方清理)"——**与实测相悖**:relayp000 库中 25 个非本轮 `p01a_*` 历史残留 schema 现在全部在场;"实测 0"可由错误查询口径(docker exec psql 未指定 `-d relayp000`,默认连 postgres 库)复现出假 0。
2. **Major-2**:合同 D 项硬禁令"口令、Cookie、**CSRF**、临时账号凭据……**禁止提交 GitHub/CI 回执/截图**"被违反:入库证据 JSON 的 `bodyHead` 字段含真实 CSRF token 值前缀(60 hex 字符);且 REPORT §3.6 与提交信息声称"口令/Cookie/**CSRF 零入库**",与入库事实相反。

---

## 二、逐项亲测记录与数字

### 1. 冷启动与变更面核对 —— PASS

- 克隆 detach 后 `git log -1` = `b78b8acadf74d90af630af00bfc2d21bbc5f05cc`(2026-11-18 02:41:50 +0800)✓
- `git diff 5457922..b78b8ac --stat`:**22 文件,+901/-46**,恰为 REPORT(1)+ evidence(9)+ screenshots(8 png+1 manifest)+ MAC 卡(1)+ `scripts/webux11-preview.mjs`(1)+ `test/e2e/webux13-preview-lifecycle.test.ts`(1)。**零 src/、零 web/、零 migrations、零新依赖** ✓ 与合同范围一致。
- 注:协调方提示背景称"evidence 10 文件",实际 evidence/ 目录为 **9 文件**(REPORT §8 "evidence×10" 同为笔误)→ 记 Minor-m2。

### 2. 红态复现(关键项)—— PASS

- 操作:`git checkout 5457922 -- scripts/webux11-preview.mjs` 取父版本脚本,`RELAY_E2E=1 WEBUX13_TAG=review-red npx vitest run test/e2e/webux13-preview-lifecycle.test.ts`。
- 结果:**恰 2 failed|0 passed**,失败原因均为临时目录泄漏,与红态基线定义逐字吻合:
  - T1(就绪后 SIGTERM):`expect(newDirs).toEqual([])` 失败于测试 265 行——登录面全过(302/401→登录 200→200/200)、SIGTERM exit 0、端口释放、schema 删除,**泄漏恰 3 目录**;
  - T2(启动窗口 SIGTERM):失败于 297 行,`expected [ …(3) ] to deeply equal []`,实收 `/tmp/webux11-preview-reg-IJgRlY`、`/tmp/webux11-preview-remote-base-giqL6Q`、`/tmp/webux11-preview-stage-CRN9yH`。
- /tmp 前后快照差分(仅增不改不删):红态轮共新增**恰 6 目录**=2 套×3(T1:reg-Qh1ogD/remote-base-YMdZXw/stage-3vFskf;T2:reg-IJgRlY/remote-base-giqL6Q/stage-CRN9yH)。**此 6 目录为本 REVIEW 红态复现所造成,已登记、按硬禁令不清除**。
- 红态 evidence(preview-lifecycle-review-red.json)亲读:T1 完整真实——unauth /workspace **302**(→/login.html)、/api/health **401**、登录 **200**(hasCookie=true,pwLen=12,口令零落盘)、授权面 **200/200**、SIGTERM code 0、tmp newDirs=3。红态非早退假红(Duration 2.89s 属实:T2 为 reg 目录一出现即 TERM,耗时极短;T1 全链在 2.55s 内完成,服务启动确实快)。
- 复原:`git checkout b78b8ac -- scripts/webux11-preview.mjs`,`git status` 仅剩 node_modules 符号链接与我本轮测试产物(未跟踪 JSON)✓。

### 3. 绿态三套测试 —— PASS

| 套件 | 命令 | 期望 | 实测 |
| --- | --- | --- | --- |
| webux13-preview-lifecycle | `RELAY_E2E=1 WEBUX13_TAG=review-green npx vitest run test/e2e/webux13-preview-lifecycle.test.ts` | 2/2 | **2 passed (2)**(T1 1399ms、T2 1168ms)|
| webux11-firstuse-audit | `RELAY_E2E=1 WEBUX11_TAG=review npx vitest run test/e2e/webux11-firstuse-audit.test.ts` | 6/6 | **6 passed (6)**(83.2s,桌面 1440+手机 390,D1/D2/D3/M1/D4 全绿)|
| webux12-goal-idempotency | `RELAY_E2E=1 WEBUX12_TAG=review npx vitest run test/e2e/webux12-goal-idempotency.test.ts` | 15/15 | **15 passed (15)**(2.67s)|

- 测试库:默认 RELAY_DB_URL=127.0.0.1:55433/relayp000(docker relay-p000-pg,映射 5432/tcp→127.0.0.1:55433 已亲核)。
- 测试后 `/tmp/webux11-preview-*` 差分:绿态全部零新增 ✓。

### 4. 预览真实起停亲测 —— PASS

第一轮 SIGTERM(端口 37123,克隆内 `node scripts/webux11-preview.mjs --port 37123`):
- 监听面:`ss -tlnp` = `127.0.0.1:37123`,**无 0.0.0.0 绑定**(`grep -c '0.0.0.0:37123'` = 0);无 HTTPS 端点(纯 HTTP)✓
- 未授权:/workspace **302**(→http://127.0.0.1:37123/login.html)、/api/health **401** ✓
- 从 stdout 取一次性口令(12 字符,未入任何文件)POST /api/session = **200** ✓
- 授权 /workspace = **200**、/api/health = **200** ✓
- SIGTERM(发至真实 node 进程,首次 TERM 误中 setsid 包装进程的曲折见 §六.3):进程退出;`/tmp/webux11-preview-*` 74→71,**恰删自建 3 目录**(reg-SmxAlK/remote-base-ZapHo8/stage-TXgDow,02:48:39 时间戳组)零新增;端口 37123 释放(ss 计 0);relayp000 中 `p01a_%` 26→25(自建 schema 删除,余 25=历史残留)、`p01a_webux11_preview%` = **0** ✓

第二轮 SIGHUP(SSH 断开场景,端口 37124):
- 启动后登录面复测:302 / 401 / 登录 200 ✓
- `kill -HUP <真身 pid 3755832>`:进程退出;/tmp 74→71(恰删自建 3 目录零新增);schema 26→25;端口 37124 释放 ✓
- 孤儿检查:`ps aux | grep webux11-preview` 零残留 ✓

### 5. 脚本修复面亲读 —— PASS(不轻信描述,逐条对照源码)

- `scripts/webux11-preview.mjs`:信号注册(SIGINT/SIGTERM/SIGHUP,93-95 行)**先于**任何目录创建(reg 115 行/remoteBase 120 行/stage 226 行)与 createTestDb(104 行)✓;`newTemp()`= `markTemp(mkdtempSync(...))` + `tempRoots` 登记(56-60 行)✓;shutdown `await tReady → t.cleanup()`(DROP schema)后 `cleanupTempRoots()`(77-92 行)✓;`process.on("exit")` 同步兜底(97-101 行)✓;verify scratch 在 `io.verifyRemoteContent` 的 `finally` 中 safeRm 自删(205-221 行)✓;`evidenceChecks` 与 webux11 e2e 夹具同款 deterministic_test `cat delivered.txt` expect `ok`(183-185 行)✓。
- `src/runtime/safe-rm.ts`(未改动,亲读):`markTemp` 创建即写哨兵 `.relay-run-sentinel`(含 createdAt/pid);`safeRm` 强制绝对路径、禁止面(/、/tmp、tmpdir、HOME 本体)、仓库根子树拒删、roots 归属校验、哨兵向上探测、realpath 反 symlink 逃逸、**sentinel 参数必填**(省略即拒)✓ 与提交描述一致。

### 6. MAC 卡核对 —— PASS

`p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md` 逐条与脚本实测行为对照:
- 前台一条命令 `node scripts/webux11-preview.mjs`(默认 8790,--port 可改)与脚本 argPort 逻辑一致 ✓
- 可选限时后台 `timeout 30m ...`(SIGTERM 路径,亲测 TERM 清理有效)✓
- "Ctrl+C(或直接关闭那个 SSH 终端)"= SIGINT/SIGHUP,SIGHUP 亲测清理有效 ✓
- SIGKILL 例外已注明("kill -9 式强杀无法拦截,诚实限制")✓
- "预览只绑定 127.0.0.1,不开公网"与实测一致 ✓
- **口令零出现于卡面**(全文仅提及"打印一次性登录口令")✓
- 截图指针指向本包 8 张(06~08 手机)✓;13 口径刷新(12 修复+重试安全=同意图·同项目·同键;换项目/换身份 409)与 webux12 套件实测行为一致 ✓

### 7. 证据目录抽查 —— 存在两处不符(见 Major/Minor)

- 结构:REPORT 1 份(§0~§8 共 9 个节标题)、evidence/ **9 文件**、screenshots/preview/ 8 png+manifest ✓(协调方提示"evidence 10 文件"不符,REPORT §8"evidence×10"同为 9;记 Minor-m2)
- 口令脱敏:`preview-lifecycle-audit-red.json` 的 `pwHead: "***REDACTED***"`、两份 JSON 的 stdoutTail 口令行 `***REDACTED***` ✓ 口令本体零入库
- **CSRF 未脱敏**:`preview-lifecycle-audit-red.json:40` 与 `preview-lifecycle-verify.json:39` 的 `bodyHead` 含真实 `csrfToken` 值前缀 60 hex 字符 → Major-2
- 截图:manifest(takenAt 2026-11-17T18:35:31Z、base 127.0.0.1:18884、consoleErrors 空数组、8 shots);亲看 `04-desktop-result.png`(1440×900):绿色"✓ Relay 已完成本轮工作"卡(代码修改/4 项测试/独立复核通过/已提交 GitHub 1 文件)+ACTIVE 态双按钮(新建后续任务+发送),与 MAC 卡旅程表一致;文件尺寸 390×844(手机)实测存在 ✓

### 8. CI exact-head 独立核验 —— PASS

- `HTTPS_PROXY=http://127.0.0.1:8118 gh run list --repo pwl1987/relay --commit b78b8ac...`:run **44150658655**(workflow "ci",status completed,**conclusion success**,headSha=b78b8ac...)✓
- jobs(gh api .../runs/44150658655/jobs):
  - test(id 134277750811)= **success**
  - e2e(id 134277750884)= **success**
- **e2e job 日志亲读**(gh api .../jobs/134277750884/logs):
  - 总计 **Tests 63 passed | 2 skipped (65)** = 61 基线+新增 2 ✓
  - `webux13-preview-lifecycle.test.ts (2 tests)`(1896ms)真跑 ✓
  - `webux12-goal-idempotency.test.ts (15 tests)` ✓、`webux11-firstuse-audit.test.ts (6 tests)`(81.5s)✓、`webux11r-terminal-execute.test.ts (10 tests)` ✓
- **test job 日志亲读**(jobs/134277750811/logs):
  - quality:quick:21 files passed(21)
  - quality:full:**Test Files 76 passed | 17 skipped (93);Tests 484 passed | 85 skipped (569)**
  - 计数口径对账:协调方提示基线口径为"75 passed|17 skipped(92 files)"(12R CI 44012161445@5457922);b78b8ac = 基线 +1 文件(webux13-preview-lifecycle.test.ts),该文件在 CI(无 RELAY_E2E)下跑其门测试 `it("RELAY_E2E 未开启,显式 skip(不假装)", () => expect(E2E).toBe(false))` 为**真实断言并通过**(日志:`webux13-preview-lifecycle.test.ts (1 test) 2ms` ✓)⇒ 76|17(93) **精确对账**,格式检查亦覆盖两个新增文件(biome format 行在日志)✓

### 9. 边界核验 —— PASS

- 生产 PID:`ps -p 3242781 -p 3242782` = relay-web(`src/server/index.ts`)/ relay-worker(`src/worker-entry.ts`),二者 START 均为 2026-11-13 02:00:08,全程未变 ✓
- 主工作区 `/home/ubuntu/dev/relay`:`git status --porcelain` 仅有既有未跟踪循例(config/、p0-mvp/soak-r3b/、10 份历史 ci-checkruns-*.json,另含 12R 轮的 macux13 产物与实施方自己留置的 `p0-mvp/mac-ux-handoff-13/evidence/ci-checkruns-b78b8ac.json`、`ci-e2ejob-b78b8ac-excerpt.log` 未跟踪回执);主工作区 HEAD=b78b8ac,**无本 REVIEW 任何痕迹**(本 REVIEW 全部操作在 /tmp/p13-review-b78b)✓
- 本 REVIEW 零 commit:克隆 `git log -5` 顶=b78b8ac,无新提交 ✓;克隆内改动仅为我运行测试产生的未跟踪/被测试覆盖文件(见 §六.4),不影响仓库历史
- /tmp 最终态:71 目录 = 复核前快照 65 + 本 REVIEW 红态轮 6(已登记,不清除);本轮 TERM/HUP/绿态测试均零新增 ✓
- schema 最终态:relayp000 `p01a_%` = **25**(全部为合同保护的历史残留,未触碰);本 REVIEW 自建 schema(`p01a_webux11_preview_*`)**零残留** ✓

---

## 三、Major 列表(2 项)

### Major-1:p01a_* 基线登记失实("实测 0/已被清理"与实测相悖,假 0 口径可复现)

- **主张原文**:REPORT §1(及提交信息 A 节):"测试库 `p01a_*` schema 冷启动实测 **0 个**(12R 收口时登记的 25 个历史会话残留 schema,已被 12R 协调方按其抽核方法学清理;本轮零清理动作,非本轮所为)"。
- **亲测反例**:
  1. 经合同钉死口径 `127.0.0.1:55433/relayp000`(docker 端口映射 5432/tcp→127.0.0.1:55433 已亲核)查询 `information_schema.schemata LIKE 'p01a_%'`:**26 个**=25 个非本轮历史残留 + 1 个本 REVIEW 预览进程活跃 schema。25 个残留名单(逐个列出):`p01a_c1_hb_err_{26169b48,4643fe67,72f1a7b4,9c9eb338}`、`p01a_c1_toolev_{32e9a701,67c1c3ef,877bfbfc,f4e58290}`、`p01a_c2_budget_{893ec2b8,8caf6cc8,9ada059d}`、`p01a_c2_runner_{7f56e043,d3cea757}`、`p01a_dbg_pie2e_{12113d0c,3c696143,c2b35803,dbc9160e,fb6aac0f}`、`p01a_p02a_e2e_d6de8192`、`p01a_rev1_pogqulj4`、`p01a_review_f_cli_r28bt5`、`p01a_review_probe_f1_a80d9433`、`p01a_webux02_shots_{2ca91fde,2de7eac6,6c9bd087}` —— **数量恰为 25,与合同 5457922 CURRENT.md A 节"25 个旧历史 p01a_* schema 不得清理"的登记数吻合**。
  2. 老旧性证据:上述 25 个 schema 的最小 relfilenode 分布 41701~843879,远小于本 REVIEW 预览进程新建 schema 的 1200808(PostgreSQL OID/relfilenode 递增分配)⇒ 均为本轮之前的老对象,**不可能为清理后重现**。
  3. 假 0 口径复现:`docker exec relay-p000-pg psql -U postgres -Atc "SELECT current_database();"` = `postgres`(未指定 -d 时默认连 postgres 库);同一命令 `LIKE 'p01a_%'` count = **0**;加 `-d relayp000` 后 count = 26。"实测 0"极可能由此口径得出(REPORT 未附查询语句无法确证,但假 0 可精确复现)。
- **定性**:行为面合规(25 个确实一个未清,硬禁令遵守);失实在**登记**——合同 A 项"新事实如实登记"的核心声明之一与实测相悖,并把"已被协调方清理"归功于一个未发生(至少无法证实)的动作。该失实会误导 13 收口后的下一轮冷启动基线(继续用错误口径会继续看到假 0)。
- **修复要求(REWORK)**:更正 REPORT §1(及 CURRENT/CONTINUATION 若同步引用)为"25 个历史 p01a_* 残留仍在 relayp000(经 55433/relayp000 实测);`docker exec psql` 不带 `-d relayp000` 会得假 0,附正确查询口径";不改任何 schema 数据。

### Major-2:入库证据含 CSRF token 前缀,违反合同硬禁令字面,"CSRF 零入库"声明与事实相反

- **合同原文**(5457922 CURRENT.md D 节):"口令、Cookie、**CSRF**、临时账号凭据仅本机终端安全显示,**禁止提交 GitHub/CI 回执/截图**"。
- **亲测反例**:
  1. `p0-mvp/mac-ux-handoff-13/evidence/preview-lifecycle-audit-red.json:40`:`"bodyHead": "{\"ok\":true,\"authenticated\":true,\"role\":\"owner\",\"csrfToken\":\"55f3d0c6576adab07090b516abff1f4382648d0955c9ced11449197619ab"`(60 hex 字符真实值前缀,被 120 字符截断);
  2. `p0-mvp/mac-ux-handoff-13/evidence/preview-lifecycle-verify.json:39`:同构,`csrfToken":"a73087710d1207b703f17b86edc695d89364107032893d361ed3b70299db`(60 hex);
  3. 源头:`test/e2e/webux13-preview-lifecycle.test.ts:167` `bodyHead: loginBody.slice(0, 120)` —— 13 新增 harness 自创字段(既有 webux11 harness 无 bodyHead/csrfToken 记录模式,已 grep 证实),author 对口令做了 pwLen+REDACTED 处理但漏了 bodyHead 内嵌的 csrfToken;
  4. REPORT §3.6 与提交信息 C⑥ 明文声称"口令/Cookie/**CSRF 零入库**"——与上述入库事实相反。
- **缓解(如实记录)**:两 token 分属一次性预览进程的内存会话,进程已退出即失效,且为截断前缀 ⇒ 实质泄露风险≈0;口令本体确已全程 REDACTED(亲核)。但合同禁令为字面性("禁止提交"),且与自我声明直接冲突。
- **修复要求(REWORK)**:①对入库两份 JSON 的 bodyHead 做 csrfToken 脱敏(截断至 `csrfToken":"***REDACTED***` 或整字段移除,并在 REPORT 登记更正动作);②改 harness 不再记录含 csrfToken 的 bodyHead(或对其再脱敏);③更正"CSRF 零入库"声明为事实口径。

---

## 四、Minor 列表(3 项)

### Minor-m1:红态轮泄漏目录总量未如实登记

- 亲测时间线:/tmp/webux11-preview-{reg,remote-base,stage}-* 目录组按 mtime 分组:11-15 23:49×1、11-16 00:07×1、11-17 11:38×1、11-17 11:39×1(**=冷启动历史 4 套 12 目录+2 旧日志,REPORT §1 此句准确**)、11-18 02:11:49×1(=§2 手工冒烟,reg-XzCwgh/remote-base-KdKhuC/stage-F9r1zo,登记准确)、**02:15:45~02:22:20 间 16 套**(均为提交 b78b8ac[02:41:50] 之前、实施窗口内产生,与 REPORT §2 自述的测试假红×2/独立复刻/孤儿处理/audit-red 证据轮迭代时间吻合)。
- 提交时实际基线 = **21 套 63 目录+2 日志**;REPORT 仅点名"手工冒烟 1 套+audit-red 测试 2 套",对实施窗口内其余 ~13 套无总量登记,"红态轮泄漏目录如实登记"在总量上不完整。硬禁令(不清算)本身遵守 ✓。
- 修复要求:在 REPORT(或 CONTINUATION)补登红态期泄漏总量与时间窗,声明留作基线不清算。

### Minor-m2:证据文件数口径笔误

- REPORT §8"REPORT/REVIEW/evidence×10/screenshots×9":实际 evidence/=**9 文件**(5 log+2 json+2 log),screenshots/=9(8 png+manifest)✓。协调方任务提示"evidence 10 文件"同样不符。属登记笔误,无实质影响。

### Minor-m3(观察项,非 13 包缺陷):指定 TAG 字面复跑会覆盖克隆内既有同名封存证据

- 本 REVIEW 按协调方指定命令 `WEBUX11_TAG=review` 复跑 webux11,在**我的 /tmp 克隆内**覆盖了已封存的 review 轮证据(`p0-mvp/web-ux-acceptance-11/evidence/firstuse-audit-review.json`+13 张 screenshots/review/*.png 显示为 M;仅限临时克隆,不影响仓库历史与主工作区)。11R 的 M2 教训("证据轮与回归轮分离、回归必须显式 TAG=ci")在 harness 缺省/指定 TAG 行为上仍可复现。非 13 包引入、不在 13 变更面,登记为后续 harness 加固观察项。

---

## 五、CI 计数口径(独立亲核)

| Job | run / id | 结果 | 关键计数(日志亲读) |
| --- | --- | --- | --- |
| e2e | 44150658655 / 134277750884 | success | **Tests 63 passed \| 2 skipped (65)**;webux13-preview-lifecycle **2 tests 真跑**(1896ms);webux12 15;webux11 6(81.5s);webux11r 10 |
| test | 44150658655 / 134277750811 | success | quality:quick 21 files(21);quality:full **76 passed \| 17 skipped (93 files)**,Tests 484 passed \| 85 skipped (569);对账=基线 75\|17(92)+webux13 文件(门测试 1 test 真断言通过) |

双 job success 且计数与"61 基线+新增 2(65)""92 文件+新增 1(93)"精确吻合,**无 ba70fd0 式"绿而不全"**。

---

## 六、边界核验记录

1. 生产 PID 3242781(web)/3242782(worker)START=2026-11-13 02:00:08,复核前后未变;零生产读写/重启/配置/公网暴露/真实模型调用。
2. 主工作区 12 项保护物(config/、p0-mvp/soak-r3b/、10 份历史 ci-checkruns-*.json)原样在场;主工作区 git status 仅有既有未跟踪循例,无本 REVIEW 痕迹;主工作区未被本 REVIEW 写入任何文件。
3. 本 REVIEW 操作曲折如实登记:首轮 SIGTERM 实验中 `setsid nohup ... &` 返回的 PID 为 setsid 包装进程,TERM 使包装退出而真身(node,经 ss -tlnp 交叉定位 pid=3737370)未收到信号;随后用 ss 定位真身重发 TERM 完成第一轮验证,SIGHUP 轮同样以 ss 定位真身。此为我方操作面问题,不构成被审对象缺陷(测试 harness 的 spawn/kill 直接持子进程句柄,无此问题)。
4. 本 REVIEW 在自己克隆内的痕迹:未跟踪 node_modules 符号链接、两份我生成 evidence JSON(preview-lifecycle-review-red/green.json)、红态复现造成的 6 个 /tmp 泄漏目录(已登记不清)、克隆内 review 轮证据被我 TAG=review 复跑覆盖(见 Minor-m3)。零 commit、零 push。
5. /tmp 前后清单差分:复核前快照 65 条 → 最终 71 条,差额恰=红态轮 6 目录;未删除/修改任何既有历史条目。
6. 测试库最终态:relayp000 `p01a_%`=25(全为合同保护残留);本 REVIEW 自建 schema 零残留;未执行任何 DROP/DDL 于他人对象。

## 七、NOT_RUN / 未验证项(如实)

- 用户 Mac 实机体验 = **NOT_RUN**(REPORT 已如实标注;USER_DECISION 唯一归属用户本人)。
- 手机真机(VPN/刘海/软键盘)= **NOT_TESTED**(REPORT 已标注)。
- SIGKILL 强杀路径 = 未亲测(脚本层不可拦截为设计限制,MAC 卡已注明;不影响判定)。
- 实施方"三次真实交付链冒烟"(无配置轮 FAILED fail-closed/配置轮 COMPLETED/截图轮)未逐轮重放(其证据 p13-preview-delivery-smoke.log 等仅 5 行摘要,信息量有限);但交付链绿路径的等效面已由 webux11 D1-D4(含 COMPLETED 旅程与失败链)+截图 04 亲核间接覆盖。
- 8 张截图中逐张亲看 1 张(04),其余 7 张核验存在性+分辨率+manifest 一致性,未逐张目检。

## 八、终裁

**REWORK**(Major-1、Major-2 须修复后复核;修复面=REPORT/证据 JSON/harness 脱敏,均为登记与证据面,**不需要改动 scripts/webux11-preview.mjs 的修复逻辑本体**——该本体经红/绿/TERM/HUP/CI 全链亲测有效)。3 Minor 一并建议消化。修复后按流程重推并由协调方确认;本 REVIEW 不代宣布 UX_HANDOFF_READY 最终生效、不代宣布用户 Mac UX ACCEPTED、不构成生产 GO/MVP ACCEPTED。

---

## 九、执行方 REWORK 消化记录(2026-11-18,收口提交时点;Round 2 待 Reviewer 复核)

- **Major-1 消化**:REPORT §1 基线更正——25 个历史 `p01a_*` 残留全部在场(经 `-d relayp000` 实测复核=25,名单与 Reviewer 列举一致);"实测 0/已被协调方清理"系 `docker exec psql` 未带 `-d relayp000` 连错库的假 0,已在 REPORT 登记**正确查询口径**与口径教训;零 schema 数据改动。CURRENT/CONTINUATION 收口行同步采用更正后口径。
- **Major-2 消化**:①harness 移除 `bodyHead` 字段(响应体片段一律不进证据);②`preview-lifecycle-verify.json` 以修复后 harness 重生成(TAG=verify,2/2 passed,全文零 16+ hex);③`preview-lifecycle-audit-red.json` 的 csrf 前缀原地脱敏 `***CSRF-REDACTED***`;④REPORT §3⑥ 声明更正为事实口径并如实登记 b78b8ac 历史仍含截断前缀(一次性已失效 token,实质风险≈0;不 rewrite 已推送历史)。
- **Minor-m1 消化**:REPORT §4 补登实施窗口(02:11~02:22)泄漏总量 17 套 51 目录+历史 4 套 12 目录=提交时点 21 套 63 目录+2 日志(与 Reviewer mtime 分组一致),全部不清算留作基线;Reviewer 自身红态 2 套 6 目录由其 REVIEW 自行登记。
- **Minor-m2 消化**:REPORT §8 生成物计数更正(evidence 9 文件+2 未跟踪 CI 回执循例)。
- **Minor-m3**:登记为后续 harness 加固候选(指定 TAG 复跑覆盖同名封存证据;非 13 变更面,本轮不实施)。
- 消化自测:全包 hex 凭据清扫=0(仅剩提交 SHA/Run ID 公开标识符);口令行清扫=0 未脱敏;quality:quick PASS(修复后 harness 格式/typecheck 干净)。

---

## 十、Round 2 复核(同一 Reviewer,2026-11-18)

**终裁:PASS(0 Major / 0 Minor 阻断;2 条不阻断登记项)**。七项消化与 Round 1 指认一一对应,全部只读核验通过(未跑测试套件/未 commit/未改文件/未清理):①§1 基线更正与亲测一致(25 个名单逐项相同+正确口径+假 0 教训);②两份证据 JSON 零 16+ hex、csrfToken 仅剩占位、verify.json 重生成后整字段消失且结构完整(t1/t2 exit 0、probe 302/401→200/200、newDirs 0、schema 0/0);③harness bodyHead 零命中;④§4 泄漏总量与 mtime 分组精确一致;⑤§7 CI 回填与其 job 日志逐字相符;⑥REVIEW 原文 185 行零差异、仅追加 §九。附加边界:变更面恰 4 M+1 新增 REVIEW、HEAD 仍 b78b8ac 零 commit、生产 PID 未变、/tmp 71 条与其 after-red 快照逐字一致=执行方零删除。

**不阻断登记项**:1) CURRENT/CONTINUATION 收口行更正口径由收口提交兑现(合同 E 项),收口提交 CI 再次 exact-head 核验;2) 修复后 harness 的 quality:quick PASS 为执行方自测,由收口提交 CI 客观复核。

**结论口径**:13 包工程收口(ENGINEERING);UX_HANDOFF_READY 最终生效仍待用户 Mac 实机体验 USER_DECISION;Agent 不代宣布 UX ACCEPTED/生产 GO/MVP ACCEPTED。
