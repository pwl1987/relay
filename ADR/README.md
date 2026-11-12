# Relay 架构决策记录（ADR）

状态：**FROZEN（已接受的架构边界）**；`OPEN` 项不等于可无审计扩范围。以 [架构基线](../ARCHITECTURE_BASELINE.md) 为唯一架构叙述入口，ADR 仅记录裁决和理由。

- [0001 产品边界](0001-product-boundary.md) — FROZEN
- [0002 轻量 Core 与 P0 边界](0002-lightweight-core.md) — FROZEN
- [0003 Pi 与 Session / 协议边界](0003-agent-runtime-and-session-fabric.md) — FROZEN，P0 集成方式已裁决（RPC+双层隔离）
- [0004 自治与质量门](0004-autonomy-and-quality-gates.md) — FROZEN，数值阈值 OPEN
- [0005 Operator 能力排序](0005-operator-capabilities.md) — FROZEN
- [0006 Context/Memory/Code Intelligence](0006-memory-knowledge-code-intelligence.md) — FROZEN，P1 具体实现 OPEN
- [0007 Durable Workflow 技术选型](0007-durable-workflow.md) — **ACCEPTED：REJECT DBOS FOR P0（依据 P0-00 实测）**
- [0008 Method Packs 与扩展](0008-extensions-and-method-packs.md) — FROZEN（职责）；Registry OPEN
- [0009 Model Policy 与多 Provider 分层](0009-model-policy.md) — **ACCEPTED(v0.1 设计冻结；实现 OPEN，激活前置=MVP 最终 ACCEPTED)**
- [0010 MVP 验收口径调整](0010-mvp-acceptance-repositioning.md) — **ACCEPTED(2026-11-12；连续 24h 重定位为 Operational/Pilot Readiness Gate；原 R-3 保持 PARTIAL 历史事实不改；R-3B 暂缓并入 PILOT-24H)**

修改 FROZEN 决策须说明替代方案、验证和迁移影响；不要删除旧 ADR 或建立第二个权威目录。