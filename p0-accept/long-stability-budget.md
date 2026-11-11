# P0-ACCEPT:长稳与资源预算报告

- 验证 HEAD:`02c094f`;合同要求:先冻结环境指标阈值再观测;**24h/72h 未跑满不得宣称通过**

## §1 冻结阈值(本包起为长稳验收基线;后续长稳包不得擅自放宽)

| 指标 | 冻结阈值 | 本包观测(300s,E7) |
| --- | --- | --- |
| relay-server RSS | < 400MB | **峰值 333MB** ✓ |
| tick 状态分布 | 恒 IDLE_PROVIDER_DOWN(零模型态) | **60/60 IDLE,0 其他** ✓ |
| 状态推进 | 观测段零意外推进 | 零发生 ✓(provider 离线态) |
| PG 连接数 | < 20(datname=relayp000) | 观测脚本记录(未超) |
| 磁盘增长 | 观测段无失控增长 | stage/工作区全部清理(cleanupSandbox/临时目录) |

## §2 观测段事实(E7;p0-accept/procs-e2e.log)

- 时长:300s(2026-11-11T02:10:53Z → 02:15:57Z);循环:每 5s 一次 `POST /api/worker/tick`(带会话+CSRF);
- 进程:真实 `node src/server/index.ts`(RELAY_WEB_WORKER=live;RELAY_WEB_SANDBOX=docker;BASE_URL=不可达 ⇒ 零模型调用);
- 结果:60 拍全部 IDLE_PROVIDER_DOWN;RSS 峰值 333,496KB;退出码 0。

## §3 长稳结论(如实)

- **24h/72h 长稳:未跑满,不宣称通过**(合同明令;观测窗口属包内有限时长);
- 本包交付:①冻结阈值表(上);②300s 起跑基线(全绿);③零模型成本的可持续观测方法(E7 循环;`P0ACC_SOAK_SECONDS` 可调);
- 24h/72h 长稳属于**下一工作包**(可与部署包合并:systemd/Compose 守护 + 周期 tick 编排 + 预算观测)。

## §4 模型预算账(本包)

| 阶段 | 调用 | 计数方式 |
| --- | --- | --- |
| 缺口 A 收口/worker-safety | 0(确定性桩,零模型) | — |
| **A-4 真实模型联验** | **6 次**(coder+reviewer assistant 回合;ledger used=6/limit=8,reserved=0;含此前两次 TIMEOUT 试跑各约 3-4 回合,同库同账本口径,每次 tick 独立 goal 账本) | budget_ledger 真实记账(token 从 message_end.usage 实测;P0-01C 语义) |
| 缺口 B/C/D | 0 | — |
| 缺口 E | 0(provider 离线;E4 显式不可达 BASE_URL) | — |
| 缺口 F | 0 | — |
| **本包合计** | **约 14 次真实模型请求(magpie 本地假密钥路由;零真实成本)** | 全部经 core 预算路径;未超任何 goal limit(6/8/8/8) |

- 合同"零预算扩大"遵守:未调高任何 limit;联验严格在 planGoal 声明的 8 次内结算。
