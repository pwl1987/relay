# REVIEW-RELAY-WEB-UX-ACCEPTANCE-11(独立 Reviewer 终裁)

- Reviewer:RELAY-WEB-UX-ACCEPTANCE-11 独立 Reviewer(隔离冷启动,对执行方自述零采信,全部实质主张亲自跑/亲眼看)
- 终裁时间:2026-11-16 00:20 CST(基线 HEAD=8d53fc18bc9273fd42e32c8372c1f9ad504b81d2)
- **终裁:REWORK(1 Major,0 停机级;R1 最小修复后预期 PASS。工程面修复真实性、回归、边界、文档一致性全部亲核属实;唯一 Major=包内「修复前 audit/ 轮」证据已被当轮全量回归覆盖为「修复后」形态,REPORT 引用与现存文件矛盾,Evidence 不足即 REWORK)**
- 本 REVIEW 文件自身不入 git,留执行方随包提交;Reviewer 零 commit/零 push。

## 0. Reviewer 自身边界声明(硬边界遵守)

- 全程零 commit/零 push/零分支创建;生产进程仅 `ps`/`ss` 只读核对;生产 DB 零连接(测试仅经 `docker exec relay-p000-pg psql` 只读查 `pg_namespace`);受保护未跟踪物(config/、soak-r3b/、6 份 CI 回执)**内容零打开**,仅 `stat` mtime;零真实模型;临时还原 workspace.js 后已逐字节精确恢复(见 §3);我方 e2e 复跑弄脏的 30 个 tracked 证据文件已代为 `git checkout --` 恢复,终态工作区=仅 `web/workspace.js`(31+/7-)+ 本包 untracked 产物;预览一次性 schema 已清(`MATCH_COUNT=0`)。

## 1. A 冷启动与事实盘点(亲测)

| 核验 | 命令 | 实测 |
| --- | --- | --- |
| 远端同步 | `GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none" git fetch origin; git rev-parse origin/main HEAD` | 两者均 = `8d53fc18bc9273fd42e32c8372c1f9ad504b81d2` ✓ |
| 未跟踪物 | `git status --porcelain=v1` | 恰为 8 项保护物(config/、p0-mvp/soak-r3b/、6 份 ci-checkruns-*.json 含 cutover 02348b6)+ 3 项包产物(p0-mvp/web-ux-acceptance-11/、scripts/webux11-preview.mjs、test/e2e/webux11-firstuse-audit.test.ts)✓ |
| 生产进程只读 | `ps -o pid,lstart,args -p 3242781 -p 3242782` | PID 3242781=`node src/server/index.ts`、3242782=`node src/worker-entry.ts`,均 **Fri Nov 13 02:00:08 2026** 启动,与合同登记一致,未变 ✓ |
| 生产绑定 | `ss -ltnp \| grep 8787` + `ip -4 addr` | `10.30.5.80:8787 users:(pid=3242781)`;本机 LAN IP=10.30.5.80 ✓(MAC 卡地址属实) |
| 保护物 mtime | `stat` 8 项 | config/ = 2026-11-12 12:21:40、soak-r3b/ = 2026-11-12 07:07:50(与合同 A 登记一致);6 份回执最新者 = cutover 02348b6 回执 2026-11-15 21:39:27,**早于合同提交 21:49:18** ⇒ 执行窗口(21:49 后)零触碰 ✓ |

## 2. B 变更面清点(亲测)

- 终态 `git diff 8d53fc1 --stat`:**仅 `web/workspace.js` 1 file changed, +31/-7**;`git diff 8d53fc1 -- src deploy migrations config web/style.css` = **0 行** ⇒ 「零 Core/零第二状态机/零 CSS 改动」声称属实 ✓。
- 交接期瞬态如实登记(重要,避免误判):执行方全量 e2e 回归(23:49:29–23:52:29)曾把 test/e2e 既有套件的 49 个 tracked 截图/日志弄脏;**Reviewer 首次快照(23:54:35)恰在其恢复前**;执行方于 23:55:13 `git checkout --` 全部恢复(p0-mvp/webux-02 等文件 mtime=23:55:13 亲测)、23:55:25 定稿 REPORT ⇒ REPORT §5「已恢复」在交接时点**属实**。Reviewer 自己的回归复跑(00:08:36–00:10:00)再弄脏 30 个(p0-02c/、p0-webux-03c/、p0-webux-03d/),已按同一原则代为恢复;终态 `git status` 仅 ` M web/workspace.js` ✓。

## 3. C 修复真实性(代码审读 + 行为亲跑)

**代码审读**(`git diff web/workspace.js` 逐行):
- B1:`renderComposer` 空白态 `execBtn.hidden=true` + **`execBtn.style.display="none"` 内联兜底**,任务态 `hidden=false; style.display=""` 原样恢复 ✓。
- B2:失败块新增 `data-testid="ws-fail-next-step"`、text=「下一步:点「查看原因」了解详情;如要重试,请新建一个需求,把要做的事再告诉 Relay。」✓(与 REPORT 逐字一致)。
- B3:`state.hasProjects` 初始 undefined;`populateProjectSelect` 实读 `/api/projects` 后 `state.hasProjects=list.length>0`;`renderFeed` hero 副标按 `hasProjects===false` 切换为「尚无项目:直接在下方输入一句话即可开始;…」,未读取/失败维持通用文案;零项目注册表读取后 `renderFeed(true)` 原位刷新 ✓。

**根因复核**:`web/style.css:211` `.btn{display:inline-flex}`(作者样式)压过 UA `[hidden]{display:none}`;既有例外仅在 262(`#conn-banner`)、514(`.ws-composer-project`)、547(`.ws-menu-btn` 等),**确无 `#ws-execute` 例外** ⇒ B1 根因与「RELAY-CONTROL-READY-03 引入回归」的说法属实 ✓(`git log -S ws-execute` = 079b97d 2026-11-13 20:17:04 +08:00,晚于生产进程 02:00:08 启动 ⇒ MAC 卡「现役 A 无执行按钮」亦属实)。

**红态复现(Reviewer 亲跑)**:
1. `cp web/workspace.js /tmp/ws-fixed-backup.js`(md5 `f7f26f34fdde5ef2bf565e60ae9e7e8d`)→ `git show 8d53fc1:web/workspace.js > web/workspace.js`(此时 `git diff web/workspace.js` = 空)。
2. `RELAY_E2E=1 WEBUX11_TAG=review-red npx vitest run test/e2e/webux11-firstuse-audit.test.ts` → **恰 3 失败:D1(410 行 executeVisible true→false)、M1(510 行同)、D4(636 行 workBlockText 含「下一步」失败,实测文本『✗ 本轮工作未完成,需要处理✗代码修改未完成查看原因』);3 passed;71.59s** ✓ 与执行方 `webux11-red-first.log`(23:39:54,同 3 失败)与 `webux11-audit-red-reprod.log`(23:47:44,同 3 失败)一致。
3. 精确恢复:`cp /tmp/ws-fixed-backup.js web/workspace.js` → md5 复原 `f7f26f34…`,`git diff web/workspace.js` 复原 = +31/-7 同一 patch ✓。

**绿态亲跑**:`RELAY_E2E=1 WEBUX11_TAG=review npx vitest run …` → **6/6 passed(85.48s)**;我方 `evidence/firstuse-audit-review.json`(capturedAt 00:05:25)d2/m2:`heroSub=尚无项目:直接…`、`executeVisible=false` ✓。

## 4. D 截图亲看与 JSON 一致性

**verify/(修复后)亲看,文案逐字与代码一致**:
- `d02-workspace-empty-desktop.png`:唯一蓝色主按钮「开始」,无「交给 Relay 执行」;hero 副标=「尚无项目:直接在下方输入一句话即可开始;如需按项目组织,先在左侧「项目」页添加项目。」;选择器如实显示「尚未配置项目 — 直接开始」✓(=workspace.js heroSub 逐字)。
- `m02-workspace-empty-mobile.png`:输入框全宽、右侧单「开始」按钮,无横向挤压 ✓。
- `d09-failed-desktop.png`:红卡「✗ 本轮工作未完成,需要处理 / ✗ 代码修改未完成」下含「下一步:点「查看原因」了解详情;如要重试,请新建一个需求,把要做的事再告诉 Relay。」+「查看原因」按钮 ✓(=ws-fail-next-step 逐字)。
- `d07-decision-desktop.png`:决策卡「⚠ 需要你的决定 / 问题/建议/风险/截止 / 允许 / 批准、不允许、稍后处理」三按钮,工作块「等待你的决定 ○项目分析○代码修改○自动测试○独立复核○交付」✓。
- `d04-result-desktop.png`:绿卡「✓ Relay 已完成本轮工作」+ 代码修改/4 项测试/独立复核通过/已提交 GitHub 打勾 + 查看修改/技术详情 ✓。

**review-red/(Reviewer 自产修复前证据)亲看**:`d02` = **双主按钮「交给 Relay 执行」+「开始」并列**+旧 hero「在下方选择项目,用一句话说出需求…」(与选择器「尚未配置项目 — 直接开始」自相矛盾);`m02` = 输入框被双按钮挤压至约 100px;`d09` = **无「下一步」行** ⇒ 三阻断项修复前形态全部实证,与我方红态 JSON(executeVisible=true、旧 heroSub)一致 ✓。

**audit/(执行方标注「修复前」)亲核 = 与声称不符,见 Major-1**:audit/d02 与 verify/d02 视觉同一(唯一「开始」+新 hero);audit/d09 **含「下一步」行**;audit 与 verify 多图 md5 完全相同(d01、m01–m06、m08),其余仅字节级近同;`firstuse-audit-audit.json`(capturedAt=2026-11-15T15:50:11.773Z)facts:`executeVisible=false`、`heroSub=尚无项目:直接…` = **修复后形态** ⇒ 该轮被当轮回归覆盖。JSON capturedAt 与对应截图 mtime 互洽(verify JSON 23:46:54≈verify 截图 23:46:14–23:46:54;audit JSON 23:50:11≈回归窗口内),排除事后伪造;问题是「轮次标签与内容不符」,非「冒充」。

## 5. E 预览脚本(审读 + 短暂实跑)

- 审读 `scripts/webux11-preview.mjs`(197 行):仅绑 127.0.0.1(server.listen(argPort,"127.0.0.1"));一次性 schema= `createTestDb("webux11-preview")`(授权守卫 fail-closed:p01a_ 前缀 + 127.0.0.1:55433/relayp000 三元组,否则连接前拒绝);口令 `randomBytes(9).toString("base64url")` 仅打印一次、不落盘;`RELAY_PROJECTS_FILE`→mkdtemp 空注册表;交付=一次性本地 bare 远端(makeBareRemote,credentialFile:null);退出 SIGINT/SIGTERM→clearInterval+server.close+t.cleanup();不写仓库任何文件 ✓。
- 实跑:`timeout 30 node scripts/webux11-preview.mjs --port 8799` → `login.html=200`、`/workspace=302→login.html`、`/=302→login.html`;SIGTERM 退出(exit 124=timeout 预期,handler 执行清理);`docker exec relay-p000-pg psql … pg_namespace LIKE 'p01a_webux11_preview%'` → **MATCH_COUNT=0,零残留** ✓。30 秒后即毁,零长跑。

## 6. F 边界与隐私

- 全部新文件 grep:零生产凭据/零密码值/零真实项目数据;模型=`{provider:"stub",apiKey:"stub",baseUrl:"http://127.0.0.1:1/v1"}`(不可达层,零付费请求);`credentialFile:null` + 本地 bare 远端 ⇒ 零外部 GitHub 写入;`RELAY_PROJECTS_FILE` 两处均指向 tmp 一次性文件,`config/projects.json`(162B)内容 Reviewer 亦未打开、产物中仅出现「绝不读取」声明性文字 ✓。
- harness `sandbox:"host-fallback"`、stub 注入(argv=[node, stub-pi.mjs])、每任务独立 bare 远端、`stageBaseDir`=mkdtemp ⇒ 不触碰生产 ✓。

## 7. G 回归亲核(与执行方 evidence 数字逐一对上)

| 项 | Reviewer 亲跑 | 执行方 evidence | 一致 |
| --- | --- | --- | --- |
| journey+03C+03D | `RELAY_E2E=1 npx vitest run test/e2e/web-journey.test.ts test/e2e/webux03-workspace.test.ts test/e2e/webux03-mobile.test.ts` → **27 passed,EXIT=0** | (其回归为全量,见下) | ✓ |
| 全量 e2e | (我方仅跑上述 3 文件+webux11) | `webux11-e2e-regression.log`:**36 passed \| 2 skipped (38)**,5 files passed \| 2 skipped (7);2 skipped=03C/03D shots 显式证据门(亲核 `RELAY_03C_SHOTS`/`RELAY_03D_SHOTS` 门代码) | ✓ |
| quality quick | `node scripts/quality.mjs quick` → **21 files/182 tests 全过,总裁决 PASS,EXIT=0** | `webux11-quality-quick.log` = 182/182 PASS | ✓ |
| tsc | `npx tsc --noEmit` → 干净 | 同声称 | ✓ |
| biome | `npx biome lint src web test scripts bin` → **0 error、95 warnings、3 infos**(grep 命中均为源码字符串非 lint error);`web/workspace.js` 单独 6 warnings | 「警告为基线,零新增 error」 | ✓ |

## 8. H 文档一致性(REPORT / MAC 卡 vs 代码事实)

- MAC 卡地址 `http://10.30.5.80:8787` = ss 实测生产绑定 ✓;口令路径说法(一次性打印/不落盘)= 脚本行为 ✓;preview 用法+SSH 隧道+Ctrl+C 清理 = 脚本实现 ✓;差异表「发送/交给 Relay 执行」语义 = workspace.js(方案 A 双操作)+api.ts 事实 ✓(`「已批准,Relay 继续执行」` workspace.js:554;`「已记录…不会自动创建新执行任务;如需继续,请新建一个需求。」` api.ts:442)。
- 三条测试需求可复制 ✓;手机真机 VPN/安全区/软键盘 **NOT_TESTED** 如实标注 ✓;「18 张截图 screenshots/verify/」= 实数 18(d01–d10 + m01–m08)✓。
- REPORT 结论口径 = **ENGINEERING PASS + UX HANDOFF READY**,明写「用户 Mac UX ACCEPTED 仍必须由用户本人…Agent 不代宣布」⇒ 不冒充用户验收 ✓;§6 CI 声称亲核:Reviewer 经 `gh run list/view` 实测 8d53fc1 = run **43721016797,jobs test=>success、e2e=>success** ✓;style.css 存在 format 漂移属实(`npx biome format web/style.css` 报错)⇒「不碰 CSS」决策成立 ✓。

## 9. Major/Minor 登记与 R1 修复指令

**Major-1(唯一,必须修,证据不足即 REWORK 的直接原因):包内「修复前 audit/ 轮」已被当轮全量回归覆盖为「修复后」形态,REPORT 对其引用失实。**
- 时间线(全部 mtime/日志亲测):red-first(TAG 默认=audit,23:39:54–23:41:05,修复前,3 失败,截图当时写 audit/)→ 修复 → verify(TAG=verify,23:46:12–23:47:37,6/6)→ red-reprod(23:47:44–23:48:56,还原 workspace.js 后复原)→ **全量回归 23:49:29–23:52:29 内含 webux11 harness、TAG 缺省=audit,在已修复代码上 6/6 通过,覆盖 audit/ 截图+JSON** → 23:55:13 的 `git checkout --` 只恢复 tracked 文件,不含 untracked 包目录 ⇒ 现存 audit/=修后形态(§4 证据)。
- 影响:合同交付物 1 的「TAG=audit=修复前红态证据」不成立;REPORT §2 表格「d02/m02 截图:executeVisible=true…双主按钮并列」与 §4「修复前=audit/」对现存文件不成立。先红文本证据(webux11-red-first.log / webux11-audit-red-reprod.log,各恰 3 失败)仍在且我方已复现,故非工程造假,是证据轮被回归吞没后的登记缺失。
- **R1 修复指令(最小,约 3 分钟)**:①`git show 8d53fc1:web/workspace.js > web/workspace.js` 临时还原 → `RELAY_E2E=1 WEBUX11_TAG=audit npx vitest run test/e2e/webux11-firstuse-audit.test.ts`(应恰 3 失败,自动重写 audit/ 18 图+firstuse-audit-audit.json 为红态)→ 从备份精确恢复修复版并核 `git diff web/workspace.js` 仍=+31/-7;②REPORT §2/§4 引用同步为重写后的红态 audit/(或改引 Reviewer 已留证的 `screenshots/review-red/` + `firstuse-audit-review-red.json`,并如实注明该轮由 Reviewer 产出);③REPORT §5 追加一句:回归复跑必须设 `WEBUX11_TAG=ci`(或在干净克隆),防再覆盖。

**Minor-1**:harness 第二个 describe(D4)的 afterAll 只 `stopStack`,不落盘 JSON ⇒ `d9/d10` facts(OBS 已累积)不进任何 `firstuse-audit-*.json`,失败态文案证据仅存截图+断言日志。建议:合并落盘(单 describe 或第二个 afterAll 亦写 TAG 文件)。
**Minor-2**:全量 e2e 在本仓库复跑会再次覆盖 audit/ 轮与既有证据目录(本轮已发生一次)。结构性建议:CI/复跑固定 `WEBUX11_TAG=ci`,或在 harness 头注释与 REPORT 钉住「证据轮与回归轮分离」;不建议为此新开部署编排或大改。
**Minor-3**:Reviewer 追加产物登记:`screenshots/review/`(18 张,TAG=review 绿态)、`screenshots/review-red/`(12 张,TAG=review-red 红态)、`evidence/firstuse-audit-review.json`、`firstuse-audit-review-red.json` 为独立复核证据,随包提交与否由执行方裁量(保留利于追溯);本 REVIEW 文件不入 git,由执行方随包提交。

## 10. 终裁(Round 1)

**REWORK**(1 Major / 3 Minor;零停机级、零生产影响、零越界)。工程面(三项修复真实性、先红后绿、回归零退化、隔离预览、边界与隐私、文档口径)全部亲核属实;R1 完成 Major-1 修复并同步 REPORT 引用后,复核轮(最多两轮内)预期 **PASS**。

## 11. Round 2(2026-11-16 00:25 CST;独立复核,零采信)

**终裁:PASS(0 Major;Round1 Major-1 已消化,M1/M2/M3 已消化,含下方声明更正)。**

### 11.1 Major-1 修复核验(红态 audit/ 重生成,亲测)

- 执行方重生成日志 `evidence/webux11-audit-red-regen.log`(mtime 00:19:05):**恰 3 失败(D1/M1/D4)| 3 passed (6)** ✓。
- `evidence/firstuse-audit-audit.json`(tag=audit,capturedAt=2026-11-15T16:19:05.829Z,11 步)facts 亲读:`d2/m2: heroSub=「在下方选择项目,用一句话说出需求。…」(旧文案)、executeVisible=True`;`d9-failed-terminal: workBlockText=「✗ 本轮工作未完成,需要处理✗代码修改未完成查看原因」——无「下一步」` ⇒ 红态 ✓。
- 截图亲看:`screenshots/audit/d02`(mtime 00:17:57)= **双主按钮「交给 Relay 执行」+「开始」并列 + 旧 hero**,与 Reviewer Round1 自产 review-red/d02 同形态;`audit/d09`(00:19:05)= **失败块无「下一步」行** ✓。
- 图数自洽:audit/ 现存 **11 图**(d01–d09 + m01–m02;红轮 D1/M1/D4 于钉住断言处中止 ⇒ d10 与手机后半程不产生),REPORT 所述「清除 7 张修后残留(18−11)」相符 ✓。
- `web/workspace.js` patch 未动:md5 `f7f26f34fdde5ef2bf565e60ae9e7e8d`(与 Round1 备份一致),`git diff 8d53fc1 --stat` 仍 **+31/-7 同一 patch** ✓;终态 `git status` 仅该文件 + 包 untracked 产物 ✓。

### 11.2 Minor-M1 核验(JSON 统一落盘)

- harness 重构:`flushObservations()`(71 行)被两个 afterAll 分别调用(387/612 行,注释标明 Reviewer Minor-1)⇒ 失败态 facts 全量覆盖写 ✓。
- `firstuse-audit-verify.json`(00:20:51)现 **18 步**,含 `d9-failed-terminal`、`d10-failed-reason-opened`,workBlockText 含「下一步:点「查看原因」了解详情;如要重试,请新建一个需求…」(绿态)✓。
- Reviewer 亲跑(见 11.4)的 `firstuse-audit-review-round2.json` 亦 **18 步含 d9/d10**,证明改动端到端生效 ✓。

### 11.3 Minor-M2/M3 核验

- harness 头注释 10–11 行钉入「轮次分离(Reviewer Minor-M2,必守):…全量 e2e 复跑内含本 harness 时**必须显式 WEBUX11_TAG=ci**(缺省 audit 会覆盖红态证据,11 包已实际发生一次)」✓。
- REPORT 引用同步亲读:§2(19–20 行:audit/=R1 重生成红态 11 图,与 review-red/ 12 图互证;R1 登记段含 red-regen 日志与 +31/-7 同 patch);§5(53 行:污染段追加「内含本 harness 的复跑必须显式 WEBUX11_TAG=ci」);§5(51 行:Round1 终裁与 R1 消化①–⑤登记)✓。
- **M3 处置与声明更正**:执行方决定 review/、review-red/、review 系 JSON 随包入库,本 REVIEW 文件亦随包提交——故本文件头部「自身不入 git,留执行方随包提交」在此更正为:**「本 REVIEW 文件由执行方随包提交(入 git),Reviewer 本人零 commit/push 的边界不变」**;Reviewer 独立证据(review/、review-red/、firstuse-audit-review.json、firstuse-audit-review-red.json、firstuse-audit-review-round2.json)随包入库,利于追溯 ✓。

### 11.4 Reviewer 亲跑回归(新 TAG,红态证据零覆盖)

- `RELAY_E2E=1 WEBUX11_TAG=review-round2 npx vitest run test/e2e/webux11-firstuse-audit.test.ts` → **6/6 passed(84.85s,Start 00:23:02)** ✓。
- 红态证据未被我方运行触碰:运行后 `firstuse-audit-audit.json`(00:19:05)与 `audit/d02`(00:17:57)mtime 不变;round2 产物落独立目录 `screenshots/review-round2/` + 独立 JSON ✓。
- 边界同 Round1:零 commit/push、生产仅只读、保护物未读、零临时还原需求(本轮无需动 workspace.js)。

### 11.5 Round 2 结论

Round1 全部发现(Major-1 + Minor-1/2/3)已按 R1 指令消化且经独立复核属实;三项修复、回归、隔离与文档口径维持 Round1 已核事实。**终裁 PASS(ENGINEERING PASS + UX HANDOFF READY 口径不变;用户 Mac UX ACCEPTED 仍唯一归属用户本人,Agent 不代宣布)。** 后续提交按 REPORT §6 回填 exact-head CI 双 job 回执即可。
