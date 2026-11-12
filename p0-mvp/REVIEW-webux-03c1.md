# WEB-UX-03C.1 独立 Reviewer 复核记录(桌面对话工作区体验收口)

- 复核对象:工作区未提交变更(基线 HEAD=`bc23701` == live origin/main;单 Writer 确认远端未推进)。
- Reviewer:独立子代理(只读复核+亲测;未修改任何文件、未 push、零模型消耗)。
- 裁决:**PASS-WITH-FINDINGS(零 REWORK)**;发现 Major-1 + Minor-1~8,**已全部消化后复跑**(见 §3)。

## 1. 逐项判定(Reviewer 原判,全部 PASS)

| 项 | 判定 | 关键证据(文件:行号,以消化前快照为准) |
| --- | --- | --- |
| P0-1 单 Composer | 过 | workspace.html 删 ws-newtask 面板;renderComposer 两态(空白态「告诉 Relay 你想做什么……」+「开始」/任务态「继续告诉 Relay……」+「发送」);整页唯一 textarea 由 e2e UX1 断言背书 |
| P0-2 项目上下文唯一 | 过 | 服务端 goalStatusView.projectName 与 workspaceSidebarView 归组同源(matchProjectByScope 唯一规则,SQL 口径一致:最近 Task `ORDER BY created_at DESC, id DESC LIMIT 1`);客户端唯一出口 projectDisplay() 用于 Header/右栏/侧栏;「默认工作区」全仓删除 |
| P0-3 阶段去重聚合 | 过 | deriveWork 每阶段 if/else 互斥链,key 唯一;主 Feed 不再渲染逐条事件 |
| P0-4 工作状态块 | 过 | 运行中「Relay 正在处理」/完成「Relay 已完成本轮工作」原位更新;原始事件完整保留技术详情层 |
| P0-5 布局收敛 | 过 | .ws-feed-col 760px + `margin:auto auto 0`(贴 Composer,避免 justify-content 溢出裁切);composer 同宽;nearBottom 才自动滚 |
| P0-6 右栏降噪 | 过 | 默认四项;elapsed 仅 >0 显示;技术详情默认关;整栏可折叠 |
| P1-1 错误用户化 | 过(残口=Major-1,已消化) | 主 Feed 全用户文案;发送/创建/决策失败不直出 err.message;C2 断言无 propose_failed、无 /tmp/ |
| Core 生命周期 | 零变更 | diff 仅 views/goal.ts(纯读)+ web/* + test/* |
| CSP/innerHTML | 零违规 | 全 DOM API+textContent;app.js 对 html key 主动 throw |

UX1~UX6 断言真实性:全部真实覆盖(非摆设),含空白态唯一输入、两态占位/按钮、三处+选择器项目同源、阶段唯一、块原位更新、C3/C4/C5 不回归。

## 2. 亲测(Reviewer 本机执行)

- `npx tsc --noEmit` → 0 错误
- 单测 `workspace-sidebar + goal-messages` → 8/8
- `RELAY_E2E=1 vitest run test/e2e/webux03-workspace.test.ts` → **8/8**(真实浏览器+真 PG+stub;C1/C2/C3/C5/C6/UX3/零浏览器错误)
- 截图 ws16-01~06(1440×900 逐张亲阅 + 1512×982 抽查)七问全 PASS:无双输入框/无项目矛盾/无重复事件/无大片无意义空白(短会话贴 Composer 为合同方向;空白态居中引导语属设计)/像持续 Agent 会话/技术详情默认关/主 Feed 零内部术语。

## 3. 发现与消化(全部完成;消化后复跑全绿)

| # | 级别 | 内容 | 消化 |
| --- | --- | --- | --- |
| Major-1 | Major | D3 `delivery_propose_failed` 决策 question 经 decisionCard 前 200 字直出 `propose_failed`+git 原始报错(HEAD 既有路径;本包 200 字截断只是部分缓解) | **已修**:workspace.js decisionCard 检测该前缀 ⇒ 主 Feed 显示「GitHub 交付未成功,需要处理。」;完整原始 question 保留于「待我决定」页(直出全文)与 API;消化后 e2e 8/8 复跑绿 |
| Minor-1 | Minor | 截断提示「完整内容见技术详情」指向不实 | **已修**:改为「完整内容见「待我决定」页」 |
| Minor-2 | Minor | 交付阶段以任意旧轮 DELIVERED 判「已提交」,本轮 propose 失败时误导 | **已修**:deliver 阶段改以最新变更集为准;最新 NONE 且非活跃 ⇒「交付未完成,需要处理」(不冒充旧轮) |
| Minor-3 | Minor | IN_FLIGHT 与服务端重复定义漂移风险 | **已修**:注释锚定 shared.ts IN_FLIGHT_STATES |
| Minor-4 | Minor | C6 死断言(textContent.match(/ws-work-block/)) | **已修**:改 locator count |
| Minor-5 | Minor | 第四处(Composer Project Selector)无显式断言 | **已修**:UX3 增空白态选项含 LAMICE、不含「默认工作区」断言 |
| Minor-6 | Minor | 折叠/elapsed 无断言;空白态右栏整列空白 | **已修**:C4 增折叠往返+elapsed=1 断言;refreshAll 恒调 renderDetail(空白态「未选择任务」) |
| Minor-7 | Minor | style.css 末尾重复规则 | **已修**:删除 |
| Minor-8 | Minor | 治理:工作区含非本包未提交变更 | 处理:p0-webux-03c/screenshots c1-c6(本包 journey 证据再生)随包提交;**p0-mvp/webux-02 旧截图 16 张改动系本会话开始前已存在的未解释脏工作区,不属本包,不并入提交**(保持未提交,如实披露);config/、p0-mvp/soak-r3b/ 维持未跟踪边界 |

Reviewer 特别审查结论(原文要点):
- (a) deriveWork 守住「Feed=投影不复制状态机」:仅映射服务端读模型,无客户端状态转移、无写、不伪造。
- (b) 测试夹具修正(每任务独立 bare 远端)**理由成立且必要**:每 Run 全新临时工作区(sandbox.ts mkdtempSync)+夹具每 Run 独立 git init 种子 ⇒ 第二笔起与共享远端 HEAD 无亲缘,普通 push(无 --force)必非快进被拒 ⇒ goal-loop 落 OPEN D3。措辞修正:旧 UI 并非不渲染决策卡,真正的掩盖是 (i) 旧测试从不断言无未决决策,(ii) 完成态展示依赖 `tasks.some(ACCEPTED)`/旧 DELIVERED,失败轮仍显示「本轮工作完成」(即 Minor-2,已消化)。每任务远端恢复「远端 HEAD 基线」语义,未触碰 Core。

## 4. 消化后复跑(本窗口 Writer 执行)

- `node --check web/workspace.js` ✓;`npx tsc --noEmit` ✓
- 单测 8/8 ✓;`RELAY_E2E=1 webux03-workspace` **8/8** ✓;`RELAY_E2E=1 RELAY_03C_SHOTS=1 webux03-screenshots` ✓(12 张重生成,逐张自检)
- 全量回归:253 过/37 skip;仅 github-real 2 用例因**本机网络劣化**失败(`git ls-remote failed`(空 stderr)/`spawnSync git ETIMEDOUT`;3 次尝试含按 CONTINUATION §46 剥离代理 env 复跑;客观探针=`git ls-remote https://github.com/...` 成功而 `curl https://github.com` 超时 ⇒ 间歇性网络问题非代码;该用例 `describe.skipIf(!credential.present)`,CI runner 无凭据自动 skip;失败路径与本次 diff 零交集——如实列为**未验证项**,历史先例=03C 收口轮同签名首跑 2 败后好窗口 4/4 绿)。
