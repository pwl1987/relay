# Relay 当前执行契约

- 状态：**P0-01A COMPLETE / IDLE(下一包 P0-01B NOT_ACTIVE)**。完成：2026-11-09。最终 HEAD 以远端 `main` 为准。
- 写者：**无 ACTIVE Writer**(P0-01A 写者已释放)。
- 本包唯一 Outcome 已交付:PostgreSQL 持久状态层(`src/core` 10 文件 + `migrations/` 5 表)、状态机(架构 §3 全转移表 + V08 Gate 门锁)、Lease/Fencing(TTL=权威窗口 + 心跳)、Supervisor Tick(回收→Reconcile→释放→领取)、Action Intent 两阶段 + Reconcile 三分类、**Vitest 35 用例全绿**(真实 PG + 真实 SIGKILL,每测试文件独立 schema)、全新克隆可复现、exp-c 符号链接修复。
- 独立复核:全新上下文 Reviewer 两轮(首轮 PASS-WITH-FIXES,F-1 MAJOR=TRUNCATE 审计缺口已修复;处置与复验见 `p0-01a/REVIEW.md` 与 `p0-01a/REPORT.md` §4)。
- 证据:`p0-01a/evidence/`(全量测试/全新克隆复现/exp-c 回归);结果报告:`p0-01a/REPORT.md`。
- 未解决风险(诚实清单)见 REPORT §6;需后续包承接:Gate attempt/commit 绑定与 V09(P0-02A)、决策/暂停/阻断恢复 API(P0-01C)、多 Supervisor 压测(第二 Worker 前)。

## 下一唯一建议:P0-01B(有界 Pi Run,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-01B 行与 ADR-0003 双层边界起草激活合同:单项目单任务、Pi RPC 子进程启停(锁版本+一次性 HOME+`--no-builtin-tools`)、Context/Handoff 最小形态、Run 断线可重建;状态层直接复用本包 `src/core`。**需新的明确授权**;启动沿用冷启动纪律(重读远端 main、检查写者、起草 ACTIVE Contract)。

- 边界:P0-01B 不做 GitHub 真实集成(P0-02B)、不做 Goal Loop(P0-01C)。
- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
