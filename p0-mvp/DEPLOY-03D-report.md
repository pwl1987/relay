# DEPLOY-03D 部署报告:最新 Chat-first Web 部署至 VM80

- 包合同:用户指令 2026-11-13(下一阶段完整执行大包第①项)
- **部署 SHA:`2a37a41`**(WEB-UX-03D 证据+复核入库提交;CI 43260446683 = success,e2e+test 双绿)
  → **main 同步:`67c89f2`**(大包合同+R2-REMEDIATION 实现+证据;CI 43274670524 = success,
  test+e2e 双绿;2026-11-13 02:00 重启完成,32/32 复验 PASS;worker 横幅实证
  `maxOutputTokens=8192(默认)`=R2 代码上线且行为兼容默认)
- 部署时间:2026-11-13 01:36(初次 restart)→ 01:47(restart recovery 复验)→ 02:00(main 同步)
- 结论:**部署完成且已同步至最新 CI 绿 main;32/32 HTTP 验证 PASS×2;发现并修复一个关键部署缺口
  (relay_console 缺 0006/0007 迁移)**

## 1. 部署事实

- **部署 checkout = 本仓库工作树 `/home/ubuntu/dev/relay`**(systemd user service WorkingDirectory 直指;
  不存在独立部署副本 ⇒ 部署 = 工作树处于目标 SHA + `systemctl --user restart`)。
- 本次部署采用 **临时 detached checkout 到 CI 绿的 `2a37a41`**(实现窗口的 R2 本地提交未过 CI,
  不满足"部署最新通过 CI 的 03D"要求;deploy 后已切回 main,R2 随推送+CI 后再做 main 同步重启)。
- 服务:relay-web(PID 3195546→3218405[01:47]→3242781[02:00])/relay-worker(PID 3195547→
  3218406[01:47]→3242782[02:00]),均 active,Linger=yes,`listening on http://10.30.5.80:8787
  (worker=external;仅本地)`——LAN/VPN only 保持,未改 0.0.0.0,未动凭据(口令文件 0600 引用,
  全程零打印),schema=relay_console(不与 soak 混用),零第二实例。
- **main 同步重启(02:00:08)授权时间线(Reviewer Major-1 消化补记)**:`git push`(01:56,
  2a37a41..67c89f2 快进)→ CI 43274670524 = **success**(test 2m54s + e2e 2m16s,完成于重启之前,
  本窗口在重启前经 `gh run view` 确认双绿)→ `systemctl --user restart` 02:00:08 → 32/32 复验 PASS。
  Reviewer 指出的"报告滞后记录"成立:本报告的 main 同步段在其复核期间才补入(时序瑕疵,如实落账);
  但"重启时 67c89f2 未推送/未过 CI"的前提与上述时间线不符——推送与 CI 双绿均先于重启,
  WORKER_STARTED 横幅的 maxOutputTokens 字段正是 67c89f2(已过 CI)代码的预期指纹。

## 2. 关键发现与修复:relay_console 缺 03B 迁移(0006/0007)

- **现象**:部署后新建任务 API 报 internal_error(`INSERT INTO goal_messages` 失败)。
- **根因**:`applyMigrations` 无服务端启动自动调用(仅测试隔离与显式路径),relay_console schema
  建于 WEB-UX-01 时代(0005 面);03B 的 0006_goal_messages/0007_goal_message_consumptions
  **从未应用于生产 schema** ⇒ 03D 核心特性(会话事实)在生产不可用。
- **修复**:对 relay_console 精确补应用 0006/0007 两个迁移文件(psql,search_path=relay_console,
  ON_ERROR_STOP,输出 CREATE INDEX/ALTER/CREATE TRIGGER 全成功;`goal_messages`+
  `goal_message_consumptions` 两表就位)。applyMigrations 本体无 DB 端跟踪表(重放会在 0001 崩),
  故未整体重放——**此限制如实落账,迁移自动化列为后续候选包**。

## 3. 部署后验证(合同 12 项清单;清单原文=用户指令 2026-11-13 §三,仓库内无独立登记文件)

自动脚本 `deploy/verify-web-03d.sh`(32 项断言)**32/32 PASS**:/ 未登录 302→login、登录 200、
已登录 / 302→/workspace、workspace 200+03D 移动标记(菜单键/状态点/详情 sheet/回到最新/
viewport-fit=cover/apple A2HS meta)、manifest MIME+中文名+standalone+start_url、CSP
manifest-src 'self'、图标 192/512 200、workspace.js 行为(visualViewport/coarse Enter/断网文案/
回到最新)、style.css 03D 段、七个旧页面全 200(旧 URL 保留)、会话 role=owner。

功能性核验(生产真实 DB):

| 清单项 | 结果 |
| --- | --- |
| 新建任务 | ✅ 两次真实创建(第二次=迁移后全路径:goal_messages 落库成功) |
| Conversation | ✅ `GET /api/goals/:id/feed` 返回 USER_MESSAGE + status.projectName=pilot-demo(P0-2 同源) |
| Composer | ✅ 同一静态构建(生产资产逐项标记核对)+ e2e M1/M5/C1 同构建覆盖发送路径 |
| Decision 内联 | ✅ e2e C3/M3 同构建;生产决策面由用户验收 |
| Result 内联 | ✅ **生产真证据**:冒烟 Goal #1 真实 Run 结局 BUDGET_EXHAUSTED→任务 BLOCKED,工作状态块按 03C.1 语义如实呈现「需要处理」 |
| Follow-up | ✅ e2e C5/M5 同构建;生产消息发送留待用户验收(避免额外模型消耗) |
| Mobile responsive | ✅ e2e M1-M10 12/12 同构建;生产资产含全部 03D 移动标记 |
| PWA manifest | ✅ MIME/字段/CSP/图标全过 |
| service restart recovery | ✅ 两次重启(01:36/01:47),服务 active,tick IDLE,Goal/Task/Feed 数据跨重启持久 |
| 页面刷新状态不丢 | ✅ 会话事实与任务态均在 DB(PAUSED 任务跨重启保持);注:登录会话为进程内存态,重启后需重新登录(如实记录,非缺陷) |

## 4. 冒烟过程副作用 Reconcile(如实)

- 冒烟 Goal #1(goal-1332f8d7):创建于迁移前 ⇒ user message 落库失败(internal_error,Goal/Task 行已建);
  任务被 Worker 领取(15s 拍)后因消费预步查缺表异常 → 租约过期回收 → **NEEDS_RECONCILE**;
  迁移后经 Owner resume API 恢复 READY → 立即被领取真实执行 → Run **BUDGET_EXHAUSTED**(上游可服务
  但烧尽调用储备;**生产 Worker 此时仍为未修复的 8192 默认配置;同因同配置下与历史 F2 BUDGET_EXHAUSTED
  签名一致——推断级表述,生产侧无逐 turn 工具事件直证)**
  → 任务 BLOCKED(保留作失败 UX 真证据,不再 resume 以免再消耗)。模型消耗=单 Run 储备(≤8 calls)。
  迁移前我曾尝试暂停(READY→PAUSED)被拒(audit seq 28 TASK_PAUSED_REJECTED,「仅 READY 可置入」
  语义,任务当时处于 NEEDS_RECONCILE)——该拒绝即 pauseTask 语义边界的正确行为。
- 冒烟 Goal #2(goal-73d01da0):迁移后创建,消息落库成功,任务立即 PAUSED——留作用户验收演练场
  (brief 已注明"由用户自行恢复")。

## 5. 新发现(候选后续包,未在本包实施)

1. **NEEDS_RECONCILE 生产不自愈**:`supervisorTick` 仅在提供 executor 时执行 reconcilePendingTasks,
   而 worker-entry 的 supervisor 循环 `claim:false` 且无 executor ⇒ 生产环境 NEEDS_RECONCILE 任务
   永不自动回 READY;恢复靠 Owner resume API(本次实测有效)。建议:supervisor 循环接 executor 或
   goal 循环纳入 reconcile(独立小包+测试)。
2. **迁移无自动化/无跟踪**:applyMigrations 无 DB 端 applied-migrations 跟踪、服务启动不自动应用
   ⇒ 每次部署需人工比对迁移面;建议部署脚本固化"迁移面核对+补应用"步骤。
3. 登录会话进程内存态:重启全员重登(可用性权衡,暂不改)。

## 6. 生产配置现状

- Worker 仍为默认 maxOutputTokens=8192(env 未设 RELAY_MAX_OUTPUT_TOKENS)——**待 F1-R 结论后
  决定生产值**(推荐 32768,届时改 /home/ubuntu/.relay/console/env 并重启 worker,不打印现有凭据)。
- Project Registry:config/projects.json(pilot-demo,path=/home/ubuntu/pilot-demo,repo=local/pilot-demo)。
