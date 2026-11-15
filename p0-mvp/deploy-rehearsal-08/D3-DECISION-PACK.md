# 用户 D3 决策材料(一页式)· RELAY-CUTOVER-READINESS-10 定稿(2026-11-15)

> **定稿口径(RELAY-CUTOVER-READINESS-10 准入复核完成)**:08R 测试库回环发布 / 09 备份目标 schema 唯一入口 / 09R 恢复目标实例身份门均完成隔离技术验证(协调方亲跑 09R 相关 38/38 PASS;contract-head CI 43710863776@581eee6 双 success);10 包完成生产只读准入审计 + 隔离切换模拟全链 5/5 真跑 + 本材料定稿(独立复核见 `p0-mvp/cutover-readiness-10/`)。**生产预检仍 NO-GO**。本文件只是决策材料,**材料发布 ≠ 你已选 A ≠ 自动授权**;任何生产 DDL/重启/配置写入都须你明确回复选择并批准范围/窗口后才生效;Agent 永不凭自述宣布生产成功——成败以下方各步检查命令的实测输出为准。
> 此前「09 恢复绕过未修」等历史阻断状态已由 09R 关闭(历史证据在 Git 历史与对应 Review,不作当前阻断)。

## 一、生产现状(2026-11-15 只读实测,零改写;证据=`p0-mvp/cutover-readiness-10/evidence/preflight-prod-20261115-audit.{log,json}`)

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 生产 `relay_console` 缺 0008(goal_messages.execution_request)+0009(tasks.abort_requested_at);重启后新代码依赖,不补则 worker 首拍相关查询报错 | preflight `db_migrations=FAIL` |
| 2 | `RELAY_EVIDENCE_CHECKS_JSON` 未配置 ⇒ Gate 对代码变更候选**保守停机**(NEEDS_DECISION;fail-closed 安全,自动放行不可用)⇒ 须 D3 取舍:配置检查或接受保守停机 | `evidence_checks_config=UNKNOWN` |
| 3 | 线上两服务=旧代码(2026-11-13 02:00:08 启动,PID 3242781/3242782 未变),新语义以重启为界 | svc active;`process_vs_head=UNKNOWN` |
| 4 | 出口约束栈缺席(worker 降级);重启后首拍 ensureEgress 幂等自愈,须核对 `egress ready` 横幅 | `egress_stack=UNKNOWN` |
| 5 | 在途无阻断(BLOCKED=1 PAUSED=1,不重入 Gate);Web=LAN 单接口 10.30.5.80:8787 合规;16 表齐备 | `db_inflight`/`web_bind`/`db_schema_tables`=PASS |

## 二、隔离预演结论(合成数据+一次性实例;**零生产写入**)——切换模拟全链 5/5 真跑

- 全链(`p0-mvp/cutover-readiness-10/evidence/green10-simulation.log`;全部真实工具×真实一次性 PG,零 mock):备份(09 schema 唯一入口,零跨 schema 混入)→ 隔离恢复(09R 身份门:源/目标不同实例证明通过)→ 0007 形状(生产 relay_console 形态镜像)→ 0008/0009 增量(08 工具:plan=真实迁移文件 SQL / apply 后验全绿·旧行回填 false / 重入 skipped_already / fail-at 断点如实+续跑完成)→ Gate 配置真校验(sample 合法通过 / 非法 fail-closed 拒绝 / 未配置=保守停机路径)→ **真实 preflight 工具前后对照:db_migrations FAIL→PASS,裁决仍≠GO**(evidence_checks/process_vs_head/egress 三项 UNKNOWN 不因迁移消失——分别须 D3 决策/真实重启/真实重启自愈)→ 回滚条件(备份恢复=回退目标形状;迁移后旧代码形态写入成功且默认 false ⇒ **回退代码无需回滚 schema**)。
- **验收分层(不混谈)**:隔离预演 PASS ≠ 生产真实数据验证 ≠ Mac 实机 UX ≠ 真模型 F1/F2 ≠ Pilot 24h。24h Pilot/Mac UX/真模型属 MVP/Pilot 验收层(ADR-0010),**不是生产 D3 前置门**;生产 D3 前置门=第一节四项 NO-GO/UNKNOWN 处置 + 本材料选项批准。

## 三、选项(三选一;回复即视为对所选项「批准范围」的授权)

### 选项 A:批准指定切换窗口(迁移补齐 + 功能检查取舍 + 重启)
- **你需明确**:① 窗口时间(建议最小维护窗口:全程预计 <15 分钟,服务不可用仅重启段秒级);② 批准范围=下表哪些步骤;③ Gate 取舍=配置 sample 等价检查 **或** 接受保守停机运行。
- **受影响对象/权限**(精确):`relay_console` schema 两列 ALTER(0008 NOT NULL DEFAULT false / 0009 可空,元数据级快操作,不动既有行数据)+ `~/.relay/console/env`(仅当配置检查;改前先备份)+ `relay-web`/`relay-worker` 两个 systemd **user** 服务重启(仅此两单元)。所需:生产 RELAY_DB_URL 写权限(即现 env 文件凭据,零打印)、systemd user 管理权限(已具备)、docker(egress 自愈用)。零其他服务/零防火墙/零 egress 手工操作/零凭据打印。
- **执行序**(每步最小检查/预期/失败停止):

| 步 | 操作 | 最小检查命令 | 预期 | 失败 ⇒ |
| --- | --- | --- | --- | --- |
| 1 | 备份先行 | `RELAY_DB_URL=<env 内值> RELAY_BACKUP_SCHEMA=relay_console deploy/backup.sh /tmp/relay-backup-<日期>`(Runbook §3) | exit=0+完成标记+校验和过 | 停;不进下一步 |
| 2 | 隔离恢复校验(09R 语义) | `RELAY_RESTORE_ISOLATED=1 RELAY_DB_URL=<源串> RELAY_RESTORE_CONTAINER=<psql 可用一次性容器> deploy/restore-verify.sh <备份目录> "postgresql://…@127.0.0.1:<隔离发布端口>"` | `身份证明通过`+`核对通过` | 停;备份不可信=不得切换 |
| 3 | 在途核对 | 带 bus `node deploy/preflight.ts` | `db_inflight=PASS`(无 VERIFYING/DELIVERING/NEEDS_RECONCILE/RUNNING) | 停,按 Runbook 处置 |
| 4 | 迁移补齐(核心) | 先审:`node deploy/rehearse-migration.ts plan --schema relay_console`(纯只读;连接目标取自 RELAY_DB_URL,缺省 127.0.0.1:55433/relayp000=生产所在共享实例,输出含脱敏目标自证);批准后按迁移文件逐条精确执行 0008/0009(search_path=relay_console) | plan 输出拟执行 SQL 与前置/后置材料;复跑 preflight `db_migrations=PASS` | 停;半迁移如实报告,按断点续跑或恢复路径处置,**禁手工改写生产数据** |
| 5 | (若选配置检查)写单行 `RELAY_EVIDENCE_CHECKS_JSON`(压平;改前备份 env) | 改后 preflight `evidence_checks_config=PASS` | — | 停;恢复 env 备份 |
| 6 | 重启两服务 | `systemctl --user restart relay-web relay-worker` | 横幅四要素:`evidenceChecks=<与你决策一致>`/`maxOutputTokens=<值>`/**`egress ready`**/`tick IDLE` | 停;Restart=always 兜底,横幅异常如实报告 |
| 7 | 边界核对 | `curl /api/health`(未登录 401)+登录回路;`ss -tln` 仅 `10.30.5.80:8787`;preflight 复跑 | `web_bind=PASS`;`process_vs_head=PASS`(新进程晚于 HEAD) | 停;如实报告 |

- **备份/恢复语义(09/09R)**:备份源实例须可达(身份探针=演练语义);**源停机灾备=人工流程另行留证,不属已验收自动恢复能力**。恢复目标必须是独立隔离实例(同实例别名/同集群/容器错位一律 fail-closed 拒绝)。
- **外部 GitHub reconcile 风险**:`candidate_changesets.delivered_remote_head` 与 GitHub 实际 HEAD 的外部交付状态**不在备份/恢复范围**;切换后若出现 DELIVERING/漂移 ⇒ 按 Reconcile 两阶段语义(intent 日志)处理,禁无证据 reset/force。
- **回滚**:代码回退 `git checkout <上一 exact-head CI 双绿 SHA>`(当前=581eee6,Actions 43710863776 双 success;以最新双绿为准)+ 重启——**回退代码无需回滚 schema**(两列旧代码不读);env 恢复步骤 5 备份;schema 级回退**统一走步骤 2 备份恢复**(禁 DROP COLUMN);生产数据零手工改写。不可逆面:无删除性操作;最大风险=迁移半途异常(断点续跑可解)与重启后横幅异常(回退重启可解)。

### 选项 B:保持旧进程与保守停机(维持现状)
不补迁移、不重启;Gate 对代码变更候选保守停机(fail-closed 安全);新功能(对话授权/紧急停止/归属绑定)线上不生效。零风险零收益,随时可再选 A/C。

### 选项 C:暂缓,优先真实 UX/模型验收
维持 B 现状;待 WEB-UX 实机验收与 R-2 能力复验(ADR-0011 修复后窗口)后再回到本材料。

## 四、必须如实知道的边界
- 本材料结论=**技术切换前准入材料可提交用户审批(PRE-D3 READY)**;生产预检 NO-GO 仍成立,**不构成生产 GO,选项 A 此刻尚不可执行**。
- 迁移/恢复耗时数字来自合成小库演练(秒级);生产规模以切换窗口实测为准,本包数字不得直接引用。
- 真实模型 Run/真实外部交付/Pilot-24H:严格 NOT_RUN(未授权)。

## 五、批准后首日监测清单(选项 A)
preflight 全项复跑(`db_migrations`/`evidence_checks_config`/`process_vs_head` 应 PASS/如实);`journalctl --user -u relay-worker` 横幅四要素;`ss -tln` 仅 `10.30.5.80:8787`;首拍 `IDLE` 与 `egress ready`;24h 内逐日 preflight 对比。**生产切换成功与否由上述实测输出并由你确认;Agent 不自宣成功。**
