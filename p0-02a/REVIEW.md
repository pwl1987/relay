# P0-02A 独立 REVIEW

- Reviewer:**全新上下文独立代理**(与 Coder 无共享会话;全程只读,零模型调用)
- 首轮复核对象:HEAD `6ec5ff9`(合同 `87e1db3`,实现 `772eb0c`)
- 方法:冷启动读合同 → 逐文件读实现 → 逐断言读反例测试 → 亲跑测试与类型检查(**含超出最低要求的 egress 机制容器实测**,用本地 mock origin 端口 13499,非模型 API)→ 以合同为绳找反例
- 边界遵守:未修改仓库文件、未 commit/push;实测后核实宿主零残留(容器/网络/iptables 链/DOCKER-USER 规则均确认撤除)

## 一、首轮逐条核验(C-1..C-9):全部 VERIFIED

| 条 | 裁决 | 一句依据 |
| --- | --- | --- |
| C-1 候选变更集 | **VERIFIED** | changesets.ts(manifestSha/diff/requirementSha/impactScopeWithMount)+ workspace-manifest.ts(Worker 侧递归清单,排除 .relay,symlink 不追随)+ runner.ts:189,424 接线;绑定 task/run/attempt;changesets.test.ts 4 例 + E2E 断言 result.txt ∈ added |
| C-2 独立 Reviewer | **VERIFIED** | reviewer.ts(独立 runId/HOME、runs 行 role=reviewer、allowedCommands=[] 只读)、gate-verdict.ts(无围栏=失败)、gates.ts:61-70 强制 reviewer_run_id ≠ coder_run_id 且 role 校验;prompt 只含需求+清单+证据摘要,无 Coder Handoff 字段 |
| C-3 可信 Evidence | **VERIFIED** | evidence.ts:passed 由退出码判定(模型不参与)、原文、digest、绑定;verifyEvidenceIntegrity 消费侧复验;orchestrator 以 verifier 身份采集 |
| C-4 绑定 Gate | **VERIFIED** | gates.ts 记录时绑定校验 + 消费单事务二次校验 + consumed_at 一次性;lease.ts countGatePass 只数绑定匹配当前事实的 PASS;gate-binding.test.ts 5 例全为具体拒绝原因断言(非恒真) |
| C-5 验证租约 | **VERIFIED** | verify-lease.ts 接管即 fencing+1/owner=verifier,旧 Worker advance/heartbeat 全拒;Reviewer 心跳连续 ≥2 异常 ⇒ SIGKILL;崩溃 ⇒ reclaim → 新 attempt;verify-lease.test.ts 两例实测 |
| C-6 自动消费 | **VERIFIED** | PASS→ACCEPTED / REWORK→READY(+退避)/ BLOCK→NEEDS_DECISION(+D3 行+租约终止);恢复仅经 ops.ts(actor 授权);DONE 文本零裁决路径(fake-self-approve 两例);Review 有界失败 ⇒ NEEDS_DECISION |
| C-7 循环熔断 | **VERIFIED** | loop-safety.ts + startGoalLoop/startSupervisorLoop 均接入,静默吞异常已消除;loop-circuit.test.ts 4 例(恰阈值回调、熔断冻结、成功清零、真 PG failingDb 后新实例恢复) |
| C-8 出口代理 v2 | **VERIFIED** | buildPiArgs 无 --api-key;models.json 仅占位;真实 key 仅代理 env + Authorization 改写;计数端点仅 127.0.0.1;**Reviewer 亲跑 egress-proxy.test.ts 5/5(mock origin)** |
| C-9 计数对账 | **VERIFIED** | 代理 completions 计数;gate-e2e 断言 completionsDelta === totalTurns,不一致即失败;e2e-run.log C-9 行由断言通过后产出,log 与断言互证:6==6(3+3),ledger 6/8 |

## 二、反例核验(7 条):全部 VERIFIED(F-1 注 PARTIAL 一处)

1. 虚构 DONE ✅(gate-orchestrator fake-self-approve 两例:0 裁决行 + NEEDS_DECISION)
2. 旧 attempt 用旧 PASS ✅(消费层 stale_attempt 实测;状态层见 F-1)
3. SHA 漂移 ✅(stale_candidate + 新证据绑旧 SHA 记录即拒)
4. BLOCK 不自动 ACCEPTED ✅(NEEDS_DECISION + D3 OPEN + 租约 live=false)
5. 崩溃三角 ✅(接管后幽灵全拒 + reclaim→attempt 2 + 孤儿 PASS 拒 + already_consumed)
6. 测试失败/未执行不绿色 ✅(evidence_missing / not_passed / digest 篡改三路径)
7. PG 连续异常 ✅(恰阈值熔断)

**三项特别审视**:(a) coder 自宣围栏被当 reviewer 裁决的路径——不存在(parseGateVerdict 仅 reviewer.ts 对 Reviewer 会话调用;coder run 无 role;记录+消费双身份校验);(b) 旧 PASS 经 countGatePass/consumeGateVerdict 生效——不存在(两处均校验当前事实);(c) Reviewer BLOCK 自动转 ACCEPTED——不存在(按裁决分派唯一出口,有测试锁定)。

## 三、Reviewer 亲测结果

| 项 | 结果 |
| --- | --- |
| 全量测试 | **114 passed + 8 skipped**(与声明一致) |
| tsc --noEmit | **0 错误** |
| egress-proxy 容器实测(mock origin) | **5/5**:占位 key 无泄漏、argv 无 --api-key、改写生效、计数精确 +1、计数端点对容器 DROP、外网 DROP、FAIL-CLOSED |
| 残留核查 | 容器/网络/链/DOCKER-USER 规则零残留 |
| 未亲跑 | gate-e2e(真实模型,任务禁令)——以 e2e-run.log 与断言逐条对读互证 |

## 四、发现清单(首轮)

| # | 级别 | 内容 |
| --- | --- | --- |
| F-1 | MINOR | gate-binding 旧 PASS 反例中"状态层 backstop"注释与实际断言不符(断言的是非 gated 转移成功);countGatePass 过滤无直接回归断言 |
| F-2 | MINOR | 预留数字三方不一致:代码实际 reviewer 预留 5(注释"4+4"陈旧),提交信息/REPORT 称 5+3;行为无碍(时序上 coder 已结算后再预留,峰值 ≤8)但文档与代码不符 |
| F-3 | MINOR | e2e-run.log 未内嵌产出时点 HEAD SHA;"证据绑定最终 SHA"仅靠提交包含关系间接成立 |
| F-4 | OBSERVATION | 上下文隔离是 prompt 级:Reviewer 可读候选工作区全树(Coder 理论可放置"说服性"文件);缓解到位(提示词禁令 + Worker 侧证据 + 身份三重校验 + handoff_ref 不进 Reviewer 会话),属共享候选面固有残余风险 |
| F-5 | OBSERVATION | Reviewer 回合硬顶无专属测试(coder 侧由 budget-turns-cap 覆盖) |
| F-6 | OBSERVATION | REWORK→READY 直连 UPDATE 绕过 advanceTask(同事务行锁 + state 守卫 + 审计,受控);orchestrator 决策行 id 用 Math.random 非 UUID |
| F-7 | OBSERVATION | REPORT/REVIEW/evidence 在复核期间由写者落盘;收尾提交需一并纳入 |
| F-8 | OBSERVATION | 诚实性核验通过:三项关键措辞(残留 TTL 已废/旧 PASS 不跨版本/硬顶已证明)与代码事实一致;REPORT §5 风险清单如实无夸大 |

**首轮裁决:PASS-WITH-FIXES**(无行为缺陷;MINOR 均为文档/测试卫生)。

## 五、处置(写者,处置提交)

| # | 处置 |
| --- | --- |
| F-1 | **已修**:补状态层直接断言——新 attempt 推进到 VERIFYING 后,唯一 PASS 绑定旧 attempt ⇒ `gate_not_passed`(gate-binding.test.ts,原误导注释删除) |
| F-2 | **已修**:reviewer 预留改 3(`reserveCallsPerRun: 3`,注释标"5+3 ≤ 8;合同声明口径");REPORT §0/§4 的 5+3 口径与代码一致 |
| F-3 | **已修(后续证据)**:fresh-clone-repro.log 在最终 SHA 重新生成并内嵌 `git rev-parse HEAD` 头;e2e-run.log 加产出环境头注(工作树内容 == 6ec5ff9;复核确认其与断言互证)——流程改进:此后证据文件一律内嵌 HEAD SHA |
| F-4 | **声明保留**:共享候选面的 prompt 级隔离残余风险,REPORT §5 补记;FS 级只读挂载属后续 OS 层加固(挂 P0-02B 前检查单) |
| F-5 | **声明保留**:Reviewer 回合硬顶与 coder 共用同一 wait-loop 机制(budget-turns-cap 证机制);专属测试收益低,记录在案 |
| F-6 | **部分已修**:决策行 id 统一 randomUUID;REWORK→READY 直连 UPDATE 维持(守卫+审计+同事务,advanceTask 的 gate 语义在此转移上不适用),已注释说明 |
| F-7 | **已办**:收尾提交一并纳入 REPORT/REVIEW/evidence |
| F-8 | 无需处置(核验通过项) |

复验:处置提交后送 Reviewer 复验(见末尾)。

## 六、Reviewer 复验(处置提交 380084d 后)

**复验对象**:处置提交 380084d(Reviewer 首轮对象 6ec5ff9 之上的全部处置)。

| 点 | 裁决 | 依据 |
| --- | --- | --- |
| F-1 状态层旧 PASS 直接断言 | **VERIFIED** | gate-binding.test.ts:140-150:新 attempt 走完至 VERIFYING 后,VERIFYING→ACCEPTED 断言失败且 reason==gate_not_passed;断言非恒真(夹具唯一 PASS 绑定 attempt 1,若 countGatePass 可见该转移会成功);单跑 5/5 |
| F-2 预留口径一致 | **VERIFIED** | gate-e2e.test.ts:122 reviewer 预留 3(注释 5+3 ≤ 8;合同声明口径),coder 保持 5;代码/REPORT/提交信息口径一致。附带观察(不阻塞):reviewer 回合硬顶随预留降 3,REPORT §5.5 已披露波动 3-5,重跑存在触顶保守停机的预算纪律残余 |
| F-6 uuid / 直连 UPDATE 保留 | **VERIFIED(保留可接受)** | randomUUID 已用;REWORK→READY 直连 UPDATE 与 advanceTask 同事务(行锁至提交,无并发窗口)+ state 守卫 + version 递增 + 退避 + 审计,原子性与可观测性成立 |
| 附带核查 | 0727c53 仅 egress 助手显式 stdio pipe(日志去噪),失败仍抛、FAIL-CLOSED 不变 |
| F-3 | NOT-VERIFIED(收尾提交承诺项,不阻塞)——收尾提交纳入证据;push 后核验 origin/main==HEAD 与 worktree clean |

**Reviewer 亲测**:tsc 0 错误;全量 **114 passed + 8 skipped**;gate-binding 单独 5/5;worktree clean。

**最终裁决:PASS**(三点处置全部 VERIFIED;F-3 为收尾提交的已承诺条件)。
