# 阶段 E 报告:运行编排、长稳与恢复(总执行包)

- 合同:`05c1473`(CURRENT.md 阶段 E);日期:2026-11-11;环境:VM80(隔离演练,无生产部署)
- **24h 长稳观察状态:进行中(真实计时;完成时由 soak-final.json 判定,未满不写 PASS)**

## 1. E1 relay-worker 独立入口(VERIFIED)

- `src/worker-entry.ts`:**唯一调度权威**独立进程——组合既有 `startSupervisorLoop`(回收/Reconcile/释放)+ live driver(`createLiveWorkerDriver`,FAIL-CLOSED 同 server live);零第二状态机;SIGTERM 优雅停;WORKER_STARTED/STOPPED 审计。
- `deploy/relay-worker.service`:systemd 单元样例(仅样例,本包不部署;Restart=on-failure/KillSignal=SIGTERM)。
- **过程发现并修复一处真实组合缺陷**:`supervisorTick` 无条件 `claimNextReady` 但 Supervisor 无执行器 ⇒ 组合下两环路争抢、任务被领走后无人执行。修复:`TickOptions.claim`(缺省 true 兼容既有);worker-entry 传 `claim:false`(领取归 goal 环路)。
- 验收(`test/integration/worker-entry.test.ts` **3/3**):
  - 进程内启动/优雅停:banner+审计+FAIL-CLOSED 空转(provider 未配置零领取,任务保持 READY);
  - **SIGKILL → 重启**:两个真实进程先后启动(审计 2 次 WORKER_STARTED);过期租约被 `RECLAIM_EXPIRED` 回收 ⇒ **NEEDS_RECONCILE**(安全语义:副作用不确定先 Reconcile,可见不自动推进);runs 零行(零重复副作用);
  - 零第二调度权威:server 仍默认 external(结构断言)。

## 2. E2 长稳(观察进行中)

- 复核冻结阈值:RSS<400MB(300s 基线峰值 333MB)、IDLE 稳定。
- **采集已启动(2026-11-11 17:33 +08 起,真实 24h 计时)**:`p0-mvp/soak-24h/`——relay-worker 真实进程(nohup;soak24h 独立 schema)+ 每分钟采样(RSS/CPU/存活/PG 连接/tick 状态)落 `samples.csv`。
- 启动时点观测:RSS 稳定 ~109MB(启动瞬时 311MB 为 node 初始读数;稳态远低于阈值);tick 全部 `IDLE_PROVIDER_DOWN`(FAIL-CLOSED 空转;零模型调用零成本)。
- **工作模式(真实任务循环)长稳**:受 magpie 模型能力面约束(阶段 D 实锤),以 300s 基线为工作模式代表,如实标注;24h 工作模式观察未开跑(依赖更强模型路由——部署包依赖)。
- 完成判定:采样器满 86400s 自动写 `soak-final.json`(completed/rssPeak/结论建议);**未满前一切报告不得引用"24h PASS"**。

## 3. E3 备份与 Artifact 恢复(VERIFIED,演练实测)

- `deploy/backup.sh`:pg_dump 整库(宿主无 client ⇒ docker exec relay-p000-pg 回退)+ **Artifact manifest**(跨 schema 聚合已交付变更集/commit/remoteHead/文件清单)+ audit 索引 + 校验和。
- `deploy/restore-verify.sh`:一次性隔离 PG 容器 → **每次演练新建干净库**(整库 dump 含 CREATE SCHEMA,重复恢复不撞)→ ON_ERROR_STOP 恢复 → 交付记录与 manifest 交叉核对 + 全 schema 审计行核对 + 校验和验证;恢复时间(RTO)秒粒度记录。
- **演练实锤**(种子:1 goal/1 run/1 DELIVERED 变更集/25 审计行):
  - 备份:db 414734 bytes + manifest 1 个交付变更集(跨 10 schema)+ audit 25 行 + checksums;
  - 恢复:**交付记录 1/1 一致 ✓;审计行(全 schema)60 ✓;校验和全部一致 ✓**;
  - 过程修复 4 处脚本真实缺陷(manifest 跨 schema/psql 回退/URL dirname 破坏/argv 索引)。
- 数据丢失窗口:两次备份间写入(RPO=备份间隔;部署参数属部署包);外部 Git 状态以 GitHub 实际为准(Reconcile 语义见 V05/V10)。

## 4. 边界(如实)

- 24h 空闲观察进行中(未满不写 PASS);72h 未开跑(24h 完成后按需)。
- 工作模式 24h 长稳未开跑(模型能力面约束;300s 基线为代表,如实)。
- systemd 单元为样例未安装(不生产部署——总包边界)。

## 5. 测试账

- 新增:`worker-entry.test.ts` 3 例;deploy/ 三脚本+单测化校验(manifest/check .mjs);全量回归见提交信息;tsc 0。
