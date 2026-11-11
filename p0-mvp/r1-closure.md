# R-1 闭环:GitHub 真实写入验收通过(2026-11-12)

- 前提:用户完成 PAT 补权(Repository access 勾选 `pwl1987/relay-delivery-sandbox` + Contents: Read and write;未扩大其他权限;明文未读取/复制/展示)
- 预核验(只读 API):仓库端点 200 + `permissions.push: true` + 所属 pwl1987 ✓
- 验收运行:`npx vitest run test/integration/github-real.test.ts`(代理变量净化后;首跑失败根因=测试进程 git 走坏代理——该测试 P0-ACCEPT 时因凭据缺失从未联网,本闭环首次暴露)

## 验收结果(4 passed / 1 skipped;1 skipped=经典 token 拒用例诚实 skip)

| 收口指令要求 | 结果 |
| --- | --- |
| 真实 main 写入成功 | ✅ 基于真实远端 HEAD 建候选 → DELIVERED(105s) |
| 远端漂移拒绝 | ✅ 外部写者快进推进 main ⇒ Relay 拒绝覆盖(CONFLICT/非 force);远端保持外来头 |
| Commit/Tree/内容三重核验 | ✅ 远端 HEAD==candidate commit + 树逐文件 + API 内容核对(测试内三重) |
| 历史不丢失 | ✅ `base → relay: task t-gh-real attempt 1 → foreign` 只增不减;外来头在顶 |
| 不强推 | ✅ 夹具自证无强推标志(始终执行用例)+ 漂移实验 REJECT_NO_FORCE_PUSH 语义 |

## 独立 API 复核(Reviewer 线外;交付后即时)

- `GET /commits`:base(`a49f4317`)→ relay 交付(`175eb071`,attempt 1)→ foreign(`0dbf08a9`,漂移实验)——顺序与语义吻合
- `GET /git/trees/<HEAD>`:README.md, delivered.txt, foreign.txt, src.txt(交付产物与外来内容共存)
- 日志:`p0-mvp/github-real-closure.log`

## 裁决变更

- **US-08/G6:BLOCKED → VERIFIED**(真实 GitHub 写入/漂移/历史保全全链实证;P0-02B 机制面 + 本闭环运行时面合一)
- 首跑网络失败的运维教训:github-real 类测试须在**代理变量净化环境**运行(与"Node/vitest 不读代理 env"不矛盾——execFileSync git 子进程继承 vitest 进程 env,该文件 git 调用显式带凭据但继承代理变量;宿主代理上游断 ⇒ 首跑 120s 超时)

## 附记:R-2/R-3 收口处置(2026-11-12 本轮;收口指令"VM80 执行 R-2/R-3")

### R-2(授权参数缺失 ⇒ 只出清单,零真模型运行)

- 核对:用户本轮指令未含替代模型/预算/超时/凭据来源任一授权参数 ⇒ 按指令 §2 生成精确待授权清单 **`p0-mvp/r2-pending-authorization.md`**(四项参数表+授权后对照实验设计+消耗明示),**停止真实模型运行、不伪造结果**。
- 本轮零真模型调用(未跑全量 vitest ⇒ A-4 亦零消耗;预算账本未动);R-2 结论维持 **PARTIAL**。

### R-3(中断取证 → 续采 → 期满待终验)

- **中断事实**:两采集进程于 2026-11-12 06:05+0800(观察 **12.53h** 时点)被会话解体 SIGTERM 波及——证据:`worker.log` 末行 `SIGTERM received;graceful stop…`+`stopped`(22:05:08Z);内核日志零 OOM;目录无 soak-final.json ⇒ 采样器与 worker 同波及(非 worker 先死自写 final);末样本 45100s alive=yes。计时起点**未被重置**。
- **续采**(06:10+0800):按原始口径复刻启动(env `RELAY_DB_SCHEMA=soak24h`+`RELAY_WORKER_ID=soak-worker`+无 `RELAY_PI_*`;裸 node;`RELAY_WORKER_INTERVAL_MS=15000`;日志/CSV **只追加**;新表头由验证器①剔除);`setsid` 完全脱离会话进程组(防再被会话解体波及);worker PID 810994 / sampler PID 811916(pid 文件已更新,格式不变)。
- **中断缝如实落账**:45100→45465s(**365s**,06:04:32→06:10:37);中期核验快照 `p0-mvp/soak-24h/verify-interim-20261112T0613+0800.json`:观察未满(45526/86400s)+缝 1 条+pg 采样失败 2 行(= 首实例 docker exec 未通的历史痕迹,REVIEW-stage-e §3② 已核)+RSS 峰值 312936<400000 ✓+3015 拍 tick 全 `IDLE_PROVIDER_DOWN` 零领取 ✓。
- **期满与口径**:期满点 **2026-11-12 17:32:52+0800**(start-epoch 1794389572+86400);到期运行 `node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log` 终验;**存在中断缝 ⇒ 按"缺失样本或中断时保持 PARTIAL"执行,不得改 PASS**;口径仍为"24h 空闲稳定性"。
- 判定影响:R-2 待授权 + R-3 有中断缝 ⇒ **MVP 终判 REWORK 维持**(矩阵 §5 已同步)。
