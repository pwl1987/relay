# Relay 当前执行契约

- 状态:**P0-02A ACTIVE(提交与独立验证)**。写者:本会话(VM80 唯一 Writer)。冷启动基线:`origin/main == HEAD == db5ebed`(P0-01C 收尾提交,worktree clean)。授权锚:用户 2026-11-10 P0-02A 授权消息 + `docs/CONSTRUCTION_PLAN.md` P0-02A 行 + `p0-01c/REPORT.md` §5/§6 移交项。
- **合同先行(P0-01C F-4 流程改进的执行)**:本合同文本作为独立首提交先于一切实现提交落盘。

## 一、目标

把 P0-01C 的自治 Goal Loop 升级为**带独立质量验证的受控提交闭环**:Coder Run 产出候选变更 → Candidate ChangeSet → 独立 Reviewer Run(不同 Run/上下文)→ 可信 Evidence → 绑定版 Gate → 自动裁决消费与状态推进。Coder Agent 自宣的 DONE 不构成验收。

## 二、交付阶段

### C-1 Candidate ChangeSet
- Run 结束时由 **Worker 侧**对 Run 工作区做前后清单对比(路径→sha256 清单):base_sha、candidate_sha(对清单内容的 sha256)、changed_files(增/改/删)、impact_scope(与 allowed_scope 的交集校验)、绑定 task/run/attempt。
- 迁移 0003:`candidate_changesets`、`gate_evidence` 两新表;`task_gate_verdicts` 增绑定列(attempt/candidate_sha/requirement_sha/test_env/reviewer_run_id/evidence_ids/consumed 标记)。
- 需求版本绑定:requirement_sha = sha256(goal 原文 + task 约束快照),变更集创建时由 Worker 采集。

### C-2 独立 Reviewer Run
- Reviewer 是**独立 Run**:独立 Pi RPC 会话、独立沙箱;输入 = 需求文本 + 变更集清单 + Evidence,**不得输入 Coder 的 Handoff 叙事**(上下文隔离)。
- 结构化裁决围栏 `relay-gate-verdict(verdict=PASS|REWORK|BLOCK, findings=...)`,由 Worker 侧解析;解析失败/无围栏 = Review 失败(有界重试后 NEEDS_DECISION,不烧模型循环)。
- **Gate 记录强制 reviewer_run_id ≠ coder run_id**;违反即拒绝(编码 Agent 不能自宣验收)。

### C-3 可信 Evidence
- `gate_evidence`:kind、passed(由 Worker 按退出码判定,**非模型判定**)、raw_output 原文、ts、env(node/镜像/沙箱/命令)、content_sha256、produced_by、绑定 (task, attempt, candidate_sha)。
- 确定性检查与真实 API 行为检查由 **可信执行器**(Worker 侧进程)执行并落库;不依赖 Agent 可改写的 workspace 日志。
- PASS 裁决必须引用 evidence_ids,消费时逐条核验:存在、绑定匹配、passed=true、digest 与原文一致。

### C-4 Gate 绑定(旧 PASS 不跨版本)
- recordGateVerdict 必须携带:taskId + attempt + candidate_sha + requirement_sha + test_env + reviewer_run_id + evidence_ids。
- PASS 前置:attempt == task 当前 attempt;candidate_sha == 当前变更集;evidence 绑定同 (attempt, sha) 且全 passed;reviewer_run_id ≠ coder run_id。
- **消费时二次校验绑定**(交易内):attempt/sha/requirement 任一失配 ⇒ 拒绝消费 + 审计;每份裁决至多消费一次。

### C-5 VERIFYING 独立验证租约
- 新 `acquireVerificationLease`(Core):Run 成功后由 Gate 编排方接管租约——fencing+1、owner=verifier,**立即废掉模型 Worker 残留 TTL 的权威**(旧 fencing 的 advance/heartbeat 全拒)。
- Reviewer Run 期间由编排方心跳续租;心跳连续异常 ⇒ 止损(SI 置 NEEDS_RECONCILE 路径交由回收,Reviewer Run 杀死)。
- Verifier 崩溃 ⇒ 租约到期 ⇒ 既有 reclaim(VERIFYING 在工作链)→ NEEDS_RECONCILE → READY → 新 attempt 重验,不产生假通过。

### C-6 Gate 自动消费与状态推进
- `consumeGateVerdict`(单事务:绑定校验 + advance + 审计):PASS→ACCEPTED(租约释放);REWORK→REWORK(+指数退避);BLOCK→NEEDS_DECISION(+decision 行 D3,经 ops API 恢复,永不自动批准)。
- Review 失败有界重试耗尽 ⇒ NEEDS_DECISION(保守停机,不无限烧模型)。
- **模型文本 DONE ≠ PASS**:Handoff status=done 不产生任何裁决行;唯一 PASS 来源 = 绑定版 Reviewer 裁决或 OPERATOR。

### C-7 Goal Loop 异常可观测/熔断/恢复
- startGoalLoop/startSupervisorLoop 去除 `.catch(() => {})`:连续 tick 异常计数 + onTickError 回调;连续 ≥ 阈值(默认 3)⇒ 熔断(停止调度新 tick),尽力落审计;进程重启后新循环从 PG 恢复(熔断态属进程内,重启即恢复推进)。

### C-8 出口代理 v2:密钥隔离 + 请求计数
- relay-egress-fwd 由 TCP 裸转发升级为 **HTTP 反向代理**(仍 host 网络、仍 FAIL-CLOSED):代理持有真实 key(env 注入,不进 runDir/argv/容器),改写 Authorization;Run 容器 models.json 只含代理地址+占位 key;**删除 `--api-key` argv 传递**(宿主 ps 可见面,P0-01B F-7)。
- 代理内嵌**被动请求计数**(透传字节不变,tap 客户端→服务端请求行),本地计数端点供核验。
- 验证门(接真密钥前必测,本包用假密钥验证机制):容器内 models.json/env/argv 均无真实 key;完整 Run 经代理可用;外部 DROP 白名单语义不变。

### C-9 回合计数独立核验
- E2E 对比:runner 侧 assistant 回合计数 vs 代理层观测的真实 Provider 请求数。**不一致时如实报告,不得宣称模型 API 请求硬顶已证明**(合同条款 9)。

## 三、必须通过的反例(测试逐条覆盖)

1. Agent 虚构 DONE ⇒ Gate 不通过(无裁决行,任务停留 VERIFYING,不得 ACCEPTED)。
2. 同一 Task 新 attempt 使用旧 PASS ⇒ 消费拒绝(attempt 绑定失配)。
3. Candidate SHA 变化后旧证据/旧 PASS 失效 ⇒ 消费拒绝。
4. Reviewer BLOCK ⇒ 任务 NEEDS_DECISION,**不自动 ACCEPTED**(恢复仅经 ops API)。
5. Worker 在 VERIFYING 前后崩溃 ⇒ 无假通过、无双重裁决(裁决记录/消费事务化,至多一次)、无永久失联(租约回收→重验)。
6. 测试失败或未执行 ⇒ evidence passed=false 或缺失 ⇒ PASS 拒绝,不得显示绿色。
7. PostgreSQL 连续异常 ⇒ 不静默无限循环(计数、回调、熔断)。

## 四、验收

1. Vitest + 真实 PostgreSQL 全绿;非模型部分全新克隆可复现;模型相关显式 skip。
2. ≥1 真实模型 E2E:Coder Run + 独立 Reviewer Run + Evidence + Gate 消费全闭环,全程经 budget_ledger 预留/核算;回合/请求计数核验结论如实。
3. 三、七条反例测试全过;证据(日志/账本快照/复现输出)绑定最终实现 SHA,存 `p0-02a/`。
4. 独立 Reviewer(全新上下文)复核,REPORT(`p0-02a/REPORT.md`)+ REVIEW(`p0-02a/REVIEW.md`)落盘;处置后快进推送 main,核验 origin/main==HEAD 且 worktree clean。
5. 更新 CURRENT.md(完成态)与 docs/CONTINUATION.md。

## 五、预算分段(未经授权不得扩大)

- 阶段 A(合同+实现+stub 测试):**0** 付费模型调用(stub RPC)。
- 阶段 B(真实模型 E2E):**≤8 次**(Goal 账本上限;Coder+Reviewer 两 Run 计入;单 Run 回合硬顶照旧;跑前声明,重跑累计不得超 8)。
- 需要超出 ⇒ **阻断并说明**,不自动扩大;安全门禁失败 ⇒ 阻断相关工作,不放宽门禁。

## 六、边界与停止条件

- 禁止:真实 GitHub 写路径(P0-02B)、Web(P0-02C)、生产部署、RSI、额外长期分支、强推。
- main-only、唯一 Writer、快进推送;写者冲突/工作区分叉 ⇒ 只读停下。
- 宿主改动面:egress 代理容器/规则(沿用 relay-p01c 标记体系,可幂等重建/撤除),零其他宿主服务改动。
