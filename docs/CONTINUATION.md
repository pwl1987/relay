# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09 已完成 P0-00(可行性/安全/恢复语义实验,`p0-00/REPORT.md`)与 **P0-01A(持久状态与可靠执行内核,`p0-01a/REPORT.md`)**;2026-11-10 已完成 **P0-01B(有界 Pi Run,`p0-01b/REPORT.md`)**。**P0-01C 尚未实施,不代表产品功能存在。**

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 交互:`docs/UI_UX.md`;安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- **P0-00 结果:`p0-00/REPORT.md`**(ADR-0003/0007 裁决依据)
- **P0-01A 结果:`p0-01a/REPORT.md`**(状态层/35 测试/复核)
- **P0-01B 结果:`p0-01b/REPORT.md`**(有界 Pi Run/70 测试/双层隔离/成本核算)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;ChatGPT optional;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已裁决并落地(2026-11-10 更新)

- **ADR-0003**:Pi 集成=RPC 子进程+`--no-builtin-tools`+扩展注入受控工具+每 Run 一次性 HOME+OS 容器隔离(双层缺一不可)。→ **已在 P0-01B 代码化:`src/runtime`**(pi-version 版本锁定/sandbox 双层沙箱/pi-rpc 协议客户端/runner 生命周期/relay-tools.extension 受控工具/context+handoff)。
- **ADR-0007**:自研 PG 事务+租约+fencing+append-only 审计 → **P0-01A 已代码化 `src/core`**。
- **Lease TTL 契约**:TTL 窗口=权威窗口;Worker 必须心跳续租;**心跳权威仅在工作链内(P0-01B F-3 收口:NEEDS_RECONCILE/终态心跳拒绝)**;Supervisor 仅过期后回收;终态绝对优先。
- **Reconcile 契约**:执行前核对 expected;RESERVED→EXECUTING→COMPLETED/CONFLICT/FAILED;恢复先查目标真实状态三分类,绝不盲目重试。
- **Run 生命周期契约(P0-01B 新增)**:Run 成功 ≠ 任务 ACCEPTED(VERIFYING 后必过 Gate);超时→TIMEOUT+任务 FAILED;取消→CANCELLED;心跳被拒→立即杀 Pi+零推进(INTERRUPTED);断连→rpc_disconnect+任务留 RUNNING;恢复=从 DB 重建上下文(resume_mode=context_rebuild),不假装恢复模型内部状态。
- **测试基建**:Vitest 70 用例(真实 PG+真实 SIGKILL+真实 docker kill+真实容器模型 E2E),每测试文件独立 schema;`npm ci && npm run db:up && npm test` 非模型 68 例全新克隆可复现,E2E/沙箱在缺 provider/docker 时显式跳过。测试库 `relay-p000-pg`(127.0.0.1:55433,512Mi)。
- 运行环境事实:VM80=ubuntu2604;**Pi 1.5.0 已 vendored(升级须改 RELAY_PI_VERSION+package.json 并留证,禁全局 pi)**;模型路由 magpie 127.0.0.1:3425 当前可用(Provider 探测驱动,env RELAY_PI_* 可覆盖);宿主 ufw 拒容器→宿主(沙箱用 --network host,网络隔离妥协已记录);gh 令牌超范围,P0-02B 前必须换细粒度 PAT;宿主 umask/ACL 对 other 关闭(容器挂载依赖 ensureNodeModulesReadable/chmod 链,勿删)。

## 唯一下一任务:P0-01C(Goal Loop,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. 按 CONSTRUCTION_PLAN P0-01C 行起草 ACTIVE Contract:简单目标→任务分解→状态推进、Decision Fallback、重试/replan/停滞熔断;复用 `src/core`(Supervisor Tick 四步)与 `src/runtime`(Runner 单任务闭环);NEEDS_DECISION/PAUSED/BLOCKED 恢复 API 在此落地(P0-01A F-2 遗留)。
3. 验收对齐:人工缺席时安全 Task 继续;D3 一直被阻断;无限失败有限停止(V11 预算熔断:token/attempt/wall)。
4. 边界:不做真实 GitHub 写路径(P0-02B)、不做 Gate 编排(P0-02A)、不大量写 MVP、不启动 Web/RSI。
5. 模型预算:按阶段分段计数+每次运行前声明(P0-01B 教训:整包总额上限在排查期易超)。
6. 完成后:独立复核、快进 push main、核验 `origin/main==HEAD` 且 worktree clean、更新 `CURRENT.md` 与本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/CONTINUATION.md、p0-00/REPORT.md、p0-01a/REPORT.md、p0-01b/REPORT.md。严格 main-only、单 Writer、禁强推。只激活并执行 P0-01C(Goal Loop):按 CONSTRUCTION_PLAN P0-01C 行起草有边界验收合同与分段模型预算,复用 src/core 状态层与 src/runtime Runner 实现简单目标→任务→状态推进、Decision Fallback、重试/replan/停滞熔断(V11),落地 NEEDS_DECISION/PAUSED/BLOCKED 恢复 API;不做真实 GitHub 写路径,不做 Gate 编排,不生产部署,不自动 RSI。测试沿用 Vitest+独立 schema 模式并真实故障注入;E2E 在缺 provider/docker 时显式跳过。遇写者冲突、权限旁路或不可确认副作用时保持只读或阻断并说明原因。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。
