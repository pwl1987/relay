# RELAY-DEPLOY-REHEARSAL-08 · 用户 D3 决策材料(一页式)

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
- **登记 F-1(如实)**:`deploy/backup.sh` 第 3 步审计索引在宿主无 psql 时回退命令**硬编码** `docker exec relay-p000-pg … relayp000` 且表名未按 schema 限定 ⇒ 生产审计行在 `relay_console` schema 下,该索引**可能为空或读取到 public 旧表**。切换窗口执行备份时,审计索引请以 schema 限定命令人工核对(D3 材料附命令),或批准后续小包修复 backup.sh(本包未改它)。
- 真实模型 Run/真实外部交付:严格 NOT_RUN(未授权)。

## 五、批准后的首日监测清单(选项 A)

preflight 全项复跑(`db_migrations/evidence_checks_config/process_vs_head` 应 PASS/如实);`journalctl --user -u relay-worker` 横幅四要素;`ss -tln` 仅 `10.30.5.80:8787`;首拍 `IDLE` 与 egress ready;24h 内逐日 preflight 对比。
