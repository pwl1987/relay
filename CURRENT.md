# Relay 当前执行契约

- 状态：**IDLE / DESIGN_SPEC_COMPLETE / P0-00 NOT_ACTIVE**。
- 写者：**无 ACTIVE Writer**。未来建议 VM80 为唯一 Relay 代码 Writer，Mac 为只读审核/远程控制；启用前必须核查 VM80 实际目录、写者锁与 live GitHub head。
- 当前已交付：PRD、详细架构、建设方案、UX、部署、安全威胁与可验证测试矩阵的中文设计。**没有开始产品编码或宣称 POC 通过**。
- 权威：`README.md`（导航）→ `ARCHITECTURE_BASELINE.md`、`CONTRACTS.md`、`DOMAIN_MODEL.md`（架构/行为）→ `docs/PRD.md`（产品）→ `docs/CONSTRUCTION_PLAN.md`（阶段）→ `docs/VALIDATION_PLAN.md`（验收）→ ADR。
- 设计阶段原事实起点 `fb88870913b4a0a9b4a23bdc7fc35c3e61a5fdb8`，**不是本文件持续有效的最新 HEAD**。
- 下一唯一建议：**P0-00：Pi SDK/RPC 权限隔离 + Pg Tick/Lease vs DBOS + 外部副作用不确定时的 Reconcile POC**。
- P0-00 启动前：重新读取远端 `main`；检查同仓其他 Writer/脏工作区；确认 VM80 是否已有 `relay` 工作区；选择独立测试仓库/受限服务；声明可写范围与实际测试预算；将本文件改为 ACTIVE 并只授权该包。
- 安全阻断：沙箱/Policy 被绕过、外部写结果不明无法核对、同 Task 双写、GitHub 非快进冲突，均不得直接升级到完整产品实现。
- 本轮禁止：大量编码、生产部署/凭据、自动发布、自我修改当前稳定版本、额外长期分支、强推。
- 下一窗口完整入口：[docs/CONTINUATION.md](docs/CONTINUATION.md)。