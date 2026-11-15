# RELAY-CUTOVER-READINESS-10 独立 Reviewer 复核(隔离冷启动)

- Reviewer:独立上下文冷启动,对执行方自述零采信,实质主张全部亲跑/亲证。
- 复核时间:2026-11-15 20:57~21:40 CST(全程)。
- 复核对象:live main 581eee6 源码、`p0-mvp/cutover-readiness-10/REPORT-RELAY-CUTOVER-READINESS-10.md`(§5/§6 占位除外)、`p0-mvp/deploy-rehearsal-08/D3-DECISION-PACK.md`(本包定稿版,未提交工作区修改)、`test/integration/d10-cutover-simulation.test.ts`。

## 一、冷启动记录

| 项 | 结果 | 证据 |
| --- | --- | --- |
| HEAD | `581eee60c7a388d3d44b16b603e071a2d7290fe9`(=origin/main,无分叉) | `git log --oneline -3`:581eee6→fbf32f0→271f2f9;`git rev-parse HEAD` |
| 最低祖先 | fbf32f0 在 HEAD 祖先链上 | 同上 |
| 工作区 | 与登记一致:`M p0-mvp/deploy-rehearsal-08/D3-DECISION-PACK.md`(本包 D 项定稿,`git diff --stat`=+43/-37 与 REPORT §4 声称一致)+ 未跟踪 `p0-mvp/cutover-readiness-10/`、`test/integration/d10-cutover-simulation.test.ts`(本包产物)+ 7 项保护性未跟踪物;无其他脏面 | `git status --porcelain=v1` |
| 保护物 7 项 | 全部在场且 mtime 均早于本包工作窗(20:57 后),零触碰:`config/`(11-12 12:21)、`p0-mvp/soak-r3b/`(11-12 07:07,未启动)、ci-checkruns-bacc849.json(11-15 16:38)、fbf32f0.json(11-15 18:31)、27e9259.json(11-14 23:19)、c22d23f.json(11-15 15:03)、e28c386.json(11-14 21:03) | `stat -c '%y %n' <各项>` |
| 生产服务 PID | `systemctl --user show` 亲核:**3242781/3242782 未变**,ExecMainStartTimestamp=Fri 2026-11-13 02:00:08 CST(与合同「11-13 02:00:08 启动=旧进程」一致) | systemctl 只读输出 |
| 复核全程边界 | 本 Reviewer 零生产写入/零迁移/零重启/零 config-env 密钥触碰/零模型请求/零真实 GitHub 业务交付/零强推;对生产的唯一动作=合同允许的只读采样(preflight.ts+systemctl show);真实读写仅发生在一次性测试容器(见 §三.4 动态探针,用后即毁零残留) | 全程命令记录(本文) |

## 二、REPORT §1-§4、§7-§8 逐项亲证

### 1. §1 A 项(生产只读审计)——成立
- 证据文件存在且内容自洽:`evidence/preflight-prod-20261115-audit.{log,json}`(2026-11-15T12:58Z,HEAD=581eee6)。
- **Reviewer 独立重跑** `env DBUS_SESSION_BUS_ADDRESS=… node deploy/preflight.ts`(先审读 deploy/preflight.ts 全部查询形态=纯 SELECT/information_schema/聚合计数,零 DML/DDL/系统写,确认只读后执行):**裁决=NO-GO,四项与执行方证据逐字一致**——`db_migrations=FAIL`(缺 0008/0009)、`evidence_checks_config=UNKNOWN`、`process_vs_head=UNKNOWN`、`egress_stack=UNKNOWN`;PASS 面一致(`db_inflight` BLOCKED=1 PAUSED=1 / `web_bind` 10.30.5.80:8787 / `db_schema_tables` 16 表 / `db_reachable` / `cred_perms` / `env_file` 键名零取值 / docker/沙箱镜像)。
- 唯一差异=Reviewer 重跑时 `git_head=FAIL(被跟踪树存在未提交修改)`:系本包 D 项 D3 定稿修改尚未提交所致,属复核场景自致,非生产状态变化,不构成执行方缺陷(执行方取证时点 12:58Z 树净)。
- 零凭据值输出亲证:两次 preflight 输出均只有键名枚举,无取值。

### 2. §2 B 项(五文档协调 + M5-1/M5-2 判定)——成立
- 五文档抽查亲证:①`docs/DEPLOYMENT_PLAN.md` 顶部=FROZEN+「实现注记(2026-11-14)…以 deploy/README-deploy.md 为唯一事实文档;§4 候选路径为设计稿」;②`p0-mvp/final-coverage-matrix.md` 第 56 行「**MVP 判定:REWORK 维持**(不得 ACCEPTED)」未被偷改;③Runbook §3 含 09R 身份门语义、§4.5 含「旧代码不读这两列⇒回退代码无需回滚 schema」;④581eee6 版 D3 顶部已无「09 恢复绕过未修」阻断顶注(本包定稿版保留「已由 09R 关闭」澄清);⑤CURRENT 历史行与 08/09/09R 报告口径一致。
- **M5-1 代码事实亲证成立**:`deploy/restore-target-verify.mjs` 的 `readInspectMapping` 仅检视 `NetworkSettings.Ports["5432/tcp"]`(恰一条+HostIp=127.0.0.1+数字 HostPort),不检查其余端口键(=不拒额外发布端口,REPORT 表述准确);身份绑定链两条:`RESTORE_URL 端口==恢复容器 5432/tcp 唯一映射 HostPort`(第 124 行,REPORT 引用准确)与 `docker exec 恢复容器内 pg_postmaster_start_time==RESTORE_URL 探针值`(`deploy/restore-verify.sh:91-94`,REPORT 引用准确)。**Reviewer 独立动态探针**(见 §三.4):额外发布端口(9999/tcp→32900)在场时身份门 PASS 且正确绑定 5432 映射(32899)——证实额外端口不参与任一链环,「不存在误配置额外端口⇒DDL 打错实例的可达形态」判定成立,维持 09R 登记(对抗性加固候选,非阻断)正确。
- **M5-2 代码事实亲证成立**:`restore-verify.sh` 身份门(2c/2d)位于任何 DDL(DROP/CREATE DATABASE 第 115-125 行)之前,「证明→DDL」窗口真实存在;但利用它需活跃主体在宿主做 rm+同名重建+保持发布端口——该主体在操作者信任模型内本可直接对任意实例发 DDL,与「docker inspect 元数据自不可信」同层,非误配置可达。维持登记不实施(扩展克制)判定正确;真实缓解=受控窗口一次完成(Runbook 执行序),D3 已如此表述。

### 3. §3 C 项(模拟切换 5 用例)——成立
- 测试文件语义与 REPORT 表格逐条对照一致(①备份 schema 作用域/16 表/零 decoy/零密码断言;②09R 身份门+0007 形状 g8/g9=0/0+中文保真;③切换前 preflight FAIL→plan→apply 后验→重入 skipped_already→切换后 PASS 且裁决≠GO+三 UNKNOWN 如实;④二次恢复=回滚形态→fail-at 0009 断点如实→续跑完成→旧代码形态 INSERT 默认 false→校验和重放;⑤resolveEvidenceChecks sample 通过/5 类非法 fail-closed/未配置=undefined)。
- 断言中的 5 类非法变异与 `src/worker-entry.ts` resolveEvidenceChecks 实际错误消息(非法 JSON/空数组/功能性证据/非空字符串数组/1000~600000)一一对应。

### 4. §7/§8(生产影响/NOT_RUN)——成立
- 生产影响=零与 Reviewer 观测一致(本人重跑 preflight 前后 PID 未变、无任何生产副作用痕迹)。
- NOT_RUN 清单如实:quality:full/release 本地未跑(仓库中无对应本地日志,与声称一致);生产备份/恢复/切换/真模型/Pilot/Mac UX 均未触碰。

## 三、套件真跑与独立探针

### 1. d10 新套件(Reviewer 独立重跑)
```
npx vitest run test/integration/d10-cutover-simulation.test.ts
→ Test Files 1 passed (1);Tests 5 passed (5);Duration 9.49s(执行方绿证 9.65s,一致)
```

### 2. 既有负向面抽查(Reviewer 独立重跑)
```
npx vitest run test/integration/deploy-rehearsal.test.ts test/integration/evidence-gate-rehearsal.test.ts test/unit/d09r-restore-target.test.ts
→ Test Files 3 passed (3);Tests 39 passed (39);Duration 8.48s(原负向用例零退化)
```
- 执行方 `green10-targeted-regression.log` 56/56(7 文件:d10 5 + 08 面 13 + d09 5 + 09R 33)与 REPORT 声称一致;Reviewer 独立覆盖其中 44/56(d10 5/5+上述 39/39),其余 12(d09 集成 5+09R 集成 6+08 E2E 1)为 09/09R 收口时已两轮 PASS 的既有面,本包未改动其代码(d09/d09r/08 文件零 diff)。
- `docker ps -a --format '{{.Names}}' | grep d10-` → 零残留(执行方声称与 Reviewer 复核一致)。

### 3. 执行方 quality:quick 绿证
- `evidence/quality-quick-10.log`:biome lint PASS(warnings 非阻断)+d10 文件 format PASS+`tsc --noEmit` PASS+unit 182/182 PASS,quick 总裁决 PASS。Reviewer 未全量重跑(时间有界),以 d10/39 项真跑+tsc 形面抽查覆盖;log 内部时序/计数自洽。

### 4. Reviewer 独立动态探针(M5-1 反例形态;仅一次性容器)
```
一次性 postgres:17-alpine ×2(rvw-src-*/rvw-rst-*,合成口令):
  恢复容器发布两个端口:5432/tcp→32899 + 9999/tcp→32900(均 127.0.0.1)
node deploy/restore-target-verify.mjs --source-url …32898… --target-url …32899…
  --container-inspect-json <inspect> --restore-container rvw-rst-*
→ 「身份证明通过」,exit=0,容器发布=32899(正确绑定 5432 映射;额外端口未被拒且未参与判定)
```
结论:证实 M5-1 事实面(额外发布端口不被拒)同时证实其无害面(两条身份链均不被额外端口干扰,DDL 经 exec 进指定容器与端口无关)→ 支持 REPORT「非阻断候选」判定。探针容器与 inspect 临时文件已销毁(`docker rm -f`+rm,复核 `grep "rvw-|d10-"` 零残留)。

## 四、D3 决策材料逐条对照代码事实(合同 D 项)

| D3 主张 | 代码/事实核验 | 裁定 |
| --- | --- | --- |
| 步骤 1:`RELAY_DB_URL=<env> RELAY_BACKUP_SCHEMA=relay_console deploy/backup.sh <dir>`,预期 exit=0+完成标记+校验和 | backup.sh 用法注释与代码($1=输出目录;`RELAY_BACKUP_SCHEMA` 必填 fail-closed;成功 `backup-<STAMP>.done` 原子标记+`checksums-<STAMP>.sha256`;d10 ① 真跑全过) | 一致 |
| 步骤 2:restore-verify.sh 预期「身份证明通过」+「核对通过」 | 两字符串分别实存于 restore-target-verify.mjs:183 与 restore-verify-check.mjs:106;RELAY_RESTORE_ISOLATED=1/RELAY_DB_URL 必填拒绝面实存(restore-verify.sh:27-28);d10 ②④ 真跑 | 一致 |
| 步骤 3:preflight `db_inflight=PASS` | preflight.ts 按 state 聚合 tasks(只读) | 一致 |
| 步骤 4:`node deploy/rehearse-migration.ts plan --schema relay_console`(只读);apply 拒绝生产;按迁移文件逐条执行(search_path=relay_console) | CLI 解析 `plan|apply --schema`;plan=detectMigrationShape+buildIncrementalPlan 纯只读;`RESERVED_SCHEMAS` 含 relay_console,apply 在任何连接前拒绝(rehearse-migration.ts:58-90);迁移文件 `migrations/0008…/0009…` 均为元数据级 ADD COLUMN(0008 NOT NULL DEFAULT false/0009 可空),与「不动既有行数据」一致 | 一致(连接目标语义见 Minor-M1) |
| 步骤 5:配置后 `evidence_checks_config=PASS` | preflight.ts:未配置⇒UNKNOWN/合法⇒PASS/非法⇒FAIL(启动即抛 crash-loop 语义) | 一致 |
| 步骤 6:横幅四要素 evidenceChecks=/maxOutputTokens=/egress ready/tick IDLE | 全部实存:worker-entry.ts:120 横幅含 `evidenceChecks=<N|未配置(Gate 保守停机)>` 与 `maxOutputTokens=<值(默认/配置)>`;worker-entry.ts:139 `[relay-worker] egress ready(network=…)`;goal-loop.ts:413 status="IDLE"(tick status=…);Runbook §4.3 同口径 | 一致 |
| 步骤 7:`curl /api/health` 401+`ss -tln` 单接口+process_vs_head=PASS | Runbook §4.4 同形态;preflight process_vs_head 语义=新进程晚于 HEAD | 一致 |
| 回滚:`git checkout <上一 exact-head CI 双绿 SHA>`(当前=581eee6@43710863776)+回退代码无需回滚 schema+schema 回退统一走备份恢复(禁 DROP COLUMN) | **gh run view 43710863776 亲核:status=completed,conclusion=success,双 job(test/e2e)success@581eee6**;「旧代码不读两列」亲证:migrations 0008/0009 及 src 引用于 079b97d(2026-11-13 20:17:04 +0800)加入,晚于生产进程启动(11-13 02:00:08),线上旧代码确不读;回退基准 581eee6 代码读两列但与迁移后 schema 自洽(两场景结论均为「无需回滚 schema」);禁 DROP COLUMN 与 Runbook §4.5 一致 | 一致 |
| 备份源可达性=演练语义;源停机灾备=人工流程另行留证 | Runbook §3 同语义(身份探针需源可达) | 一致 |
| Gate fail-closed/未配置保守停机 | resolveEvidenceChecks+preflight+worker-entry 三处同源(fail-closed 实测 5 类拒绝) | 一致 |
| egress 自愈=重启后首拍 ensureEgress 幂等重建+横幅核对 | worker-entry.ts:130-145(egressInitDone 一次性初始化,ok⇒ready 横幅,异常⇒unavailable+FAIL-CLOSED 不领取) | 一致 |
| GitHub reconcile 风险(delivered_remote_head 不在备份范围;禁无证据 reset/force) | restore-verify.sh:134 明示外部 Git 不在恢复脚本范围;Runbook 同口径 | 一致 |
| 「Agent 永不凭自述宣布生产成功」「材料发布≠选 A≠自动授权」+不可逆面+最小维护窗口 | D3 顶部定稿口径+§三 A①+回滚段+§五;REPORT §7 同口径 | 一致 |
| **生产 NO-GO 口径保持** | D3 顶部+§一+§四「生产预检仍 NO-GO/不构成生产 GO/选项 A 此刻尚不可执行」;无任何 GO 或自动授权表述(定稿 diff 仅强化未削弱) | 保持 |

## 五、模拟/实测边界与测试卫生(合同 C/E)

- **边界标注如实**:d10 文件头显式声明「本套件证明的是工具链与逻辑序在隔离实例上成立;生产切换本体=NOT_RUN(硬边界禁止);preflight 其余检查项反映宿主真实现状,不属模拟断言」;REPORT §3 SIMULATED/NOT_RUN 段与之一致;D3 §二「隔离预演 PASS ≠ 生产真实数据验证 ≠ Mac UX ≠ 真模型 ≠ Pilot 24h」+§四分层(24h Pilot/Mac UX/真模型=ADR-0010 验收层,非生产 D3 前置门)。无一处以 CI 双绿或文档检查冒充运行时验收;CI 双绿仅用于 exact-head 提交基线核验(用途正当)。
- **零 mock 冒充**:全文件 grep `vi.mock|vi.fn|jest.mock|sinon|stub` 零命中;全部经由真实工具(真实 docker 一次性双实例、真实 backup.sh/restore-verify.sh、真实 rehearse-migration、真实 preflight 工具经 defaultProbes 指向隔离实例、真实 resolveEvidenceChecks)。⑤ 未跑 docker 检查执行器一事由 REPORT 交叉引用既有 evidence-gate-rehearsal 3/3(Reviewer 已含于 39/39 真跑)承担,引用关系诚实。
- **无第二控制面**:d10 仅复用 08R `startEphemeralPg/destroyEphemeralPg`(127.0.0.1 随机发布+严格 inspect 校验)、08 rehearse-migration、09 backup/restore 工具链、既有 safe-rm;未新增任何部署编排/通用脚本。
- **afterAll 清理链完整**:destroyEphemeralPg×2 + `safeRm(tmpRoot,{roots,sentinel:RUN_SENTINEL})`;实测零容器残留。
- **模型权限**:d10 全程 `RELAY_PI_BASE_URL=http://127.0.0.1:9`(discard 端口)+合成占位 API key,零真实模型请求;preflight 只输出键名零取值;D3 材料明确「零凭据打印」。

## 六、发现(分级)

### Major:0 项

### Minor:1 项(登记,不阻断)
- **M1(D3 材料精确性,信息性)**:D3 选项 A 步骤 4 的 plan 命令 `node deploy/rehearse-migration.ts plan --schema relay_console` 未注明连接目标来源——rehearse-migration 的 target-url 缺省为 `RELAY_DB_URL 环境变量 ?? postgresql://…@127.0.0.1:55433/relayp000`(src/core/db.ts DEFAULT_TEST_DATABASE_URL)。在生产宿主未导出 RELAY_DB_URL 的常态下缺省恰指向生产 relay_console 所在共享实例(09 拓扑实证),plan 为纯只读且输出含脱敏目标可自证,Runbook §3.74 同形态,故不构成可达危害;但作为「每步最小检查命令」其连接语义依赖隐式缺省,建议后续材料修订时在步骤 4 括注「连接目标=RELAY_DB_URL 或缺省共享实例,以输出中脱敏目标为准」。登记不阻断。

### 非缺陷澄清(不计级)
- Reviewer 重跑 preflight 时 `git_head=FAIL` 为本包未提交定稿修改自致(§二.1),非生产事实变化。
- 「回退代码无需回滚 schema(两列旧代码不读)」的「旧代码」指线上 11-13 旧进程代码;回退基准 581eee6 代码读两列但与迁移后 schema 自洽——两种回退场景下「无需回滚 schema」结论均成立(§四回滚行),表述继承自 Runbook §4.5,无事实错误。

## 七、终裁

**PASS**(0 Major,1 Minor 登记)。

依据:①冷启动一致(HEAD=origin=581eee6;工作区与登记逐项相符;7 项保护物零触碰;生产 PID 未变);②生产只读事实四项 NO-GO/UNKNOWN 经 Reviewer 独立重跑逐字复现,生产 NO-GO 口径在 REPORT 与 D3 材料全程保持,无任何 GO/自动授权表述;③A/B/C/D 四项实质主张全部亲证成立——M5-1/M5-2 维持「非阻断候选」的判定经代码事实+独立动态探针双重证实,无被掩盖的可达绕过形态;④d10 5/5 与既有负向面 39/39 独立真跑通过,零容器残留,零 mock,无第二控制面,清理链完整;⑤D3 决策材料与 backup.sh/restore-verify.sh/rehearse-migration/preflight/worker-entry 横幅的代码事实逐条一致,合同 D 十二项要素齐备,CI 回执 43710863776@581eee6 双 success 经 gh 独立核验;⑥模拟/实测/SIMULATED/NOT_RUN 边界标注如实,验收分层不混谈。

**本 PASS 仅裁示「D3 准入材料可提交用户审批(PRE-D3 READY)」与执行质量;不构成生产 GO、不构成任何生产操作授权、不冒充 Mac UX/真模型/24h 验收。生产切换须用户按 D3 材料单独明确批准。**
