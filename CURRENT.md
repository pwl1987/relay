# Relay 当前执行契约

- **RELAY-EGRESS-ISOLATION-07 🔵 ACTIVE（2026-11-14；运行时出口栈资源归属与测试隔离）**
  - **最低祖先/验收前置**：`531cf46d07a603315e28402525e44a389ec31425`。协调方独立复核 RELAY-SAFETY-AUTHORITY-06 **PASS**：对照 a142935→531cf46 共 3 提交、34 文件及 live 代码，exact-head CI **43553709093@531cf46** test/e2e 双 job success；VM80 复跑 22/22 定向测试、无 user bus/显式 user bus 两环境真实只读预检，均符合 fail-closed；7 份关键文档入口的相对链接扫描无失效。06 的 DOC/Runtime 矫正已验收，**生产仍 NO-GO**（迁移 0008+0009 缺、功能检查未配置、旧进程、egress 栈缺失）；不等于用户 Mac UX/整体 MVP/生产部署通过。
  - **唯一结果**：**使测试环境与 Relay 在用的模型出口约束栈彼此隔离，证明无人值守时多入口并发调用/重复初始化/清理不会误删或重建不属于本执行者的资源**，并保留原有沙箱网络禁止外联、密钥隔离、请求计数和 fail-closed 语义。消除目前“不能在 VM80 安全执行可能调用 `teardownEgress` 的 full 测试”之根因；不得因此偷换为生产发布或新功能平台化。
  - **A 冷启动和只读归属盘点**：核对 live main/AGENTS/CURRENT/ADR-0005/安全与运维、Writer/本地 worktree 的两项受保护未跟踪目录 `config/`、`p0-mvp/soak-r3b/`；检查 `src/runtime/egress.ts` 中固定 `relay-egress-net`/`relay-egress-fwd`/`RELAY-EGRESS`/端口 13425/13426、iptables DOCKER-USER/INPUT 标记及 `ensureEgress` 每次 `docker rm -f` 重建代理；逐一穷尽 `src/{cli,server,worker-entry}` 和 test/integration 的 `ensureEgress/teardownEgress` 调用，区分默认生产路径、明确测试授权路径和模型实测 gated 路径。真实 VM80 资源只用 `docker inspect/ps/network inspect`、`sudo -n iptables -S` 等**只读**观察，禁止测试启动/关闭/清理在用默认出口资源。记录最小威胁矩阵：进程并发 ensure、读模型请求期间 ensure、测试 teardown、同名第三方容器、网络/链缺失或半残、重启后恢复、权限/环境变量继承、清理重复触发。
  - **B 反例先红**：针对当前源码建立隔离的**命令注入/模拟执行器**或完全独立的 Docker 宿主测试，对 `ensureEgress` 每次无条件删除同名代理、`teardownEgress` 无所有权校验删除共享网络/iptables/代理和仅改 `RELAY_EGRESS_NETWORK` 仍撞固定资源给出可复现缺陷证据。禁止在运行生产 worker 的 VM80 直接验证破坏性反例；测试运行必须具备无付费模型/无真凭据/独立临时目录、身份与退出后清理保证。若无法造出安全隔离宿主，红态只做命令模拟+CI 隔离 Docker，不允许在 VM80 实际变更 iptables/生产默认容器。
  - **C 最小实现**：保持原生产出口默认名称/端口/现有安全边界不变，修改仅必需的 `src/runtime/egress.ts`、调用方与测试；让测试使用**完整独立命名空间**（网络名、代理容器名、iptables 链/跳转标记、监听/计数端口等所有会冲突资源，不只是 network 环境变量），显式归属标签/owner token，在创建前校验所有权，teardown 仅限本次创建且当前仍持有的资源；遇到未知/已占用/标签不匹配必须拒绝，不得覆盖或删除。生产 `ensureEgress` 对已健康、配置相同的代理**不得无谓 rm/recreate**；多入口并发确保互斥或安全收敛，不得切断其他在途 Run；配置不符及半残必须有有界、可解释、fail-closed 的恢复/拒绝路径，不假称 READY。优先最小改动与模块内复用，不新增独立 Daemon/DB/调度器/不采用全局高权限默认操作。**不能证明跨进程安全时应保守阻断而非假装已实现全局锁。**
  - **D 回归验收**：须具有“旧版本红、新版本绿”的相同反例：未经授权的测试 teardown 不能删生产默认资源；仅提供独立 network 名仍不能取得默认代理/iptables；owner 不匹配/旧 token/清理重复触发不删他人资源；并发 ensure 在健康复用时不杀现有代理、请求不中断；配置冲突 fail-closed；模拟故障/半残有审计或明确阻断；现有安全约束（默认 deny 出网、loopback 代理可达、Key 不进入容器/env/inspect/argv、日志零真实密钥、真实费用零）不得退化。对**隔离 CI 或专用测试容器环境**实跑至少一次创建→模拟并发→核验→清理的 E2E；CI 与生产资源完全隔离。仅在归属保护被独立 Reviewer 认可后才可决定是否在 VM80 本地运行 full；否则本地 `full/release=NOT_RUN`、CI 隔离验证。测试须检测错误清理与匿名资源接管，不允许只断言 happy path。执行 `quality:quick`、定向 test、exact-result-head GitHub CI test/e2e；真实模型/外部远程写入严格 NOT_RUN。
  - **E 独立复核与交付**：独立 Reviewer 新上下文检查命令执行边界、网络拓扑/所有权、恶意/竞争反例、失败清理、PI/CLI/Web/Worker 原有调用兼容、测试是否会拆共享链；必要时两轮有界修复。更新必要的 `docs/SECURITY_MODEL.md`、`docs/OPERATIONS.md`、`deploy/README-deploy.md` 和对应测试说明（避免新增重复架构文件），保留用户 D3 部署门、把未验证和残余风险写明。中文 REPORT/REVIEW+红绿及隔离证据→main-only 快进提交→核 exact-head CI→CURRENT/CONTINUATION 收口→Writer 释放。若方案必须直接修改宿主全局 iptables 但无法安全隔离，**BLOCKED 并提供更小替代方案，绝不冒险跑破坏性测试**。
  - **硬边界**：单人/唯一 Writer/main-only/禁强推；不得读取或输出真凭据、调用付费模型/外部部署、改生产 `relay_console` 或执行迁移 0008/0009、改真实 env/凭据、restart/stop/reload 在用服务、清理/重建在用 `relay-egress-net`/`relay-egress-fwd`/RELAY-EGRESS 或现有防火墙、触碰 `config/`/`p0-mvp/soak-r3b/`、创建第二 Workflow/Gate/状态系统，禁止把测试隔离成功当作生产可切换。生产 D3 授权尚未授予。所有实现与安全执行由本地 Agent 在受控范围自主处理。
  - **后续候选（本包不做）**：隔离迁移 0008/0009 的可复现增量迁移与恢复预演、功能性检查生产配置方案、Mac UX 用户实机验收、真实单项目 Pilot；是否生产部署由用户单独明确 D3 决策。

- **RELAY-SAFETY-AUTHORITY-06 ✅ 收口(2026-11-14)**:提交链 a142935(用户合同登记,含四项目研究登记 docs/EXTERNAL_PATTERN_COMPARISON_20261114.md)→ 3a4266e(实施:A 预检误判红绿修复+B 全仓 31 文档审计纠偏+C 四项目裁决登记+D CURRENT/CONTINUATION 压缩,32 文件 +805/-356,零 src/ 改动)→ 801bae9(独立 Reviewer 两阶段终裁入库+最终报告)→ 收口;exact-head CI **43553382081@801bae9 双 job success**(test+e2e,gh run view 亲测)。独立 Reviewer:A 项两轮 REWORK(1 Major=Runbook 示例 XDG_RUNTIME_DIR 值错误)→修复→**PASS** + 整包终裁 **PASS(0 Major,Minor-1~3 已消化)**;冷启动挑战通过/注入探针 25 项+12 场景亲测/文档矩阵抽查属实/压缩不丢事实 8 项抽查/硬禁令 9 条全过;报告 p0-mvp/safety-authority-06/REPORT-RELAY-SAFETY-AUTHORITY-06.md。**A 项准入判据(修复后语义)**:process_vs_head=PASS 仅当全部目标服务与 HEAD 时间可靠读取且真实晚于 HEAD(同秒歧义归旧代码);服务探针异常="无法查询" fail-closed,不虚构"未运行",git 探针失败不假 clean;parseSystemdSinceIso 剥时区缩写本机时区解析(与 05 版 GNU date 结果逐字节一致)。**生产影响=零**(零 src 改动/零生产写入/零重启;生产预检仍 NO-GO:迁移缺 0008+0009+检查未配置+旧进程+egress 不在,处置全在 Runbook);quality:full/release 本地 NOT_RUN(防 teardownEgress 拆生产 egress 共享栈)由隔离 CI 43553382081 双绿覆盖。
- **C 项四项目借鉴裁决已登记未实施**:NO-CHANGE(已有)×9(含研究清单漏列的 src/core/intents.ts 两阶段意图日志)/ADOPT_METHOD×2/POC×6(候选池=P0_P1_ROADMAP.md,立包须 ACTIVE 合同)/DEFER×4/REJECT×1(第二控制面/高权限 Shell 维持);零移植零新依赖。
- 当前无新 ACTIVE 授权;Writer 已释放;下一窗口从 live main 冷启动。

## 关键未解决风险与决策（当前事实；接手必读）

- **生产 NO-GO（2026-11-14 只读预检实测；处置路径全在 deploy/README-deploy.md Runbook）**：①迁移缺 0008（goal_messages.execution_request）+0009（tasks.abort_requested_at），重启后新代码依赖，补齐写生产 schema 须用户 D3；②`RELAY_EVIDENCE_CHECKS_JSON` 未配置 ⇒ Gate 对代码变更候选保守停机（fail-closed 安全、自动放行不可用），配置或接受保守停机=用户 D3；③线上进程为旧代码（2026-11-13 02:00:08 启动，早于其后全部提交），新语义以重启为界；④出口约束栈不在（测试套件 teardownEgress 拆除共享栈），worker 降级，重启后首拍 ensureEgress 自愈、须核对 egress ready 横幅。**生产切换（迁移/配置/重启）全部须用户单独 D3 授权。**
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

## 治理纪律（总包，不变）

main-only；单 Writer；每包 ACTIVE 合同先于实现提交；每包独立测试/复核/CI/快进推送；Issues 只管任务不作调度器；外部副作用结果不明先 Reconcile（两阶段意图日志 `src/core/intents.ts`）；不能借测试或修复清理其他项目目录；一包被阻断则记录原因推进其余；Runtime≠Model；生产凭据零打印；网络失败优先 VM80 代理 127.0.0.1:8118。

## 基线终账（不变）

MVP=REWORK 维持(矩阵权威 `p0-mvp/final-coverage-matrix.md`;**验收口径已调整:连续 24h 不再是 MVP 硬阻断,重定位 Operational/Pilot Readiness Gate,裁决记录 ADR-0010——最终裁决包按新必需项清单重生成矩阵,历史行不回改**);R-1 已解除 VERIFIED;R-2 PARTIAL(2026-11-12 双败+归因:zcode/GLM-5.3 对照完成,F2 预算止损/F1 沙箱 maxTokens 8192 截断零编辑,报告 p0-mvp/r2-contrast/REPORT-r2-contrast.md;工程修复=ADR-0011 maxOutputTokens,能力结论 UNRESOLVED);R-3 **PARTIAL 定格**(2026-11-12 17:35 终验完成:86432s+缝 365s+PG 异常 2,证据冻结入库,收尾报告 p0-mvp/r3-final-closeout.md;按 ADR-0010 不再阻断 Usable MVP)。
