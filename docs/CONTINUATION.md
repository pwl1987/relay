# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09 完成 P0-00(实验,`p0-00/REPORT.md`)与 P0-01A(状态内核,`p0-01a/REPORT.md`);2026-11-10 完成 **P0-01B(有界 Pi Run,`p0-01b/REPORT.md`)** 与 **P0-01C(受控 Goal Loop,`p0-01c/REPORT.md`)**。**P0-02A 尚未实施,不代表产品功能存在。**

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- **P0-00**:`p0-00/REPORT.md`(ADR-0003/0007 依据);**P0-01A**:`p0-01a/REPORT.md`;**P0-01B**:`p0-01b/REPORT.md`;**P0-01C**:`p0-01c/REPORT.md`(含 §5 密钥隔离设计、§3.1 合同时序治理事实)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已裁决并落地(2026-11-10,P0-01C 更新)

- **ADR-0003 双层边界已完整代码化并加厚**:工具层 = vendored Pi 1.5.0(路径钉死三道校验)+ `--no-builtin-tools` + relay_read/**relay_exec(命令前缀白名单,`$()`/`${}`/控制字符全禁)** + toolEvents Worker 侧持久化;OS 层 = docker `--cap-drop ALL`/uid 10001/限挂载 + **网络出口三层**(专用 bridge + RELAY-EGRESS/DOCKER-USER 出站白名单 + loopback 转发器容器;规则缺失 FAIL-CLOSED 拒启,无 host 网络降级路径)。
- **机器预算(P0-01C 新裁决)**:budget_ledger 先预留再执行后核算;model_calls 无带 limit 行 = FAIL-CLOSED;**Run 中回合硬顶**(assistant 回合 ≥ 预留 ⇒ SIGKILL+BUDGET_EXHAUSTED+任务 BLOCKED),单 Run 机械不可破账本;token 实测/保守估算。
- **D0-D4 裁决语义**:D2 仅执行创建时已声明的 fallback;**D3 永不超时自动批准**(过期仅标 EXPIRED_STILL_BLOCKED);恢复动作需 actor 授权(RELAY_OPERATORS)+ expected state_version + 合法转移 + OPERATOR 审计。
- **自治恢复语义**:retry_not_before 指数退避;相同失败签名 ≥3 熔断 CIRCUIT_OPEN;attempt 预算;并发 Tick 恰一赢家;进程重启从 PG 恢复(无内存权威);IDLE/模型断供探测不烧 token;goal 聚合 COMPLETED/FAILED。
- **Lease 契约(累计)**:TTL=权威窗口;心跳权威仅工作链内(NEEDS_RECONCILE/终态拒);心跳 DB 连续异常 ≥2 ⇒ Run 止损;VERIFYING 后租约仅剩心跳窗口,Gate 须窗口内完成(边界移交 P0-02A Gate 编排)。
- **测试基建**:Vitest 97 用例(真实 PG/SIGKILL/docker kill/iptables 实测/stub RPC/回合硬顶),每文件独立 schema;非模型 94 例全新克隆可复现,模型相关显式 skip。测试库 `relay-p000-pg`(127.0.0.1:55433)。
- **运行环境事实(累计)**:VM80=ubuntu2604;Pi 1.5.0 vendored(升级改 RELAY_PI_VERSION+package.json 留证);magpie 127.0.0.1:3425 当前可用(**非 loopback 源 401**——容器模型连接必须经 relay-egress-fwd 转发器);bridge 容器默认可出外网(iptables 白名单约束);ufw 拒容器→宿主(INPUT 需单条放行转发端口);gh 令牌超范围(P0-02B 前必须换细粒度 PAT);宿主 node_modules ACL 对 other 关闭(勿删 ensureNodeModulesReadable/chmod 链)。
- **治理流程改进(P0-01C F-4)**:工作包 ACTIVE 合同必须**先于实现提交**落盘(独立首提交);模型预算按阶段分段计数+运行前声明。

## 唯一下一任务:P0-02A(提交与独立验证,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. **先起草 ACTIVE 合同并独立提交落盘**(P0-01C F-4 流程改进),再实施。合同要点按 CONSTRUCTION_PLAN P0-02A 行:Candidate Diff、独立 Reviewer(与 Coder 上下文隔离)、测试/Reality Gate、Evidence 绑定 commit(gate_attempt 绑定,消化 P0-01A F-5/V09 旧 PASS 跨 attempt 边界);Gate 编排消费 P0-01C 遗留的"VERIFYING 后租约窗口"。
3. 验收对齐:错误答案/假 DONE 必失败;证据绑定 commit;Gate 缺失 ⇒ 不得 DELIVER。
4. 边界:不做 GitHub 真实写路径(P0-02B)、不做 Web(P0-02C)、不生产部署、不 RSI。
5. 模型预算:按阶段分段计数,每次运行前声明;继续经 budget_ledger 预留。
6. 完成后:独立复核、快进 push main、核验 `origin/main==HEAD` 且 worktree clean、更新 `CURRENT.md` 与本文件。

## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/CONTINUATION.md、p0-00/REPORT.md、p0-01a/REPORT.md、p0-01b/REPORT.md、p0-01c/REPORT.md。严格 main-only、单 Writer、禁强推。**先把 P0-02A ACTIVE 合同独立提交落盘,再实施**:提交与独立验证——Candidate Diff、独立 Reviewer(与 Coder 上下文隔离)、测试/Reality Gate、Evidence 绑定 commit(gate_attempt 绑定,消化旧 PASS 跨 attempt 边界与 VERIFYING 租约窗口);复用 src/core 状态层/src/runtime Runner/budget_ledger。不做 GitHub 真实写路径,不做 Web,不生产部署,不 RSI。测试沿用 Vitest+独立 schema+真实故障注入;模型相关显式 skip;预算按阶段分段计数经账本预留。遇写者冲突、门禁失败或需要增加预算时阻断并说明,不自动扩大。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。
