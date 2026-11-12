# R-3 24h 空闲观察·期满终验收口报告(阶段A;2026-11-12)

- 合同:总执行包第一包(现有最终收口轮,b373726 合同边界)+ 可用 MVP 最终收口大包·阶段A(d3543c2;ADR-0010)
- 事实源:VM80 独立 Runner 产物(verify-final-20261112T1735+0800.json)+ live main;本报告为收口记录,判定权在独立 Reviewer

## 1. 唯一终验快照(独立 Final Runner 859915 于 17:35:28+0800 产出;只读边界未触碰采集进程)

`p0-mvp/soak-24h/verify-final-20261112T1735+0800.json`(stderr 空;verify exit=1=硬异常如实信号,判定权在 REVIEW):

| 项 | 结果 | 对照 |
| --- | --- | --- |
| 观察窗口 | first=32s → last=86432s,**≥86400 ✓** | 真实计时起点 start-epoch=1794389572 未重置 |
| 样本 | 1433(验证器内建剔除 2 处重启表头) | CSV 共 1436 行 |
| **中断缝** | 45100→45465 = **365s,如实保留** | 历史事实,零修改 |
| **PG 采样异常** | **2 行,如实保留**(pg_sampling_failed_rows:2) | 历史事实,零修改 |
| RSS | 峰值 312936KB < 400000 ✓ | 与中期快照一致(无泄漏趋势) |
| CPU | 峰值 4.1% | 空闲负载 |
| 任务领取 | claimedTasks=[] **零领取**;unexpectedTick=[] | 5748 拍全 IDLE_PROVIDER_DOWN |
| errorTicks | 无 | Worker 全程无错误节拍 |
| **硬异常** | sampling_gaps:1 + pg_sampling_failed_rows:2 | ⇒ **终验口径 PARTIAL,不得 PASS**(收口合同既定) |

## 2. 三进程生命周期(核对 + 受控停止)

| 进程 | 结局 | 证据 |
| --- | --- | --- |
| Sampler 811916 | 17:33:41 自退(末样本后自写 soak-final.json 并退出) | soak-final.json present;elapsedSeconds=86432/workerAliveAtEnd=true |
| Final Runner 859915 | 17:35:28 fire→verify→done(唯一快照,单次运行) | final-runner.log:RUNNER fire/done 各一次 |
| Worker 810994 | **17:37:23 SIGTERM 受控停止**,优雅停机铁证落盘 | worker.log:`[relay-worker] SIGTERM received;graceful stop…`→`[relay-worker] stopped`(**注:810994=06:10 续采进程;原始进程 06:05 被会话解体波及,续采历史见 matrix G7 行/CONTINUATION §3 前文**) |

停止前末样本:epoch 1794476004,elapsed 86432,IDLE_PROVIDER_DOWN;停止后三进程 ps 全部退出。

## 3. 结论(按合同)

**旧 R-3 = PARTIAL(历史事实,定格)**:365s 中断缝与 2 次 PG 采样异常如实保留,不修改为 PASS,不重启旧 R-3。
**不再阻断 Usable MVP**——规定原因(ADR-0010 决定 5 原文):"原 R-3 是以空闲 FAIL-CLOSED 为主的稳定性观察,不能充分代表真实业务负载;连续运行验收后移至 Pilot,在真实使用过程中完成。"
连续 24h 验收义务移至 MVP ACCEPTED 后的 PILOT-24H(Operational Readiness Gate);R-3B 独立空闲 24h 暂缓(预置产物 soak-r3b/ 保持未跟踪未启动)。

**并行窗口注记(纠偏合同要求,如实)**:本轮观测后半段(约 10:30 起)与 R-2 F2/F1 有界模型实验(11:0x~11:10)及 WEB-UX 开发活动并行,且主机同期存在部署的生产 Worker(1592938,12:20 起)与 Web 服务(1691536,13:09 起,独立 schema=relay_console);**本轮数据仅作历史稳定性观察(空闲 FAIL-CLOSED 口径),不作 Operational Readiness 认证证据**——Operational Readiness 待 MVP ACCEPTED 后 PILOT-24H 按新口径另行验证。

**收尾时点说明(诚实披露)**:收尾按纠偏合同"F2/F1 结束后执行"于 17:37~进行(实际受控停止 17:37:23,此时观察窗口已于 17:32:52 期满、Sampler 17:33 自退、Runner 17:35 快照落盘——停止动作零影响证据;Worker 停止前 elapsed 已 86432≥86400)。收尾执行窗口与另一会话(WEB-UX 泳道,最后提交 17:23)经活动核查(远端 HEAD 不动+10 分钟零文件活动)后串行执行,零并发写。

## 4. 证据冻结清单(本收口提交)

- 解除 skip-worktree:`samples.csv`(**+1070 行**,git numstat 口径;366→1436)、`worker.log`(**+4305 行**,含 17:37 优雅停机铁证)(**勘误:提交 9ef38bc 消息中"samples.csv+430 行"为笔误,430 为 worker.log 行数,git numstat 为权威口径**)
- 新增入库:`final-runner.log`、`soak-final.json`、`verify-final-20261112T1735+0800.json`、`verify-final-20261112T1735+0800.stderr.txt`
- 保持未跟踪零触碰:`p0-mvp/soak-r3b/`(六文件,暂缓指令)

**tick 计数口径注记(Reviewer m-2)**:快照 JSON 的 5748 拍对应 Runner fire 时点(17:35:28Z+8);冻结版 worker.log 全文 5755 拍(含 17:35:18Z→17:37:03Z 停机间自然追加 7 拍)——两个时点数字均为真;零领取实锤=claimed 非 "-" 行数为 0。

## 5. 环境注记(诚实披露)

- 本机代理栈(127.0.0.1:8118)上游断:git/curl 走 SSH 443 通道;github-real.test.ts 在代理 env 污染下 2 例失败,剥代理后 4/4 全绿(与 soak/本收口无关,如实留账)。
- 采样器重启双表头 2 处由验证器内建剔除(设计行为,非数据丢失);elapsed 沿 start-epoch 不重置。
