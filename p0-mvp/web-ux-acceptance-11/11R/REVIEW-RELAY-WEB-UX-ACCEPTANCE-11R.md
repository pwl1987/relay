# RELAY-WEB-UX-ACCEPTANCE-11R 独立 Review 复核记录(单轮;2026-11-16)

> Reviewer 独立复核,一切以亲自读源码/亲跑命令/亲看截图为准,不采信执行方自述。
> 冷起点:live main HEAD=`cebeb4f`(11R 合同提交);基线=48efc19(11 收口);工作区含执行方未提交修复(6 M 跟踪+2 非保护未跟踪),Reviewer 只读复核+本文件落盘,零 commit/push。
> 复核后临时克隆已删除,主工作区零污染(前后 status/保护物 mtime/PID 逐一对照一致)。

## 0. 终裁

**PASS(技术面;0 Major,2 Minor 登记不阻断)。**

归属声明(如实):本 PASS 仅覆盖 11R 工程/技术面。WEB-UX-03 用户 Mac 实机 **UX ACCEPTED 唯一归属用户本人**(按 MAC-ACCEPTANCE-CARD.md 实机操作并明确反馈后方可写入,Agent 不代宣布);生产切换 **D3 决策不在 Reviewer 可裁范围**(唯一归属用户/协调方,生产预检 NO-GO 维持)。

## 1. 冷启动与工作区核对(亲自执行)

- `git log -3 --oneline`:HEAD=`cebeb4f`(11R 合同)→ `48efc19`(11 收口)→ `3298518`(11 实施)。与合同登记链一致。
- `git status --porcelain`:M 跟踪文件 **6 个**=web/workspace.js、web/workspace.html、test/e2e/webux03-mobile.test.ts、test/e2e/webux03-workspace.test.ts、test/e2e/webux11-firstuse-audit.test.ts + **p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md(+6/-3)**。
  - **核对说明**:复核委托书写的是「恰 5 个 M」,实际 6 个;但 11R 合同 **E 项明文授权**「更新 `MAC-ACCEPTANCE-CARD.md` 让用户只需一次 Mac 真实操作」,且该文件 diff 内容(终态「新建后续任务」行为/暂停指引/A·B 差异表新增第④障碍说明)与合同授权用途一致——**属授权内变更,非越界**。此为委托书描述与合同文本的差异,以合同为准(AGENTS.md 权威顺序),登记备查,不计执行方缺陷。
- 非保护未跟踪 2 项:`test/e2e/webux11r-terminal-execute.test.ts`(1131 行,新 harness)、`p0-mvp/web-ux-acceptance-11/11R/`(REPORT+evidence 6 件+screenshots 21 图)。
- 受保护未跟踪 **9 项**全部在场:`config/`、`p0-mvp/soak-r3b/`、CI 回执 7 份(bacc849/fbf32f0/02348b6/27e9259/c22d23f/e28c386/48efc19)。
- 11R 合同全文(CURRENT.md 顶部)逐条读毕(A 冷启动/B 先红/C 最小实现/D 真实浏览器/E 交付审查+硬边界)。

## 2. Diff 逐行核读(零 src/ 改动确证)

`git diff --stat`:6 文件 +105/-27;`git diff --name-only | grep '^src/'` = **0 条**——后端 held 分支(src/server/api.ts:433-477 亲读原样:非 ACTIVE 一律只追加消息、`held:true`、`followUpTaskId:null`、audit GOAL_MESSAGE_HELD、ack 含「不会自动创建新执行任务;如需继续,请新建一个需求」)、Goal 状态机(src/core/goals.ts:158 枚举 ACTIVE|PAUSED|EXHAUSTED|COMPLETED|FAILED 原样)、权限边界一字未动。

`git diff --numstat`:web/workspace.js +73/-9、web/workspace.html +6/-0、03C/03D/11 harness 三测试 +8/-6/+7/-5/+5/-4、MAC 卡 +6/-3。**非 MAC 卡 5 文件合计=+99/-24,与执行方 REPORT §5「逐字重放(+99/-24 同 patch)」精确吻合**;MAC 卡为合同 E 授权的交接文档更新另行计。

关键修复点逐行核读(全部属实):

1. **renderComposer 三分支**(`gs = state.status.goalState` 真实快照):`ACTIVE` ⇒ 双操作原样(方案 A 不回归);`PAUSED` ⇒ 执行/新建双退场+`#ws-state-hint` 中文恢复指引「该需求已暂停:暂不能执行新任务;如需继续,请先通过任务恢复操作恢复,Relay 不会自动恢复。」;**其余一切非活动态(含未知/空串)⇒ 执行按钮 `hidden+display:none` 内联兜底(B1 同款合规路径),`#ws-followup`(「新建后续任务」)在场,行内项目选择器同场**——未知状态按非活动处理=fail-closed,绝不承诺执行。
2. **createFromComposer 防双击**:`state.creatingGoal` 在途旗标+`sendBtn`/`followBtn` 双禁用 ⇒ 并发/双击仅一次 POST;空文本/超长先校验后置旗标;失败⇒中文提示+旗标复位+按钮恢复+**草稿保留在输入框**;成功⇒跳转新 Goal(旗标不复位,页面卸载,fail-closed 方向正确)。
3. **populateProjectSelect 预选与一次填充守卫**:头部 `if (sel.options.length > 0) return;`(HTML 里 select 初始为空,首填不受影响;renderComposer 终态分支与 init 双调用点不会重复刷);预选仅当 `state.goalId && state.status.projectName` 且遍历 options 命中才 `sel.value=bound`——**注册表不含该项目则不预选**,服务端仍按注册表 400 校验,不伪造关联、不扩权。
4. **workspace.html**:新增 `#ws-followup`/`#ws-state-hint`(均 `hidden` 起步,渲染层 JS 独占管理);注释如实钉入 CSP 发现——亲核 `src/server/app.ts:232` 确有 `style-src 'self'`(无 unsafe-inline),标记内联 style 属性会被拦、JS `.style.display` 属性操作不受限,该发现属实且为 B1 路径合规性提供了反向证明。
5. **03C C5/03D M5 测试语义更新**(合同「必要最少测试」授权):旧断言确实**钉住误导行为本身**(终态断言执行按钮可见并点击),翻转为「终态 `ws-execute` **不可见**+点「发送」⇒ held ack 含「不会自动创建新执行任务」(nth(1) 第二条同文案)+`tasks` 计数不变=零派生」——测试意图(终态只记录不派生)保持,服务端负例由 11R harness T3/T7 承担,无覆盖缺口。
6. **webux11 harness 缺省 `TAG=audit→ci`**:仅影响 `SHOT_DIR`/`EVIDENCE_DIR` 输出目录,属 11 包 M2 教训(缺省 audit 曾覆盖红态证据)的安全方向修正;11R 新 harness 自设计起即缺省 `ci`,证据轮显式 TAG。

## 3. 证据 JSON 与日志核验(亲自解析)

- **`webux11r-terminal-execute-audit-red.json`(红态,tag=audit-red,14 步,capturedAt=2026-11-16T01:31Z)**:`t1-executed-but-held` = `held:true`、`followUpTaskId:null`、`goalsBefore==goalsAfter==1`、note 含「不会自动创建新执行任务」、buttonLabel=「交给 Relay 执行」(误导同屏直证);终态事实步 `executeVisible:true`(COMPLETED/FAILED);`t3-paused-facts` PAUSED 且执行按钮在场;`t2b-pre-fix-no-project-select`(终态无项目选择器);正例 `t5-executive-request-derived`(ACTIVE 显式执行⇒`followUpTaskId` 真实 Task、tasksAfter=2);负例 `t7-*`(COMPLETED/PAUSED held=true 零派生、unknown_project 400、empty/tooLong 400)。与 REPORT §2 全部吻合。
- **`webux11r-terminal-execute-verify.json`(绿态,tag=verify,实数 27 步,capturedAt=07:00Z)**:终态(桌面/手机)`executeVisible:false`+`followupVisible:true`(label=新建后续任务,手机高度 44px);`t3-paused-facts` `executeVisible:false`+`followupVisible:false`+`stateHintVisible:true`(中文恢复指引全文在场)+`projectSelectVisible:false`;`t2b-terminal-bound-facts-settled` `projectSelected:"p-alpha"`;`t2-followup-created`/`t2b-followup-created`/`t4-followup-created-on-failed` 均 `httpStatus:201`+真实新 GoalId+跳转;`t2-double-click-guard` `postCount:1`;`t2-empty-text-guard` 0 请求;`t2-server-error-draft-kept` 草稿全文保留在输入框+「创建失败」提示,`t2-retry-after-error-ok` 恢复后重试成功;`t3/t4/t7-*` held=true/followUpTaskId=null/400 矩阵全过。**Minor-1**:REPORT §4 写「21 步 JSON」,实际 27 步,计数笔误(所有关键事实无一不符,不阻断)。
- **日志**: `webux11r-red-first.log` 尾部 `Tests 6 failed | 4 passed (10)`,失败名单=T1/T2/T2b/T3/T6/T4;`webux11r-verify-green.log` `10 passed (10)`(119s);`webux11r-e2e-regression.log` **46 passed | 2 skipped**(2 skipped=03C/03D 显式截图证据门,与 CI 同口径);`webux11r-quality-quick.log` **182 passed + quick 总裁决 PASS**。
- **consoleErrors 双轮 JSON 头部 desktop/mobile 均空数组**。

## 4. 关键截图亲看(Read 工具直看 PNG,6 张)

| 图 | 亲看所见 |
| --- | --- |
| `audit-red/r02-completed-executed-but-held.png` | 终态(右栏「已完成/已交付」)+held 回执「已记录执行请求。该需求已完结,不会自动创建新执行任务…」+完成卡与**蓝色「交给 Relay 执行」按钮同屏在场**——Major-U1 误导面直证 |
| `verify/r01-completed-terminal.png` | 同一终态:**执行按钮消失**,蓝色「**新建后续任务**」+「发送」+行内项目选择器(「请选择一个项目」),无 hint |
| `verify/r08-paused-hint.png` | 右栏「已暂停」;composer 仅「发送」(无执行/无新建);输入框下方**中文恢复指引全文** |
| `verify/m03-paused-hint-mobile.png` | 手机 390 暂停态同形态(仅发送+指引),无误导入口 |
| `verify/m01-completed-terminal-mobile.png` | 手机终态:项目选择器+「新建后续任务」+「发送」,执行按钮退场 |
| `verify/r04-followup-new-goal.png` | 后续任务**真实新 Goal**:新需求 ACTIVE(进行中/排队中)+「已纳入执行队列」进度块——ACTIVE 态双操作按方案 A 正确恢复 |

## 5. 独立红绿复现(临时克隆亲自执行;主工作区零污染)

操作:`git clone --shared --no-checkout /home/ubuntu/dev/relay /tmp/rr11r-review` → `checkout cebeb4f` → symlink node_modules → 拷入执行方工作树 5 文件+新 harness。

- **红轮**(web/ 两文件还原 cebeb4f=修复前,`WEBUX11R_TAG=review-red2`,当前 harness):**恰 6 failed | 4 passed (10)**,退出码 1。失败名单=T1/T2/T2b/T3/T6/T4,与执行方红日志身份完全一致;4 个通过恰=T5(ACTIVE 正例)/T7(后端负例矩阵)/零浏览器错误×2。**6 个失败点逐一核对全为翻红断言**:572(T1 executeVisible 应隐藏实在场)、595(T2 followup 应在场实缺)、749(T2b 项目选择器应在场实缺)、797(T3 executeVisible 应隐藏实在场)、910(T6 手机 executeVisible)、1073(T4 executeVisible)——5× `expected true to be false` + 2× `expected false to be true`,零环境错误。
- **绿轮**(恢复修复后 web/,`WEBUX11R_TAG=review`):**10 passed (10)**,退出码 0,131.5s,0 pageerror/console.error。
- 红绿翻转面=仅 web/workspace.{js,html} 两文件(克隆内 `git checkout cebeb4f -- web/…` ⇄ `cp` 修复版往返,其余不动)——**修复因果钉死**。
- 测试产物全部落在克隆目录;主工作区 11R/ 下无 review-* 产物;克隆已删除。
- **Minor-2(登记,不阻断)**:执行方红日志断言行号(T6=892/893、T4=1053 等)与随包当前 harness(T6=910/912、T4=1071-1075)存在 **+18/+20 行漂移**——harness 在红轮证据生成(09:30)之后、绿轮(14:58)之前有过增补(绿轮 JSON 含 `t2b-terminal-bound-facts-settled` 等待预选落定的观察步,红轮 JSON 无此步,佐证增补发生在两轮之间),REPORT 未披露此节。**实质影响=零**:该 harness 为未跟踪新文件无 git 历史可考,行号漂移使红轮证据与入库 harness 失去逐字节对应,但翻红断言语义未变,且 Reviewer 以**当前** harness+修复前代码独立复现同样恰 6 失败(名单一致),红绿判定不受影响。属 11 包 M2(证据轮被覆盖)的低烈度同族簿记问题,建议收口提交时在 harness 头注释或 REPORT 补一句「红轮证据生成于 harness v1(增补 settled 观察步前),行号以 Reviewer 独立复现为准」即可关闭。

## 6. 合同 C 语义逐条对照

| 合同 C 条款 | 亲核结果 |
| --- | --- |
| ACTIVE 双操作不变 | ✓ renderComposer `gs==="ACTIVE"` 分支原样;T5 正例红绿两轮均过(发送=只记录/显式执行⇒派生受控 Task,响应 followUpTaskId) |
| 终态显式「新建后续任务」真实创建(既有 POST /api/goals 入口) | ✓ 点击⇒201+真实新 GoalId+跳转(verify JSON t2/t2b/t4+亲看 r04);零新 API(diff 面 grep 无新端点) |
| 旧 Goal 不重启、消息不丢 | ✓ harness 断言 goalsCount 恰 +1(新 Goal)、旧 Goal state/feed 计数不变、DB 直查;held 分支未动 |
| PAUSED 不暗示可执行+中文恢复指引+不自动恢复 | ✓ 双按钮退场+hint 全文;零自动恢复代码;T3 两轮断言 |
| 项目归属不伪造不扩权 | ✓ 预选仅当注册表仍含(遍历命中才赋值);服务端 `unknown_project` 400;新 Goal 任务 `allowed_scope`=注册表路径(服务端权威解析,harness 直查 DB 断言) |
| 双击/空文本/报错 fail-closed 草稿保留 | ✓ `postCount:1`/0 请求/路由 abort⇒草稿保留+显式报错+恢复重试成功 |
| 不新增表/PlanRevision/新 API/第二状态机 | ✓ 改动面=web/ 2+test/ 3+MAC 卡,零 src/ 零 schema 零新端点 |
| 后端 fail-closed 负例同时通过(合同 B) | ✓ T7:COMPLETED/PAUSED 显式执行⇒held:true 零派生;未登记项目 400;空/超长 400(红绿两轮均过) |

## 7. 边界核验(复核前后双拍)

- `systemctl --user show relay-web relay-worker -p ExecMainPID`:**3242781/3242782**,复核前后一致,未变。
- 保护物 9 项 `stat -c %Y`:config=1794457300、soak-r3b=1794438470、7 份 ci-checkruns=1794731920/1794738691/1794749967/1794669571/1794726217/1794661438/1794761084——**复核前后逐一相同**,零触碰。
- `docker ps`:无任何 `relay-test-*` 残留容器(仅既有生产 relay-p000-pg 与无关项目容器)。
- `git log --oneline -1` 始终=`cebeb4f`;执行方尚未提交(合同 E 流程:收口提交在 Reviewer 终裁后);Reviewer 零 commit/push。
- 主工作区 `git status` 复核前后逐字节一致;我方全部测试产物在临时克隆内并已随克隆删除。

## 8. 发现清单

- **Major:0。**
- **Minor-1**:REPORT §4 绿轮证据写「21 步 JSON」,实际 `webux11r-terminal-execute-verify.json` =27 步(逐条数过);所有关键事实无一不符,计数笔误,不阻断。
- **Minor-2**:红轮证据日志与随包 harness 存在 +18/+20 行号漂移(harness 红轮后、绿轮前有增补,REPORT 未披露);Reviewer 以当前 harness 独立复现同样恰 6 失败,判定面不受影响;建议收口时一句话注明 harness 版本对应关系(见 §5)。
- **核对说明(不计缺陷)**:工作区为 6 个 M 跟踪文件而非委托书所述 5 个——第 6 个 MAC-ACCEPTANCE-CARD.md 为合同 E 项明文授权且内容合规(§1)。

## 9. 终裁与归属

**技术面终裁=PASS(0 Major)。** 依据:合同 A-E 逐条有独立亲核证据;先红(恰 6,翻红断言面)后绿(10/10)由 Reviewer 在隔离克隆以当前入库 harness 独立复现钉死;零 src/ 改动确证;合同 C 语义逐条满足;硬边界零触碰。

如实归属:**WEB-UX-03 用户 Mac UX ACCEPTED 唯一归属用户本人**(MAC-ACCEPTANCE-CARD.md 已按 11R 行为更新,待用户实机操作与明确反馈);**生产 D3/生产切换唯一归属用户按 D3-DECISION-PACK 单独明确批准**,均不在本 Reviewer 可裁范围。生产预检 NO-GO 维持;MVP=REWORK/真模型/24h 口径不变。
