# Relay 当前执行契约

- **RELAY-DEPLOY-REHEARSAL-08 ✅ 收口(2026-11-14;隔离增量迁移演练与 D3 决策预演,零生产写入)**:提交链 241893d(用户合同登记,含协调方 07R 独立审计 PASS)→ **071210e**(实施:①A 差距审计=init-schema 见 goals 即跳过/applyMigrations 全量重放撞表/0008·0009 裸重跑撞列 ⇒ 增量升级无安全入口+backup.sh 审计索引硬编码 relay-p000-pg 未按 schema 限定(**F-1 登记**);②B 反例先红(隔离测试 PG p01a_*):init-schema 跳过实证/全量重放撞表/裸重跑撞列(真实既有代码)+工具缺失套件全红;③C **deploy/rehearse-migration.ts**(503 行)=plan 只读(information_schema+聚合,生产 relay_console 只读输出拟执行 SQL/前置后置/回滚材料)+apply 硬守卫(保留 schema/非 p01a_/非回环/未显式端口在**任何连接前**拒绝,7 类目标 exit=2+差分实证拒绝先于连接)+逐步事务 search_path 钉死+标记检测跳过(重复不盲撞)+fail-at 注入真实半迁移(断点定位可续跑不假 GO)+后验(列定义/旧行回填 false/append-only 触发器/FK=3);④D 真实演练=单测 9/9+隔离 E2E 1/1(一次性 postgres:17-alpine 容器:backup.sh 同命令形态 pg_dump+真实 backup-manifest.mjs→真实迁移→代码回退兼容 INSERT[旧行为默认 false]→真实 restore-verify-check.mjs 交叉核对一致→回退边界断言[恢复库 g8/g9=0/0+合成行中文保真])+Gate 真实 docker 演练 3/3(sample.json 真实 resolveEvidenceChecks 合法+5 类非法拒绝/真实 dockerCheckRunner UID=10001+network=none/orchestrator 三场景 未配置⇒NEEDS_DECISION·真实通过⇒ACCEPTED·检查失败⇒保守阻断,零 stub 冒充);13/13+quality:quick PASS+tsc/biome 干净+调用方回归 39/39+CI 就绪门修正(SELECT 1 重试 90s 替代 pg_isready 早通,CI 实测教训 §6⑥);⑤E **D3 决策材料**=p0-mvp/deploy-rehearsal-08/D3-DECISION-PACK.md(一页式三选项 A 批准切换窗口/B 保持旧进程保守停机/C 暂缓补验+各风险/门槛/回滚+边界标注[隔离 PASS≠生产验证≠Mac UX≠模型/24h];**绝不自动选择/执行**)+生产只读计划入库;⑥独立 Reviewer 隔离冷启动**两轮复核:Round1 REWORK(2 Major 均证据簿记[--out 仅 json 分支生效致证据悬空/RED-d 日志残缺],实质面全部亲证:守卫矩阵+6 自建探针 schema 迁移语义+13/13+19/19+quick)→修复(writeOut 双态落盘+证据真实生成[Reviewer 独立重跑逐字段相等]+红态如实重取+措辞/数字更正)→**Round2 PASS(0 Major,R2-Minor-1 已消化)**;报告 p0-mvp/deploy-rehearsal-08/REPORT-RELAY-DEPLOY-REHEARSAL-08.md。exact-head CI **43608637410@16fb5e2 双 job success**(test+e2e 亲测;CI 上 08 三套件真跑 9/9+1/1[一次性容器 7.6s]+3/3,full 总裁决 PASS,evidence/ci-* 入库)。**生产影响=零**(relay_console 迁移标记 0/0 前后一致、服务 PID 3242781/3242782 未变、preflight/src/migrations 零 diff、保护面零触碰);**生产预检仍 NO-GO,生产切换三选项材料已备,须用户单独 D3 才生效;本包不构成任何 GO 提升**;F-1(backup.sh 审计索引)登记未改。当前无新 ACTIVE 授权,Writer 已释放。

- **RELAY-EGRESS-ISOLATION-07R ✅ 收口(2026-11-14;07 REWORK 最小纠偏)**:提交链 b3dea03(用户合同登记,含协调方审计 COORDINATOR-REVIEW-20261114.md[Major-1=链名前 8 字符截断碰撞])→ 6749ed3a(实施:R1-R6 反例先红[6/6 红]+chainNameFor 全量 id hash 派生+链归属门 chainScopeOwned[任何 -F/-A/-X 前置:空链=归属不可证拒绝/他作用域规则拒绝]+chainRulesStrict 严格读取[-S 失败 fail-closed;真实 -S 含 -N 声明行须剔除]+空链 3s 有界宽限+teardown 链删除门;Round2 追加 lineHasTag 词边界精确匹配替换 7 处裸 includes[Reviewer 自建真实 hash8 碰撞对 frntla/frntla-M 同链且短 tag⊂长 tag 真机复现子串穿透]+ensureEgress 重排拒绝路径零副作用;12 文件 +1243/-39)→ 收口;exact-head CI **43592822713@6749ed3a 双 job success**(test+e2e 亲测;CI 上隔离 E2E 真跑 11/11=25.9s 含 07R 双 scope/强制碰撞用例)。独立 Reviewer 隔离冷启动**两轮复核**:Round1 REWORK(协调方 Major-1 修复确认,新发现子串穿透 1 Major+Minor-1~3)→修复→**Round2 PASS(0 Major,探针 30/30 真机双方向实测;Minor-3/4/5 登记,5 已消化)**;R9/R10 先红后绿核实;硬禁令逐条全过;报告 p0-mvp/egress-isolation-07/REPORT-RELAY-EGRESS-ISOLATION-07R.md。**核心纠偏成果**:不同合法 EgressScope 不得共享/误清同一条 iptables 链——链名全量派生(前缀截断碰撞消除)+词边界精确归属门(摘要碰撞/子串穿透一律拒绝,第一方完全不变)+teardown 注册表身份边界;默认域链名/生产名/端口/FAIL-CLOSED/健康复用不退化;07 的既有测试全部保持通过。**生产影响=零,生产预检仍 NO-GO**(处置全在 Runbook),生产切换须用户单独 D3 授权。quality:full/release 本地 NOT_RUN 由隔离 CI 43592822713 双绿覆盖。

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
| RELAY-EGRESS-ISOLATION-07R | 11-14 | ✅ 两轮复核 PASS（0 Major；纠偏 07 链名碰撞+子串穿透） | b3dea03→6749ed3a | `p0-mvp/egress-isolation-07/REPORT-RELAY-EGRESS-ISOLATION-07R.md` |

## 治理纪律（总包，不变）

main-only；单 Writer；每包 ACTIVE 合同先于实现提交；每包独立测试/复核/CI/快进推送；Issues 只管任务不作调度器；外部副作用结果不明先 Reconcile（两阶段意图日志 `src/core/intents.ts`）；不能借测试或修复清理其他项目目录；一包被阻断则记录原因推进其余；Runtime≠Model；生产凭据零打印；网络失败优先 VM80 代理 127.0.0.1:8118。

## 基线终账（不变）

MVP=REWORK 维持(矩阵权威 `p0-mvp/final-coverage-matrix.md`;**验收口径已调整:连续 24h 不再是 MVP 硬阻断,重定位 Operational/Pilot Readiness Gate,裁决记录 ADR-0010——最终裁决包按新必需项清单重生成矩阵,历史行不回改**);R-1 已解除 VERIFIED;R-2 PARTIAL(2026-11-12 双败+归因:zcode/GLM-5.3 对照完成,F2 预算止损/F1 沙箱 maxTokens 8192 截断零编辑,报告 p0-mvp/r2-contrast/REPORT-r2-contrast.md;工程修复=ADR-0011 maxOutputTokens,能力结论 UNRESOLVED);R-3 **PARTIAL 定格**(2026-11-12 17:35 终验完成:86432s+缝 365s+PG 异常 2,证据冻结入库,收尾报告 p0-mvp/r3-final-closeout.md;按 ADR-0010 不再阻断 Usable MVP)。
