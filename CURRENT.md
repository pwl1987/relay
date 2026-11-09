# Relay 当前执行契约

- 状态：**P0-00 COMPLETE / IDLE(下一包 P0-01A NOT_ACTIVE)**。完成时间：2026-11-09。
- 写者：**无 ACTIVE Writer**(P0-00 写者已释放)。
- 本包唯一 Outcome 已交付：`p0-00/REPORT.md`(实验 A–D 证据/归因/裁决)、ADR-0003(RPC+双层隔离 ACCEPTED)、ADR-0007(REJECT DBOS FOR P0 ACCEPTED)、P0-01A 最小执行契约建议(REPORT §6)、独立复核(REPORT §7,PASS,修正条件已处置并重跑留证)。
- 实验包提交:`e54027a`(起点 `origin/main == 575ae25`,快进);本文件与 `docs/CONTINUATION.md` 的收尾更新由其后一笔提交承载,最终 HEAD 以远端 `main` 为准。
- 运行时残留(仓库外,已申报):Docker 容器 `relay-p000-pg`(专用 PG,127.0.0.1:55433)与 `.p0-00-lab/` 隔离区保留至复核完成,可随时清理;未触碰其他项目、共享 Pi 配置、LoopX 注册表。

## 下一唯一建议:P0-01A(持久状态,NOT_ACTIVE)

按 `p0-00/REPORT.md` §6 与 `docs/CONSTRUCTION_PLAN.md` P0-01A 边界起草激活合同:Drizzle migrations(tasks/leases/audit_events/action_intents)、状态机与 fencing、单 Worker Tick 循环、外部动作两阶段日志,exp-b/exp-c 实验脚本升级为 Vitest 集成测试(V04/V06/V05 对应项)。

## P0-01A 启动前(沿用冷启动纪律)

重新读取远端 `main`;检查同仓其他 Writer/脏工作区;声明可写范围与预算;将本文件改为 ACTIVE 并只授权该包。安全红线不变:沙箱/Policy 被绕过、外部写结果不明无法核对、同 Task 双写、GitHub 非快进冲突,均不得升级到完整产品实现。

- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
