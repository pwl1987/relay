# Relay / HIVE Next 续接（仅导航；不拥有当前合同）

> **2026-11-14**：唯一 ACTIVE 见 [CURRENT.md](../CURRENT.md) 首项 **RELAY-SAFETY-AUTHORITY-06**（A 预检误判修复已过独立复核 PASS；B 文档审计/C 四项目借鉴/D 文档压缩进行中）。生产 NO-GO，未经用户 D3 不得迁移、重启、改配置。四项目研究来源见 [EXTERNAL_PATTERN_COMPARISON_20261114.md](EXTERNAL_PATTERN_COMPARISON_20261114.md)。**下文历史叙述已压缩：旧 ACTIVE/执行指示均无效，一切以 live main 的 CURRENT.md 顶部为准。**

状态:**FROZEN(续接指令,不是独立事实源)**。本文件只做短导航：当前授权、关键未解决风险与登记项、历史包索引全部在 **CURRENT.md**；历史包的合同原文、逐日进度与实施细节以 **Git 历史（git log/show）与各包报告/复核记录（`p0-00/`..`p0-accept/`、`p0-mvp/`）** 为准。

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`+部署 Runbook:`deploy/README-deploy.md`
- 总包终账:`p0-mvp/REPORT-final.md` + `p0-mvp/final-coverage-matrix.md`(终版矩阵)+ `p0-mvp/REVIEW-final.md`(终审)
- 各包报告:`p0-00..p0-accept/`、`p0-rework2/`(阶段 A)、`p0-rework1/`(阶段 B)、`p0-mvp/REPORT-stage-d|e.md`(阶段 D/E)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 运行环境事实(累计,接手必读)

- **Node strip-types 子进程禁 TS 参数属性**;裸 `node src/xxx.ts` 直跑 .ts(cli/server/worker-entry 同模式;src/server/index.ts 曾因参数属性从未能启动——已修)。
- **vitest 全量与克隆复现不可并行**(egress 栈互踩,R-9);**VM80 存在真实生产 egress 共享栈,全量本地测试可能 teardownEgress 拆除生产共享栈** ⇒ 全量验证交隔离 CI;CI 隔离运行为权威口径;magpie 本地模型间歇挂起/方差极端(零编辑/烧回合)——隔离复跑定性,失败如实落账。
- **本机代理栈上游断**:git/curl 网络操作用 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy`;**git push 走 `ssh.github.com:443`**(`GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none"`;直连 443 被劣化,Sectigo 假证书实证);Node/vitest 不读代理 env 不受影响;gh CLI 走代理 `HTTPS_PROXY=http://127.0.0.1:8118`。
- **systemd user bus**:VM80 命令会话缺 `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` 时无法查询 user 单元(preflight 已按"无法查询"fail-closed 处理,RELAY-SAFETY-AUTHORITY-06);需要查询时显式 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus XDG_RUNTIME_DIR=/run/user/$UID`。
- 测试 PG:docker `relay-p000-pg`(127.0.0.1:55433);宿主无 pg_dump/psql ⇒ 脚本走 docker exec 回退(backup/restore/采样器同源)。
- **清理安全**:`src/runtime/safe-rm.ts` safeRm/markRunDir/markTemp(中央守卫;sentinel 必填)——新增递归删除一律走它(教训:`tmpRoots.push(tmpdir())` 险删 /tmp;git clone 要求空目录 ⇒ 哨兵在 clone/commit 后打)。
- worker 驱动:worker-entry 是唯一调度权威(supervisor claim:false 修正两环路争抢);server 默认 external;三入口同 Core(RELAY_DB_SCHEMA 三入口对等)。
- 门控测试:RELAY_E2E/RELAY_BACKUP_E2E/RELAY_DISCOVERY_E2E/RELAY_F1_E2E/RELAY_F2_E2E/RELAY_F3_E2E + **模型消耗测试显式门禁(2026-11-12 第四包遗留):RELAY_A4_E2E(live-worker-e2e)/RELAY_GATE_E2E(gate-e2e)/RELAY_EGRESS_E2E(egress-proxy)**——基础设施门全开不等于授权跑真模型;"零模型定向回归"不再意外触发(教训:07:00 A-4 意外运行);常规全量自动 skip 不假装;测试内改进程 env 必须**子进程隔离**(discovery.test.ts Major-F1 教训)。
- **长跑任务必须脱离会话进程组**(2026-11-12 教训):会话解体对其子进程连坐 SIGTERM——soak 两进程曾在 12.53h 时点被波及(优雅停铁证在 worker.log)。重启一律 `setsid nohup bash -c 'echo $$/WORKER_PID=$$ > pidfile && exec env … cmd >> log 2>&1' &` 模式(exec 保 PID);sample.sh 重启会追加表头(验证器①内建剔除),elapsed 沿 start-epoch 不重置。
- **受保护未跟踪目录**:`config/`(运行时 Project Registry)与 `p0-mvp/soak-r3b/`(R-3B 冻结预置)严禁触碰或提交。

## 治理流程(累计)

ACTIVE 合同先于实现提交落盘;证据文件内嵌产出时 HEAD SHA;模型预算分阶段声明经 budget_ledger;每包独立 Reviewer(全新上下文亲测;发现 Major 必修必复验);复核窗口内追加提交须在 REVIEW 记录时序;Agent 的 DONE 不是验收,不得把本地 Reviewer PASS 等同协调方独立验收。

## 历史记录归档说明(2026-11-14,RELAY-SAFETY-AUTHORITY-06 D 项)

2026-11-14 起本文压缩为短导航：原逐包长叙述（P0-00..P0-ACCEPT、总授权执行包、R-1/R-2/R-3、OPERATOR-CONSOLE-00、MODEL-POLICY-00、WEB-UX-01..03D、MVP-READINESS-01、ARCH-FREEZE-01、QUALITY-LOCAL-01、SAFETY-CLOSE-02、CONTROL-READY-03、CONTROL-SAFETY-04、GATE-INTEGRITY-04A/-R2、DEPLOY-PREFLIGHT-05 等）已按"历史交 Git 与已存在 Evidence 追溯"原则移出本文——逐包裁决、提交链与报告路径见 **CURRENT.md「历史包索引」表**；逐项登记（M-4 handback、STOPPED 恢复、审计结构化、迁移自动化、各 Minor）见 **CURRENT.md「关键未解决风险与决策」节**。压缩未删除任何唯一事实：运行环境与治理流程保留于上文，其余均可在 Git 历史与报告文件中完整追溯（历史版本见 `git log -- docs/CONTINUATION.md`）。
