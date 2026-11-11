# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09~11 完成 P0-00..P0-02C 与 P0-ACCEPT;2026-11-11 完成总授权执行包六阶段(阶段 A REWORK-2 CLI / B REWORK-1 Discovery / C GitHub 权限核查(BLOCKED)/ D F1-F3+清理安全 / E 编排+长稳采集+备份 / F 终审)。**MVP 终判:REWORK 维持(独立 Reviewer 一致)——终态见 `p0-mvp/REPORT-final.md`。24h 长稳采集进行中,勿动 soak 进程。**

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- 总包终账:`p0-mvp/REPORT-final.md` + `p0-mvp/final-coverage-matrix.md`(终版矩阵)+ `p0-mvp/REVIEW-final.md`(终审)
- 各包报告:`p0-00..p0-accept/`、`p0-rework2/`(阶段 A)、`p0-rework1/`(阶段 B)、`p0-mvp/REPORT-stage-d|e.md`(阶段 D/E)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 总包收官后的三个 REWORK 解除项(全部有界)

1. **R-1(用户侧单点)**:PAT 勾选 `pwl1987/relay-delivery-sandbox`+Contents RW → `npx vitest run test/integration/github-real.test.ts`(无需新授权;禁宽权限 gh token)。
2. **R-2(用户授权模型)**:业务修改需非 magpie 模型(Discovery 已 VERIFIED;F1/F2 门控链路就绪,重跑即闭环)。
3. **R-3(时间)**:24h 观察期满 → `p0-mvp/soak-24h/soak-final.json` 自动判定 → REVIEW 确认(采样器自动写;勿动进程)。
全部解除 → 重生成终版矩阵+独立 Reviewer → 方可 ACCEPTED(不得以 CI 绿代替)。

## 运行环境事实(累计,接手必读)

- **Node strip-types 子进程禁 TS 参数属性**;裸 `node src/xxx.ts` 直跑 .ts(cli/server/worker-entry 同模式;src/server/index.ts 曾因参数属性从未能启动——已修)。
- **vitest 全量与克隆复现不可并行**(egress 栈互踩,R-9);CI 隔离运行为权威口径;magpie 本地模型间歇挂起/方差极端(零编辑/烧回合)——隔离复跑定性,失败如实落账。
- **本机代理栈上游断**:git/curl 网络操作用 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy`;**git push 走 `ssh.github.com:443`**(`GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none"`;直连 443 被劣化,Sectigo 假证书实证);Node/vitest 不读代理 env 不受影响。
- 测试 PG:docker `relay-p000-pg`(127.0.0.1:55433);宿主无 pg_dump/psql ⇒ 脚本走 docker exec 回退(backup/restore/采样器同源)。
- **清理安全**:`src/runtime/safe-rm.ts` safeRm/markRunDir/markTemp(中央守卫;sentinel 必填)——新增递归删除一律走它(教训:`tmpRoots.push(tmpdir())` 险删 /tmp;git clone 要求空目录 ⇒ 哨兵在 clone/commit 后打)。
- worker 驱动:worker-entry 是唯一调度权威(supervisor claim:false 修正两环路争抢);server 默认 external;三入口同 Core(RELAY_DB_SCHEMA 三入口对等)。
- 门控测试:RELAY_E2E/RELAY_BACKUP_E2E/RELAY_DISCOVERY_E2E/RELAY_F1_E2E/RELAY_F2_E2E/RELAY_F3_E2E——常规全量自动 skip 不假装;测试内改进程 env 必须**子进程隔离**(discovery.test.ts Major-F1 教训)。

## 治理流程(累计)

ACTIVE 合同先于实现提交落盘;证据文件内嵌产出时 HEAD SHA;模型预算分阶段声明经 budget_ledger;每包独立 Reviewer(全新上下文亲测;发现 Major 必修必复验);复核窗口内追加提交须在 REVIEW 记录时序。

## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 AGENTS.md、CURRENT.md、p0-mvp/REPORT-final.md、p0-mvp/final-coverage-matrix.md、p0-mvp/REVIEW-final.md 与 docs/CONTINUATION.md。**当前总包已收官(MVP=REWORK 维持;24h 长稳采集进行中,勿动 p0-mvp/soak-24h/ 两个进程)**。按用户指令处理三项 REWORK 解除项:①若用户已为 PAT 勾选沙箱仓+Contents RW → 跑 github-real.test.ts 闭环;②若用户授权业务模型路由 → 跑 RELAY_F1_E2E/F2_E2E 真模型闭环;③若 24h 已满 → 读 soak-final.json 判定并请 REVIEWer 确认。三项齐备后重生成终版矩阵+独立 Reviewer 终审,全过才可改判 ACCEPTED。严格 main-only、单 Writer、禁强推;每包 ACTIVE 合同先行;测试沿用 Vitest+独立 schema+safeRm;网络操作 env -u 代理变量、push 走 ssh.github.com:443。遇写者冲突、门禁失败或需要增加预算时阻断并说明,不自动扩大。完成后更新 CURRENT.md 与 docs/CONTINUATION.md,报告真实 SHA、CI 与风险。
