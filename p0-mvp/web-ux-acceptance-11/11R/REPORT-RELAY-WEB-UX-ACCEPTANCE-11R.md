# RELAY-WEB-UX-ACCEPTANCE-11R 执行报告(终态/暂停态执行按钮纠偏:可证伪反例→最小修复→红绿闭环)

> 合同:CURRENT.md「RELAY-WEB-UX-ACCEPTANCE-11R 🔵 ACTIVE」(登记于 **cebeb4f**,2026-11-16;基线=11 收口 48efc19;协调方对 11 裁决 REWORK,唯一 Major-U1=终态/暂停态「交给 Relay 执行」按钮承诺与执行结果不一致)。
> 结论口径:**工程面(A 冷启动→B 先红反例→C 最小修复→D 真实浏览器红绿+回归→E 独立 Reviewer)完成与否以 Reviewer 终裁为准**;WEB-UX-03 用户 Mac 实机 UX ACCEPTED 仍唯一归属用户本人;生产预检 NO-GO 维持,零生产触碰。

## 1. A 冷启动与差距审计(合同 A)

- **快进**:live main 48efc19→**cebeb4f**(合同提交;推送前核对其 exact-head Actions **43781867386** test+e2e 双 success,GitHub check-runs API 亲核);本地=origin=cebeb4f。
- **保护物 9 项零触碰**:`config/`、`p0-mvp/soak-r3b/`、CI 回执 7 份(backup bacc849/fbf32f0、cutover 02348b6、deploy 27e9259/c22d23f、egress e28c386、11 收口 48efc19)——执行前后 mtime 逐一核对一致(§5 边界)。
- **生产只读核对**:relay-web/relay-worker PID **3242781/3242782 未变**(systemctl --user 只读);现役=旧 Web 进程,本包全部验证跑在隔离栈。
- **合同 A 指定文档/代码逐项亲读**:AGENTS/CURRENT/`docs/WEB_UX_03_CONTRACT.md`(既有)/`docs/AGENT_CONTROL_LOCAL_QUALITY.md`+`ADR/0012-agent-control-local-quality.md`(实存,已读)/`src/server/api.ts`/`web/workspace.js`/既有 e2e 与 11 截图/Mac 卡。**先核 Core 事实(不凭前端推断)**:
  - Goal 状态枚举=`ACTIVE | PAUSED | EXHAUSTED | COMPLETED | FAILED`(`src/core/goals.ts:155`;schema 注记 `src/core/schema.ts:218`)。现役聚合只产出 COMPLETED/FAILED(`goal-loop.ts:201/204`);**goal 级 PAUSED 无现役置入路径**(仅任务级 ops.pauseTask READY→PAUSED);CANCELLED 是 Task 态非 Goal 态。UI 分支按「非 ACTIVE 且非 PAUSED ⇒ 终态」处理,天然覆盖 EXHAUSTED 与(若未来出现)CANCELLED。
  - 服务端 held 分支(`api.ts:433-477`):`goalState !== "ACTIVE"` ⇒ 只追加消息、返回 `held:true/followUpTaskId:null`、不派生 Task;PAUSED 绝对不重激活;**唯一例外**=终态前在途排队的显式执行可审计重激活(consumption.ts 边界消费)——本包零改动,全部保留。
  - 既有创建入口 `POST /api/goals`:rawInput 必填(空/超长 400)、projectId 必须在注册表内(未登记 ⇒ 400 unknown_project;路径由服务端解析,不接受浏览器路径)——后续任务复用同一入口与同一授权边界,零新 API。
  - 写操作 CSRF(x-relay-csrf 双提交)、状态投影 `/api/goals/:id/status`(goalState/projectName 服务端权威)。

## 2. B 先红反例(合同 B;新增 `test/e2e/webux11r-terminal-execute.test.ts`,RELAY_E2E 门)

隔离合成栈(独立测试 schema p01a_ + 确定性 stub[baseUrl=127.0.0.1:1 不可达层,零付费] + 每任务一次性本地 bare 交付远端 + `RELAY_PROJECTS_FILE`=一次性合成注册表[绝不读受保护 config/];真实 Chromium 双视口 1440×900 + 390×844)。10 测试=6 类红翻面 + ACTIVE 正例 + 后端负例矩阵 + 零浏览器错误门。

- **红轮(修复前代码,`WEBUX11R_TAG=audit-red`)恰 6 失败**(`evidence/webux11r-red-first.log`,翻红断言面):
  - **COMPLETED 桌面(T1)**:事实采集 `executeVisible=true`+`followupVisible=false`(红);**行为反例=亲点「交给 Relay 执行」捕获 HTTP 响应 `held:true/followUpTaskId:null`**、Goal 数不变、Goal 未被重启、消息只追加(`t1-executed-but-held`,截图 `r02` ——终态「已完成·已交付」+ held 回执「不会自动创建新执行任务」与在场的蓝色「交给 Relay 执行」同屏,误导面直证);
  - **FAILED 桌面(T4,exit-mid 确定性失败链)**:终态执行按钮在场(红);11 B2「下一步」文案回归同步通过;
  - **PAUSED 桌面(T3)/手机(T6 后半)**:夹具在隔离 schema 内直接构造(见 §4 夹具说明),执行按钮在场、零恢复指引(红);
  - **终态新建后续任务全流程(T2/T2b/T6 前半)**:入口缺失(红)。
- **同轮通过=正例控制与负例矩阵(红绿轮均须过,证明问题纯在前端、后端边界不动)**:
  - **ACTIVE 正例(T5)**:ACTIVE 态执行按钮可见且语义准确;普通「发送」⇒ 只记录零派生;显式「交给 Relay 执行」⇒ 安全边界内**立即派生受控 Task**(响应 followUpTaskId,两任务均 ACCEPTED、Goal COMPLETED)——方案 A 不回归;
  - **后端负例矩阵(T7/T3/T4)**:COMPLETED/PAUSED/FAILED Goal 上显式执行请求(API 级)⇒ 全部 `held:true`+零 Task 派生+状态不变;未登记 projectId ⇒ 400 unknown_project 且零 Goal 创建;空/超长 rawInput ⇒ 400——**不重开/不越权/fail-closed 全部保持**;
  - 零 pageerror/console.error。
- 红态证据:`screenshots/audit-red/` 8 图(亲看亲核)+ `evidence/webux11r-terminal-execute-audit-red.json`(14 步)。

## 3. C 最小修复(合同 C;`web/workspace.{html,js}` 两文件,零 CSS、零 src/、零 Core/生命周期改动)

| # | 处置 | 内容 |
| --- | --- | --- |
| 终态(COMPLETED/FAILED/EXHAUSTED 等) | 执行按钮退场→显式「新建后续任务」 | `renderComposer` 按 `state.status.goalState` 真实快照三分支:`gs==="ACTIVE"` 保持方案 A 双操作;`gs==="PAUSED"` 见下行;**其余(非活动/未知)执行按钮 `hidden+display:none`(JS 内联,B1 同款路径)**,新按钮 `#ws-followup`(「新建后续任务」)在场,点击复用既有 `createFromComposer()`(POST /api/goals)真实创建新 Goal 并跳转;行内项目选择器同场显示(`populateProjectSelect` 按需一次填充,**预选现 Goal 绑定项目**仅当注册表仍含该项目,用户可改选/可不选);旧 Goal 历史不重启、消息不丢;`state.creatingGoal` 在途旗标+双按钮禁用 ⇒ 双击/网络重发不重复创建;空文本/超长/服务端报错 ⇒ 中文提示+草稿保留+可重试(fail-closed) |
| PAUSED | 不暗示可执行+中文恢复指引 | 执行/新建两入口均退场;`#ws-state-hint` 显示「该需求已暂停:暂不能执行新任务;如需继续,请先通过任务恢复操作恢复,Relay 不会自动恢复。」;「发送」保持聊天存档(held ack 服务端既有文案「该需求会话已暂停…」);零自动恢复 |
| ACTIVE | 语义不变 | 「发送=只记录 / 交给 Relay 执行=显式授权(派生受控 Task)」原样;终态/暂停态若残留客户端仍触发执行入口,走 sendMessage(true)=服务端 held 只记录——fail-closed 兜底(composerSubmit 注记) |

- **先红后绿**:红=恰 6 失败(§2)→ 修复 → **绿轮(`WEBUX11R_TAG=verify`)10/10 全绿**(`evidence/webux11r-verify-green.log`;13 图+27 步 JSON,含终态新按钮/后续任务新 Goal 视图/旧 Goal 不变/暂停指引/ACTIVE 正例全链)。
- **harness 版本对应(Round1 Reviewer Minor-2 消化)**:红轮证据(audit-red,09:30)生成于绿轮(verify,14:58)之前,其间 harness 曾做测试基础设施增补(T2b 预选落定等待步等,+18/+20 行)——翻红断言语义零变化,故红轮日志所附行号与随包当前 harness 存在行漂移;Reviewer 以当前 harness 在临时克隆独立复现同样恰 6 失败(断言点 572/595/749/797/910/1073)证实判定面不受影响。
- **CSP 发现(绿轮实测,如实登记)**:首版修复曾在新按钮标记上用内联 `style="display:none"` 属性——被应用 CSP(`style-src 'self'`,无 unsafe-inline)**拦截并报 console.error**;已改为纯 JS `.style.display` 控制(CSP 不拦 JS 属性操作,亦是 11 包 B1 修复同款合规路径)。此发现反向证明 B1 选 JS 侧内联是唯一合规路径,已钉入 workspace.html 注释。
- **绑定 Goal 执行观察(非缺陷,授权边界正确行为的实证)**:红轮开发期发现项目绑定 Goal 经 stub 执行会到 NEEDS_RECONCILE——根因=stub 写盘于任务工作区,`recordChangeset` 对 `allowed_scope=[项目目录]` 判 violations ⇒ scope 越界写被授权边界正确拦截。T2b 因此以夹具直置终态(任务 ACCEPTED+Goal COMPLETED,隔离 schema,头部注明),只测 UI 后续任务流程与项目绑定校验(新 Goal 任务 `allowed_scope`=注册表路径,服务端权威解析)。

## 4. D 真实浏览器与截图复核(合同 D)

- 双视口完整链:ACTIVE(正例,显式执行派生 Task)→ 终态(COMPLETED/FAILED)→ 输入新请求 → 点「新建后续任务」→ **确认真实新 Goal ID**(跳转 URL 与 201 互证)且**旧 Goal 状态/交付/消息历史未变**(feed 条数、状态 DB 直查);PAUSED 仅指引不暗启;并行双击(仅 1 次 POST)/空文本(0 请求+提示)/服务端报错(路由注入 abort ⇒ 草稿保留+显式报错,恢复后重试成功)负面矩阵全过。
- SIMULATED(合成业务数据+确定性 stub)× REAL(真实 Web 实现/真 Chromium/真隔离 PG)边界在每个证据 JSON 头部如实标注;**不冒称真模型/Mac 实机**。
- 截图:`11R/screenshots/verify/` 13 图 + `audit-red/` 8 图(桌面+手机,含首屏终态/后续任务新 Goal/旧 Goal 不变/暂停指引/ACTIVE 双操作);执行方亲看亲核。
- **旧链回归**:test/e2e 全量 **46 passed | 2 skipped**(2 skipped=03C/03D 显式截图证据门,与 CI 同口径;`evidence/webux11r-e2e-regression.log`)+ **quality:quick PASS**(lint/format/typecheck/unit 182/182;`evidence/webux11r-quality-quick.log`)+ tsc/biome 干净(workspace.js 仅既有警告)。
- **旧测试必要最小更新(合同 C「必要最少测试」授权)**:03C C5 与 03D M5 曾**钉住误导行为本身**(终态断言执行按钮可见并点击)——按 11R 语义翻转为「终态执行按钮不可见+发送路径 held ack(含不会自动创建新执行任务指引)+零派生」,测试意图(终态只记录不派生)不变;终态显式执行请求的服务端负例由本包 T3/T7 承担。
- **11 harness 缺省 TAG 改为 ci(M2 反向应用)**:`WEBUX11_TAG` 缺省 `audit` 曾致红态证据被回归覆盖(11 包事故)——缺省改为回归安全的 `ci`,证据轮必须显式指定;本包 harness(`WEBUX11R_TAG`)自设计起即缺省 `ci`。
- **隔离回归不覆盖历史 11 截图**:11R 证据全部落 `11R/{screenshots,evidence}/` 独立目录;回归轮 webux11/webux11r 产物走 `ci` tag 且当轮即清(可再生,不入库);当轮回归弄脏的既有跟踪证据已按名精确恢复至 HEAD(逐字节;当轮数字以本包日志为准)。

## 5. 生产影响与边界(硬边界逐条)

生产影响=**零**:零生产进程触碰(PID 未变)/零生产 DB 读写(隔离栈+一次性 schema)/零配置/重启/迁移/egress/防火墙/端口/零真实模型(stub 不可达层)/零外部 GitHub 业务交付(一次性本地 bare 远端)/保护物 9 项 mtime 执行前后逐一核对一致。**执行记录(如实)**:本轮回归后清理污染时曾误将自有 5 文件修复一并 `git checkout` 回退——当即发现,按上下文逐字重放(+99/-24 同 patch)并**全量复验**(绿轮重跑 10/10、e2e 全量重跑 46p|2s、quality:quick 重跑 PASS);最终提交以 Reviewer 独立红绿复现为准。

## 6. 如实 NOT_RUN

- 用户 Mac 实机 UX 验收:**NOT_RUN(唯一归属=用户本人;ACCEPTED 不得由 Agent 写入)**;MAC-ACCEPTANCE-CARD.md 已按 11R 行为更新(终态「新建后续任务」/暂停指引)。
- 手机真机(VPN/安全区/软键盘):NOT_TESTED(390×844 真实 Chromium 等效覆盖)。
- 真实模型执行/真实 GitHub 业务写入/Pilot-24H/生产迁移重启/D3:硬禁令,NOT_RUN;MODEL-POLICY-01 未启动。
- quality:full 本地未跑(由隔离 CI test job 全量覆盖,推送后以 exact-head 为权威)。
