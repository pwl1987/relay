# P0-ACCEPT:备份与恢复验收报告(缺口 F)

- 验证 HEAD:`511c2b6`(测试 `test/integration/backup-restore.test.ts`;运行日志 `p0-accept/backup-restore-run.log`)
- 裁决:**VERIFIED(MVP 发布 Gate V19 达成)**——真实备份产物 + 隔离实例恢复 + 全实体核对 + 外部状态核对

## §1 备份(实际执行)

| 项 | 事实 |
| --- | --- |
| 数据库 | `pg_dump --schema=<测试schema> --no-owner --no-privileges`(宿主无 client 时经 `docker exec relay-p000-pg pg_dump`——测试 PG 容器内同版本 client);产物 **23,819 字节** SQL 落盘 |
| Evidence/Artifact | gate_evidence.raw_output/env/content_sha256 随库备份(证据以行内原文+哈希双面保真);Artifact 目录级备份属部署包参数(OPEN;当前 Run 工作区为临时面,权威事实在 DB——P0-01B"run 行是唯一权威事实"架构) |
| 配置 | 迁移 5 个文件随库结构入库;服务配置面(env/凭据路径)未含于 DB 备份——登记为部署包任务 |

## §2 恢复(隔离实例;**非简单重启**)

| 步骤 | 事实 |
| --- | --- |
| 隔离实例 | `docker run -d --rm postgres:17-alpine`(一次性新容器,随机宿主端口 **127.0.0.1:32769**,独立 POSTGRES_DB=relay_restore) |
| 导入 | `psql -v ON_ERROR_STOP=1` 全量导入 —— **零错误** |
| 实例独立性 | 与源实例(relay-p000-pg:55433)完全隔离的独立 PG 进程/数据目录 |

## §3 全实体核对(13 表)

- 行数:13 表(goals/tasks/leases/runs/sessions/candidate_changesets/task_gate_verdicts/action_proposals/gate_evidence/action_intents/decisions/budget_ledger/audit_events)逐一 count 一致;
- 内容:**每表全行 `json_agg` 摘要 md5 两库逐一相等**(实体零丢失/零漂移;含中文文本与 jsonb 保真);
- 抽查:goals.raw_input 中文保真 ✓。

## §4 外部状态核对

- 恢复后 bare 远端 HEAD == candidate_changesets.git_commit_sha(**外部 Git 事实不受恢复动作影响**);
- 语义:恢复后如需判断"外部写动作是否要 Reconcile",以远端真实 HEAD 对照恢复库的 intent/changeset 状态(V05 语义;本包核对通道就位)。

## §5 诚实声明

- 备份参数(RPO/RTO/Retention/加密/异地)仍为 OPEN(P0-00 裁决边界)——本包验证的是**机制与可恢复性**,不是备份运维方案;
- 恢复演练为**新起隔离实例**,非同实例重启(合同明令);
- CI 环境(无 docker)该测试自动 skip,不假装。
