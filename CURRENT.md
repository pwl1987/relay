# Relay 当前执行契约

- 状态:**P0-01C COMPLETE / IDLE(下一包 P0-02A NOT_ACTIVE)**。完成:2026-11-10。最终 HEAD 以远端 `main` 为准。
- 写者:**无 ACTIVE Writer**(P0-01C 写者已释放)。
- 本包唯一 Outcome 已交付:受控 Goal Loop——**C-1 安全收口**(心跳 DB 连续异常止损、relay_exec 命令白名单 `$()`/`${}` 全禁、工具事件 Worker 侧可信持久化、网络出口三层约束 bridge+DOCKER-USER 白名单+loopback 转发器,FAIL-CLOSED 拒启,无 host 网络降级路径)、**C-2 机器预算**(budget_ledger 先预留再执行后核算 + Run 中回合硬顶,单 Run 机械不可破账本;FAIL-CLOSED;token 实测/保守估算)、**C-3 D0-D4 决策**(D2 仅事先授权 fallback;D3 永不超时自动批准;恢复 API actor 授权+state_version+审计)、**C-4 自治恢复**(指数退避、失败签名熔断、并发 Tick 恰一赢家、进程重启从 PG 恢复、IDLE/断供不烧 token)。
- 测试:**97 用例 = 94 passed + 3 skipped**(E2E/沙箱在缺 provider/docker/iptables 环境显式跳过);真实模型自治闭环 E2E 经账本预留(used=4/limit=8,预留全额释放);全新克隆可复现。
- 独立复核:全新上下文 Reviewer 两轮——首轮 **PASS-WITH-FIXES**(10 发现,2 MAJOR:回合硬顶零专属测试/命令白名单漏 `$()`)→ 处置 65544ed(两 MAJOR 三重证实关闭)→ 复验 **PASS-WITH-FIXES**(3 项 REPORT 文字错位)→ 处置 e5fdc3e → 闭合确认 **PASS(无保留)**(8a6a941 落盘);全过程见 `p0-01c/REVIEW.md` 与 `p0-01c/REPORT.md` §4。
- 治理事实(P0-01C F-4,如实记录):本包 ACTIVE 合同文本晚于首个实现提交入库(3536042);复核确认内容与授权锚同源;**流程改进已固化:后续包合同必须先于实现提交落盘**。
- 宿主改动残留(可清理):iptables `relay-p01c-egress` 规则 + `relay-egress-net` + `relay-egress-fwd` 转发器容器(`--restart unless-stopped`);清理入口 `teardownEgress()`(src/runtime/egress.ts)或手工 `docker rm -f relay-egress-fwd` + 删规则。
- 未解决风险(诚实清单)见 `p0-01c/REPORT.md` §6;真密钥隔离**设计**已交付(§5,实现挂 P0-02 检查单)。

## 下一唯一建议:P0-02A(提交与独立验证,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-02A 行起草激活合同:Candidate Diff、独立 Reviewer(与 Coder 上下文隔离)、测试/Reality Gate、Evidence 绑定 commit(gate_attempt 绑定,P0-01A F-5/V09);Gate 编排落地后消化本包遗留的"VERIFYING 后租约窗口"边界(自动裁决消费)。**需新的明确授权**;启动沿用冷启动纪律;**合同先于实现提交落盘**(P0-01C F-4 流程改进);模型预算按阶段分段计数+每次运行前声明。

- 边界:P0-02A 不做 GitHub 真实写路径(P0-02B)、不做 Web(P0-02C)、不生产部署、不 RSI。
- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
