# P0-02A 交付报告:候选变更与独立质量验证

状态:**COMPLETE(待复核收尾)**。执行:VM80 唯一 Writer 会话,2026-11-10,起点 `origin/main == db5ebed`。合同 `87e1db3`(独立首提交,**先于实现落盘**——P0-01C F-4 流程改进兑现)→ 实现 `772eb0c` → E2E 修复 `6ec5ff9`。最终 HEAD 以远端 main 为准。

## 0. 交付标识

| 项 | 值 |
| --- | --- |
| 新增 core | `changesets.ts`(变更集)/ `evidence.ts`(可信证据)/ `gate-orchestrator.ts`(编排)/ `verify-lease.ts`(验证租约)/ `loop-safety.ts`(循环熔断);`gates.ts` 重写为绑定版;`lease.ts` countGatePass 绑定感知;`lifecycle.ts` 增 VERIFYING→NEEDS_DECISION |
| 新增 runtime | `workspace-manifest.ts`(清单快照)/ `gate-verdict.ts`(围栏解析+Reviewer 提示)/ `reviewer.ts`(独立 Review Run);`runner.ts` 接线变更集;`sandbox.ts` 密钥隔离(占位 key + 删 `--api-key`);`egress.ts` 升级 HTTP 反向代理(持钥改写 + 请求计数) |
| 迁移 | `0003_gate_orchestration.sql`(手写):candidate_changesets / gate_evidence 两新表 + task_gate_verdicts 九个绑定列(attempt/candidate_sha/requirement_sha/test_env/reviewer_run_id/coder_run_id/evidence_ids/consumed_at/consumed_by) |
| 测试 | Vitest **122 用例 = 114 passed + 8 skipped**(非模型全新克隆可复现);新增 7 文件(changesets / gate-binding / verify-lease / gate-orchestrator / loop-circuit / egress-proxy / gate-e2e);legacy 迁移绑定签名(v08-gate / run-lifecycle / v04 / pi-e2e);pi-e2e-c 由 gate-e2e 取代(真实模型 E2E 只跑一份,预算纪律) |
| 模型调用 | **最终验收 E2E 账本实测 used=6/8**(coder 3 + reviewer 3;预留 5+3 全额释放)。开发调试期共 5 次 E2E 失败迭代 + 若干容器实测,全部走 magpie 本地假密钥路由(零真实成本),已按合同预算纪律如实计入并推动修复(见 §3) |
| 宿主改动面 | egress 代理容器/规则沿用 `relay-p01c-egress` 标记体系(幂等重建/撤除);零其他宿主服务改动 |

## 1. 合同交付对照(CURRENT.md C-1..C-9)

### C-1 Candidate ChangeSet ✅
Run 前后由 Worker 对工作区做清单快照(相对路径→sha256;排除 `.relay`;不追随符号链接),diff 出增/改/删;`candidate_sha = sha256(规范清单)`,`requirement_sha = sha256(goal 原文+任务约束)`;影响面按挂载点换算核验(等于挂载点的 scope 根映射为工作区根);绑定 task/run/attempt。SUCCEEDED 才有候选(失败 Run 无候选)。审计 CHANGESET_RECORDED。

### C-2 独立 Reviewer Run ✅
独立 Pi RPC 会话 + 独立沙箱 HOME;`workspaceDirOverride` 共享候选工作区(独立上下文、同一候选面);输入 = 需求 + 变更清单 + 证据摘要,**无 Coder Handoff 叙事**;runs 行 `detail.role="reviewer"`(Gate 记录强制校验该身份且 reviewer_run_id ≠ coder run_id);Reviewer 禁 relay_exec(只读);提示词带回合预算纪律与 few-shot 围栏样例;裁决围栏 `relay-gate-verdict` 由 Worker 侧解析,无围栏=审查失败。

### C-3 可信 Evidence ✅
`gate_evidence`:kind / passed(**由 Worker 按退出码判定,非模型判定**)/ raw_output 原文 / env(node/host/命令/沙箱)/ content_sha256 / produced_by,绑定 (task, attempt, candidate_sha)。确定性检查 Worker 侧真实子进程执行;reviewer 原始输出一并落证据。消费时逐条核验:存在、绑定、passed=true、digest 与原文一致(防事后篡改)。

### C-4 绑定 Gate(旧 PASS 不跨版本)✅
recordGateVerdict 强制:变更集存在且 attempt/candidate/requirement 匹配、Reviewer 身份独立(role=reviewer 且 ≠ coder run)、PASS 必须引用全 passed 证据、test_env 必带。consumeGateVerdict 单事务二次校验全部绑定后推进并标记 consumed(至多一次);任何失配 ⇒ GATE_CONSUME_REJECTED 审计 + 状态不变。状态层 countGatePass 同步绑定感知(只数:未消费 + attempt/候选/需求匹配当前事实)——旧 PASS 在记录层、消费层、状态层三处均不可复用。

### C-5 VERIFYING 独立验证租约 ✅
`acquireVerificationLease`:Run SUCCEEDED 后 Gate 编排方接管——fencing+1、owner=verifier,**模型 Worker 残留 TTL 权威即时作废**(旧 fencing 的 advance/heartbeat 全拒,实测断言);Reviewer Run 期间 verifier 心跳续租(连续异常止损,杀 Review Run);verifier 崩溃 ⇒ 租约到期 ⇒ 既有 reclaim(VERIFYING 在工作链)→ READY → 新 attempt 重验。P0-01C REPORT §6-1 的"6 秒残留窗口"边界就此关闭。

### C-6 Gate 自动消费与状态推进 ✅
consumeGateVerdict 事务内:PASS→ACCEPTED(租约释放);REWORK→REWORK→READY(+指数退避);BLOCK→VERIFYING→NEEDS_DECISION(lifecycle 转移表新增此合法边)+ D3 决策行 + 显式终止租约——**永不自动批准**,恢复仅经 ops API(actor 授权 + state_version)。Review 有界失败(无围栏/预算触顶/权威丢失不重试)耗尽 ⇒ 保守 NEEDS_DECISION。**模型文本 DONE ≠ PASS**:Handoff 落库如实,但唯一 PASS 来源 = 绑定版 Reviewer 裁决(fake-self-approve 反例测试证明 coder 自宣围栏零路径生效)。

### C-7 循环异常可观测/熔断/恢复 ✅
`loop-safety.ts`:连续 tick 异常计数(成功清零)、逐次 onTickError、达阈值(默认 3)熔断停止调度 + onCircuitOpen + 尽力落 TICK_ERROR 审计(DB 故障时审计失败被吞,可观测以回调为准);startGoalLoop / startSupervisorLoop 均接入(P0-01C F-8 静默吞异常收口)。恢复 = 新循环实例(进程重启语义;事实状态全在 PG)。

### C-8 出口代理 v2(密钥隔离 + 请求计数)✅
relay-egress-fwd 升级 HTTP 反向代理(host 网络,FAIL-CLOSED 不变):真实 key 仅存代理进程环境(`FWD_REAL_KEY`),来自 Run 的请求 Authorization 被改写;**`--api-key` argv 已删除**(宿主 ps 可见面收口,P0-01B F-7);Run 容器 models.json 仅 `sk-relay-proxy-placeholder` 占位。实测:容器可见面(models.json/argv/env)零真实 key;占位 key 经代理被换真(magpie 接受);外部 DROP 与计数端口对容器子网封闭语义不变。真密钥接入前的验证门全部落地——本包仍用假密钥(本 VM 无真 key),机制已验证。

### C-9 回合计数 vs Provider 请求数独立核验 ✅
代理对每个 HTTP 请求 1:1 计数并单列 completions(POST *completions*)。最终验收:`completions=6 == coder 回合 3 + reviewer 回合 3`,`total requests=6`(无额外非 completions 请求),`ledger used=6/8`。**对账一致,模型 API 请求硬顶宣称成立**(E2E 断言强制:不一致即测试失败)。

## 2. 反例对照(合同第三节 7 条,全部有专属测试)

| # | 反例 | 测试 | 结果 |
| --- | --- | --- | --- |
| 1 | Agent 虚构 DONE,Gate 不得通过 | gate-orchestrator(fake-self-approve 两例)+ gate-binding(无裁决行断言) | ✅ coder 自宣围栏/自评 DONE 零路径生效;无 Reviewer 裁决则停留 VERIFYING/NEEDS_DECISION |
| 2 | 新 attempt 使用旧 PASS 必须拒绝 | gate-binding(stale_attempt + countGatePass 不可见)+ verify-lease(孤儿 PASS) | ✅ 记录/消费/状态三层皆拒 |
| 3 | Candidate SHA 变化后旧证据失效 | gate-binding(stale_candidate + 证据绑定失配) | ✅ |
| 4 | Reviewer BLOCK 不能自动 ACCEPTED | gate-orchestrator(BLOCK→NEEDS_DECISION + D3 行 + 租约终止) | ✅ |
| 5 | VERIFYING 前后崩溃:无假通过/无双重裁决/无永久失联 | verify-lease(接管后幽灵全拒 + 回收重验 + 孤儿 PASS 失效)+ gate-binding(already_consumed) | ✅ |
| 6 | 测试失败或未执行不得显示绿色 | gate-binding(evidence_missing / evidence_not_passed / digest 篡改) | ✅ PASS 记录与消费都必须有全 passed 且 digest 完整的证据 |
| 7 | PG 连续异常不能静默无限循环 | loop-circuit(恰 N 次回调后熔断、成功清零、新实例恢复) | ✅ |

## 3. 实施中修复的缺陷(留痕,全部由真实故障暴露)

1. **VERIFYING→NEEDS_DECISION 不是合法转移**(首次 BLOCK 流测试暴露)——lifecycle 转移表补边(注释:恢复仅经 ops API,永不自动批准)。
2. **PASS 必须引用证据 vs 无变更集流程不可有证据** 的矛盾——证据 candidate_sha 用 `""` 哨兵对齐无候选流程;gate-helper 播种真实证据行。
3. **HTTP 探测缺 `req.end()`**(egress 代理就绪等待双向死等,15s 超时)——补 end;`docker rm -f` 补缺失容器防守。
4. **Node 全局 keep-alive 复用 vs 服务端 keepAliveTimeout 相撞**(socket hang up 竞态,诊断端点偶发 null)——计数端点请求一律 `agent: false` 一次性连接。
5. **Reviewer models.json 缺 baseUrl 重写**(**本包头条缺陷**):容器内连自身 loopback → pi auto_retry×3 → `stopReason:"error"`、空文本、烧满预留。抽出共享 `rewriteBaseUrlForContainer`(runner/reviewer 同源)+ FAIL-CLOSED 校验同款。
6. **真实模型 4 回合不出裁决围栏**(few-shot 样例 + "读完立即裁决"纪律后收敛为 3 回合内出栏)。
7. **Reviewer 共享工作区 chmod 踩容器 UID 属主文件**(宿主非属主无权 chmod)——共享候选不再重 chmod(权限面已由 runner 建好,Reviewer 只读)。
8. **assistant 文本块为空时的兜底提取**(auto_retry 后 content 异常;扫描 assistant message JSON、转义还原后匹配围栏——仍是模型自述,非虚构)。
9. **预算型 Review 失败重试只会烧穿同一账本**——orchestrator 对 `budget*` 失败不再重试。
10. 测试自身问题(记录备查):gate 反例中先过期租约再推进的顺序错误;`setInterval` 不立即触发;failingDb 未代理 transaction。

## 4. 模型预算如实账(合同第五节)

- 阶段 A(合同+实现+stub 测试):0 付费调用(stub RPC / 纯 core 测试)。
- 阶段 B:最终验收 E2E **账本 used=6/8**(coder 3 + reviewer 3;预留 5+3;单 Run 回合硬顶生效)。开发调试 5 次失败迭代(每次 ~6-8 请求)+ egress-proxy 容器实测 1 次请求,全部为 **magpie 本地假密钥路由(零真实成本)**;每次迭代都被账本如实记账并驱动了 §3 的修复(预算耗尽路径本身是 FAIL-CLOSED 语义的实测)。
- 无一次绕过账本的模型调用;无预算扩大申请。

## 5. 未解决风险与边界(诚实清单)

1. **代理容器 env 持真 key 的宿主可见面**:`docker inspect` 可见(宿主 root 面)。设计如此(密钥不出宿主;Run 容器/argv/models.json 零可见),真密钥接入时的进阶收口:宿主 0600 文件 + 代理只读挂载(挂 P0-02B 前检查单)。
2. **证据检查的执行面是宿主 Worker**(`worker-host`):确定性命令在宿主 cwd=工作区执行,不经容器。命令由合同/编排方配置(非模型注入),argv 直启无 shell 面;若要求与 Run 同环境执行,需 Worker 容器化(P0-02A 范围外,已记录)。
3. **Reviewer 兜底提取**在 assistant 文本块为空时扫描 message JSON——比纯文本面宽;宽松方向的误报可能(把模型非围栏文本当围栏)不存在(围栏正则严格),漏报方向与纯文本一致。
4. **legacy 无变更集流程**的 PASS(candidateSha=null)仅限无 runner 的手动/运维链路(v08 语义测试);有 runner 必产变更集且绑定强校验。
5. **E2E 对模型行为的依赖**:coder/reviewer 收敛回合数有波动(实测 3-5);预留(cap)+账本是机械上限,波动不破预算但可能触发保守停机(NEEDS_DECISION)——语义如实。
6. **goal 聚合时机**:Gate 消费后本 tick 即聚合 COMPLETED(tick2=IDLE)。测试初版误期待 tick2 报 COMPLETED,已修正断言语义(实现无缺陷)。
7. 未做:真实 GitHub 写路径(P0-02B)、Web(P0-02C)、生产部署、RSI。

## 6. 复现命令

```bash
git clone https://github.com/pwl1987/relay && cd relay
npm ci && npm run db:up
RELAY_PI_BASE_URL=http://127.0.0.1:1/v1 npm test   # 114 passed + 8 skipped(模型/容器相关显式 skip,零模型)
npx tsc --noEmit                                    # 0 错误
# 容器门(需 docker;egress 另需 sudo iptables + 本地 provider):
npx vitest run test/integration/egress-proxy.test.ts test/integration/sandbox-enforcement.test.ts
# 最终验收 E2E(真实模型;goal 账本硬限 8,实测 6/8):
npx vitest run test/integration/gate-e2e.test.ts
# 环境变量:RELAY_PI_PROVIDER/MODEL/API_KEY/BASE_URL;RELAY_EGRESS_FORWARD_PORT/COUNT_PORT
```

## 7. 证据索引

| 证据 | 内容 |
| --- | --- |
| `p0-02a/e2e-run.log` | 最终验收 E2E(6ec5ff9):C-9 核验行 completions=6==turns=6(3+3)、ledger 6/8、1/1 passed |
| 容器门 | egress-proxy 4 + sandbox-enforcement 2,全过(2026-11-10 实测;Reviewer 可复跑) |
| 全量 | 114 passed + 8 skipped + tsc 0 错误(6ec5ff9;Reviewer 亲测口径相同) |
| `p0-02a/REVIEW.md` | 独立 Reviewer(全新上下文)复核报告与处置 |
| 合同时序 | `87e1db3`(合同)→ `772eb0c`(实现)→ `6ec5ff9`(修复)——合同先于实现,F-4 流程改进兑现 |
