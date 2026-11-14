# Relay 当前执行契约


- **RELAY-EGRESS-ISOLATION-07R 🔵 ACTIVE（2026-11-14；07 独立审计 REWORK 最小纠偏）**
  - **最低祖先**：a31d9479a0180c9e2e88c8b31dc514e7b49db878。协调方独立核 GitHub exact-head CI 43579979419@a31d947（test/e2e 双成功）、live main/两次交付提交/代码/07 REPORT+REVIEW；VM80 本地 main 对齐，受保护未跟踪目录只有 config/ 和 p0-mvp/soak-r3b/，Writer 已释放；亲跑 mock-only 单测 10/10 PASS。**独立新发现 Major-1**：createTestEgressScope('abcdefgh-one') 与 ('abcdefgh-two') 的 network/container/ruleTag/port 均不同，但 chain 同为 RELAY-EGRESS-abcdefgh（在 VM80 调用实际代码复现）。egress.ts 的 chainNameFor(id) 取合法 id 前 8 字符；第二 scope 的 ensureEgress 若规则不匹配可执行 iptables -F 对共同链清空重写；teardown 的 owned 注册键仅以物理 chain 名标识，存在跨作用域清理风险。直接实测确认名称碰撞；跨作用域破坏路径为**源码推导**，未在共享宿主实际执行。07 现有 CI+单 scope E2E 未覆盖，**协调方裁决 07=REWORK**，而非 Agent 报告的 PASS。详见 p0-mvp/egress-isolation-07/COORDINATOR-REVIEW-20261114.md。
  - **唯一交付目标**：修复不同合法 EgressScope 之间的 iptables 链名冲突与跨 scope 归属误判：两个合法不同 scope 不得共同修改同一个链；即使人为制造同名/摘要碰撞，必须在改变他人资源之前明确拒绝。确保测试全套资源隔离（网络/容器/链/规则/端口）真实成立，保留原有安全默认拒绝、密钥隔离、健康复用和恢复语义。**只做 07 的纠偏，不进入新功能或生产部署。**
  - **A 冷启动+代码根因**：git 安全快进 live main，核 AGENTS/CURRENT/ADR/Writer/脏树和 protected 目录；完整审查 src/runtime/egress.ts 的 chainNameFor、createTestEgressScope、resolveEgressScope、ensureEgress、teardownEgress、verifyEgressRules，以及 owned 注册表和实际 Docker/iptables 规则操作顺序。核报告中“已完全隔离”是否被反例推翻；不得删改既有 07 成功证据。
  - **B 反例先红**：扩展已有 test/unit/egress-isolation.test.ts 模拟执行器：两个不同合法 ID 共享前 8 字符、同名链但不同 ruleTag/owner、创建冲突/只读探针失败/匿名链/旧链、归属注册表混淆；实证旧实现第二作用域可能 -F 第一个链以及误清风险，保存红态记录。测试绝对不调用 VM80 默认生产 iptables、Docker 默认资源、真实模型。
  - **C 最小修复**：在既有 EgressScope 与模块内用全量稳定标识派生受限长度链名（不能仅截断前缀），并对人为同名/哈希碰撞做**前置归属确认与拒绝**；仅靠碰撞概率很低不算满足。任一真实链非自身作用域、归属不可证、iptables 读取失败时 fail-closed，禁止对未知或他人链执行 -F/-X/-A 或删除其跳转/INPUT。修复 teardown 的 chain 注册与真实作用域身份边界，防止同名跨 scope 误删。默认生产网络 relay-egress-net、代理 relay-egress-fwd、iptables 链 RELAY-EGRESS、端口不改；历史同名无归属链不得自动接管；多入口健康复用和跨进程状态知觉不退化。尽量不新增通用锁/数据库/daemon/抽象层；确有不可解决的全局资源归属则拒绝并记录。
  - **D 红绿与隔离测试**：同组反例修前红修后绿；两个不同合法 scope A/B 均建立时分别验真实规则，清理 A 后 B 仍健康、清理 B 后双域零残留；强制同链碰撞时第二方拒绝且第一方完全不变；无权/未知链零删；当前 07 单测10/10、隔离 E2E6/6、egress-enforcement4/4、沙箱及相关调用方回归不退化。隔离 CI Docker/iptables 运行双 scope E2E，前后核 default Docker 网络、代理、iptables 链/DOCKER-USER/INPUT 和监听端口（不能只检查网络存在）。VM80 本地只允纯 mock/只读，full/release 有干扰风险则 NOT_RUN 交 CI。quality:quick、定向测试、GitHub exact-result-head test/e2e；零模型/付费/生产操作。
  - **E 独立验收与交接**：独立 Reviewer 在隔离上下文亲测两个同前八 ID、强制同链、跨 owner、teardown 互不伤、默认不变；检查失败路径是否可能误刷共同链、修复是否引入新权限或破坏兼容。普通缺陷至多自主修复两轮；出中文 REPORT/REVIEW、红绿证据与真实 CI，main-only 快进提交，核 exact-head CI，CURRENT/CONTINUATION 收口，释放 Writer。允许最小修改 src/runtime/egress.ts、相关 unit/integration、SECURITY_MODEL/OPERATIONS/Runbook；额外调用方变更须证明必要性。
  - **硬禁令**：生产 relay_console/迁移 0008/0009/服务 stop、restart、reload/生产默认 egress 网络、代理、iptables/真实密钥 env/模型/外部交付/防火墙/公网/TLS/新分支/强推/第二控制面一律不做；config/ 与 p0-mvp/soak-r3b/ 受保护不得触碰。生产继续 NO-GO，须用户单独 D3 才能切换。若无法在隔离范围证明安全，提交 BLOCKED 与最小安全替代，不试错删除。
  - **交接**：本地 Agent 从 live main 冷启动、独占 Writer、执行以上全部有界步骤，提交收口后让用户简单回复“本地 Agent 已完成”；协调方只从 GitHub 独立验收。

- **RELAY-EGRESS-ISOLATION-07 ⚠️ Agent 已提交、协调方 REWORK(2026-11-14；见 07R 合同)**:提交链 5cca5a8(用户合同登记)→ a88b0f4(实施:命令注入模拟执行器反例先红 9/9+EgressScope 独立命名空间/owner 归属/健康复用/状态感知收敛+测试面全作用域化+隔离 E2E,28 文件 +2662/-314)→ 收口;exact-head CI **43575650845@a88b0f4 双 job success**(test+e2e 亲测;CI 上隔离 E2E 真跑 6/6=23.8s、egress-enforcement 4/4、unit 10/10,full 总裁决 PASS)。独立 Reviewer 隔离冷启动终裁 **PASS(0 Major,Minor-1~4:1/3 已消化,2/4 登记后续候选)**;自建 7 探针独立实证(created 态不误杀/引号分词/create 冲突不误杀/运行中配置不符拒绝/混合注册表隔离/派生性质/verify 作用域化);冷启动挑战通过;硬禁令逐条核对全过;报告 p0-mvp/egress-isolation-07/REPORT-RELAY-EGRESS-ISOLATION-07.md。**核心成果**:测试环境与生产出口约束栈完全隔离——测试一律 `relay-test-*` 独立命名空间(网络/容器/链/标记/端口全派生),teardown 仅删本执行者创建且仍持有的资源(审计报告,零删除逐项带原因),匿名同名资源 fail-closed 拒绝,生产 ensureEgress 健康复用不重建(在途请求不中断);默认名/端口/FAIL-CLOSED 不变;"full 测试拆生产 egress 共享栈"根因消除。**生产影响=零,生产预检仍 NO-GO**(迁移缺 0008+0009/检查未配置/旧进程/egress 栈缺席——重启后首拍自愈,处置全在 Runbook),生产切换须用户单独 D3 授权;归属标签=运维标记非安全认证。quality:full/release 本地 NOT_RUN(合同 D 顺序门)由隔离 CI 43575650845 双绿覆盖。
- **RELAY-SAFETY-AUTHORITY-06 ✅ 收口(2026-11-14)**:提交链 a142935(用户合同登记,含四项目研究登记 docs/EXTERNAL_PATTERN_COMPARISON_20261114.md)→ 3a4266e(实施:A 预检误判红绿修复+B 全仓 31 文档审计纠偏+C 四项目裁决登记+D CURRENT/CONTINUATION 压缩,32 文件 +805/-356,零 src/ 改动)→ 801bae9(独立 Reviewer 两阶段终裁入库+最终报告)→ 收口;exact-head CI **43553382081@801bae9 双 job success**(test+e2e,gh run view 亲测)。独立 Reviewer:A 项两轮 REWORK(1 Major=Runbook 示例 XDG_RUNTIME_DIR 值错误)→修复→**PASS** + 整包终裁 **PASS(0 Major,Minor-1~3 已消化)**;冷启动挑战通过/注入探针 25 项+12 场景亲测/文档矩阵抽查属实/压缩不丢事实 8 项抽查/硬禁令 9 条全过;报告 p0-mvp/safety-authority-06/REPORT-RELAY-SAFETY-AUTHORITY-06.md。**A 项准入判据(修复后语义)**:process_vs_head=PASS 仅当全部目标服务与 HEAD 时间可靠读取且真实晚于 HEAD(同秒歧义归旧代码);服务探针异常="无法查询" fail-closed,不虚构"未运行",git 探针失败不假 clean;parseSystemdSinceIso 剥时区缩写本机时区解析(与 05 版 GNU date 结果逐字节一致)。**生产影响=零**(零 src 改动/零生产写入/零重启;生产预检仍 NO-GO:迁移缺 0008+0009+检查未配置+旧进程+egress 不在,处置全在 Runbook);quality:full/release 本地 NOT_RUN(防 teardownEgress 拆生产 egress 共享栈)由隔离 CI 43553382081 双绿覆盖。
- 当前无新 ACTIVE 授权;Writer 已释放;下一窗口从 live main 冷启动。

## 关键未解决风险与决策（当前事实；接手必读）

- **生产 NO-GO（2026-11-14 只读预检实测；处置路径全在 deploy/README-deploy.md Runbook）**：①迁移缺 0008（goal_messages.execution_request）+0009（tasks.abort_requested_at），重启后新代码依赖，补齐写生产 schema 须用户 D3；②`RELAY_EVIDENCE_CHECKS_JSON` 未配置 ⇒ Gate 对代码变更候选保守停机（fail-closed 安全、自动放行不可用），配置或接受保守停机=用户 D3；③线上进程为旧代码（2026-11-13 02:00:08 启动，早于其后全部提交），新语义以重启为界；④出口约束栈不在（07 之前测试套件 teardownEgress 无所有权校验拆除共享栈——**该根因已由 RELAY-EGRESS-ISOLATION-07 消除**：测试走独立命名空间、teardown 只删本执行者持有资源），worker 降级，重启后首拍 ensureEgress 自愈、须核对 egress ready 横幅；如遇匿名同名资源被拒，须人工核验归属后 D3 处置（Runbook §0 归属块）。**生产切换（迁移/配置/重启）全部须用户单独 D3 授权。**
- **验收分层（不得混谈）**：MVP 工程=REWORK 维持（ADR-0010，矩阵 `p0-mvp/final-coverage-matrix.md`）；用户 Mac 实机 UX 验收与手机 VPN 验收=未开始（WEB-UX-02/03 系已 Engineering PASS+Reviewer PASS，Agent 不代宣布 UX ACCEPTED）；24h 运维连续性=R-3 PARTIAL 定格、R-3B 暂缓并入 PILOT-24H；真实模型能力对照（R-2）=PARTIAL 双败+归因，工程根因（maxTokens 8192 截断）已由 ADR-0011 修复，能力结论 UNRESOLVED 待上游稳定窗口+新授权。
- **登记未实施（指针）**：M-4 完整 handback / STOPPED 交付工具化恢复 / ControlCommand 审计结构化收敛（CONTROL-SAFETY-04 §登记）；迁移自动化（DEPLOY-03D）；Minor-PF-1~5（05 报告 §9）；R2-1~4（04A-R2 报告）；质量差距 8 项（p0-mvp/quality-local-01/GAP-REGISTER.md）；AUTOLOOP P1-1/P1-2/P1-3（docs/AGENT_AUTOLOOP_REFERENCE.md）；四项目 POC 候选池（P0_P1_ROADMAP.md「POC 候选池」）。
- MODEL-POLICY-01、REAL-PILOT、R-3B 门均未激活，不得自行启动。

## 历史包索引（2026-11-09~11-14；合同原文与完整证据以 Git 历史及所列报告为准，历史行不作执行授权）

| 包 | 日期 | 裁决/状态 | 关键 SHA | 报告/记录 |
| --- | --- | --- | --- | --- |
| P0-00..P0-02C、P0-ACCEPT | 11-09~11 | ✅ 完成 | — | `p0-00/`..`p0-accept/` |
| 总授权执行包六阶段+收口包 | 11-11 | ✅ | — | `p0-mvp/REPORT-final.md`、`final-coverage-matrix.md` |
| R-1 闭环解除 | 11-12 | ✅ US-08/G6 VERIFIED | — | `p0-mvp/r1-closure.md` |
| R-2 模型对照 | 11-12 | PARTIAL 双败+归因（F2 预算止损/F1 截断） | — | `p0-mvp/r2-contrast/REPORT-r2-contrast.md` |
| R-3 24h 终验 | 11-12 | PARTIAL 定格（缝 365s 保留） | — | `p0-mvp/r3-final-closeout.md` |
| OPERATOR-CONSOLE-00 | 11-12 | ✅ P0-UI-1~6 | 2265e9b→108a4fd | `p0-mvp/REVIEW-operator-console-00.md` |
| MODEL-POLICY-00 | 11-12 | ✅ 设计冻结（实现 OPEN） | 254ec5b→5fb4766 | `docs/MODEL_POLICY.md`、`ADR/0009` |
| 可用 MVP 最终收口大包 | 11-12 | 口径裁决=ADR-0010；阶段A/B ✅ | 693ef55→4332459 | `ADR/0010` |
| WEB-UX-01 | 11-12 | ✅ Engineering PASS / UX=REWORK；VM80 部署完成 | 62b4d54→61c2069 | `p0-mvp/REVIEW-webux-01.md` |
| WEB-UX-02 | 11-12 | ENGINEERING-READY（用户实机验收唯一剩余门） | 43c4a24→dc8cb25 | `p0-mvp/REVIEW-webux-02.md` |
| WEB-UX-03 A/B/B.1/C/C.1 | 11-12 | ✅（03A 复核 PF；03C.1 PASS） | 9bc80af→44224df | `docs/WEB_UX_03_*.md`、`p0-mvp/REVIEW-webux-03*.md` |
| WEB-UX-03D | 11-13 | ✅ Reviewer PASS（八问 8/8） | c97e9c4→2f82f15 | `p0-mvp/REVIEW-webux-03d.md` |
| 下一阶段完整执行大包 | 11-13 | ✅（DEPLOY-03D/R2-REMEDIATION-01/AUTOLOOP/验收说明） | 34e6d74→8fe0f7f | `p0-mvp/DEPLOY-03D-report.md` 等 |
| RELAY-MVP-READINESS-01 | 11-13 | ✅ 收口（F1/F2 真实对照=UNRESOLVED 如实） | 9b05cfb | `p0-mvp/readiness-01/REPORT-READINESS-01.md` |
| RELAY-ARCH-FREEZE-01 | 11-13 | ✅ 独立审计 PASS（A6 REWORK=实现缺口非设计缺陷） | 7251ecb→dcb26cd | git 历史+`docs/CONTINUATION.md` 历史节 |
| RELAY-QUALITY-LOCAL-01 | 11-13 | ✅ REWORK(M-1)→PASS | 2b57f04→de3ba22 | `p0-mvp/quality-local-01/` |
| RELAY-SAFETY-CLOSE-02 | 11-13 | ✅ PASS（0 Major 7 Minor） | 3033c14→b7fe040 | `p0-mvp/safety-close-02/` |
| RELAY-CONTROL-READY-03 | 11-13 | ✅ 两轮 REWORK→PASS | bf68a65→7ede3b4 | `p0-mvp/control-ready-03/` |
| RELAY-CONTROL-SAFETY-04 | 11-14 | ✅ 两轮 REWORK→PASS | 9feeb3d→0a1a7e1 | `p0-mvp/control-safety-04/` |
| RELAY-GATE-INTEGRITY-04A | 11-14 | ✅ PASS（0 Major 5 Minor） | 2648577→2b4c499 | `p0-mvp/gate-integrity-04a/REPORT-GATE-INTEGRITY-04A.md` |
| RELAY-GATE-INTEGRITY-04A-R2 | 11-14 | ✅ PASS（0 Major 4 Minor） | 96db097→2c6516a | `p0-mvp/gate-integrity-04a/REPORT-GATE-INTEGRITY-04A-R2.md` |
| RELAY-DEPLOY-PREFLIGHT-05 | 11-14 | ✅ 两轮 REWORK→PASS；生产实测 NO-GO 如实 | b3d1e5e→a12a5a7 | `p0-mvp/deploy-preflight-05/REPORT-RELAY-DEPLOY-PREFLIGHT-05.md` |
| RELAY-EGRESS-ISOLATION-07 | 11-14 | ⚠️ Agent PASS；协调方 REWORK（跨作用域链名碰撞 Major） | 5cca5a8→a88b0f4 | `p0-mvp/egress-isolation-07/REPORT-RELAY-EGRESS-ISOLATION-07.md` |

## 治理纪律（总包，不变）

main-only；单 Writer；每包 ACTIVE 合同先于实现提交；每包独立测试/复核/CI/快进推送；Issues 只管任务不作调度器；外部副作用结果不明先 Reconcile（两阶段意图日志 `src/core/intents.ts`）；不能借测试或修复清理其他项目目录；一包被阻断则记录原因推进其余；Runtime≠Model；生产凭据零打印；网络失败优先 VM80 代理 127.0.0.1:8118。

## 基线终账（不变）

MVP=REWORK 维持(矩阵权威 `p0-mvp/final-coverage-matrix.md`;**验收口径已调整:连续 24h 不再是 MVP 硬阻断,重定位 Operational/Pilot Readiness Gate,裁决记录 ADR-0010——最终裁决包按新必需项清单重生成矩阵,历史行不回改**);R-1 已解除 VERIFIED;R-2 PARTIAL(2026-11-12 双败+归因:zcode/GLM-5.3 对照完成,F2 预算止损/F1 沙箱 maxTokens 8192 截断零编辑,报告 p0-mvp/r2-contrast/REPORT-r2-contrast.md;工程修复=ADR-0011 maxOutputTokens,能力结论 UNRESOLVED);R-3 **PARTIAL 定格**(2026-11-12 17:35 终验完成:86432s+缝 365s+PG 异常 2,证据冻结入库,收尾报告 p0-mvp/r3-final-closeout.md;按 ADR-0010 不再阻断 Usable MVP)。
