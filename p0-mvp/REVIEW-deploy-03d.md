# REVIEW:DEPLOY-03D 部署独立复核

- Reviewer:独立上下文 Reviewer(全新窗口;未参与 DEPLOY-03D 实现)
- 复核时间:2026-11-13 01:55~02:10 CST
- 复核时点仓库态:本地 main HEAD=**67c89f2**(1:55:00 F1-R 提交;任务简报所称 ede154f 已被其后提交覆盖),main ahead origin/main 5 个提交,live GitHub 不可达(gh `Forwarding failure`)
- 复核性质:只读复核+亲测;**本 Reviewer 未执行任何重启/写入/服务变更**(全部命令为 git 只读、HTTP 探测、psql SELECT、systemctl show/cat、journalctl、grep)
- 复核对象:p0-mvp/DEPLOY-03D-report.md、deploy/verify-web-03d.sh、生产实例(10.30.5.80:8787)、relay_console schema、相关源码

## 结论:**PASS-WITH-FINDINGS**

部署事实(01:36/01:47 于 2a37a41)、32/32 HTTP 验证、迁移缺口根因与修复、冒烟副作用记账、新发现技术陈述——逐项亲测/源码核验**全部成立**;报告与脚本声称一致、无凭据泄漏、无安全边界破坏。存在 **1 项 Major**(复核窗口内发生一次未记录的生产重启,当前生产运行态已脱离部署 SHA,详见 Major-1)与 4 项 Minor,均为治理/文档精度问题,不动摇部署验证本身的结论;不构成 REWORK。

## 一、必做验证(亲测证据)

### 1. 报告与脚本一致性 — PASS
- 报告称"32 项断言"(report:32)。逐条清点 deploy/verify-web-03d.sh:302 路由 3 项(L23/31/36)+workspace 200+7 标记(L39-48,4 项 check+7 项 contains 计 8)+manifest 7 项(L51-58)+图标 2 项(L61-64)+JS 行为 4 项(L67-71)+CSS 1 项(L74-75)+旧页 7 项(L78-81)+会话 1 项(L84-85)= **恰 32 项 check/contains**。脚本能力(只读 HTTP 探测、口令经文件、零打印)与报告声称一致。
- 口令处理亲核:L27-32 口令写入 mktemp 0600 临时文件经 `--data-binary @file` 传给 curl,**不经 argv/ps**;cookie jar 0600+trap 清理;口令文件实测 `-rw-------`(0600,33 字节)。

### 2. 亲跑验证脚本 — PASS(两次)
- 第一次(约 01:58,服务 PID 3218405/3218406,即 01:47 重启实例):**PASS=32 FAIL=0**,与报告声称完全一致。
- 第二次(02:03,Major-1 所述 02:00:08 重启后的当前实例):**PASS=32 FAIL=0**(tail 确认)。

### 3. 服务态 — PASS
- `systemctl --user show`:复核前 relay-web=active/running pid=3218405、relay-worker=active/running pid=3218406;02:00:08 重启后为 3242781/3242782,均 active/running。
- `journalctl -u relay-worker -n 5`:tick 连续 `status=IDLE claimed=-`。
- `ss -tlnp | grep 8787`:`LISTEN 10.30.5.80:8787`(pid=3218405,后为 3242781)——**非 0.0.0.0,LAN/VPN only 保持**;journal 启动行亦为 `listening on http://10.30.5.80:8787 (worker=external;仅本地)`。
- `systemctl --user list-units 'relay-*'`:仅 relay-web/relay-worker 两个 loaded unit;`loginctl show-user`:Linger=yes。pgrep 实际进程恰 1 web+1 worker,**零第二实例**。

### 4. 迁移面 — PASS
- `information_schema.tables`(relay_console):`goal_message_consumptions`、`goal_messages`、`goals` 等 16 表;**0006/0007 两表就位**,与 migrations/0006_goal_messages.sql、0007_goal_message_consumptions.sql 文件头(CREATE TABLE 列集)吻合。schema 隔离:schemata 中 relay_console 与 soak24h 及各测试 schema 相互独立。

### 5. 冒烟数据 — PASS
- goal-73d01da0:goal_messages 恰 1 条(actor=USER,kind=USER_MESSAGE,内容为"验收演练…由用户自行恢复");task-af2ebcc9 state=**PAUSED**。与报告 §4 一致。
- goal-1332f8d7:goal_messages **0 条**(与"创建于迁移前⇒user message 落库失败,Goal/Task 行已建"吻合);task-93cdadf0 state=**BLOCKED**(state_version=6,attempt=2);runs 恰 1 条(attempt=2,outcome=**BUDGET_EXHAUSTED**,detail=`{"cap":4,"turns":4,"budget":{"tokensIn":1044,"tokensOut":300,"actualCalls":4},"reason":"budget_turns_cap"}`)。
- audit_events seq 23-37 链完整:**WEB_GOAL_CREATED(25)→CLAIM(26,READY→LEASED)→RECLAIM_EXPIRED(27,LEASED→NEEDS_RECONCILE)→TASK_PAUSED_REJECTED(28)→TASK_RESUMED(29,NEEDS_RECONCILE→READY)→CLAIM(30)→ADVANCE(31,32)→RUN_BUDGET_EXHAUSTED(33)**;goal#2:WEB_GOAL_CREATED(36)→TASK_PAUSED(37)。GOAL_PLANNED(24)预算=`{"modelCalls":8}`。

### 6. 部署 SHA — PASS(部署期)/ 见 Major-1(当前态)
- `git log --oneline 2a37a41 -1`:存在;`git show 2a37a41 --stat`:内容=03D 证据再生+Reviewer 入库+CURRENT/CONTINUATION 更新,与 03D 证据提交一致;`git merge-base --is-ancestor 2a37a41 main` 通过(是 main 祖先)。
- **横幅指纹三重证实**(WORKER_STARTED audit):17:36:16Z(pid 3195547)与 17:47:48Z(pid 3218406)banner 均无 maxOutputTokens 字段,与 `git show 2a37a41:src/worker-entry.ts` L45 的 banner 逐字吻合 ⇒ **01:36/01:47 两次重启确运行 2a37a41 代码**;18:00:09Z(pid 3242782)banner 含 `maxOutputTokens=8192(默认)` ⇒ 当前 worker 运行 main(≥6d3eddb)代码。
- **CI 在线核验不可达**:`gh run view 43260446683` → `Get "https://api.github.com/...": Forwarding failure`。如实记录:无法在线核 CI,以实现窗口记录 43260446683=success 为准。

### 7. 安全边界 — PASS
- 监听地址 10.30.5.80(非 0.0.0.0,见上);unit 文件(systemctl cat)**零内联凭据**,凭据仅经 `EnvironmentFile=/home/ubuntu/.relay/console/env` 引用(未读取该文件内容);unit WorkingDirectory=/home/ubuntu/dev/relay 证实"部署 checkout=本工作树"。
- 泄漏扫描:报告/脚本 grep 口令值/密钥无命中(仅 RELAY_MAX_OUTPUT_TOKENS 配置名等非凭据词);commit message(34e6d74..HEAD)中 "token" 均指模型 token 计数,无凭据。
- schema 隔离(见上);零第二实例(见上);口令文件 0600(见上)。

## 二、工程复核要点(逐项证据)

### a. "部署=工作树 detached 至 2a37a41"合规性 — 成立
- systemd unit `WorkingDirectory=/home/ubuntu/dev/relay`(relay-web/relay-worker 两 unit 同)⇒ 不存在独立部署副本,"部署=工作树处于目标 SHA+restart"的事实前提成立。
- 部署目标论证成立:2a37a41 之后的本地提交(6d3eddb R2 实现、0ecee26/67c89f2 两次失败尝试记录、34e6d74 合同、ede154f 部署报告)均未过 CI(R2 两次尝试因上游故障 FAILED),故 2a37a41=最新通过 CI 的 03D。
- 方式合规:临时 detached 符合 AGENTS.md"孤立开发可用临时 detached worktree;不得自动创建永久功能分支";未触碰 main 历史写操作、无强推、未动凭据;当前工作树已回 main。
- 保留意见:该论证只覆盖**部署时刻**;复核窗口内 02:00:08 的未记录重启已使"当前生产=2a37a41"不再成立(Major-1)。

### b. 迁移缺口根因与修复方式 — 正确
- `applyMigrations`(src/core/db.ts:68-91):按 meta/_journal.json 顺序重放全部迁移,**无 DB 端 applied-migrations 跟踪**;调用面仅 `createIsolatedSchema`(db.ts:104,测试隔离)与 CLI 显式路径;src/server/index.ts 与 src/worker-entry.ts 均无启动自动调用(grep 全仓证实)——报告"无服务端启动自动调用/仅测试隔离与显式路径"准确。
- "整体重放会在 0001 崩"有据:migrations/0000、0001 均**无 `CREATE TABLE IF NOT EXISTS`**(grep 计数 0,0001 为裸 CREATE TABLE),对已存在 0005 面的生产 schema 重放必然在首个建表语句失败——"精确补 0006/0007 而非整体重放"是唯一正确选择。
- 佐证链:cli.ts:342 早在代码中预留"当前 schema 缺少迁移面(未跑 applyMigrations?)——属环境未就绪"诊断语;goal-1332f8d7 的 goal_messages 0 行+同刻 Goal/Task 行已建,与"INSERT 失败"叙述吻合。
- 修复结果态证实:两表就位(必做 4)+goal-73d01da0 消息落库成功(必做 5)。原始 psql 交互输出未入仓库,以结果态间接证实(见未验证项 5)。

### c. 12 项合同清单覆盖与如实性 — 成立(带 Minor-2)
- "合同 12 项清单"的**原始枚举未在仓库文档中找到**(仅合同登记提交 34e6d74 与报告标题提及);报告以 32 项 HTTP 断言(部署面)+10 行功能表(生产面)映射覆盖。建议后续报告显式枚举 12 项做 1:1 对照(Minor-2)。
- "同一静态构建"论证结构性成立:web/workspace.js、web/style.css、web/manifest.webmanifest 均为 git 跟踪文件(`git ls-files` 证实),服务直接从磁盘直服(无构建步)⇒ 同 SHA=同资产;CI e2e 即在 2a37a41 树上运行。
- Decision/Composer/Follow-up 生产端到端如实推迟至用户验收,理由成立:避免真实模型消耗(F1-R/F2-R 两次授权已消耗、合同禁止重跑)、上游处劣化窗口(67c89f2:冒烟窗口 5×200 证明上游抖动恢复又断);且 Result 内联已取得生产真证据(冒烟 Goal#1 BUDGET_EXHAUSTED→BLOCKED,工作状态块按 03C.1 语义呈现)——推迟的边界划在"需再烧真实模型"的行为上,未推迟的部分(Result)已用真实失败 Run 覆盖。诚实性 PASS。

### d. 冒烟副作用 Reconcile 记录完整性 — 成立(带 Minor-3)
- 审计链完整且状态机吻合:READY→LEASED→NEEDS_RECONCILE→READY→LEASED→RUN_BUDGET_EXHAUSTED→BLOCKED(state_version=6),与报告 §4 叙述逐步对应。
- 消耗记账如实:计划预算 `modelCalls:8`(GOAL_PLANNED seq 24),报告"模型消耗=单 Run 储备(≤8 calls)"为上界表述;实际 `actualCalls:4`(exhaust 原因 budget_turns_cap,turns=4/cap=4)——上界诚实,实际消耗更低。
- BLOCKED 保留理由成立:作失败 UX 真证据(生产唯一真实 Run 结局),不再 resume 以免再消耗;goal#2 PAUSED 留验收演练场,消息内容自证("由用户自行恢复")。
- Minor-3:seq 28 TASK_PAUSED_REJECTED(17:41:17,NEEDS_RECONCILE 态下暂停被拒,note="仅 READY 可置入 PAUSED")在 DB 链中存在但报告 §4 未叙述。

### e. 新发现技术陈述 — 准确(带 Minor-4)
- **NEEDS_RECONCILE 生产不自愈** — 源码逐点证实:supervisorTick 中 `reconciled = options.executor ? await reconcilePendingTasks(...) : []`(src/core/supervisor.ts:219-221);生产 worker 的 supervisor 循环 `startSupervisorLoop(db, { intervalMs, workerId, claim: false })` 不传 executor(src/worker-entry.ts:53);goal 环路走 `driver.tick()`(worker-entry.ts:56-76),src/server/worker.ts 中 grep supervisorTick/executor/reconcile **零引用** ⇒ 生产无任何路径执行 reconcilePendingTasks。恢复靠 Owner resume:audit seq 29 实测 `TASK_RESUMED NEEDS_RECONCILE→READY`。陈述准确。
- **迁移无自动化/无跟踪** — 准确(见 b)。
- **会话内存态** — 准确:src/server/auth.ts:83 `private readonly sessions = new Map<string, Session>()`,重启即失,"重启后需重新登录"如实且定性"非缺陷"恰当。
- **"等价于复现历史 F2 签名"** — 方向成立但精度有限(Minor-4):冒烟 Run 的 exhaust 原因码 budget_turns_cap 与历史 F2 一致(REVIEW-r2-contrast.md:11 "F2 6/6 budget_turns_cap"),配置条件(未修复 8192 默认)一致;但生产 relay_console 无逐 turn 工具事件表(runs.detail 仅 cap/turns/budget/reason),零工具调用/输出截断等 F2 要件在生产 Run 上**无直证**——签名等同属推断级而非逐字段直证。

## 三、发现清单

### Major-1:复核窗口内发生未记录的生产重启;当前生产运行态已脱离部署 SHA 2a37a41
- **事实**:2026-11-13 02:00:08 CST,relay-web/relay-worker 双服务被 systemctl 重启(journal:`Stopping relay-web.service…Started relay-web.service`,两 unit ActiveEnterTimestamp=02:00:08);当前 relay-web pid=3242781、relay-worker pid=3242782,工作树在 main(HEAD=67c89f2)。
- **指纹铁证**:02:00:09Z WORKER_STARTED banner 含 `maxOutputTokens=8192(默认)`——该字段仅存在于 6d3eddb 之后的 worker-entry.ts;2a37a41 的 banner(git show 2a37a41:src/worker-entry.ts L45)无此字段。⇒ **当前生产运行的是未推送、未经 CI 的 main 代码**(ahead 5,含 R2-REMEDIATION 实现),而非报告声称的部署 SHA。
- **矛盾**:报告(01:50:52 定稿)§1 明言"deploy 后已切回 main,**R2 随推送+CI 后再做 main 同步重启**";02:00:08 重启发生在报告定稿与最后一次提交(01:55:00)之后,提前触发了该计划明言暂缓的动作,且无任何文档记录。
- **归属不可判定**:本 Reviewer 全程只读(未执行任何 restart);无法归因于并发会话或用户,证据面无记录。
- **缓解(实测)**:①`git diff 2a37a41..main -- web/` **零差异**——03D web 面(本包部署目标)两 SHA 等价;②src/server 仅 worker.ts +6/-2(R2 透传),worker 默认 8192 行为与部署时等价(audit banner 自证 8192(默认));③02:00:08 重启后的当前实例**重跑 32/32 PASS**;④LAN-only 绑定/凭据引用/schema/零第二实例全部保持。
- **定级理由**:部署验证本身成立(01:36/01:47 于 2a37a41 有横幅铁证),故不构成 REWORK;但生产运行态与部署权威记录脱钩、且是一次未授权/未记录的状态变更,违反"部署事实可追溯"的治理要求,定 Major。**要求后续动作**:在 DEPLOY-03D 报告补记(或独立 CURRENT 记录)该重启事实与归属,并由用户/写者决定:接受 main 现状(待推送+CI 后落账)或将工作树重新 detached 至 2a37a41 重启对齐。

### Minor-1:报告 §1 PID 转写错误
- report:14 "relay-web(PID 3195546→3218406)/relay-worker(PID 3195547→3218406)"——relay-worker 终态 3218406 正确,relay-web 终态实为 **3218405**(复核前 systemctl 实测);3218406 被重复写给两个服务。

### Minor-2:"合同 12 项清单"原始枚举未入库
- 全仓 grep "12 项/12项" 仅命中报告自身;合同登记提交 34e6d74 也只提及不枚举。报告以 32 断言+10 行功能表映射,覆盖判断成立,但无法做与合同原文的 1:1 核对。建议后续合同登记时把清单枚举落进仓库。

### Minor-3:TASK_PAUSED_REJECTED 未在报告 §4 叙述
- audit seq 28(17:41:17,NEEDS_RECONCILE 态下 Owner 暂停被拒)在链中存在但报告叙述跳过了该事件;记录完整性无损,叙述完整性欠一格。

### Minor-4:"复现历史 F2 签名"为推断级表述
- 同因(budget_turns_cap)同配置条件(8192 默认)成立;但生产无逐 turn 工具事件面,零工具调用/截断等 F2 要件无直证(见二.e)。建议表述降格为"同因同配置条件,签名等同为推断"。

### 观察(不计发现)
- O-1:config/projects.json(生产 Project Registry)**未入 git**(untracked,非 gitignore);单写者运维配置可接受,但版本控制外存在丢失/漂移风险,建议注记或落库。
- O-2:verify 脚本在 /tmp 残留 d03d-manifest(manifest 响应体,非敏感);登录体文件即用即删、cookie jar 0600+trap 清理——卫生可接受。
- O-3:cli.ts:323-344 已有只读"DB 与迁移面"诊断(13 表+守卫),可作为后续"迁移自动化候选包"的现成检测基座。

## 四、未验证项(如实)

1. **CI 在线核验不可达**:gh run view 43260446683 → Forwarding failure(GitHub 不可达窗口)。以实现窗口记录 43260446683=success 为准,推送后应在线补核。
2. **真机浏览器级验证**:iPhone A2HS/键盘/safe-area/VPN 实机——留用户验收(与 REVIEW-webux-03d 未验证项口径一致)。
3. **Decision/Composer/Follow-up 生产端到端(真实模型路径)**:留用户验收,理由=避免真实模型消耗+上游劣化窗口(见二.c);Result 内联已由冒烟真实 Run 覆盖生产证据。
4. **02:00:08 重启的执行者归属**:证据面不可归因(Major-1)。
5. **迁移补应用的原始 psql 交互输出**:未入仓库;以结果态(两表就位+goal-73d01da0 消息落库成功)间接证实。
6. **口令文件内容**:按零打印原则未读取内容,仅核验存在性/权限(0600)/长度(33 字节)。
