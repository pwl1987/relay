# Relay 当前执行契约

- 状态:**P0-02A COMPLETE / IDLE(下一包 P0-02B NOT_ACTIVE)**。完成:2026-11-10。最终 HEAD 以远端 `main` 为准。
- 写者:**无 ACTIVE Writer**(P0-02A 写者已释放)。
- 本包交付:候选变更与独立质量验证——**C-1 Candidate ChangeSet**(Worker 侧工作区清单 diff,base/candidate/requirement sha + 影响面,绑 task/run/attempt)、**C-2 独立 Reviewer Run**(独立沙箱/上下文,无 Coder 叙事;role=reviewer 身份 + 独立性强制;只读策略)、**C-3 可信 Evidence**(Worker 采集,passed 由退出码判定,digest 防篡改)、**C-4 绑定 Gate**(attempt/candidate/requirement/test_env/reviewer 绑定;消费单事务二次校验 + 一次性;旧 PASS 三层不可复用)、**C-5 VERIFYING 独立验证租约**(接管即废残留 TTL;P0-01C 6 秒窗口边界关闭)、**C-6 Gate 自动消费**(PASS→ACCEPTED / REWORK→READY 退避 / BLOCK→NEEDS_DECISION+D3 行;DONE≠PASS)、**C-7 循环熔断**(连续异常计数+回调+熔断,F-8 收口)、**C-8 出口代理 v2**(HTTP 反代持钥改写 Authorization;`--api-key` argv 删除;models.json 占位;计数端点)、**C-9 completions 对账**(代理层计数 == 回合数,断言强制)。
- 测试:**122 用例 = 114 passed + 8 skipped**(34 文件;非模型全新克隆可复现;模型/容器相关显式 skip);最终验收 E2E(gate-e2e):真实模型 coder 3 回合 + 独立 Reviewer 3 回合 → Gate PASS → ACCEPTED → goal COMPLETED,**账本 used=6/8,C-9 对账 completions=6==turns=6**;7 条反例逐条专属测试。
- 独立复核:全新上下文 Reviewer 两轮——首轮 **PASS-WITH-FIXES**(C-1..C-9 全 VERIFIED;亲跑 egress-proxy 容器实测 5/5 + 全量独立复现;3 MINOR + 5 OBS)→ 处置 `380084d` → 复验 **PASS**;见 `p0-02a/REVIEW.md`、`p0-02a/REPORT.md` §4。
- 治理:F-4 流程改进兑现(合同 `87e1db3` 先于实现 `772eb0c` 独立落盘);新流程改进(复核 F-3):**此后证据文件一律内嵌产出时 HEAD SHA**(fresh-clone-repro.log 已内嵌)。
- 遗留检查单(接真密钥/P0-02B 前):① 代理持钥升级为宿主 0600 文件注入(docker inspect 可见面收口);② Reviewer 共享候选面 FS 级只读挂载(现 prompt 级隔离,复核 F-4);③ gh 令牌仍超范围(P0-02B 前必须换细粒度 PAT,P0-01C 遗留)。
- 宿主改动残留(可清理):iptables `relay-p01c-egress` 规则 + `relay-egress-net` + `relay-egress-fwd` 代理容器(HTTP 反代,`--restart unless-stopped`);清理入口 `teardownEgress()`(src/runtime/egress.ts)。

## 下一唯一建议:P0-02B(真实 GitHub 写路径,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-02B 行起草激活合同:Candidate→branch/commit/PR 的 Action Proposal→Policy→Scoped Executor 全链、外部副作用两阶段意图(action_intents RESERVED→EXECUTING→COMPLETED)+ Reconcile、远端 SHA 漂移拒绝;前置检查单见上(细粒度 PAT 必须)。**需新的明确授权**;启动沿用冷启动纪律 + 合同先于实现提交落盘;模型预算按阶段分段计数经 budget_ledger 预留。

- 边界:P0-02B 不做 Web(P0-02C)、不生产部署、不 RSI。
- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
