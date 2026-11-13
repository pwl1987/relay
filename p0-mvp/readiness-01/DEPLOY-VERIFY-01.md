# RELAY-MVP-READINESS-01 子包①:WEB-UX-03D 部署一致性核实报告

- 合同:RELAY-MVP-READINESS-01 §二(用户指令 2026-11-13;CURRENT.md ACTIVE 行)
- 执行:2026-11-13 07:24~07:40 CST;核实方式=只读为主(登录回路+页面/API 只读 GET+Chromium 只读冒烟;零消息发送=零模型消耗)
- 结论:**VM80 实际提供的 Relay Web 与 live GitHub main(`9b05cfb`,产品代码与 `8fe0f7f` 一致)字节级一致;HTTP 行为 32/32;Chromium 双端冒烟 17/17 零页面错误;LAN/VPN-only 保持;Android PWA 当前被非安全上下文硬阻断(HTTPS 最小方案见 §8,仅方案未实施)**

## 1. 冷启动核验(§一)

- live main 重新 fetch=`8fe0f7f`(开工时)→ 合同登记提交 `9b05cfb` 后快进推送成功(SSH-443 attempt=1,网络窗口期模式同前日);本地与远端 0/0 分叉。
- exact-head CI:43280551759 = success(test 2m24s;@`8fe0f7f`)。
- Writer:单 Writer(本窗口),无分叉无冲突;未跟踪产物仅受保护两项=`config/`(运行时 Project Registry,部署产物,不入库)与 `p0-mvp/soak-r3b/`(R-3B 冻结预置,不入库不启动)——分类记录,全程零触碰。
- VM80 运行环境:relay-web/relay-worker 均 active(02:00:08 起,PID 3242781/3242782),`WorkingDirectory=/home/ubuntu/dev/relay`(部署 checkout=工作树),ExecStart=node src/server/index.ts|src/worker-entry.ts,Restart=always,EnvironmentFile=/home/ubuntu/.relay/console/env(0600;仅核验变量名,零打印值),Linger=yes。

## 2. 服务健康证据

- worker 启动横幅(journald,02:00:09):`[relay-worker] started workerId=relay-worker-1 intervalMs=15000 sandbox=docker maxOutputTokens=8192(默认)`——R2 代码上线且默认兼容行为实证。
- relay-web 近 12h journald error/exception 计数=0;监听=10.30.5.80:8787 单接口(ss 实证;非 0.0.0.0,无公网端口,无 Tunnel 进程变更)。
- worker tick 正常(横幅后无异常重启;MainPID 与 02:00 复验记录一致)。

## 3. 资源指纹三方比对(线上 vs 工作树 HEAD vs GitHub raw)

| 资产 | 本地 HEAD(=工作树,干净) | VM80 HTTP served | GitHub raw @`8fe0f7f` |
| --- | --- | --- | --- |
| web/workspace.js | 0f58a367243ff83d | 0f58a367243ff83d | 0f58a367243ff83d ✅抽查 |
| web/style.css | 41a84d38ca157dce | 41a84d38ca157dce | (抽查未扩) |
| web/manifest.webmanifest | f2fae1fbbee10fd3 | f2fae1fbbee10fd3 | f2fae1fbbee10fd3 ✅抽查 |
| web/workspace.html | 01af68dd3497b73a | 01af68dd3497b73a | — |
| web/login.html | 3998555109aa6a0a | 3998555109aa6a0a | — |
| web/app.js | 1ef186a44f746aa2 | 1ef186a44f746aa2 | — |

工作树与 origin/main 0/0 一致且 tracked 零脏 ⇒ **本地=served=GitHub HEAD 三方字节级一致**(raw 抽查 2/2 相符佐证)。

## 4. HTTP 行为验证(32 项自动断言)

`deploy/verify-web-03d.sh` **32/32 PASS**(/ 302 路由/登录 API 200/已登录 302→/workspace/workspace 03D 标记七项/manifest MIME+中文名+standalone+start_url/CSP manifest-src/图标 192+512 200/workspace.js 行为四项[visualViewport/coarse Enter/断网文案/回到最新]/style.css 03D 段/七个旧页 200/会话 role=owner)。

## 5. 生产 DB schema 面(只读)

relay_console **16 表**全部在位(含 0006_goal_messages/0007_goal_message_consumptions;~~原记 17 系本报告误数~~,经用户独立复核实测 16 普通表,已于复核消化节更正);goal_messages=1 行/goal_message_consumptions=1 行(演练 Goal 首消息+消费记录)。03B 会话事实特性生产可用(与 DEPLOY-03D 迁移修复后状态一致,无回归)。

## 6. Chromium 真实双端冒烟(Playwright Chromium;零发送=零模型消耗)

脚本 `p0-mvp/readiness-01/chromium-smoke.mjs`;结果 `smoke-results.json`;截图 `shots/`(9 张:4×1440×900 + 5×390×844)。**17/17 PASS,0 页面 JS 错误**:

| 端 | 验证项 |
| --- | --- |
| 桌面 1440×900 | 登录→/workspace;标题=「Relay · 工作区」;侧栏含两 Goal(状态点灰/红);会话页含需求原文气泡+单 Composer;BLOCKED Goal 失败工作块含「查看原因」按钮;右栏任务信息 pane(项目/状态/阶段/等待用户) |
| 移动 390×844(isMobile+hasTouch) | 登录→/workspace;顶栏 ☰ 可见+工程 stamp 隐藏;抽屉开(350ms 过渡后 class 断言)→遮罩关闭回原上下文;选 Goal 后抽屉自动关;会话含需求原文;BLOCKED Goal 失败块「查看原因」→**技术详情 sheet 打开并关闭**(sheet 内=任务信息/Goal ID/任务/模型 magpie/zcode-GLM-5.3/预算 已用4·上限8/Run=BUDGET_EXHAUSED·budget_turns_cap/执行事件原始两条失败——真实生产失败 UX 证据);Composer 可键入(未发送);「回到最新」浮层元素在 DOM |

脚本修正两处(如实;均为断言/选择器错误,产品行为正确):①标题断言误用「工作台」→03D 实际标题「Relay · 工作区」;②移动技术详情入口误用桌面 `#ws-pane-toggle`(≤900px 已隐藏,正确)→实际入口=Result 卡「技术详情」(ws-result-tech)/失败块「查看原因」(ws-fail-reason)→toggleTech→openSheet(与 03D 实现一致)。

生产 API 实况(只读 GET):Goal #73d01da0=验收演练(PAUSED,1 task)/Goal #1332f8d7=部署冒烟(BLOCKED,BUDGET_EXHAUSED);Projects API configured(pilot-demo);待我决定页 200(32 项内)。

## 7. 功能面逐项判定

| 项 | 判定 | 依据 |
| --- | --- | --- |
| CSP | ✅ | 32/32 manifest-src 'self' 断言+既有 CSP 未回归 |
| 登录流程/Session | ✅ | 302 链+登录 200+role=owner+Chromium 双端登录实测(重启后会话内存态需重登=已知非缺陷) |
| Projects API | ✅ | /api/goals projectName=pilot-demo 同源;32 项注册表断言 |
| Conversation | ✅ | Chromium 双端会话渲染+DB 消息/消费 1/1 |
| Decision | ✅(面)/⏸(真实决策动作) | Decision 卡组件同构建 e2e C3/M3 覆盖;待我决定页 200;**生产真实决策动作留用户验收(当前无未决 Decision)** |
| Result | ✅ | 生产真证据:BLOCKED Goal 失败块+技术详情 sheet 全事实(双端截图) |
| Follow-up | ⏸ 未验证(生产发送) | **零模型消耗原则:不向生产 Goal 发送消息**(发送会派生真实 Run);同构建 e2e C5/M5 覆盖;留用户 VPN 实机验收 |

## 8. PWA 安装判定(Android 与 iOS 分开)+ HTTPS 最小方案

**Android Chrome(判定:当前不可安装,唯一硬阻断=非安全上下文)**
- 服务面已满足:manifest MIME application/manifest+json、name/short_name/display:standalone/start_url、icons 192+512 全 200、theme 浅色。
- **阻断:经 `http://10.30.5.80:8787`(非本机 HTTP)访问 ⇒ 非安全上下文 ⇒ Chrome 安装条件不满足**(安装提示/beforeinstallprompt 不可用);现代 Chrome 安装条件已不强制 Service Worker(03D 有意无 SW 不再是首要阻断)。

**iOS Safari A2HS(判定:基础可用,体验降级)**
- apple-mobile-web-app-capable/mobile-web-app-capable/status-bar-style/viewport-fit=cover 均在页面(32/32);HTTP 下 apple meta 生效 ⇒ 添加到主屏幕后可以 standalone 打开。
- 降级项:manifest 驱动的图标/名称在部分 iOS 版本对 HTTP 源不可靠(可能显示截图缩略图标);真机行为=未验证(留实机)。

**HTTPS 最小方案(仅方案;涉及网络/安全配置,未实施,待用户裁决)**
- 方案 A(推荐,最小影响面):VM80 同机新增 TLS 终结(如 Caddy 内部 CA/mkcert 或 node 自签),**仅监听 10.30.5.80:8443** 内网地址;Mac/iPhone 安装并信任内部根证书;零公网暴露/零防火墙变更/零 DNS 变更/零现有服务改动;systemd user service 同模式。
- 方案 B:若用户 VPN 为 Tailscale/Headscale 系,用其内建 `serve`/证书能力对 tailnet 内提供 HTTPS(涉 VPN 组件配置,需用户确认路由现状)。
- 方案 C:内网 DNS+内部 CA DNS-01(复杂度最高,不建议本轮)。
- 影响声明:任一方案均保持 LAN/VPN-only 边界(合同硬约束),不引入公网可达性。

## 9. 回滚方法(部署面)

部署 checkout=工作树 ⇒ 回滚=`git checkout <目标SHA>(detached)`+`systemctl --user restart relay-web relay-worker`。已知可用回滚点:`8fe0f7f`/`67c89f2`(当前运行构建,产品代码等同)/`2a37a41`(03D 初部署)。DB 回滚:relay_console 迁移为增量(0006/0007 为新增表,不破坏旧结构),回退代码无需回滚 schema。数据面回滚:恢复快照/备份流程沿用既有 ops(未在本包执行)。

## 10. 未验证项(如实)

1. 真机 iPhone Safari A2HS/键盘/safe-area/VPN 实机行为(合同定为用户实机验收)。
2. Android Chrome PWA 实装(被安全上下文阻断,理论判定如 §8;装 HTTPS 后方可实测)。
3. 生产 Follow-up 真实发送(零模型消耗原则,留用户验收)。
4. 生产真实 Decision 处置动作(当前无未决 Decision 可操作;组件级由 e2e 覆盖)。
5. GitHub raw 指纹仅抽查 2 资产(其余 4 资产以本地=served 双方一致+工作树=origin/main 等价推得)。
6. CI @`9b05cfb`(合同登记提交,仅 CURRENT.md 文字变更;推送后 CI 结果待确认,不影响产品代码结论)。

## 11. 用户独立复核发现消化(复核提交 3dea3fa;PASS-WITH-FINDINGS 零 REWORK)

用户于本包执行期间并行独立复核子包①(重新核对 live main/进程/监听/HTTP/Chromium 亲跑 17/17/截图亲看/生产 PG 直查),五发现逐项消化:

| 发现 | 消化 |
| --- | --- |
| F-1 表计数 17 系误数 | ✅ 已更正 §5 为 16 表(独立复核实测口径;后续报告以此为准) |
| F-2 证据应记结果提交 SHA | ✅ 结果提交=02c19f2(子包①证据);本报告形成时 HEAD=9b05cfb 属时序如实;后续证据一律优先记结果 SHA(本节即结果提交内) |
| F-3 exact-head CI 不可独立确认 | ✅ **已确认:CI 43330123942 = success(2m36s)@02c19f2**(gh run list 实证;用户连接器空返回系查询通道问题,非 CI 缺失) |
| F-4 未验证项保持有效 | ✅ 如实维持(真机 A2HS/Android HTTPS 后安装/生产 Follow-up 发送/真实 Decision 动作留用户实机) |
| F-5 d-04 截图命名 | ✅ 注记:d-04=桌面右栏折叠态截图,移动技术详情以 m-04 sheet 为准(不影响结论) |

复核裁决遵从:子包①进入收口不改产品代码;不升级为 UX/PWA 已验收;R2 工程修复保留,F1/F2 对照 UNRESOLVED 维持;不启动 REAL-PILOT/MODEL-POLICY-01/公网开放。
