# Relay 当前执行契约

- **RELAY-SAFETY-AUTHORITY-06 🔵 ACTIVE（2026-11-14；05 独立 REWORK 纠偏 + 四项目借鉴与文档更新）**
  - **证据和裁决**：最低祖先 a12a5a77ed61391d03275c0bdec1a1b42a524185。协调方核实 RELAY-DEPLOY-PREFLIGHT-05 的 3 提交/10 文件、exact-head CI 43540478413@a12a5a7 test/e2e 双绿、VM80 独立定向复测 **12/12 PASS**（backup-restore 独立运行另有 SKIP，不当 PASS）；真实生产只读预检仍 **NO-GO**。**新增 Major 反例**：在 VM80 命令会话不具备 systemd user bus（无 XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS）时，两个实际运行的服务被 preflight 误报 FAIL，`process_vs_head` 同时误报 **PASS（声称新代码生效）**。`ss/ps` 证实真实进程存在；显式提供正确 user bus 后两个服务 active，process_vs_head=UNKNOWN（旧进程）。代码根因是 `deploy/preflight.ts` 把无可解析时间的空 stale 集合当作 PASS；另需防止 git status 探针失败假 clean。**05 工程成果/CI 已证实，但准入判断语义有缺陷 ⇒ 协调方 REWORK；不得将本地 Reviewer 的 PASS 等同独立验收。**
  - **唯一目标/顺序**：A 修复预检错误事实判定并真实红→绿；B 全仓权威文档及代码事实审计；C 四项目技术借鉴集成到原有架构/产品/安全/路线图；D 语义纠偏与文档压缩；E Reviewer、测试、GitHub CI 收口。一包可自主顺序完成，但 A 未通过独立检查不得展开大规模文档改写。**只授权 deploy 预检修复、测试和中文文档，不批准生产变更或借鉴项目功能编码。**
  - **A 预检安全修复**：冷启动 live main、AGENTS/CURRENT、05 REPORT/REVIEW/Runbook，核单 Writer、仅 main、保护未跟踪 `config/` 和 `p0-mvp/soak-r3b/`。反例先红：systemctl user bus 不可达、两个 active 但 sinceIso 缺失/非法、任意目标服务缺失/不活跃、git status 或 HEAD 时间读取失败、进程确实早/晚于 HEAD、CST 跨时区对照。**要输出 process_vs_head=PASS，所有目标服务及 HEAD 时间都必须可靠读取且真实匹配；缺任何条件不得 PASS**；服务探针异常应标明“无法查询”而非虚构“未运行”；整体 GO 必须 fail-closed。修 `deploy/preflight.ts`、定向测试/Runbook，必要调整仅本区域；对 VM80 无 user bus 与显式 user bus 两环境做真实只读对照。
  - **B 权威文档审计**：盘点根 README、AGENTS、ARCHITECTURE_BASELINE、CONTRACTS、DOMAIN_MODEL、P0_P1_ROADMAP、ADR 索引/决策、docs/{PRD,CONSTRUCTION_PLAN,DETAILED_ARCHITECTURE,SECURITY_MODEL,VALIDATION_PLAN,INTEGRATIONS,OPERATIONS,UI_UX,WEB_UX_03*,MODEL_POLICY*,DEPLOYMENT_PLAN,CONTINUATION}、deploy/README-deploy、CURRENT 与有依赖的 REPORT。按 KEEP/CORRECT/MERGE/REVALIDATE/RETAIN_EVIDENCE 逐文档输出矩阵，审代码/测试确认“已经实现 / 仅设计 / CI 测试 / 真实用户未验收 / 线上旧代码”的区别。先依赖（脚本/链接/历史语义）审核，禁止因文件大盲删/移动。
  - **C 四项目借鉴审查并入架构**：参考已登记的 `docs/EXTERNAL_PATTERN_COMPARISON_20261114.md` 和上游 SHA，逐项对照 Relay 已有代码，按 ADOPT_METHOD/POC/DEFER/REJECT 裁决：AgentRun 的副作用日志+崩溃切片、受控学习/Skill、预算 UNKNOWN、多 Runtime 合同；PINE 的事件订阅、去抖节流、来源可信度、按需手册、Pi SDK 基线；agentes.chat 的自治刹车、交接回执、审批卡、按需工具、MCP 调用身份、记忆来源；grokbot-clone 的活动流、查看/接管、简明工作台。已有就 NO-CHANGE；新功能仅在现有 ADR/Roadmap 留 POC 候选，**不实施**；不引入第二控制面、常驻服务、进程内队列、隐蔽学习真相源或提高 Shell 权限。注明 AGPL-3.0-only 附加 UI 署名、Apache/MIT、素材权利。
  - **D 文档实质梳理**：校正 README 的过时 OPEN、AGENTS“本轮仅设计文档”旧句、MVP 工程/用户 Mac UX/24h 运维验收差别、生产 NO-GO（0008/0009 迁移缺失、功能性 checks 未配置、旧进程、egress 不在）、用户 D3 决策、Runtime≠Model、main-only 单 Writer、权威与证据分层。对既有 Architecture/ADR/PRD/Roadmap/Security/Validation/UI/Deploy 只做真正需要的语义更新；`CURRENT.md` 和 `docs/CONTINUATION.md` 各近 70KB 且有过期 ACTIVE：在依赖审计后压缩为唯一当期任务、关键未解决风险、原始报告/commit 指针，历史以 Git 和已存在 Evidence 追溯；续接文件只做短导航。不要创建第二状态文件或无必要全仓物理改名。
  - **E 证明/交付**：反例红绿+两环境只读对照，文档全覆盖更新/未改理由矩阵、Markdown 链接与状态一致性、新 Agent 只读 README/AGENTS/CURRENT 的冷启动挑战；定向 PG/Docker 与 quality:quick，隔离的全量/CI；**VM80 存在真实生产 egress 共享栈，禁止盲跑可能调用 teardownEgress 的全量本地测试**，不能保证安全则 NOT_RUN 交由隔离 CI。独立 Reviewer 亲审代码、文档、证据与不变量，最多两轮修复；中文 REPORT/REVIEW、main-only 快进推送、核 exact-head CI 双 job、CURRENT/CONTINUATION 收口、Writer 释放。验收仅纠偏+文档，不是生产部署/真实模型/真实外部交付。
  - **硬禁令**：零生产迁移 0008/0009、零生产 DB/env/口令/配置写入、零服务 restart/stop/reload、零模型调用/生产 GitHub 写入、零网络/TLS/公网改造、零触碰 `config/`/`soak-r3b/`、零创建长期分支/强推、零改 Core 生命周期/Gate/Policy、零移植外部源码或运行外部服务。生产 **NO-GO** 仍须用户单独 D3 授权处置；Writer/权限/架构冲突停相关子项并报告，其它独立文档审计可继续。
  - **交接**：本地 Agent 安全快进 live GitHub main，读 AGENTS + CURRENT，执行唯一 ACTIVE 大包，测试、独立 Reviewer、入库证据并在 CI 真实完成后收口；完成仅向用户报告推送，协调方从 GitHub 重新复核。

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
