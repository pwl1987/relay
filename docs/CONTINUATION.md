# Relay / HIVE Next 续接（以最新 live main 为准）

状态：**FROZEN（续接指令，不是独立事实源）**。2026-11-09 已完成 P0-00（可行性/安全/恢复语义实验，`p0-00/REPORT.md`）与 **P0-01A（持久状态与可靠执行内核，`p0-01a/REPORT.md`）**。**P0-01B 尚未实施，不代表产品功能存在。**

## 唯一事实源及阅读

仓库：`https://github.com/pwl1987/relay`，只用 `main`，禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR，以及：
- 产品：`docs/PRD.md`；技术：`docs/DETAILED_ARCHITECTURE.md`；建设：`docs/CONSTRUCTION_PLAN.md`
- 交互：`docs/UI_UX.md`；安全：`docs/SECURITY_MODEL.md`；验证：`docs/VALIDATION_PLAN.md`；环境：`docs/DEPLOYMENT_PLAN.md`
- **P0-00 结果：`p0-00/REPORT.md`**（ADR-0003/0007 裁决依据）
- **P0-01A 结果：`p0-01a/REPORT.md`**（状态层实现/35 测试/复核/风险清单）+ `p0-01a/REVIEW.md`

产品原则：唯一 Lifecycle/State owner；六阶段 SDLC；Pi first 且 Runtime≠Model；ChatGPT optional；Action Proposal→Policy→Scoped Executor；外部副作用结果不明先 Reconcile；证据/真实体验为 Gate；24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已裁决并落地(2026-11-09)

- **ADR-0003**:Pi 集成=RPC 子进程+`--no-builtin-tools`+扩展注入受控工具+每 Run 一次性 HOME+OS 容器隔离(双层缺一不可)。→ P0-01B 实施依据。
- **ADR-0007**:REJECT DBOS FOR P0;自研 PG 事务+租约+fencing+append-only 审计。→ **已在 P0-01A 代码化:`src/core`**(lifecycle 状态机/lease 单事务+fencing/intents 两阶段+Reconcile/supervisor tick/gates V08 门锁/policy V02 作用域)。
- **Lease TTL 契约**:TTL 窗口=权威窗口(窗口内旧 Token 即使进程死亡仍权威);Worker 必须心跳续租;Supervisor 仅过期后回收;终态绝对优先。
- **Reconcile 契约**:执行前核对 expected;RESERVED→EXECUTING→COMPLETED/CONFLICT/FAILED;恢复先查目标真实状态三分类(确认/缺失安全重试/人工),绝不盲目重试。
- **测试基建**:Vitest 35 用例(真实 PG+SIGKILL+mock git),每测试文件独立 schema,`npm ci && npm run db:up && npm test` 全新克隆可复现;测试库 `relay-p000-pg`(127.0.0.1:55433,512Mi)。
- 运行环境事实:VM80=ubuntu2604;Pi 1.5.0 会自更新(Worker 必须锁版本);宿主 ufw 拒容器→宿主;gh 令牌超范围,**P0-02B 前必须换细粒度 PAT**。

## 唯一下一任务:P0-01B(有界 Pi Run,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. 按 CONSTRUCTION_PLAN P0-01B 行 + ADR-0003 双层边界起草 ACTIVE Contract:单项目单任务、Pi RPC 子进程(Pi **锁版本**+一次性 HOME+`--no-builtin-tools`+受控扩展工具)、Context/Handoff 最小形态、Run 断线重建上下文;状态层复用 `src/core`,Run 记录落 `runs`/`sessions`(按 DETAILED_ARCHITECTURE §2 裁剪)。
3. 验收对齐:允许动作成功/禁止动作拒绝/工具旁路阻断即 BLOCK(V14 延续);Run SIGKILL 后经 Tick 回收+上下文重建(V04 延伸)。
4. 边界:不做 GitHub 真实集成(P0-02B)、不做 Goal Loop(P0-01C)、不大量写 MVP。
5. 完成后:独立复核、快进 push main、核验 `origin/main==HEAD` 且 worktree clean、更新 `CURRENT.md` 与本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next，全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区，读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/CONTINUATION.md、p0-00/REPORT.md、p0-01a/REPORT.md、p0-01a/REVIEW.md。严格 main-only、单 Writer、禁强推。只激活并执行 P0-01B：按 ADR-0003 双层边界与 p0-01a 状态层实现有界 Pi Run（Pi 锁版本+RPC 子进程+一次性 HOME+--no-builtin-tools+受控工具；Run 落 runs/sessions；崩溃后经 supervisor tick 回收并重建上下文），先制定有边界验收合同和预算再实施；不接入真实 GitHub 写路径，不做 Goal Loop，不生产部署，不自动 RSI。测试沿用 Vitest+独立 schema 模式并真实故障注入。遇写者冲突、权限旁路或不可确认副作用时保持只读或阻断并说明原因。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。
