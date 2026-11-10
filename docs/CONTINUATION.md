# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09 完成 P0-00(实验)与 P0-01A(状态内核);2026-11-10 完成 P0-01B(有界 Pi Run)、P0-01C(受控 Goal Loop)、**P0-02A(候选变更与独立质量验证)**。**P0-02B 尚未实施,不代表产品功能存在。**

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- 各包报告:`p0-00/REPORT.md`、`p0-01a/REPORT.md`、`p0-01b/REPORT.md`、`p0-01c/REPORT.md`(§5 密钥隔离设计)、`p0-02a/REPORT.md`(独立验证链;REVIEW 见 `p0-02a/REVIEW.md`)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已裁决并落地(2026-11-10,P0-02A 更新)

- **Candidate ChangeSet**:Run 工作区 Worker 侧清单 diff(base/candidate/requirement sha256 + 影响面挂载点换算);SUCCEEDED 才有候选;迁移 0003(changesets/gate_evidence/verdicts 九绑定列)。
- **独立 Reviewer Run**:独立沙箱/上下文(需求+清单+证据,无 Coder Handoff);runs 行 role=reviewer + reviewer_run_id ≠ coder run 双重强制;只读策略;裁决围栏 `relay-gate-verdict` Worker 解析;有界失败 ⇒ NEEDS_DECISION(预算型失败不重试)。
- **绑定 Gate**:record 前置校验 + consume 单事务二次校验 + 一次性消费;countGatePass 绑定感知——**旧 PASS 在记录/消费/状态三层均不可跨 attempt/candidate SHA/需求版本复用**;PASS 必须引用全 passed 且 digest 完整的证据;模型 DONE 文本零裁决路径。
- **VERIFYING 独立验证租约**:acquireVerificationLease 接管(fencing+1)⇒ 模型 Worker 残留 TTL 权威即时作废;崩溃 ⇒ reclaim ⇒ 新 attempt 重验(P0-01C 6 秒窗口边界关闭)。
- **Gate 自动消费**:PASS→ACCEPTED;REWORK→READY(+退避);BLOCK→NEEDS_DECISION(+D3 行,永不自动批准,恢复仅经 ops API)。
- **循环熔断**(loop-safety):连续 tick 异常计数(成功清零)→ 阈值熔断停调度 + 回调 + 尽力审计;恢复 = 新实例(进程重启语义)。
- **出口代理 v2**:HTTP 反向代理持真钥改写 Authorization;`--api-key` argv 已删;models.json 仅占位;计数端点(仅宿主)1:1 计数 + completions 单列;计数探测一律 `agent: false`(keep-alive 竞态实测坑)。
- **C-9 对账语义**:E2E 断言 completions == coder+reviewer 回合数,不一致即失败——"硬顶已证明"必须有代理层独立计数背书。
- **Lease/Gate 契约(累计)**:TTL=权威窗口;心跳仅工作链内;心跳 DB 连续异常 ≥2 ⇒ Run 止损;VERIFYING 由验证租约接管;VERIFYING→NEEDS_DECISION 合法(恢复仅经 ops)。
- **测试基建**:Vitest 122 用例(34 文件;独立 schema);非模型 114 例全新克隆可复现;7 条合同反例逐条专属断言(非恒真)。测试库 `relay-p000-pg`(127.0.0.1:55433)。
- **运行环境事实(累计)**:VM80=ubuntu2604;Pi 1.5.0 vendored;magpie 127.0.0.1:3425(非 loopback 源 401;容器模型连接必经 relay-egress-fwd HTTP 代理);relay_exec 白名单禁 `;&|` 反引号 换行 $( ${(`>` 允许);ufw 拒容器→宿主;宿主 node_modules ACL other-关闭(勿删 chmod 链);**execFileSync 会透传子进程 stderr(助手需显式 stdio pipe)**;**pi 容器内模型 baseUrl 必须重写为宿主出口代理(runner/reviewer 同源 rewriteBaseUrlForContainer,缺它 = 连自身 loopback → auto_retry → stopReason=error)**。
- **治理流程(累计)**:ACTIVE 合同先于实现提交落盘(独立首提交);证据文件内嵌产出时 HEAD SHA(复核 F-3);模型预算分阶段声明经 budget_ledger;调试期失败迭代如实计入报告。

## 唯一下一任务:P0-02B(真实 GitHub 写路径,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. **先起草 ACTIVE 合同并独立提交落盘**,再实施。要点按 CONSTRUCTION_PLAN P0-02B 行:Action Proposal→Policy→Scoped Executor 全链;外部副作用两阶段意图(action_intents RESERVED→EXECUTING→COMPLETED/CONFLICT)+ Reconcile;expected_remote_sha 漂移拒绝;Candidate ChangeSet(本包)→ branch/commit/PR 的绑定延伸。
3. **前置检查单(P0-02A 遗留)**:① gh 令牌超范围,**必须先换细粒度 PAT**(仅该 repo 的 contents/PR 权限);② 代理持钥升级宿主 0600 文件;③ Reviewer 候选面 FS 级只读挂载。
4. 验收:真实 remote 沙箱仓库演练(禁推 relay 主仓库);意图未明 Reconcile 实测;证据绑定 commit。
5. 边界:不做 Web(P0-02C)、不生产部署、不 RSI、不强推。
6. 模型预算:按阶段分段计数经账本预留;完成後独立复核、快进 push、核验 origin/main==HEAD 且 worktree clean、更新 CURRENT.md 与本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/CONTINUATION.md,以及 p0-00..p0-02a 的 REPORT/REVIEW。严格 main-only、单 Writer、禁强推。**先把 P0-02B ACTIVE 合同独立提交落盘,再实施**:真实 GitHub 写路径——Action Proposal→Policy→Scoped Executor、action_intents 两阶段+Reconcile、expected_remote_sha 漂移拒绝、Candidate→branch/commit/PR 绑定;**前置:细粒度 PAT(当前 gh 令牌超范围,未换前禁真实写)、代理持钥 0600 化、Reviewer 只读挂载**。复用 src/core 状态层/绑定版 Gate/验证租约/budget_ledger。不做 Web,不生产部署,不 RSI。测试沿用 Vitest+独立 schema+真实故障注入(真实 remote 用沙箱演练仓库);预算分阶段经账本预留。遇写者冲突、门禁失败或需要增加预算时阻断并说明,不自动扩大。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。
