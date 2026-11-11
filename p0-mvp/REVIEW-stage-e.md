# 阶段 E 独立 Reviewer 复核报告(运行编排/长稳/恢复)

- 复核人:独立 Reviewer(不采信实现者声明,一切以亲自读取与运行结果为准)
- 复核 HEAD:`f149b061103d996b7872a27d6c7b32087fc769a2`(已推送 main;工作区仅 soak-24h 两个采集文件在持续更新,预期内)
- 合同:`05c1473:CURRENT.md` "本包范围(阶段 E)"
- CI:`42997745428` — `gh run view` 亲查 `{"conclusion":"success","status":"completed"}` ✓
- 复核时点:2026-11-11 18:30 +08;**soak 观察进度 3432/86400s(≈4.0%,进行中——本轮不判长稳结论,只验证采集机制真实性与报告如实性)**
- 复核动作约束遵守:除本文件外仓库零改动;未 commit/push;未触碰 soak 采集进程(3624561/3627722 复核后仍存活);演练残留(6 个 `p01a_review_e1/e3_*` schema、一次性容器)已全部清理。

## 0. 逐项裁决总表

| 项 | 裁决 |
|---|---|
| tsc --noEmit = 0 | VERIFIED |
| worker-entry.test.ts 3/3 | VERIFIED |
| supervisor-tick.test.ts 3/3(claim 缺省 true 兼容) | VERIFIED |
| E1:亲自 spawn 真实进程全链(banner/IDLE_PROVIDER_DOWN/审计/RECLAIM_EXPIRED/runs=0) | VERIFIED |
| 组合缺陷(supervisor claim)真实性与修正 | VERIFIED(终态;争抢机理成立) |
| E2:采集机制真实性(worker 存活/CSV 60s 单调/RSS 来自 /proc/未满不写 PASS/soak-final.json 逻辑) | VERIFIED(附 M3/M6/M7 观察项) |
| E3:backup→隔离恢复→交叉核对全流程 | VERIFIED(附 M1/M2 观察项) |
| 脚本安全面(sha256sum -c 注入/dump 凭据) | 无命令注入;凭据面干净(附 M4/M5 登记) |
| "5 处脚本缺陷"修正后行为 | VERIFIED(终态行为全部亲测;中间态缺陷本身不可考古,见 N1) |
| 边界如实性(systemd 样例/server external/零第二状态机/工作模式长稳未开跑) | VERIFIED(全部如实) |
| 24h 长稳结论本身 | 不判定(进行中,3432/86400s;按合同留待观察期满) |

## 1. 基础验证(亲自运行)

- `npx tsc --noEmit` → **0 错误**(exit 0)。
- `npx vitest run test/integration/worker-entry.test.ts` → **3/3 绿**(进程内启停 / SIGKILL→重启 / 零第二调度权威结构断言)。
- `npx vitest run test/integration/supervisor-tick.test.ts` → **3/3 绿**:`TickOptions.claim` 缺省 true 不破坏既有语义(`startSupervisorLoop` 经 `...tickOptions` 展开转发,已读 `src/core/supervisor.ts:245-267` 确认)。

## 2. E1 亲自实证(独立 schema + 真实进程,仿 worker-entry.test.ts 但从零自建)

自建 `/tmp/review-stage-e/e1/`(仓库零改动):`createIsolatedSchema` 建 `p01a_review_e1_32da3925` + 领域层 `claimNextReady(db,"rv-old-worker",2)` 制造 2s 短租约。随后**亲自 spawn 三个真实 `node src/worker-entry.ts` 进程**:

| 进程 | 结束方式 | 亲测观察 |
|---|---|---|
| P1(rv-kill-worker) | timeout→SIGTERM | banner `[relay-worker] started workerId=… pid=3667037` ✓;tick 全 `IDLE_PROVIDER_DOWN claimed=-` ✓;`SIGTERM received;graceful stop…`+`stopped` ✓ |
| P2(rv-kill-worker2) | **kill -9** | banner ✓;强杀无 WORKER_STOPPED(正确) |
| P3(rv-new-worker) | timeout→SIGTERM | 重启后 Supervisor 回收过期租约 ✓ |

审计核对(`audit_events` 直查):
- `WORKER_STARTED` ×3(三个进程各 1,detail.workerId 逐一对应)✓
- `WORKER_STOPPED` ×2(仅优雅停的两个;SIGKILL 者无)✓
- `RECLAIM_EXPIRED`:1 行,`task_id=rv-e1-ready,before=LEASED,after=NEEDS_RECONCILE` ✓(安全语义:副作用不确定先 Reconcile,不自动推进)
- 任务终态:被回收者 `NEEDS_RECONCILE`;**未被领取的 READY 任务在 provider 未配置下全程保持 READY(FAIL-CLOSED 零领取亲证)** ✓
- `runs` 表 = **0 行**(零重复不可逆副作用)✓

**组合缺陷裁决**:diff 证实修正前 `supervisorTick` 无条件 `claimNextReady`——worker-entry 组合下 Supervisor 环路(无执行器)会把 READY 任务领走,goal 环路(driver.tick)无任务可领 ⇒ 任务白等租约过期,两环路争抢机理成立。修正(`claim:false`;领取归 goal 环路 live driver)与缺省 true 兼容(既有测试绿)均亲测。VERIFIED。

## 3. E2 采集机制真实性(不等待观察完成)

- ① **worker 存活**:`ps` 亲查 PID 3624561 `node src/worker-entry.ts`(etime 17:46 时点),`/proc/3624561/environ` 亲读:`RELAY_DB_SCHEMA=soak24h`(独立 schema 亲查存在)、`RELAY_WORKER_ID=soak-worker`、无 `RELAY_PI_*`(FAIL-CLOSED 空转与 REPORT 一致);soak24h.tasks=1。
- ② **CSV 间隔与单调**:`samples.csv` 全量 awk 核对——间隔恒 ~60-61s,elapsed 严格单调;唯一异常缝 92→116(+24s)与表头重复(第 4 行)为**采样器重启一次**的如实痕迹(17:33:24-17:34:24 首发实例 → 17:34:49 现实例,sampler.pid=3627722 etime 吻合);前两行 `pg_conns=-`(首实例 docker exec 未通)亦如实保留。原始数据未修饰。
- ③ **RSS 来自 /proc**:我亲自 `grep VmRSS /proc/3624561/status` = 110476 kB(17:50:39),与 CSV 前一行 110296(17:49:50)连续吻合;sample.sh 逻辑确为 `awk /VmRSS/ /proc/$WPID/status`。峰值 312936 kB(node 启动瞬态,REPORT"启动瞬时 ~311MB"口径吻合)< 400000 阈值 ✓。
- ④ **REPORT 未宣称 24h PASS**:通读 REPORT——仅"进行中(真实计时)";`soak-final.json` **尚未生成**(ls 亲证);start-epoch 1794389572 = 17:32:52+08 与 worker 启动吻合。
- ⑤ **soak-final.json 生成逻辑**(`p0-mvp/soak-24h/sample.sh` 通读):`ELAPSED>=86400 || ALIVE=no` 触发一次性写出;`completed` 仅当 `elapsed>=86400`;成功分支 verdict 文本为"观察期已满——判定交由 REVIEW"、未满分支"不得宣称 PASS"——**脚本自身永不写 PASS,判定权交给本 REVIEW,如实** ✓。worker 早死也会写出 `completed=false` 的 final 文件(诚实止损)✓。

## 4. E3 亲自演练(从零执行,不信任实现者演练)

自建 `/tmp/review-stage-e/e3/`:独立 schema `p01a_review_e3_5cf415c9` + 种子(1 task/1 run/**1 条 DELIVERED 变更集**/5 行审计)→ `export RELAY_DB_URL` → `bash deploy/backup.sh /tmp/review-stage-e/e3/backup` → 起一次性 `postgres:17-alpine` 容器 → `bash deploy/restore-verify.sh <备份目录> <隔离连接串>`。

实测结果:
- **备份**:db dump 541873 bytes;manifest **3 个 DELIVERED 变更集跨 16 schema**(含我种子 schema 与 soak24h——跨 schema 聚合亲证);audit-index 25 行;checksums 生成。
- **恢复**:一次性容器内新建 `relay_restore_v1794391215` → ON_ERROR_STOP 恢复 → 输出亲读:**交付记录 备份 manifest=3 恢复后=3 一致 ✓;审计行(全 schema 合计)65**(= REPORT 时点 60 + 我种子 5 + 累积,口径吻合);**备份校验和全部一致 ✓;RTO 3s、总耗时 3s(秒粒度)✓**。
- 独立复核恢复库:我种子的 1 DELIVERED + 5 审计行逐条在位 ✓。

**脚本安全面**:
- `sha256sum -c` 注入裁决:checksums 文件是 sha256sum 的**数据**而非命令,文件名不经 shell ⇒ **无命令注入**;唯备份目录内攻击者可重写 checksums 自洽——校验和是完整性证明、非抗篡改签名(目录 770/属主缓解;REPORT 未宣称抗篡改,如实)。M4。
- dump 凭据:`pg_dump` 产物为库内 schema+数据,不含连接凭据;唯 `deploy/relay-worker.service` 样例内嵌本地开发口令(localhost-only,低风险)。M5。

## 5. "5 处脚本缺陷 + 1 处组合缺陷"核对(读 diff)

单提交 `05c1473..f149b06` 只含终态,中间态缺陷不可考古(N1);但**五处修正后行为全部亲测生效**:
1. manifest 跨 schema:`backup-manifest.mjs` 按 `information_schema` 聚合——我的演练 16 schema/3 变更集亲证 ✓
2. psql/docker 回退:宿主确无 psql/pg_dump(`command -v` 亲证),backup/restore 均走 docker exec 分支成功 ✓
3. URL dirname:`RESTORE_TARGET_URL="${RESTORE_URL%/*}/$TARGET_DB"` 派生正确,check 脚本连上恢复库 ✓
4. argv 索引:`process.argv[3] ?? argv[2]`,manifest 落盘路径正确 ✓
5. 计时:T0/T1/T2 → "DB 恢复完成:3s / 总耗时 3s" ✓
6. 组合缺陷(supervisor claim):见 §2,VERIFIED。

## 6. 边界与如实性(逐条对照)

- systemd 单元样例**未安装**:`/etc/systemd/system` 无、`systemctl cat relay-worker` 失败——REPORT"仅样例不部署"如实 ✓
- server 仍默认 external:`src/server/index.ts:56` + 结构断言字符串亲 grep(`RELAY_WEB_WORKER === "live"`×1 / `createExternalWorkerDriver`×2 / `worker-entry`×0)✓
- **worker-entry 零第二状态机:通读全文 100 行**——仅组合 `startSupervisorLoop` + `startSafeLoop(driver.tick)` + `appendAudit`;全部 DB 写仅 WORKER_STARTED/STOPPED 审计行,**无任何绕过 core 的任务/运行状态 SQL** ✓
- "工作模式长稳未开跑(模型能力面约束)":soak worker 无 RELAY_PI_*、全程 IDLE_PROVIDER_DOWN——与声明一致,如实 ✓
- "72h 未开跑""不生产部署"如实 ✓

## 7. 发现清单(全部非阻断)

- **M1** `restore-verify-check.mjs` 审计核对为全 schema 总行数(弱口径;audit_events 无 change_set_id 直连列,需经 intent_id 关联)。整库 dump+交付数+校验和三重核对下可接受,建议后续按意图关联逐行核对。
- **M2** `restore-verify.sh` docker 回退分支硬编码容器名 `relay-restore-verify`,usage 行未说明——我首跑命名 `rv-restore-verify` 即 `No such container` 失败。部署包应写入注释。
- **M3** `backup.sh` docker 回退硬编码 `relay-p000-pg`/`relayp000`,忽略 RELAY_DB_URL 的库名——RELAY_DB_URL 指向其它库时会静默备错库。本 VM 成立,移植风险。
- **M4** 校验和=完整性非抗篡改(可自洽重写);如需抗篡改应加签名/带外存校验和。
- **M5** systemd 样例内嵌本地开发口令(localhost-only;建议注释标明"演练口令,勿复用")。
- **M6** `soak-final.json` verdict 用末行 RSS 而非 rssPeakKb 判阈值——本 REVIEW 已独立看峰值(312936<400000 ✓);另采样器重启产生重复表头+24s 缝(原始数据如实,未修饰)。
- **M7** 采样器单发:worker 死亡即 break 写 `completed=false` 的 final 文件,worker 重启后采样不自动恢复——24h 覆盖依赖 worker 不死(截至复核时点已连续存活 ~57min)。

**N(不可证实项,如实登记)**:**N1** "过程修复 4/5 处缺陷"的中间态缺陷本身(无中间提交可考古;终态行为全部亲测生效)。**N2** 24h 长稳结论本身(进行中,本 REVIEW 按合同不判定)。**N3** REPORT 引用的"300s 基线峰值 333MB"属阶段 D 数据,本轮未复测(非本包义务)。

## 8. 结论

**PASS**

- E1/E2(机制面)/E3 全部合同要求经我亲自运行/演练证实;边界声明逐条如实;CI 42997745428 绿;tsc 0。
- 无 Major 缺陷;M1-M7 为非阻断观察项,建议随部署包收编(不要求本包返工)。
- **24h 长稳判定留待观察期满**(复核时点 3432/86400s ≈ 4.0%):由 `soak-final.json`(completed/rssPeakKb/verdict)+ 届时独立复核裁决;任何"24h PASS"表述在 final 文件生成前均属违规。
- 最终 MVP 终判如 REPORT 所述应标注"24h 观察进行中"——与实测一致。
