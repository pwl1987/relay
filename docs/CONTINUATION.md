# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09~11 完成 P0-00..P0-02C 与 P0-ACCEPT;2026-11-11 完成总授权执行包六阶段 + 收口包;2026-11-12 R-1 闭环解除(US-08/G6 VERIFIED)+ R-2/R-3 收口轮。**MVP 终判:REWORK 维持。R-2/R-3 现状:R-2 授权参数缺失 ⇒ 待授权清单已发出(`p0-mvp/r2-pending-authorization.md`,零真模型运行);R-3 采集于 06:05+0800@12.53h 被会话解体 SIGTERM 波及(缝 365s 落账),06:10 已按原始口径 setsid detached 续采(起点不重置;worker/sampler pid 文件已更新),期满 2026-11-12 17:32:52+0800 用 `node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log` 终验——存在中断缝 ⇒ 终验口径 PARTIAL。勿动 `p0-mvp/soak-24h/` 两进程(现已脱离会话进程组);samples.csv/worker.log 保持 skip-worktree,终验后显式解除入库。明示:每次全量 vitest 触发 1 次真模型 A-4 实验(magpie,limit=8)。**

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- 总包终账:`p0-mvp/REPORT-final.md` + `p0-mvp/final-coverage-matrix.md`(终版矩阵)+ `p0-mvp/REVIEW-final.md`(终审)
- 各包报告:`p0-00..p0-accept/`、`p0-rework2/`(阶段 A)、`p0-rework1/`(阶段 B)、`p0-mvp/REPORT-stage-d|e.md`(阶段 D/E)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 总包收官后的三个 REWORK 解除项(全部有界)

1. ~~R-1~~ **已解除**(2026-11-12 用户补权;`p0-mvp/r1-closure.md`+`REVIEW-r1-closure.md`:US-08/G6 VERIFIED)。
2. **R-2(用户授权模型)**:业务修改需非 magpie 模型(Discovery 已 VERIFIED;F1/F2 门控链路就绪)——**2026-11-12 授权参数(替代模型/预算/超时/凭据)缺失,精确待授权清单已发出:`p0-mvp/r2-pending-authorization.md`;授权到位即按 `r2-failure-analysis.md` §3 跑对照实验**(**注:此句已过时——2026-11-12 07:50 授权已定案 zcode/GLM-5.3 四参数,见 CURRENT.md 第三包"已授权定案"行,`r2-pending-authorization.md` 已关闭留档;执行排期见 ADR-0010 阶段B**)(**再注 2026-11-12 11:10:阶段B 已执行——F2/F1 各一次正式尝试双败,R-2=PARTIAL+归因:F2 BUDGET_EXHAUSTED@6(7×200 零上游故障,止损正常);F1 run SUCCEEDED 但零编辑空提交,机判 1/4 拒+Reviewer BLOCK,根因=`src/runtime/sandbox.ts:131` maxTokens:8192 输出钳制截断(模型自身上限 128000;修复属新变量待用户授权,未实施);model_ref=zcode/GLM-5.3 路由日志逐行实证;零重跑零加预算零换模型零变量调整;报告=`p0-mvp/r2-contrast/REPORT-r2-contrast.md`**)。
3. **R-3(时间+中断)**:**06:05+0800@12.53h 会话解体 SIGTERM 波及两采集进程(缝 365s 落账),06:10 已按原始口径 setsid detached 续采、起点不重置**;期满(17:32:52+0800)→ `node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log` 终验 → REVIEW 确认;**存在中断缝 ⇒ 终验口径 PARTIAL(收口指令:缺失样本或中断时保持 PARTIAL);soak-final.json 由采样器自动写,仅初步报告,判定权在验证器+REVIEW**。
全部解除 → 重生成终版矩阵+独立 Reviewer → 方可 ACCEPTED(不得以 CI 绿代替)。

## MODEL-POLICY-00 设计冻结包(2026-11-12 用户指令;与五包顺序并行)

**只做设计冻结,零模型消耗**:中文设计文档 `docs/MODEL_POLICY.md` + `ADR/0009-model-policy.md`(Provider 四层分层/QuotaPool 统一 glm_weekly/Scarcity/RunModelDecision 持久化/Run 边界切换/异构 Reviewer/DEGRADED_LOCAL/评价指标)。**禁止**:改 R-2 模型与实验变量、消耗新额度、删 Magpie、改 Pi Runtime/生产 Worker、启动动态路由、干扰 soak。MVP 最终 ACCEPTED 后才激活 MODEL-POLICY-01 实施(四通道真实验证+可回放 Evidence)。冻结执行顺序不变:第一包收口→F2→F1→R-3B→MVP 最终裁决(**注:R-3B 已暂缓→PILOT-24H,顺序更新见 ADR-0010 与本文"可用 MVP 最终收口大包"节**)。

## 可用 MVP 最终收口大包(2026-11-12 用户指令;口径裁决=ADR-0010)

**MVP 验收口径正式调整**:连续 24h(及 72h/业务长稳)不再作为 Usable MVP ACCEPTED 硬阻断,重定位为 **Operational/Pilot Readiness Gate**;原 R-3 结论保持 PARTIAL(历史事实,不改 PASS、不重启);**原第二包 R-3B 暂缓**(`p0-mvp/soak-r3b/` 预置产物保持未跟踪、不启动),24h 移至 MVP 后 **PILOT-24H** 在真实使用中完成(真实任务/空闲/模型调用/GitHub/DB/Web/Decision/自然 Restart,无未解释退出/无重复副作用/无状态丢失 ⇒ Operational Readiness=VERIFIED)。执行顺序取代五包中 R-3B 位置:**阶段A 旧 R-3 收口(17:32:52+0800 Runner 唯一快照后;受控停止/冻结证据/解除 skip-worktree/更新 CURRENT+CONTINUATION+matrix/独立 Reviewer/CI/快进推送)→ 阶段B R-2 F2→失败归因→F1(授权四参数不变,F2 失败先归因禁自动重跑)→ 阶段C Operator Console(复用现有 Web/API/Core 禁大型重构;信息架构:Dashboard/Projects/New Goal/Goal Detail/Decisions/Review·Result/Models·Usage(仅可观察性)/System)→ 阶段D Mac LAN+手机 VPN 真实验收 → 阶段E 真实项目 Pilot(≥1 完整任务,自然语言需求禁理想化 Prompt;采集 first_pass_rate/accepted_rate/rework_rate/model_calls/wall_time/tool_failure_rate/reviewer_reject_rate/人工介入/Decision 数/Delivery 成功率)→ MVP 最终裁决(必需项清单见 ADR-0010)**。安全边界:Web 第一阶段仅 LAN+VPN,禁公网裸端口/自动公网域名/Cloudflare Tunnel/浏览器保存 Provider Key/Web 返回模型凭据明文。最终报告必须区分 **Engineering Verified / User Experience Verified / Operational 24h Pending|Verified** 三类,不得混为单一 PASS。MODEL-POLICY-00 冻结维持,MODEL-POLICY-01 不得提前实施。

## WEB-UX-01(2026-11-12 用户大包第四阶段;主路径纠偏后=阶段C)

**实施完成+独立 Reviewer PASS-WITH-FINDINGS(零 Major)**:pi-web(HEAD b96b28b,MIT 实测核验)仅作 UI/UX 参考,**零移植**(台账 docs/PI_WEB_REFERENCE.md 为空);§4.3 views.ts(1981 行)拆分为 src/server/views/ 八模块+纯再导出桶(行为不变,逐字节核验);§4.5 New Goal 项目绑定 P0(浏览器只提交受控 projectId,server 按 config/projects.json 注册表解析路径,Task allowed_scope 绑定项目目录,body.path 一律忽略,audit 落 resolvedPath);§4.4 AppShell(侧栏+手机抽屉)/§4.6 Goal 七阶段 Timeline(确定性推导)/§4.7 采用推荐按钮/§4.8 只读 Diff Viewer(/api/changesets/:id/diff,本地注册仓库 git diff,不可用如实)/§4.10 PWA 最小(自有图标)/§4.11 轮询 8s/30s 零 WebSocket/§4.12 手机 390×844。验证:typecheck+console 15/15+全量回归 51 文件+e2e 7/7(J1-J7;J6 手机无横向溢出零控制台错误;J7=绑定+反向可见+抽屉)。零 MODEL-POLICY-01/零 schema/零 Core/零 soak/零真模型。复核记录 `p0-mvp/REVIEW-webux-01.md`。下一阶段=VM80 Console 部署(systemd user/Linger/仅 LAN+VPN)。

## WEB-UX-02(2026-11-12 用户指令;WEB-UX-01 终裁 Engineering PASS / User Experience = REWORK)

用户 Mac 实机验收反馈(视觉不足/大量英文/信息层级不清/首入不知如何开始/偏工程后台)⇒ UX=REWORK;**WEB-UX-02 ACCEPTED 前暂停:Mac LAN 正式验收、手机 VPN 正式验收、REAL-PILOT、UX VERIFIED**。安全先行已完成:部署口令曾在执行报告明文出现→已轮换(**Web Authentication = CONFIGURED**;新口令仅存 ~/.relay/credentials/web-password 0600;git 历史/工作区/journald 零泄漏;后续报告禁印凭据明文)。产品定位=**AI 软件开发工作台**:打开→选项目→输入自然语言→开始→看进度→做决定→看结果;全中文化(导航=工作台/项目/任务/待我决定/验收结果/AI 资源/系统状态;状态中文映射,API/DB 枚举不改);首页重做(今天想让 Relay 做什么?+项目+大输入框+开始处理;只留 正在处理/等待我决定/最近完成/有问题);AppShell(pi-web 式左侧导航+底部新建需求+状态 Badge);项目页/任务时间线/待我决定卡/验收结果页全面重做;最小 Design System;Mac 1440×900 优先+手机 390×844 简化。禁止:MODEL-POLICY-01/改 Core/改生命周期/改 Gate/新状态模型/第二后端/fork pi-web/Next.js 盲迁;继续 Vanilla JS。**验收五门**:工程∧视觉(截图独立 Review)∧中文∧新手(不读文档走通五步)∧**用户本人 Mac 实机认可才算 ACCEPTED,Agent 不得代宣布 UX PASS**。提交纪律:实现与 Evidence 分离。零模型/零 soak/零 schema/零 Core;CSP style-src 'self' 与 polling 8s/30s 保持。

## 运行环境事实(累计,接手必读)

- **Node strip-types 子进程禁 TS 参数属性**;裸 `node src/xxx.ts` 直跑 .ts(cli/server/worker-entry 同模式;src/server/index.ts 曾因参数属性从未能启动——已修)。
- **vitest 全量与克隆复现不可并行**(egress 栈互踩,R-9);CI 隔离运行为权威口径;magpie 本地模型间歇挂起/方差极端(零编辑/烧回合)——隔离复跑定性,失败如实落账。
- **本机代理栈上游断**:git/curl 网络操作用 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy`;**git push 走 `ssh.github.com:443`**(`GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none"`;直连 443 被劣化,Sectigo 假证书实证);Node/vitest 不读代理 env 不受影响。
- 测试 PG:docker `relay-p000-pg`(127.0.0.1:55433);宿主无 pg_dump/psql ⇒ 脚本走 docker exec 回退(backup/restore/采样器同源)。
- **清理安全**:`src/runtime/safe-rm.ts` safeRm/markRunDir/markTemp(中央守卫;sentinel 必填)——新增递归删除一律走它(教训:`tmpRoots.push(tmpdir())` 险删 /tmp;git clone 要求空目录 ⇒ 哨兵在 clone/commit 后打)。
- worker 驱动:worker-entry 是唯一调度权威(supervisor claim:false 修正两环路争抢);server 默认 external;三入口同 Core(RELAY_DB_SCHEMA 三入口对等)。
- 门控测试:RELAY_E2E/RELAY_BACKUP_E2E/RELAY_DISCOVERY_E2E/RELAY_F1_E2E/RELAY_F2_E2E/RELAY_F3_E2E + **模型消耗测试显式门禁(2026-11-12 第四包遗留):RELAY_A4_E2E(live-worker-e2e)/RELAY_GATE_E2E(gate-e2e)/RELAY_EGRESS_E2E(egress-proxy)**——基础设施门全开不等于授权跑真模型;"零模型定向回归"不再意外触发(教训:07:00 A-4 意外运行);常规全量自动 skip 不假装;测试内改进程 env 必须**子进程隔离**(discovery.test.ts Major-F1 教训)。
- **长跑任务必须脱离会话进程组**(2026-11-12 教训):会话解体对其子进程连坐 SIGTERM——soak 两进程曾在 12.53h 时点被波及(优雅停铁证在 worker.log)。重启一律 `setsid nohup bash -c 'echo $$/WORKER_PID=$$ > pidfile && exec env … cmd >> log 2>&1' &` 模式(exec 保 PID);sample.sh 重启会追加表头(验证器①内建剔除),elapsed 沿 start-epoch 不重置。

## 治理流程(累计)

ACTIVE 合同先于实现提交落盘;证据文件内嵌产出时 HEAD SHA;模型预算分阶段声明经 budget_ledger;每包独立 Reviewer(全新上下文亲测;发现 Major 必修必复验);复核窗口内追加提交须在 REVIEW 记录时序。

## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 AGENTS.md、CURRENT.md、p0-mvp/REPORT-final.md、p0-mvp/final-coverage-matrix.md、p0-mvp/REVIEW-final.md 与 docs/CONTINUATION.md。**当前总包已收官(MVP=REWORK 维持;24h 长稳采集进行中,勿动 p0-mvp/soak-24h/ 两个进程)**。按用户指令处理三项 REWORK 解除项:①若用户已为 PAT 勾选沙箱仓+Contents RW → 跑 github-real.test.ts 闭环;②若用户授权业务模型路由 → 跑 RELAY_F1_E2E/F2_E2E 真模型闭环;③若 24h 已满 → 读 soak-final.json 判定并请 REVIEWer 确认。三项齐备后重生成终版矩阵+独立 Reviewer 终审,全过才可改判 ACCEPTED。严格 main-only、单 Writer、禁强推;每包 ACTIVE 合同先行;测试沿用 Vitest+独立 schema+safeRm;网络操作 env -u 代理变量、push 走 ssh.github.com:443。遇写者冲突、门禁失败或需要增加预算时阻断并说明,不自动扩大。完成后更新 CURRENT.md 与 docs/CONTINUATION.md,报告真实 SHA、CI 与风险。
