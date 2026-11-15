# RELAY-WEB-UX-ACCEPTANCE-11 执行报告(首次使用可理解性审计·最小修复·Mac 验收交接)

> 合同:CURRENT.md「RELAY-WEB-UX-ACCEPTANCE-11 🔵 ACTIVE」(登记于 8d53fc1;最低祖先 02348b6 满足)。
> 结论口径:**ENGINEERING PASS + UX HANDOFF READY**——工程面(审计→先红→最小修复→回归→CI)完成;**用户 Mac UX ACCEPTED 仍必须由用户本人按 `MAC-ACCEPTANCE-CARD.md` 实机体验并明确反馈后方可写入,Agent 不代宣布**。生产切换(D3)口径不变:生产预检 NO-GO 维持,生产切换须用户单独批准,本包零生产触碰。

## 1. A 冷启动与事实盘点

- **快进**:live main 02348b6→**8d53fc1**(合同提交;推送前核对其 exact-head Actions test+e2e 双 success,GitHub check-runs API 亲核);本地=origin=8d53fc1。
- **保护物 8 项零触碰**(合同登记口径):`config/`(162B)、`p0-mvp/soak-r3b/`、CI 回执 6 份(backup bacc849/fbf32f0、**cutover 02348b6**、deploy 27e9259/c22d23f、egress e28c386)——存在性与 mtime 与合同登记一致,全程未读未写未纳提交。
- **生产进程只读核对**:relay-web/relay-worker PID **3242781/3242782 未变**(2026-11-13 02:00:08 CST 启动,systemctl --user 只读)。合同 A 要求的「先辨别现役=旧 Web 进程」落实:现役页面≠最新 main UI,本包全部验证跑在隔离栈,操作卡如实区分两者。
- **文档与实现盘点**:WEB_UX_03_CONTRACT(03A~03E 完成状态+§12 用户实机验收唯一剩余门)/UI_UX(实现注记:主交互=/workspace 会话式工作区)/WEB_UX_03_ARCHITECTURE(设计冻结)/USAGE_MAC·USAGE_MOBILE(旧版时点注记)/ADR-0010 验收分层;Web 真实实现=web/workspace.{html,js}+app.js+style.css+src/server/{app,api,worker,auth}.ts;既有 Playwright 资产=test/e2e/webux03-workspace(C1-C6)、webux03-mobile(M1-M10)、web-journey(J1-J6,含 exit-mid 崩溃链)、webux02-visual。

## 2. B 真实前端路径核验并先红(审计,合同 B 全链)

新增 `test/e2e/webux11-firstuse-audit.test.ts`(RELAY_E2E 门;真实 Web 实现×隔离合成栈:独立测试 schema + 确定性 stub + 一次性本地 bare 交付远端 + `RELAY_PROJECTS_FILE` 指向一次性空注册表——**绝不读取受保护 config/projects.json**;零真实模型、零外部交付、零生产连接):

- **双视口完整旅程 6/6**(桌面 1440×900 + 手机 390×844,同一栈双 context):登录首屏→空状态(无项目/无任务)→一句话建需求→Feed/进度→Decision(内联+批准)→失败/停止态(exit-mid 确定性失败链:Run FAILED(rpc_disconnect)→REWORK 退避→attempt 预算耗尽⇒任务 FAILED)→Result→追问(held)→刷新保持→手机抽屉/触控(≥44px)。
- **逐步骤结构化观察**(`evidence/firstuse-audit-audit.json`=修复前红态 11 步[executeVisible=true/旧 heroSub/失败块无下一步];`firstuse-audit-verify.json`=修后绿态 18 步[含失败态 d9/d10 全量 facts];独立 Reviewer 自产 `firstuse-audit-review{,-red}.json`):hero 文案/Composer 状态/侧栏/工作块/决策卡/回执/几何(横向溢出、Composer 贴底、触控高度)逐项采集;零 pageerror/console.error。
- **新鲜真实 Chromium 截图亲看亲核**:修复前=`screenshots/audit/`(R1 重生成红态 11 图[d01–d09+m01–m02;红态下 D1/M1/D4 于钉住断言处中止,d10/手机后半程截图不产生]与 Reviewer 自产 `screenshots/review-red/` 12 图互证);修复后=`screenshots/verify/`(18 图)与 Reviewer `screenshots/review/`(18 图)。以行为证据而非 selector PASS 判定。
- **轮次证据登记(R1,Reviewer Major-1 消化)**:首轮 audit/ 证据曾被当轮全量回归覆盖(回归内含本 harness 且缺省 TAG=audit,在修后代码上 6/6 通过、重写了 audit/)——已按 R1 在临时还原的修复前代码上重生成红态 audit/(恰 3 失败,`webux11-audit-red-regen.log`;并清除残留的 7 张修后旧图,现存 11 图与红轮断言中止形态自洽),workspace.js 精确恢复(+31/-7 同 patch),并按 M2 把「证据轮/回归轮分离、回归必须显式 WEBUX11_TAG=ci」钉入 harness 头注释;Reviewer 独立红态复现(review-red/,12 图)与本重生成互为印证。

### 前 3 项最高优先级阻断/混淆点(全部可复现;先红证据 `webux11-red-first.log` 恰 3 失败)

| # | 问题 | 行为证据(截图+DOM 事实) | 根因 |
| --- | --- | --- | --- |
| **B1** | 空白态**双主按钮**:「交给 Relay 执行」与「开始」并列,前者点击**静默无反应**;手机端输入框被挤压至 ~100px | `d02/m02` 截图:`executeVisible=true`(代码本意 blank 态 hidden);`composerSubmit(true)` 无 goalId 时直接 return | `style.css` `.btn{display:inline-flex}`(210 行)压过 UA 的 `[hidden]{display:none}`;代码库对其他元素均有 `[hidden]` 例外(514/547 行),**唯独漏 `#ws-execute`**——RELAY-CONTROL-READY-03 双按钮方案引入的回归 |
| **B2** | 失败态工作块只有「查看原因」工程入口,**零中文下一步** | `d09` 截图:仅「✗ 本轮工作未完成,需要处理/✗ 代码修改未完成/查看原因」 | 方案 A 下终败 Goal 不自动重开,重试路径=新建需求,但界面未说 |
| **B3** | 零项目时引导语自相矛盾:hero 要求「选择项目」而选择器如实显示「尚未配置项目—直接开始」,未告诉用户如何添加项目 | `d02/m02` 截图+`heroSub`/`projectFirstOption` facts | hero 副标为硬编码通用文案,未随注册表实读状态适配 |

(其余观察为非阻断:终态 Goal 追问回执文案已含明确下一步「请新建一个需求」;「项目未绑定」为 03C.1 P0-2 审定如实文案不擅改;工作块聚合时序为 P0-3/P0-5 钉住语义;手机贴底/无横向溢出/抽屉均过。)

## 3. C 最小修复(全部落位 `web/workspace.js` 单文件,零 CSS 改动、零 Core/生命周期改动、零新状态机)

| # | 修复 | 内容 |
| --- | --- | --- |
| B1 | 空白态唯一主操作 | `renderComposer` 空白态对执行按钮 `hidden=true` **追加内联 `display:none` 兜底**(.btn display 压过 [hidden] 的既知形态,与 style.css 514/547 例外同语义),任务态原样恢复——空白态只剩「开始」,点击无反应的按钮不再在场;手机输入框恢复全宽。不触碰 style.css(其 33 行存在**既有** format 漂移,任何 CSS 改动会触发 quality format 步骤失败;JS 内联即最小且内聚) |
| B2 | 失败态中文下一步 | 失败工作块新增提示行「下一步:点「查看原因」了解详情;如要重试,请新建一个需求,把要做的事再告诉 Relay。」(与既有 P1-1 文案规范一致,零内部码直出) |
| B3 | 零项目引导适配 | `populateProjectSelect` 实读 /api/projects 后记录 `state.hasProjects`,空白态 hero 副标切换为「尚无项目:直接在下方输入一句话即可开始;如需按项目组织,先在左侧「项目」页添加项目。」;未读取/读取失败维持通用文案(不冒充) |

- **先红后绿**:红=`evidence/webux11-red-first.log`(3 失败,断言面恰为 B1 桌面+手机、B2;B3 断言在 B1 修复后暴露,红态复放日志 `webux11-audit-red-reprod.log` 同证)→ 修复 → `evidence/webux11-verify-green.log` **6/6 全绿**。
- 修复钉住断言入库审计 harness(空白态 `executeVisible=false` 双视口、失败块含「下一步/新建一个需求」、零项目 heroSub 含「直接」且不含「选择项目」)。

## 4. D 体验证据与交接(合同 D)

- **两组新鲜真实 Chromium 截图**(修复前 audit/、修复后 verify/,各 18+ 张,桌面 1440 与手机 390,含首屏/建需求/进度/Decision/批准/失败/查看原因/Result/追问/刷新/抽屉):`p0-mvp/web-ux-acceptance-11/screenshots/`。SIMULATED(合成业务数据+确定性 stub)× REAL(真实 Web 实现/真浏览器操作/真隔离 PG)边界在每个截图包与观察 JSON 头部如实标注。
- **一页中文《Mac 实机验收操作卡》**=`MAC-ACCEPTANCE-CARD.md`:现役生产 Web(旧代码基线)与最新 main 隔离预览的**差异表**、预览启动方法(`scripts/webux11-preview.mjs` + SSH 端口转发,127.0.0.1 绑定零公网,不伪造在线地址)、三条可复制测试需求、正常路径逐步预期反馈、失败截图收集方式、手机真机 NOT_TESTED 如实标注。
- **隔离预览启动器**=`scripts/webux11-preview.mjs`(新增,VM80 本机一条命令):一次性测试 schema(p01a_ 授权守卫 fail-closed,退出即删,已实测清理)+随机一次性口令(仅打印一次)+stub 执行链+2.5s 自动推进;本机实测 login 200/workspace 302/退出即下线/schema 零残留。

## 5. E 独立 Reviewer 与回归

- **独立 Reviewer 隔离冷启动(原文=`REVIEW-RELAY-WEB-UX-ACCEPTANCE-11.md`)**:**Round1 终裁 REWORK(1 Major/3 Minor,零停机级)**——执行方全部实质主张(修复真实性/根因/先红日志/回归/边界/文档一致性/CI 基线 43721016797 双 success)亲核**属实**,并独立复现红态(还原 8d53fc1 版 workspace.js ⇒ 恰 3 失败,md5 精确复原)+绿态 6/6(TAG=review)+预览脚本实跑(schema 零残留);唯一 Major-1=「修复前 audit/ 证据被当轮全量回归覆盖为修后形态,REPORT 引用与现存文件矛盾」(非造假——先红日志真实且 Reviewer 已复现——属证据轮被吞没后的登记缺失)。**R1 消化(本轮)**:①红态 audit/ 在临时还原代码上重生成(恰 3 失败)+精确恢复(+31/-7 同 patch);②M1=失败态 facts 统一落盘(两 afterAll 共用 flushObservations,verify JSON 现含 d9/d10);③M2=「证据轮/回归轮分离」钉入 harness 头注释+本报告;④REPORT §2/§4 引用同步;⑤M3=Reviewer 独立证据(review/、review-red/、review-round2/ 及三个 JSON)随包入库。⇒ **Round2 复核终裁 PASS(0 Major)**(REVIEW 文件 §11):红态重生成恰 3 失败/audit 恰 11 图自洽/patch 未动/M1-M3 全部亲核属实,Reviewer 另以 TAG=review-round2 亲跑 6/6 且红态证据 mtime 零触碰;终裁=**ENGINEERING PASS + UX HANDOFF READY**(用户 Mac UX ACCEPTED 仍唯一归属用户本人)。
- **回归(零退化)**:`evidence/webux11-e2e-regression.log` = test/e2e 全量 **36 passed|2 skipped(38;EXIT=0**;2 skipped=RELAY_03C_SHOTS/RELAY_03D_SHOTS 显式证据门,设计内 skip,与 CI 同口径);Reviewer 亲跑 journey+03C+03D **27/27**、quality:quick 亲跑 **182/182 PASS**(`evidence/webux11-quality-quick.log`);tsc/biome 干净(workspace.js 仅既有警告,零新增 error)。
- **回归运行证据污染如实登记(已恢复)**:test/e2e 既有套件把当轮截图/日志写入其跟踪目录(p0-02c、p0-mvp/webux-02、p0-webux-03c/03d,共 49 文件),覆盖已入库的历史证据——执行方按「历史证据不改写」原则**全部 `git checkout --` 恢复至 HEAD**(逐字节还原;当轮运行数字以本包 `webux11-e2e-regression.log` 为准;Reviewer 复跑再弄脏的 30 个亦已恢复)。后续全量 e2e 复跑须在干净克隆进行,且**内含本 harness 的复跑必须显式 `WEBUX11_TAG=ci`**(M2,harness 头注释已钉)。

## 6. CI 时序(exact-head 如实;推送后回填)

- 基线回执:8d53fc1(合同提交)test+e2e 双 success(GitHub API 亲核,推送前完成)。
- 实施提交=本包唯一实施提交,exact-head Actions 于推送后核验双 job,回执 JSON 留未跟踪(循 bacc849/02348b6 例)。
- 收口提交(REPORT §6 回填+CURRENT/CONTINUATION)自身 CI 于推送后核验,回执留未跟踪。

## 7. 生产影响与边界

生产影响=**零**:零生产进程触碰(PID 未变)/零生产 DB 读写(隔离栈+一次性 schema)/零生产配置/重启/egress/防火墙/端口/零真实模型调用(stub 确定性执行,`baseUrl=127.0.0.1:1` 不可达层零付费请求)/零外部 GitHub 业务交付(一次性本地 bare 远端)/受保护未跟踪物 8 项零触碰。全部真实读写=一次性容器/schema/临时目录+合成数据。

## 8. 如实 NOT_RUN

- 用户 Mac 实机 UX 验收:**NOT_RUN(唯一归属=用户本人;ACCEPTED 不得由 Agent 写入)**;
- 手机真机(VPN/安全区/软键盘):NOT_TESTED(本包仅 390×844 真实 Chromium 等效覆盖);
- 真实模型执行/真实 GitHub 业务写入/Pilot-24H/生产迁移重启:硬禁令,NOT_RUN;
- quality:full 本地未跑(由隔离 CI test job 全量覆盖,推送后以 exact-head 为权威)。
