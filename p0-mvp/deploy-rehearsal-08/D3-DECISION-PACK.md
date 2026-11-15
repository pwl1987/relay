# RELAY-DEPLOY-REHEARSAL-08 · 用户 D3 决策材料(一页式)

> **2026-11-15 协调方最新独立复核：09 整包 REWORK，D3 选项 A 继续禁用。** 09 备份 schema 隔离与 F-1 修复已有真实测试和 CI，但恢复脚本可因源/目标 URL 采用 127.0.0.1 与 localhost 别名而误将同一 PG 当作不同实例；docker fallback 完全取决于 RELAY_RESTORE_CONTAINER 而不使用 RESTORE_URL。协调方用 fake psql 和 fake docker **两次亲测均观测到危险 DROP DATABASE 命令被构造，未执行任何实际 DB 操作**。先由唯一 ACTIVE RELAY-RESTORE-TARGET-09R 修复实际目标身份守卫，并经独立隔离 E2E 验收；09R 即使 PASS 也不自动授权生产迁移、备份或服务重启。生产 NO-GO 四项维持。

> **2026-11-15 更新：08R 安全纠偏经协调方 PASS，但生产仍不得切换。** 08 原一次性 PostgreSQL 端口误发布已由 08R 回环随机端口 + Docker inspect 实证修复；本轮不再以 08R 作为独立阻断项。另经源码确认：backup.sh 审计索引回退目标硬编码且未限定 schema，原备份会整库导出、manifest/restore 验证跨 schema 聚合，可能混入同库其他业务/测试数据，属于更高优先级的生产备份作用域风险。已登记 09 仅使用隔离合成数据修复真实备份/恢复一致性；**选项 A 仍暂不能执行，09 PASS 也不自动授权 D3**。生产 NO-GO 四项、真实模型/UX 未验收边界维持不变。
> **2026-11-15 续:RELAY-BACKUP-INTEGRITY-09 已实施完成并收口**(提交链 395091f→…→a458e95(09 合同)→0eb4b7b(实施)→9b8555f(CI 教训修正),exact-head CI 43694571961@9b8555f test+e2e 双 success,独立 Reviewer 两轮 REWORK→PASS(0 Major),报告 `p0-mvp/backup-integrity-09/REPORT-RELAY-BACKUP-INTEGRITY-09.md`):备份/恢复链目标 schema 唯一入口语义+f-1 修复+隔离恢复身份核对,已在合成双租户一次性实例真跑验收。**该修复提升的是「备份/恢复工具正确性」,不改变生产 NO-GO 事实**(迁移缺 0008/0009、Gate 未配置、旧进程、egress 缺席均未动);生产切换仍须用户单独 D3 授权,且切换窗口的备份/恢复演练须按 09 后语义执行并留存证据。

> 2026-11-14 · 合同 241893d · **本文件只是决策材料,不是授权,更不是执行**。
> 生产切换(迁移/配置/重启)只有在你**明确回复选择某一选项并批准范围/窗口**后才生效;未回复前生产维持现状(NO-GO 预检基线不变)。

## 一、生产现状(2026-11-14 只读实测,零改写)

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 生产 `relay_console` schema 缺 0008(goal_messages.execution_request)+0009(tasks.abort_requested_at);重启后新代码依赖,不补齐则 worker 首拍相关查询报错 | preflight `db_migrations=FAIL`;本包只读复核 `g8/g9=0/0`(evidence/production-plan-relay-console.json) |
| 2 | `RELAY_EVIDENCE_CHECKS_JSON` 未配置 ⇒ 重启后 Gate 对代码变更候选**保守停机**(NEEDS_DECISION;fail-closed 安全,自动放行不可用) | preflight `evidence_checks_config=UNKNOWN` |
| 3 | 线上两服务为旧代码(2026-11-13 02:00:08 启动,早于其后全部提交),新语义以重启为界 | systemctl PIDs 3242781/3242782 未变 |
| 4 | 出口约束栈当前缺席(worker 降级);重启后首拍 ensureEgress 幂等自愈,须核对 "egress ready" 横幅 | preflight `egress_stack=UNKNOWN` |

## 二、本包隔离预演结论(合成数据 + 独立 schema/一次性容器;**零生产写入**)

- **增量升级演练 PASS**:0007 形状 → 0008 → 0009 真实迁移文件依序执行;重复执行自动跳过不盲撞;人为注入 0009 失败 ⇒ 断点精确定位(0008 已应用/0009 待执行)且可续跑,半迁移状态如实报告"待升级"不假 GO;升级后后验(列定义/旧行默认回填 false/append-only 触发器/FK/行数守恒)全绿。
- **备份→迁移→恢复回退 PASS**:备份(0007 形状+合成数据)→ 迁移至 0009 → 恢复到独立库 ⇒ 恢复库精确回到备份时点形状(0008/0009 缺失)+ 合成行/约束/触发器逐条保真 + 交付 manifest 交叉核对一致(复用 deploy/restore-verify-check.mjs)。
- **代码回退兼容实证**:迁移后旧代码形态 INSERT(不引用新列)成功且默认回填 false ⇒ **回退代码无需回滚 schema**;schema 回退不走 DROP COLUMN(会丢迁移后数据),统一走备份恢复。
- **Gate 功能性检查演练 PASS**(真实 docker 检查执行器,UID 10001/禁网):未配置 ⇒ NEEDS_DECISION;有效检查+真实通过 ⇒ ACCEPTED;检查失败/候选缺失 ⇒ 保守阻断不进 Reviewer。
- **迁移演练工具**:`node deploy/rehearse-migration.ts plan --schema relay_console`(只读,输出拟执行 SQL+前置/后置+回滚材料)——对生产**永不执行**;apply 面对非 `p01a_*` schema、非回环/未显式端口连接串一律在任何写入前拒绝(实测 4 类拒绝全过)。

## 三、选项(三选一;回复即视为对所选项"批准范围"的授权)

### 选项 A:批准指定切换窗口(迁移补齐 + 可选检查配置 + 重启)
- **你需明确**:① 窗口时间;② 批准范围=Runbook §2(配置决策项)→§3(备份)→§4(切换顺序)的哪些步骤;③ Gate 检查是"配置 sample 等价检查"还是"接受保守停机运行"。
- **执行序**(全部按 deploy/README-deploy.md Runbook,人工逐步):备份(§3)→ 窗口内核对在途任务=0(preflight `db_inflight` 无 VERIFYING/DELIVERING/NEEDS_RECONCILE/RUNNING)→ 在 relay_console 上精确执行 0008/0009(search_path=relay_console;**需你 D3 明确批准后才执行**)→ 复跑 preflight 应 `db_migrations=PASS` → (可选)写入单行 `RELAY_EVIDENCE_CHECKS_JSON` → 重启两服务 → 横幅核对(evidenceChecks/maxOutputTokens/**egress ready**/IDLE)→ health 401/登录回路/单接口绑定核对。
- **风险与门槛**:ALTER TABLE 加列为元数据级快操作(2026-11-14 只读实测 relay_console 全 15 表合计 66 行,持锁毫秒-秒级;生产规模以窗口实测为准);重启窗口内服务不可用约秒级;egress 栈重启后自愈但须核对横幅。
- **回滚**:代码回退 `git checkout <上一 CI 绿 SHA>`+重启(schema 不回滚);env 改前备份;迁移异常时**不得手工改写生产数据**,按 §4.5/恢复路径处置。

### 选项 B:保持旧进程与保守停机(维持现状)
- 不补迁移、不重启;Gate 对代码变更候选保守停机(fail-closed 安全);新功能(对话授权/紧急停止/工作区归属绑定)线上不生效。零风险零收益,随时可再选 A/C。

### 选项 C:暂缓,先补验 Mac UX/模型稳定窗口
- 维持 B 现状,待 WEB-UX 实机验收与 R-2 能力复验后再回到本材料。

## 四、必须如实知道的边界

- **隔离合成数据 PASS ≠ 生产真实数据验证 ≠ Mac 用户 UX ACCEPTED ≠ 真实模型/24h 运维完成**(验收分层不混谈)。
- 恢复/迁移耗时数字来自合成小库演练(秒级);**生产规模耗时以切换窗口实测为准**,本包数字不得直接引用。
- **登记 F-1 → 已由 RELAY-BACKUP-INTEGRITY-09 修复(2026-11-15,0eb4b7b→9b8555f)**:`deploy/backup.sh` 审计索引硬编码/未限定 schema、整库 dump、manifest/恢复核对跨 schema 聚合与相同计数假一致、restore-verify 无隔离守卫等备份链缺陷已按目标 schema 唯一入口语义修复(合成双租户一次性实例红绿+隔离恢复真跑+独立 Reviewer 两轮 PASS,证据 `p0-mvp/backup-integrity-09/`)。切换窗口备份/恢复演练按 `deploy/README-deploy.md` §3 的 09 后语义执行(RELAY_BACKUP_SCHEMA=relay_console + RELAY_RESTORE_ISOLATED=1)并留存证据;**本修复不构成任何生产 GO 提升,选项 A/B/C 的裁决仍须用户 D3**。
- 真实模型 Run/真实外部交付:严格 NOT_RUN(未授权)。

## 五、批准后的首日监测清单(选项 A)

preflight 全项复跑(`db_migrations/evidence_checks_config/process_vs_head` 应 PASS/如实);`journalctl --user -u relay-worker` 横幅四要素;`ss -tln` 仅 `10.30.5.80:8787`;首拍 `IDLE` 与 egress ready;24h 内逐日 preflight 对比。
