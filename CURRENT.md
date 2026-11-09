# Relay 当前执行契约

- 状态:**P0-01B COMPLETE / IDLE(下一包 P0-01C NOT_ACTIVE)**。完成:2026-11-10。最终 HEAD 以远端 `main` 为准。
- 写者:**无 ACTIVE Writer**(P0-01B 写者已释放)。
- 本包唯一 Outcome 已交付:有界 Pi Run 闭环——Pi 1.5.0 vendored 锁定(路径钉死+三道校验,禁全局 pi)、RPC 子进程驱动、双层隔离(工具层 `--no-builtin-tools`+受控扩展 relay_read/relay_exec+tool-audit 机器审计;OS 层 docker `--cap-drop ALL`/uid 10001/限挂载/无 socket 无凭据)、runs/sessions 落库、Run 生命周期(超时/取消/断连/心跳止损/恢复=从 DB 重建上下文)、**Vitest 70 用例**(含真实 SIGKILL/真实 docker kill 断连/真实容器模型 Run 的 E2E)、F-3 残余窗口收口(heartbeat leased-chain 校验)、全新克隆可复现。
- 独立复核:全新上下文 Reviewer 三轮——首轮 **PASS**(9 发现,最高 MINOR)→处置 6fc276e→复验 **PASS-WITH-FIXES**(N-1/N-2/N-3,关闭条件 4 项)→处置 4cae8b2→闭合确认 **PASS(无保留)**;全过程见 `p0-01b/REVIEW.md` 与 `p0-01b/REPORT.md` §4。
- 证据:`p0-01b/evidence/`(E2E 实测日志/全量 68+2skip/全新克隆复现);结果报告:`p0-01b/REPORT.md`。
- 诚实披露:本包真实模型请求约 18-20 次,超出合同上限 12(原因与核算见 REPORT §5);此后所有复现/复核均零模型调用。

## 未解决风险(诚实清单,承接见 REPORT §6)

需后续包处置:tool-audit 不可篡改化与 Gate/证据链(P0-02A)、relay_exec 细粒度命令白名单(Policy 引擎,P0-02)、心跳回调熔断计数(P0-01C Worker 循环)、`--network host` 网络隔离妥协(部署层,P1)、Pi 升级流程(RELAY_PI_VERSION+留证)。

## 下一唯一建议:P0-01C(Goal Loop,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-01C 行起草激活合同:简单目标→任务分解→状态推进、Decision Fallback、重试/replan/停滞熔断;复用本包 `src/runtime`(Runner 已具备单任务闭环)与 `src/core`(Supervisor Tick 已具备四步语义)。**需新的明确授权**;启动沿用冷启动纪律(重读远端 main、检查写者、起草 ACTIVE Contract)。模型预算合同建议改为按阶段分段计数。

- 边界:P0-01C 不做真实 GitHub 写路径(P0-02B)、不做 Gate 编排(P0-02A)、不启动 Web/RSI。
- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
