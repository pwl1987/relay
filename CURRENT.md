# Relay 当前执行契约

- 状态:**总授权执行包(六阶段)收官 · IDLE(下一包 NOT_ACTIVE,待用户授权或用户侧动作)**。完成:2026-11-11。
- 终态:远端 main == HEAD == `e39ed68`(CI `43010653575` 双绿);**24h 长稳采集持续进行中**(`p0-mvp/soak-24h/`;未满不写 PASS)。
- **MVP 终判:REWORK 维持**(独立 Reviewer 意见一致;`p0-mvp/REPORT-final.md` §十一)——非 ACCEPTED 依据:①真实 GitHub 写入 BLOCKED(用户凭据单点);②F1/F2 真模型业务交付 PARTIAL(需更强模型路由);③24h 观察未满。机制面(安全/恢复/机判/预算/清理/编排/恢复)全部 VERIFIED 且经四轮独立复核亲测。
- 写者:**已释放**。

## 本轮(总包六阶段)完成账

| 阶段 | 交付 | 复核 |
| --- | --- | --- |
| A(REWORK-2) | CLI 七组命令+pauseTask+API pause+doctor+退出码;V03 VERIFIED | PASS-WITH-FIXES 修必 |
| B(REWORK-1) | Discovery(discoveries 表/只读会话/三入口/来源徽章);US-01/02 P0 VERIFIED | PASS-WITH-FIXES 修必 |
| C(GitHub) | 逐项核查 ⇒ BLOCKED(仓库不在 PAT 范围;根因较基线修正) | 事实核查 |
| D(F1/F2/F3+D4) | 业务级 Fixture+机判双证+T01 真模型语料化+safeRm 中央守卫 | PASS-WITH-FIXES 修必 |
| E(编排/长稳/备份) | relay-worker 独立入口(唯一调度权威)+systemd 样例+24h 采集启动+Artifact 级备份恢复演练 | **PASS** |
| F(终审) | 终版矩阵重生成+八件事亲测+REWORK 维持+2 Major 修复 | REVIEW-final(终判一致) |

- 测试终账:全量 **240 = 223 passed + 15 skipped + 2 failed**(53 文件;2 fail=github-real 403 凭据面,CI 自动 skip);tsc 0;E2E 5/5;CI 双绿链(`42965135078`→`43010653575` 全 success)。
- 过程实锤修复 20+ 处真实缺陷(含 server schema 不对等/env 污染/两环路争抢/safeRm 三冲突;全部有回归,见各阶段 REPORT)。
- 模型预算:全程 magpie 本地零真实成本;每轮事前声明+账本精确核算;零超预算。

## 解除 REWORK 的最小动作(全部有界)

1. **R-1(用户侧)**:GitHub → Fine-grained PAT → Repository access 勾选 `pwl1987/relay-delivery-sandbox` + Contents: Read and write → `npx vitest run test/integration/github-real.test.ts` 闭环(无需新授权;禁宽权限 gh token)。
2. **R-2(用户授权模型)**:为业务修改授权非 magpie 模型路由(链路已就绪:F1/F2 门控测试即真模型闭环验收)。
3. **R-3(时间)**:24h 期满 → `p0-mvp/soak-24h/soak-final.json` 自动判定 → REVIEW 确认;72h 视需。
4. 完成后重生成终版矩阵 + 独立 Reviewer 复核 → 方可改判 ACCEPTED(不得以 CI 绿代替)。

## 遗留(登记,不阻断 REWORK 判定)

公网 Search/Crawler(P1,NOT_IMPLEMENTED)/R-2 XFF/R-5 Origin:null/哨兵伪造面纵深(可写面内;当前无可利用路径)/decision not_found 映射/systemd 实装+部署参数(RPO/RTO/Retention=部署包)/工作模式长稳(依赖 R-2)/本机代理栈上游断(宿主运维;git 走 ssh.github.com:443)/soak 采样器单发(worker 重启需人工重挂)。

## 唯一事实源

`p0-mvp/REPORT-final.md`(总报告)+ `p0-mvp/final-coverage-matrix.md`(矩阵)+ 各阶段 `REPORT/REVIEW`。新窗口从 live main 冷启动;24h 观察期间不重启 soak 两个进程(worker PID 见 `soak-24h/worker.pid`、sampler PID 见 `sampler.pid`)。
