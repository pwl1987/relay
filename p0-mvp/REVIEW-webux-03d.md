# WEB-UX-03D 独立 Reviewer 复核记录(390×844 移动端对话工作区)

- **复核 HEAD=2f82f15**(实现提交;父提交=c97e9c4 合同登记;本地 main 领先 origin/main 2 提交,未推送)。
- Reviewer:独立子代理,全新上下文,与实现窗口无关联;只读复核+亲测,未修改任何产品代码、未 push、零模型消耗。
- 裁决:**PASS-WITH-FINDINGS(零 REWORK)**;§18 八问 8/8 PASS;工程复核 a-j 全过;发现 Minor-1~2(治理/证据入库)+ 观察 O-1~O-3(非缺陷,登记备查)。

## 1. 实现范围核对(合同 → diff 逐文件)

`git diff c97e9c4..2f82f15 --stat`:9 文件,+1369/−25。

| 文件 | 变更 | 合同条款 |
| --- | --- | --- |
| src/server/app.ts | 1 行:CSP 增 `manifest-src 'self'`(app.ts:232) | §14 PWA;其余指令零放宽 |
| web/workspace.html | viewport-fit=cover(:6)+apple A2HS meta(:13-16)+☰(:46)+状态点(:47)+遮罩(:37)+回到最新(:58)+详情 sheet(:84-92)+ws-conn 加 class(:44) | §2/§4/§10/§11/§14 |
| web/workspace.js | 移动断点/指针判定(:22-29)+visualViewport→--ws-app-height(:31-43)+抽屉(:121-130)+回到最新(:458-479)+toggleTech 移动路由 sheet(:487-492)+renderDetailInto 单一实现两处消费(:511-517)+发送回显/失败还原(:600-618)+growInput(:648-654)+coarse Enter=换行(:660-669)+顶栏状态点(:692-720)+断网文案(:771)+Esc/遮罩接线(:812-834) | §4/§9/§10/§11/§13 |
| web/style.css | 03D 块(:536-637):桌面隐藏新控件(:542-547)+≤900px 顶栏/抽屉/动态高度/Decision 44px/回到最新/Composer safe-area/sheet | §2/§4/§7/§9/§11 |
| web/login.html | viewport-fit=cover+apple meta(:5-14) | §14 |
| web/manifest.webmanifest | name=Relay · AI 软件开发工作台/theme 浅色(#f4f5f7)/display standalone/start_url /(:2-10) | §14 |
| test/integration/console-api.test.ts | +29 行:PWA 静态资产断言(:191-218) | §14 |
| test/e2e/webux03-mobile.test.ts | 新增 668 行:M1-M10 双栈 12 用例 | §16 |
| test/e2e/webux03d-shots.test.ts | 新增 368 行:§17 截图生成器(RELAY_E2E+RELAY_03D_SHOTS 双门) | §17 |

**零后端新路由/零 schema/零 Core/零模型消耗**:diff 中 src/ 仅 app.ts 一行 CSP;无迁移文件;无 src/core 触碰。✓

## 2. 亲测(Reviewer 本机执行,2026-11-13 00:20~00:30,未并行 vitest)

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 0 错误 |
| `npx vitest run test/integration/console-api.test.ts` | ✅ 9/9(含新增 PWA 断言:manifest MIME=application/manifest+json/CSP manifest-src/图标 192+512 可达/双入口页 viewport-fit+apple meta) |
| `RELAY_E2E=1 npx vitest run test/e2e/webux03-mobile.test.ts` | ✅ **12/12**(M1/M3/M4/M5/M7/M8/M9/M10 交付栈 + M2/M6 慢桩 6s 栈 + 两个 describe 各自「零浏览器错误」断言) |
| `RELAY_E2E=1 npx vitest run test/e2e/webux03-workspace.test.ts` | ✅ 8/8(桌面 C1-C6,**03C.1 不回退**) |
| `npx vitest run test/e2e/webux03-mobile.test.ts test/e2e/webux03d-shots.test.ts`(无门) | ✅ 13/13 全 skip——门控不污染常规全量 |

测试环境:docker relay-p000-pg(127.0.0.1:55433);Node 24;真实 Chromium 390×844(isMobile+hasTouch+deviceScaleFactor=1)。

## 3. §18 视觉八问(逐张亲看 19 张截图后判定)

亲看清单:p0-webux-03d/screenshots/ d17-01~08(390×844 八场景)、d17-09/10(1440×900 桌面回归)、mj1/mj2/mj3/mj4/mj5/mj7/mj8/mj9/mj10(journey 证据);对照 p0-webux-03c/screenshots/ws16-01-blank-newtask-1440x900.png 与 ws16-04-result-1440x900.png。

| # | 问题 | 判定 | 截图证据 |
| --- | --- | --- | --- |
| 1 | 手机打开马上知道怎么和 Relay 说话? | **PASS** | d17-01:首屏即「今天想让 Relay 做什么?」hero+项目选择+「告诉 Relay 你想做什么……」输入框+蓝色「开始」贴底;无文档/无入口寻找成本。mj1:发送后原地进入会话(用户气泡+「已纳入执行队列,即将开始」) |
| 2 | 输入框始终容易操作? | **PASS** | d17-01~08 全部场景 Composer 恒在视觉底部(M1 断言贴底 ±24px);44px 高/16px 字号(防 iOS 聚焦放大)/发送键 44×68;运行中(d17-02)、未决(d17-03)、完成(d17-04)、断网(d17-08)均可继续输入;自然增高上限 140px |
| 3 | Decision 单手可完成? | **PASS** | d17-03/mj3:「允许 / 批准」主按钮整行(M3 断言 boundingBox.height≥44),「不允许/稍后处理」两列;点击后原地更新(M3 断言卡 detached+URL 仍为原会话+DB RESOLVED_MANUAL),不跳后台页 |
| 4 | 无桌面后台压缩感? | **PASS** | 八张 390×844 无三栏并排压缩:侧栏转抽屉(d17-06)、右栏转 sheet(mj4)、Feed 全宽气泡 88%;M1 断言 scrollWidth≤391 零横向溢出;顶栏只剩 ☰+状态点+项目·标题 |
| 5 | Result 一眼能看懂? | **PASS** | d17-04/mj5:绿✓卡「Relay 已完成本轮工作」+代码修改/N 项测试/独立复核通过/已提交 GitHub N 个文件+「查看修改/技术详情」;M4 断言无 propose_failed、无 /tmp/ |
| 6 | Drawer 足够简单? | **PASS** | d17-06/mj7:品牌+「+ 新建任务」+按项目分组(LAMICE/WPS 插件/项目未绑定)状态点+「待我决定」Badge+4 个辅助入口;遮罩点击/Esc 关闭(M7 断言关闭后 URL 与 active 行不变=回原会话) |
| 7 | 长会话自然? | **PASS** | d17-07/mj8:24 条向上翻历史不被轮询拉回(M8 断言 5s 后 scrollTop<120),「回到最新 ↓」浮层出现,点击平滑回底(M8 断言贴底 ≤60px) |
| 8 | 无工程术语污染主界面? | **PASS** | 八张主界面零 Goal ID/Model/Budget/SHA/Gate/stack//tmp/provider/HTTP 内码;刷新时间戳在手机隐藏(M1 断言 ws-stamp 不可见);技术信息仅存在于主动打开的 sheet(mj4 亲见:Goal ID/模型/预算/Run/Gate·Reviewer/交付·SHA/作用域+原始执行事件全在 sheet 内) |

**任一核心项失败⇒REWORK 条款未触发:8/8 PASS。**

桌面回归对照:d17-09/10 与 ws16-01/04(03C.1 基线)逐区一致——左侧栏分组/待我决定 Badge/中央 hero+宽 Composer+「Enter 发送,Shift+Enter 换行」提示/右栏任务信息+技术详情折叠/顶栏数据读取时间俱在;桌面无 ☰、无状态点(M10 断言)。差异仅为测试数据(会话行/已运行时间 9 秒 vs 26 秒)。

## 4. 工程复核 a-j(逐条,文件:行号 证据)

| 项 | 判定 | 证据 |
| --- | --- | --- |
| a. Mobile/Desktop 同一 API/Feed,零 Mobile 专属状态模型 | ✅ | 03D diff 零新增 fetch/API 调用;移动端仅渲染层分支(renderDetailInto 单一实现两处消费,workspace.js:511-517;sheet 恒 techOpen=true :505-509);新增 UI 状态仅 `sheetOpen` 布尔(workspace.js:486,视图态非域态);Feed/侧栏/Decision/Result 全部复用 03C 的 state/refreshAll/renderFeed;M6 复用 03B.1 at-most-once 消费链断言(consumption map 恰一条,webux03-mobile.test.ts:647-652) |
| b. 桌面零回退 | ✅ | CSS:新控件桌面一律 `display:none`(style.css:542-547),全部新规则位于 `@media (max-width:900px)`(:549 起),--ws-app-height 仅移动块消费(:577);JS:`isMobileView()` 仅 toggleTech 分支(workspace.js:488),coarse 指针早退保桌面 Enter 发送(:663-669),coarse 才抑制自动聚焦(:844),桌面 ws-stamp/右栏/pane-toggle 不动(HTML 无条件渲染,CSS 桌面不隐藏);亲证=C1-C6 8/8+M10+ws16-01/04 对照+workspace 03C e2e 里 Enter 语义原样 |
| c. Composer visualViewport/safe-area/回显/失败还原 | ✅ | watchViewport 将 Math.round(vv.height) 注入 --ws-app-height、resize/scroll 双监听、无 vv 回退 innerHeight(workspace.js:31-43);.ws-main height=var(--ws-app-height,100dvh)(style.css:577)⇒不依赖 100vh;safe-area=Composer padding-bottom calc(10px+env(safe-area-inset-bottom))(style.css:609-613)+顶栏 padding-top(:551)+sheet 卡(:626)+viewport-fit=cover(workspace.html:6,login.html:5);16px 字号防 iOS 放大(style.css:615);发送即回显=pendingLocal.push+renderFeed(true) 先于 await(workspace.js:603-604);失败还原=input.value=content+growInput+「发送失败,请稍后重试」(:611-614,M9 断言 inputValue 含原文);创建失败「创建失败,请稍后重试」(:638) |
| d. 长会话 | ✅ | nearBottom<140 才自动滚(workspace.js:426,03C.1 P0-5 原语义未动);immediate(动作渲染)除外(:456);未贴底⇒updateJumpButton(overflow>40px 才显示,:458/:473-479);jumpToLatest smooth+旧 Safari scrollTop 兜底(:462-471);M8 三段断言(贴底/不被拉回/回到最新) |
| e. 技术详情默认全隐藏 | ✅ | 手机右栏整列 display:none(style.css:580);sheet 默认 hidden(workspace.html:84,CSS :546-547);toggleTech 移动端一律 openSheet(workspace.js:488)⇒Result 卡「技术详情」(:254)与失败「查看原因」(:247)在手机都进 sheet;技术字段(Goal ID/当前任务/模型/预算/Run/Gate·Reviewer/交付·SHA/作用域)只在 techShown 层渲染(:536-557),移动 testid=ws-sheet-tech/ws-sheet-events 独立(:537/:547);M4 断言 sheet 关闭时 count(ws-detail-tech)=0 且打开后含预算/作用域/Goal ID;主界面文案层无内部码(M4:无 propose_failed、无 /tmp/) |
| f. 断网 | ✅ | 拉取失败 setConn(「与 Relay 的连接暂时中断,正在重新连接。」)(workspace.js:771,用户化文案,Reviewer F-1 语义保留);不清空会话=refreshAll catch 不触碰 state(仅横幅),M9 断言断网前后气泡数相等;恢复=轮询循环未停(unroute 后横幅 hidden,M9);写失败不假成功=sendMessage catch 还原+报错(:611-614),Decision 按钮失败经 mk 包装「操作失败,请稍后重试(详见技术详情)」(:366-371,成功 notice 在 await 之后不达) |
| g. PWA | ✅ | manifest:name/short_name/display=standalone/start_url=/scope=/icons 192+512/theme 浅色(manifest.webmanifest:2-10;图标文件在 web/icons/ 实存);CSP 增 manifest-src 'self' 且仅此一项(app.ts:232,其余九指令逐字未变);workspace.html:6/13-16 与 login.html:5-14 viewport-fit=cover+apple-mobile-web-app-capable/mobile-web-app-capable/status-bar-style/apple-mobile-web-app-title;**无 Push/无 Service Worker**(全仓 grep serviceWorker 零命中);console-api 集成 9/9 背书(MIME/字段/图标可达/双入口 meta) |
| h. 安全 | ✅ | CSP 仅增 manifest-src(见 g);零 innerHTML:app.js:36 对 html key 主动 throw,workspace.js:2 铁律注释,grep 全 web/*.js 零命中;textContent-only(h() DOM API);无 Key/凭据:grep workspace.js/app.js 零 apiKey/password 命中,manifest/页面无凭据;断言层:M4 主界面禁内部码、M10 桌面零错误 |
| i. 测试质量 | ✅ | 断言真实:几何(boundingBox≥44/贴底±24/scrollWidth≤391/scroll 指标)、DB(goal_messages 行/decisions.state=RESOLVED_MANUAL/task 计数/goals 计数不变/consumption at-most-once)、route.abort 真断网、真实点击路径;不假绿=两个 describe 各有「全程零 pageerror/console.error」;门控双保险(describe.skipIf(!E2E)/(!E2E||!SHOTS),无门亲测 13/13 skip);夹具=每任务独立 bare 远端(remoteFor Map,webux03-mobile.test.ts:216-251,与 03C.1 Reviewer 修正同源;shots 同 :150-186),沿用而非新造 |
| j. 提交纪律 | ✅(附 Minor-1/2) | 时序:c97e9c4(合同,仅 CURRENT.md+docs/CONTINUATION.md)→ 2f82f15(实现,9 文件);实现提交零 soak/config/p0-mvp 产物(git show --name-only 核对);基线 44224df 未回退(03C e2e 8/8+ws16 对照) |

## 5. 发现清单

| # | 级别 | 内容 | 建议 |
| --- | --- | --- | --- |
| Minor-1 | Minor | 治理/脏工作区:工作区存在未提交的截图字节级再生——p0-mvp/webux-02/screenshots 16 张(03C.1 Review Minor-8 已登记的历史遗留,仍未处置)+ p0-webux-03c/screenshots 14 张(c1-c6/ws16 双视口,本包复跑 03C e2e 的副产物;视觉一致仅时间戳/数据差异)。未混入 2f82f15(正确),但按 AGENTS.md §2 须显式处置而非长期挂账 | 实现窗口收尾:随证据提交或 `git restore`,并在 CURRENT.md/CONTINUATION 注记 |
| Minor-2 | Minor | 证据未入库:p0-webux-03d/screenshots/ 19 张(§17 八场景+桌面回归 2 张+mj journey 9 张)当前未跟踪;2f82f15 仅含实现与测试代码,无后续 evidence 提交。03C/03C.1 先例=实现提交与证据再生提交分离且证据最终入库;推送前若不补,live main 将无 03D 截图证据 | 按先例补独立 evidence 提交(或 Reviewer 记录+截图一并)后再快进推送 |
| O-1 | 观察(非缺陷) | 桌面两处非破坏性增量:①growInput 自然增高(输入事件驱动,上限 140px)现也作用于桌面——03C.1 桌面无 JS 增高,但 CSS max-height:140px 早已存在(style.css:519),实测 ws16-01/04 与 d17-09/10 对照零视觉差异,C1-C6 8/8;②#ws-conn 加 class="ws-conn"(workspace.html:44)使桌面连接横幅获得既有样式(style.css:444,03C.1 时未挂 class 属遗漏)。两者均为改善,登记备查 | 无需行动 |
| O-2 | 观察(非缺陷) | 抽屉辅助入口「总览(旧)」带维护性「(旧)」标注,移动端可见(d17-06);继承自 03C.1 侧栏渲染(本包未改),非回退 | 后续 UX 轮可议 |
| O-3 | 观察(非缺陷) | 「回到最新」浮层 bottom 固定 108px+safe-area(style.css:596-607),Composer 增高到 140px 上限时浮层可能与输入框上缘轻微重叠(瞬态、纯视觉,未断言) | 可留真机验收观察 |

## 6. 未验证项(如实)

1. **真机 iPhone Safari/A2HS**:apple meta/viewport-fit/manifest 的实机 standalone 安装、safe-area 真机 insets、visualViewport 键盘行为、惯性滚动——模拟器(Chromium 390×844)不能替代;合同 §19 本就将其定为下一步「用户 Mac+手机 VPN 真实使用验收」。
2. **CI**:2f82f15 未推送,CI 未跑;推送后以 CI 为准(常规全量不含 RELAY_E2E/RELAY_03D_SHOTS 门,已亲证无门时 13/13 skip)。
3. **github-real 2 用例**:本机网络间歇问题为 03C.1 已登记历史事项,与本 diff 零交集,本轮未复跑。
4. §17 截图为 stub worker 合成数据(合同允许;非真实模型),真实观感以用户实机验收为准。

## 7. 结论

**WEB-UX-03D = PASS-WITH-FINDINGS(零 REWORK)**。M1-M10 12/12、桌面 C1-C6 8/8、集成 9/9、typecheck 绿、门控零污染、19 张截图逐张亲看、§18 八问 8/8 PASS、工程 a-j 全过。依 §19 完成即停:不进 REAL-PILOT/MODEL-POLICY-01/公网;Minor-1/2 由实现窗口处置(证据入库+脏区清理),随后推送+CI,最终交用户 Mac+手机 VPN 实机验收。Agent 不代用户宣布 UX ACCEPTED。
