# Relay 当前执行契约

- 状态：**IDLE / DESIGN_BASELINE_FROZEN**
- 写者：**无 ACTIVE Writer**；需要实施时先声明/确认唯一写者并检查 live `main`。
- 当前交付：顶层设计专业审计与冻结（不包含功能编码）。
- 当前 Authority：`README.md` → `ARCHITECTURE_BASELINE.md` / `CONTRACTS.md` / `P0_P1_ROADMAP.md` → 对应 ADR。
- 历史审计起点：`342c9bce59c0fbbfbc37e5b8880babcd9ad725b9`；**不得把它当成后续最新 HEAD**。
- 下一唯一建议：**P0-00 先做可运行性/威胁模型/恢复语义 POC 与验收计划，暂不进入大规模开发。**
- 下一包激活条件：重新读取 GitHub `main`；明确执行者、边界、可修改文件和预期结果；评估 Pi SDK/RPC 的权限隔离与 DBOS 可否不用；可复现最小失败/恢复用例。
- 禁止范围：生产部署、外部凭据、自动放权、多 Agent 编排平台、泛化 Plugin Marketplace、大量业务代码。
- 验收边界：当前已冻结的是**设计决策**，不是端到端产品交付；具体行为必须经后续实现和测试证明。

继续信息见 [docs/CONTINUATION.md](docs/CONTINUATION.md)。