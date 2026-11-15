# RELAY-CUTOVER-READINESS-10 执行报告(生产只读准入审计·隔离切换预演·D3 决策材料定稿)

> 合同:CURRENT.md「RELAY-CUTOVER-READINESS-10 🔵 ACTIVE」(登记于 581eee6;最低祖先 fbf32f0 满足)。
> 结论口径:**PRE-D3 READY(技术切换前 D3 准入材料已定稿并可提交用户审批;生产预检 NO-GO 仍成立;不构成生产 GO,不自动执行任何 D3 生产操作)**。

## 1. A 冷启动与现场核对

- **快进**:live main fbf32f0→**581eee6**(合同提交;推送前核对其 exact-head CI **43710863776 test+e2e 双 success**;`git merge --ff-only`,本地=origin=581eee6;工作区仅 7 项保护性未跟踪物)。
- **保护物核对(7 项,零触碰)**:`config/`(projects.json 162B)、`p0-mvp/soak-r3b/`(6 文件)、CI 回执 5 份(backup bacc849/fbf32f0、deploy 27e9259/c22d23f、egress e28c386)——存在性与 mtime 与合同登记一致,全程未读未写未纳提交(soak-r3b 按合同「不启动」)。
- **生产只读采样(合同授权面;`deploy/preflight.ts` 只读工具,带 systemd bus)**:裁决 **NO-GO**,与合同陈述逐项一致——`db_migrations=FAIL`(缺 0008/0009)、`evidence_checks_config=UNKNOWN`(未配置 ⇒ Gate 保守停机 fail-closed)、`process_vs_head=UNKNOWN`(线上旧代码)、`egress_stack=UNKNOWN`(网络+proxy 均缺席);PASS 面:`db_inflight`(BLOCKED=1 PAUSED=1,无阻断在途)、`web_bind`(仅 10.30.5.80:8787 单接口)、`db_schema_tables`(16 表)、`db_reachable`、`cred_perms`/`env_file`(0600,键名零取值输出)、docker/沙箱镜像。**生产服务 PID 3242781/3242782 未变**(2026-11-13 02:00:08 CST 启动,systemctl --user 只读核对)。文本+JSON 双证据入库 `evidence/preflight-prod-20261115-audit.{log,json}`。零凭据值/零原始业务行/零生产文件正文输出;CI 成功与生产真实服务运行两种证据不混谈(进程旧代码=如实 UNKNOWN)。

## 2. B 完整准入差距与文档协调

- **五文档交叉比对**:①`docs/DEPLOYMENT_PLAN.md`=FROZEN+实现注记指向 Runbook 为唯一事实文档,§4 候选路径标注设计稿,无矛盾;②ADR-0010 口径(24h 移 Pilot/MVP 必需项清单)与 `p0-mvp/final-coverage-matrix.md` 终判 **MVP=REWORK 维持** 一致,未被任何文档偷改;③`deploy/README-deploy.md` Runbook §0-§5 与 08/09/09R 后语义一致(§3 已含 09R 恢复语义;§1 基线为 11-14 历史记录如实标注);④`D3-DECISION-PACK.md` 顶部历史阻断顶注已由协调方在 581eee6 清除(「09 恢复绕过未修」不再构成当前阻断);⑤08/09/09R 报告与 CURRENT 收口行一致。**实质漂移=D3 材料本身**:§一生产事实停留在 11-14、缺合同 D 要求的精确对象/每步检查命令/回退基准/源可达性/reconcile 风险等要素 ⇒ 第 4 节定稿处置。
- **M5-1 判定(readInspectMapping 不拒 5432/tcp 外额外发布端口)=非阻断候选(对抗性加固,非误配置可达)**:身份绑定链为「RESTORE_URL 端口==恢复容器 5432/tcp 唯一 127.0.0.1 映射的 HostPort」(`deploy/restore-target-verify.mjs:124`)+「docker exec 进恢复容器内 pg_postmaster_start_time==RESTORE_URL 探针值」(`deploy/restore-verify.sh:91-94`)。DDL 经 docker exec 进入该容器执行,探针经该 5432 映射连接——**额外发布端口不参与两条链的任一环**,不存在「误配置额外端口 ⇒ DDL 打错实例」的可达形态;其加固价值仅在对抗性深度防御。维持 09R 登记,不实施(扩展克制)。
- **M5-2 判定(身份探针→DDL TOCTOU)=非阻断候选(信任模型边界,非误配置可达)**:2d 通过后到 DDL 之间若发生「同名容器替换」,需活跃攻击者在宿主持 docker 控制权做 rm+重建同名容器且保持同发布端口——**操作者信任模型内该主体本可直接对任意实例发 DDL**,非误配置可达形态;与 docker inspect 元数据自不可信的一般性对抗假设同层。维持 09R 登记,不实施;真实缓解=演练在受控窗口内一次完成(Runbook 执行序)。
- 两项判定与 09R Reviewer 登记口径一致;本包以绑定链代码事实+威胁模型完成合同 B 要求的「误配置可达性评估」,零代码改动、零无界重构。

## 3. C 模拟切换与断点验收(合同 C 逻辑序全链,全部真实工具×真实一次性 PG,零 mock 冒充)

新增 `test/integration/d10-cutover-simulation.test.ts`(**5/5**,9.5s;复用 08R `startEphemeralPg` 127.0.0.1 随机发布 helper + 08 `rehearse-migration` + 09 `backup.sh`/`restore-verify.sh` + 真实 `preflight.ts` 工具;不新增任何部署编排/第二控制面):

| # | 链节 | 关键断言 |
| --- | --- | --- |
| ① | 目标 schema 备份(09 语义) | 真跑 backup.sh(schema 唯一入口);manifest.targetSchema=目标;dump 恰 16 表(0007 形状)且**零**兄弟 schema/public 遗留混入;输出零密码(脱敏断言) |
| ② | 隔离恢复校验(09R 身份门) | 真跑 restore-verify.sh(源实例≠目标实例,身份证明通过);恢复库=备份时点 0007 形状(g8/g9=0/0)+中文行保真+零 decoy |
| ③ | 0008/0009 增量 | **切换前真实 preflight=db_migrations FAIL** → plan(真实迁移文件 SQL+回滚材料)→ apply 后验全绿(列定义/旧行回填 false/触发器/FK)→ 重入 skipped_already → **切换后真实 preflight=db_migrations PASS 且裁决≠GO**(evidence_checks/process_vs_head/egress 三项 UNKNOWN 如实呈现=迁移只清 FAIL 项) |
| ④ | 断点/回滚条件 | 同一备份二次隔离恢复(=Runbook「schema 回退统一走备份恢复」形态)→ fail-at 0009 注入 ⇒ 断点如实(0008 applied/0009 pending,不假 GO)→ 续跑完成;迁移后旧代码形态 INSERT 成功且默认 false(回退代码无需回滚 schema);备份校验和可重放 |
| ⑤ | Gate 配置通过/失败 | resolveEvidenceChecks 真校验:sample 合法通过;5 类非法变异 fail-closed;未配置=undefined(保守停机路径);docker 检查执行器真跑由既有 evidence-gate-rehearsal 3/3 承担(交叉引用不重复) |

- **SIMULATED/NOT_RUN 边界(合同 C 硬要求)**:全链为真实工具在真实一次性 PG 上执行,无「仅 mock」项;**生产切换本体(写 relay_console/重启服务/横幅核对/egress 自愈横幅)=NOT_RUN(硬边界禁止)**;preflight 其余检查项(svc/process_vs_head/egress/web_bind)反映宿主真实现状,不属模拟断言;隔离预演 PASS ≠ 生产 PASS。
- 复核面(合同 C):备份 schema 作用域(①)/恢复实际目标身份(②,09R 门真跑)/临界错误 stop gate(④ fail-at)/重入半迁移(③ skipped_already+④ 续跑)/日志脱敏(①② 零密码断言)——全部在链内真跑复核。
- **回归**:`evidence/green10-targeted-regression.log` **56/56**(10:5 + 08:13[9+1+3] + 09:5 + 09R:33[27 单测+6 集成]);`evidence/quality-quick-10.log` quality:quick **PASS**;tsc/biome 干净;一次性容器零残留(docker ps -a 复核)。

## 4. D D3 审批材料定稿(`p0-mvp/deploy-rehearsal-08/D3-DECISION-PACK.md` 原地定稿,唯一决策材料)

在 08 版三选项骨架上按合同 D 补齐并刷新(变更 +43/-37):
- 顶部定稿口径:材料发布≠选 A≠自动授权;**Agent 永不凭自述宣布生产成功**(成败=各步检查命令实测输出)。
- §一生产现状刷新为 2026-11-15 实测(本包 A 项证据)。
- §二预演结论=本包 C 全链 5/5+验收分层(24h Pilot/Mac UX/真模型=ADR-0010 验收层,**非生产 D3 前置门**)。
- §三选项 A 补齐:精确受影响对象/权限(relay_console 两列 ALTER+env+两 user 服务;零其他面)、七步执行序表(每步最小检查命令/预期返回/失败停止)、最小维护窗口建议、备份源可达性=演练语义(源停机灾备=人工流程另行留证)、外部 GitHub reconcile 风险(delivered_remote_head 不在备份范围;禁无证据 reset)、回滚基准=`git checkout <上一 exact-head 双绿 SHA>`(当前 581eee6@43710863776)+回退代码无需回滚 schema+schema 回退统一走备份恢复(禁 DROP COLUMN)。
- §四/§五:PRE-D3 READY 边界+首日监测清单。

## 5. 独立 Reviewer(合同 E;原文=`REVIEW-RELAY-CUTOVER-READINESS-10.md`)

独立 Reviewer 隔离冷启动,对执行方自述零采信、实质主张全部亲跑亲证。**终裁:PASS(0 Major,1 Minor 登记)**:
- 冷启动一致(HEAD=origin=581eee6;工作区与本包产物/7 项保护物 mtime 早于工作窗逐项相符);生产 PID 3242781/3242782 亲核未变;
- **生产只读事实独立复现**:Reviewer 独立重跑 preflight(先审读全部查询形态确认纯 SELECT/information_schema 后执行)⇒ NO-GO 四项与执行方证据**逐字一致**;零凭据值输出亲证;
- 套件独立真跑:d10 **5/5**(9.49s)+ 既有负向面抽查 **39/39**(deploy-rehearsal+evidence-gate+d09r 单测)零退化;容器零残留;
- **M5-1/M5-2 判定双重证实**:代码链引用逐行核对属实之外,Reviewer **自建动态探针**(一次性双容器,恢复容器额外发布 9999/tcp→32900)⇒ 身份门 PASS 且正确绑定 5432 映射(32899)——「额外端口不参与任一链环、非可达绕过」成立;M5-2 窗口形态与登记一致,维持非阻断;探针容器用后即毁零残留;
- D3 材料逐条对照代码事实:backup.sh/restore-verify.sh/rehearse-migration(apply 对 relay_console 任何连接前拒绝)/preflight 三态/横幅四要素(worker-entry.ts:120/139、goal-loop.ts:413 实存)全部一致;合同 D 十二项要素齐备;CI 43710863776@581eee6 双 success 经 gh 独立核验;「两列旧代码不读」亲证成立(两列于 079b97d 11-13 20:17 加入,晚于生产进程启动);
- 边界卫生:d10 零 mock(grep 零命中)、零第二控制面、清理链完整、模型面零真实请求;SIMULATED/NOT_RUN 与验收分层标注如实;生产 NO-GO 口径全程保持;
- **Minor-M1(已消化)**:D3 选项 A 步骤 4 的 plan 命令未注明连接目标语义(RELAY_DB_URL 或缺省 127.0.0.1:55433/relayp000)——信息性、无可达危害(plan 纯只读+输出脱敏自证),已括注精确化。

## 6. CI 时序(exact-head 如实)

- 基线回执:581eee6(合同提交)Actions **43710863776** test+e2e 双 success(GitHub check-runs API 亲核;执行方与独立 Reviewer 各自核验一致)。
- **实施提交 2fb8a78 exact-head Actions 43719135177 test+e2e 双 success**(13:27:59Z→13:32:17Z,无失败 run;GitHub check-runs API 亲核)。09/09R/10 套件 CI 真跑(宿主分支,runner 自带 psql/pg_dump):**d10 切换模拟全链 5/5(6.7s)**、d09 集成 5/5(12.7s)、d09r 集成 6/6(5.5s)、d09r 单测 27/27、09 单测 15/15、deploy-rehearsal 9/9、08 E2E 1/1、Gate 3/3;全量 **75 passed | 14 skipped(89 文件)**(`evidence/ci-testjob-2fb8a78-d10-excerpt.log`)。**CI 宿主分支真值层真杀实证持续在位**:runner 日志含 `[restore-target] fail-closed:源实例与恢复目标为同一物理实例(postmaster 启动时刻与端口相同…);同实例别名/同集群已识别,拒绝恢复`——09R 身份门在 CI host 分支真跑拒绝同实例误指,d10 模拟链的 09R 门在同一环境真跑通过。
- 收口提交(本报告 §6 回填+CURRENT/CONTINUATION)自身 CI 于推送后核验,回执留未跟踪(循 bacc849/fbf32f0 例)。

## 7. 生产影响与边界

生产影响=**零**:生产面只读操作仅 preflight 采样(information_schema+聚合计数,零原始数据;零凭据值输出)与 systemctl 只读核对;零生产写入/零迁移/零重启/零配置变更/零 egress·防火墙·TLS 触碰/零模型请求/零真实 GitHub 业务交付。全部真实读写=一次性容器+合成数据(用后即毁,零残留)。本包结论仅为「D3 准入材料是否可提交用户审批」;**生产切换须用户按 D3 材料明确批准后才可执行;本报告与 Reviewer PASS 不构成生产许可、不冒充 Mac UX/真模型/24h 验收**。

## 8. 如实 NOT_RUN

- quality:full/release 本地未跑(由隔离 CI test job 全量覆盖,推送后以 exact-head 为权威);
- 生产备份/恢复真实演练:禁止(硬边界;切换窗口须按 D3 材料步骤 1/2 与 Runbook §3 执行并留证);
- 真实模型/外部交付/Pilot-24H/Mac 实机 UX:未授权,NOT_RUN;
- 生产切换本体(迁移/重启/横幅):NOT_RUN(等待用户 D3)。
