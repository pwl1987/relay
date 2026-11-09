# Relay / HIVE Next 续接（以最新 live main 为准）

状态：**FROZEN（续接指令，不是独立事实源）**。2026-11-09 已完成首次正式产品级设计补全：PRD、详细架构、建设方案、UI/UX、安全威胁、验证矩阵与 VM80 部署方案；**未实现任何 Relay 软件功能，不代表 P0 完成**。

## 唯一事实源及阅读

仓库：`https://github.com/pwl1987/relay`，只用 `main`，禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR，以及以下文档：
- 产品：`docs/PRD.md`
- 技术：`docs/DETAILED_ARCHITECTURE.md`
- 建设：`docs/CONSTRUCTION_PLAN.md`
- 交互：`docs/UI_UX.md`
- 安全：`docs/SECURITY_MODEL.md`
- 验证：`docs/VALIDATION_PLAN.md`
- 环境：`docs/DEPLOYMENT_PLAN.md`

产品原则：唯一 Lifecycle/State owner；六阶段 DISCOVER/DESIGN/BUILD/VERIFY/DELIVER/OPERATE；Pi first 且 Runtime≠Model；ChatGPT optional；Action Proposal→Policy→Scoped Executor；外部副作用结果不明先 Reconcile；证据/真实体验为 Gate；24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已观测 VM80（非永久事实）

2026-11-09 通过只读 Connector：VM80 Dev Agent Controller ready，Pi/ZCode/LoopX available，项目根 `/home/ubuntu/dev`；项目列表未见 Relay 检出。故推荐 VM80 为唯一代码 Writer/运行测试节点、Mac 为控制/人工验收。**仍需现场核验 CPU/RAM/磁盘/网络/OS/锁/权限及是否有其他 Writer，不能直接按过去快照做写入。**

## 唯一下一任务：P0-00

1. 只读冷启动，核对 live main、本地 VM80 工作区、Writer Lock、是否有并行任务。
2. 给 P0-00 建立具体 ACTIVE Contract；只允许隔离临时代码与真实实验、非生产密钥/测试仓库。
3. 实测 Pi SDK/RPC 是否能拒绝默认工具绕过、OS 沙箱能否隔离文件/密钥/网络。
4. 比较 PostgreSQL 单 Tick/Lease 与 DBOS；注入 kill、双 Worker、过期 Lease、回执丢失但已成功写入的情况。
5. 记录证据、风险、open ADR/选择、P0-01A 最小合同；不跳过失败/冲突而开始大量产品编码。
6. 验收并提交/推送 `main`（非强推），核验 `origin/main==HEAD` 和 worktree clean；更新 `CURRENT.md` 及本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next，全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、CI、写者锁和 VM80 Relay 工作区，读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/DEPLOYMENT_PLAN.md、docs/CONTINUATION.md。严格 main-only、单 Writer、禁强推。VM80 为候选首个执行/测试节点、Mac 为控制/人工验收；先做现场资源与隔离检查。只激活并执行 P0-00：Pi SDK/RPC 权限隔离，PostgreSQL Tick/Lease 与 DBOS 恢复比较，双执行/进程 kill/外部写成功但回执丢失的 Reconcile 与越权阻断。先制定有边界验收合同和实验预算，再实施最小 POC；不大量写 MVP，不生产部署，不自动 RSI。独立复核证据与风险，提交快进 push main 并检查 SHA/干净工作区，更新 CURRENT.md 和 docs/CONTINUATION.md。遇写者冲突/权限旁路/不可确认副作用时保持只读或阻断并说明原因。