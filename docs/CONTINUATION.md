# Relay / HIVE Next 续接（以最新 live main 为准）

状态：**FROZEN（续接指令，不是独立事实源）**。2026-11-09 已完成设计补全与 **P0-00 实验包**（可行性/安全/恢复语义 POC，交付 `p0-00/REPORT.md` + ADR-0003/0007 裁决 + 独立复核 PASS）。**P0-01 尚未实施，不代表产品功能存在**。

## 唯一事实源及阅读

仓库：`https://github.com/pwl1987/relay`，只用 `main`，禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR，以及以下文档：
- 产品：`docs/PRD.md`
- 技术：`docs/DETAILED_ARCHITECTURE.md`
- 建设：`docs/CONSTRUCTION_PLAN.md`
- 交互：`docs/UI_UX.md`
- 安全：`docs/SECURITY_MODEL.md`
- 验证：`docs/VALIDATION_PLAN.md`
- 环境：`docs/DEPLOYMENT_PLAN.md`
- **P0-00 结果：`p0-00/REPORT.md`（实验证据索引、裁决依据、P0-01A 建议、未验证项）**

产品原则：唯一 Lifecycle/State owner；六阶段 DISCOVER/DESIGN/BUILD/VERIFY/DELIVER/OPERATE；Pi first 且 Runtime≠Model；ChatGPT optional；Action Proposal→Policy→Scoped Executor；外部副作用结果不明先 Reconcile；证据/真实体验为 Gate；24×7 是有资源、权限和 Ready Task 时持续安全推进。

## P0-00 已裁决(2026-11-09,实测证据见 REPORT)

- **ADR-0003**：Pi 集成 = RPC 子进程 + `--no-builtin-tools` + 扩展注入受控工具 + 每 Run 一次性 HOME + OS 容器隔离(双层,缺一不可)。
- **ADR-0007**：REJECT DBOS FOR P0;自研 PostgreSQL 事务+租约+fencing+append-only 审计(exp-b 227 行)满足全部实测语义。
- **Reconcile 模式**：action_intents 两阶段 + 执行前核对 expected + 恢复先查目标真实状态(确认/缺失重试/人工三分类)。
- 运行环境事实(非永久):VM80=ubuntu2604;Pi 1.5.0 会自更新,Worker 必须锁版本;宿主 ufw 拒容器→宿主;gh 令牌超范围,P0-02B 前必须换细粒度 PAT。

## 唯一下一任务:P0-01A(持久状态,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. 按 `p0-00/REPORT.md` §6 起草 ACTIVE Contract:Drizzle migrations、状态机+fencing、单 Worker Tick、外部动作两阶段日志;exp-b/exp-c 脚本升级为 Vitest 集成测试;各实验用独立 schema/database。
3. 边界:P0-01A 不做 Pi Run 集成(那是 P0-01B)、不做 GitHub 真实集成(那是 P0-02B)、不大量写 MVP。
4. 完成后:独立复核、快进 push main、核验 `origin/main==HEAD` 且 worktree clean、更新 `CURRENT.md` 与本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next，全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区，读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/DEPLOYMENT_PLAN.md、docs/CONTINUATION.md、p0-00/REPORT.md。严格 main-only、单 Writer、禁强推。只激活并执行 P0-01A：按 P0-00 已裁决语义(ADR-0003/0007 与 p0-00/REPORT.md §6)实现 Drizzle migrations、Task 状态机+Lease/Fencing、外部动作 action_intents 两阶段日志，将 p0-00/exp-b、exp-c 实验升级为 Vitest 集成测试(V04/V05/V06 对应项)。先制定有边界验收合同和实验预算，再实施；不开始 Pi Run 集成与 GitHub 真实集成，不生产部署，不自动 RSI。遇写者冲突、权限旁路或不可确认副作用时保持只读或阻断并说明原因。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。