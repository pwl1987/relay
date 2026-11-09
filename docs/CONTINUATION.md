# Relay / HIVE Next 新窗口续接

状态：**FROZEN（设计续接入口）**。日期：2026-11-09。此文件是导航，不是另一份项目 Authority。

## 事实源与完成状态

仓库：`https://github.com/pwl1987/relay`；唯一长期分支 `main`。本轮基于原 HEAD `342c9bce59c0fbbfbc37e5b8880babcd9ad725b9` 进行顶层审计与修订；**新窗口必须现场读取远端最新 HEAD，不能把此 SHA 认作最终 HEAD**。

设计原则已冻结：模块化单体、单一 Lifecycle/Worker State、六阶段、Pi first 但 Runtime!=Model、基于证据的门禁、有限条件下可恢复 24×7、ChatGPT 可选、Action Proposal→Policy→Executor、main-only 单写者。**本轮没有编码，不代表 P0 功能已完成。**

权威阅读顺序：
1. `README.md`、`AGENTS.md`、`CURRENT.md`；
2. `ARCHITECTURE_BASELINE.md`、`P0_P1_ROADMAP.md`、`CONTRACTS.md`、`DOMAIN_MODEL.md`；
3. 当前包相关的 `docs/DELIVERY.md`、`docs/OPERATIONS.md`、`docs/INTEGRATIONS.md`、`ADR/README.md`；
4. `docs/FINAL_AUDIT.md` 查看本次削减原因。

## 下一步唯一建议

**P0-00：可行性、安全和恢复语义 POC**。先形成明确的可执行验收/威胁模型，验证 Pi SDK/RPC 权限隔离和 PostgreSQL lease/tick vs DBOS，再选最小实现路径；暂不大量编写产品代码。优先模拟外部操作“执行成功却在回执前断连”与重启后去重，同时测试 Agent 是否可绕开 Action Policy。

P0-00 可交付：
- 一个短实验矩阵及真实复现证据（Pi 工具绕行、进程崩溃、失效 Lease、外部副作用不明、权限拒绝）；
- 选择或否决 DBOS / SDK/RPC 的 ADR，写清失败证据和运维成本；
- 具体且有界的 P0-01 首包（唯一目标、允许写入路径、风险、预算、最小验证和停止门）；
- 若关键安全门无法验证，明确 `BLOCKED` 并提供更保守退路。

## 直接复制到下一窗口的指令

> 继续 Relay / HIVE Next，全部中文。唯一事实源：https://github.com/pwl1987/relay 的 live main。请先重新读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、P0_P1_ROADMAP.md、CONTRACTS.md、DOMAIN_MODEL.md、ADR/README.md，以及 docs/CONTINUATION.md；核对当前 HEAD、现有分支、CI、独立写者和本地/远端是否有分叉。只用 main，禁止强推。先独立复核现有设计是否自洽，然后把下一唯一任务限定为 P0-00：Pi SDK/RPC 权限隔离、Durable Workflow（PostgreSQL tick/lease 与 DBOS）以及不确定副作用恢复的可复现 POC 设计与最小实验。明确验收/风险/停止条件；不要跳过 POC 直接做完整平台，不要创建其他长期分支。执行后如实际写仓库须提交推送 main、检查 origin/main 与 HEAD、记录证据，并更新 CURRENT.md 和本文件。若无法确认独占写者或 GitHub 状态，保持只读并报告冲突。