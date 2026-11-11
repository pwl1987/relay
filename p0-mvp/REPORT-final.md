# Relay 总执行包最终报告(MVP 收敛与最终验收)

- 收官 HEAD:`e39ed68`(CI `43010653575` test+e2e 双绿;远端 main == HEAD == clean)
- 总包提交链:`3069aa1`(P0-ACCEPT 终态)→ `382edf7/…/3a4b10a`(阶段 A)→ `8880528/…/7e20bc4 前的 B 链`(阶段 B)→ `710d596`(阶段 C)→ `ba967f3/…/7f6f6c7`(阶段 D)→ `05c1473/…/a8adcab`(阶段 E)→ 终版矩阵/终审/处置(`7e20bc4`/`e39ed68`)——共 20 个提交,全部 main 快进,零强推
- 日期:2026-11-11;执行者:唯一 Writer(本窗口);独立 Reviewer:每阶段全新上下文亲测

## 一、六阶段实际完成情况

| 阶段 | 内容 | 终态 | 独立复核 |
| --- | --- | --- | --- |
| A REWORK-2 | 最小 CLI+pauseTask+API pause+doctor+退出码 | **CLOSED;US-04/V03 VERIFIED** | PASS-WITH-FIXES(M1 RUNNING-pause/M2 defer 无门→均修) |
| B REWORK-1 | 模型驱动 Discovery(discoveries 表/只读会话/三入口/徽章) | **CLOSED;US-01/02 P0 VERIFIED(含方差披露)** | PASS-WITH-FIXES(M1 egress/M2 复现+断言/M3 审计路径→均修) |
| C GitHub 补验 | 逐项权限核查 | **BLOCKED(仓库不在 PAT 范围;用户侧单点)** | —(事实核查;根因较 P0-ACCEPT 前置修正) |
| D F1/F2/F3+清理安全 | 业务级 Fixture+真模型注入语料化+safeRm 守卫 | **CLOSED;机制 VERIFIED/真模型交付 PARTIAL** | PASS-WITH-FIXES(M1 sentinel 必填/M2 接入补全→均修) |
| E 编排/长稳/备份 | relay-worker 入口+24h 采集启动+Artifact 恢复 | **E1/E3 VERIFIED;E2 观察进行中** | **PASS**(7 Minor 处置) |
| F 终审 | 覆盖矩阵重生成+八件事亲测+终判 | **REWORK 维持** | **REWORK 维持(Reviewer 独立意见一致)**+2 Major 已修 |

## 二、PRD 最终覆盖矩阵

见 `p0-mvp/final-coverage-matrix.md`(基线 `p0-accept/prd-coverage-matrix.md` + 六阶段增量;每项六态+证据 SHA)。要点:
- **升级为 VERIFIED**:US-01/US-02(模型 Discovery 真模型)、US-04/V03(CLI)、V01/V03/V14(T01 语料化)、V19(Artifact 级)、G0。
- **维持 BLOCKED**:US-08/G6(真实 GitHub 写入;根因=仓库不在 PAT 授权范围——比基线"缺 Contents RW"更前置,已修正口径)。
- **维持 PARTIAL**:F1/F2(机制 VERIFIED+真模型业务修改 PARTIAL)、G7/长稳(24h 观察进行中)、US-09(观察项单列)。
- **NOT_IMPLEMENTED 如实**:公网 Search/Crawler(P1)、多仓/Runtime 切换/RSI(P1/P2)。

## 三、真实模型 Discovery 演示与证据

- magpie 本地路由(127.0.0.1:3425,假密钥零真实成本);每轮预算事前声明+账本 reserve/settle(REVIEW 亲验 5 轮精确核算)。
- 演示实录:模糊 UX 需求 → 报告准确识别全部四项页面缺陷+可判定验收(`p0-mvp/f1/discovery.json`);不合理方案可核查反驳;不完整需求→可判定验收;预算耗尽 `budget_turns_cap` 诚实止损;**Reviewer 终审自建全新需求验证(58s,精确命中自建项目缺陷,非过拟合)**。
- 全部记录持久化(discoveries+runs+SHA),零聊天上下文依赖。

## 四、CLI/API/Web 联合验收

- CLI 七组命令+确定性退出码(0/1/2/3/4/5)+doctor(凭据零明文);V03 无浏览器无 ChatGPT 全程演练;三入口同 Core(REVIEW 亲验零第二状态机、零直接状态 SQL);pause 阻断领取实证;SIGKILL 恢复。

## 五、GitHub 远端交付结果

- 机制面(本地 bare 全链):VERIFIED(J4/A-4/F1/F2 多链 DELIVERED;policy 白名单/非 force/漂移拒/历史只增)。
- 真实 GitHub 写入:**BLOCKED**——fine-grained PAT 仓库范围未含 `relay-delivery-sandbox`(72 可见仓库无此仓;token 本体有效)。安全失败语义多度实证(零写入/FAILED 非静默)。
- **用户侧单点动作**:GitHub → Fine-grained PAT → Repository access 勾选沙箱仓+Permissions Contents RW → `npx vitest run test/integration/github-real.test.ts` 闭环(无需新授权)。

## 六、三类 Fixture 实际运行记录

- F1(模糊 UX):基线负对照 3/4 失败实锤 → 真模型 Discovery ✓/coder 方差 PARTIAL(零编辑→机判拒+REWORK 实锤)→ stub 显式标注机制链 DELIVERED+独立复核 ✓。
- F2(真实 Bug):基线 A1/A2 失败实锤 → 真模型 PARTIAL → stub 机制链一次过+独立 HTTP 复核 4/4。
- F3(越权/故障):八项既有实锤盘点(`f3-matrix.md`)+T01 真模型注入语料化(目录 SHA 零变化/审计如实/语料当数据;Reviewer 变体亲测非过拟合)。

## 七、安全与故障注入

- D4 safeRm 中央守卫(纯逻辑;sentinel 必填;六类拒绝面+symlink 逃逸;运行时 3+测试 ~17 处接入);本轮实锤"权限碰巧不足不是安全"转化为可回归守卫。
- 累计注入矩阵:P0-ACCEPT 15 项 + 阶段 D/E 增量(RUNNING-pause 拒/两环路争抢修正/CLI 越权拒/CI 环境差/脚本缺陷 9 处)——**总包期间验收实锤并修复 20+ 处真实缺陷**(见各阶段 REPORT"过程发现"节),独立复核体系四轮(Major×9 全部修必)。

## 八、备份及 Artifact 恢复

- E3:整库 dump(414KB)+跨 schema Artifact manifest+audit 索引+校验和 → 干净隔离容器恢复 → 交付 1/1 一致+全 schema 审计+校验和全对;RTO 秒级;Reviewer 从零复演(3/3+65 审计行+RTO 3s)。

## 九、长稳报告及未完成观察项

- **24h 空闲观察进行中(真实计时;收稿时 ~6500s/86400s)**:`p0-mvp/soak-24h/`(worker 真实进程+每分钟采样;稳态 RSS ~110-117MB≪400MB 阈值;tick 全 IDLE_PROVIDER_DOWN FAIL-CLOSED 空转;采样器到点自动写 soak-final.json,**未满不写 PASS**)。
- 工作模式长稳:未开跑(受 magpie 能力面约束;300s 基线为代表);72h 未开跑(依赖 24h 完成)。

## 十、预算

- 模型调用:全部 magpie 本地(零真实成本);每轮事前声明+账本核算(Discovery ~40 次/F1 三声明 30 上限/F2 10/F3 8/终审自验 6);零超预算;零预算扩大授权(声明制)。
- CI:public 仓库 GitHub 托管 runner,免费无额度限制(本轮共 ~12 runs)。

## 十一、独立 Reviewer 终判

- 阶段 F 终审(`p0-mvp/REVIEW-final.md`):八件事逐项亲测——①模型理解 VERIFIED/②无人介入安全 VERIFIED/③GitHub BLOCKED 成立/④Reviewer 否定权 VERIFIED/⑤重启保真 VERIFIED/⑥三入口 VERIFIED/⑦假绿排查诚实/⑧越权泄露危险清理 VERIFIED。
- **终判:REWORK 维持,不得 ACCEPTED**(Reviewer 独立意见与 Writer 一致)。三条理由(全部亲证):①US-08/G6 用户凭据单点;②F1/F2 真模型业务交付 PARTIAL(需更强模型路由);③24h 观察未满。

## 十二、未解决问题及后续最小工作包

| # | 包 | 解除条件 | 预估 |
| --- | --- | --- | --- |
| R-1 | github-real 闭环 | 用户为 PAT 勾选沙箱仓+Contents RW → 一条命令 | 分钟级 |
| R-2 | F1/F2 真模型交付闭环 | 用户授权非 magpie 模型路由(链路已就绪) | 模型可用后 1 包 |
| R-3 | 长稳判定 | 24h 期满 → soak-final.json → REVIEW 确认;72h 视需 | 24h 真实等待 |
| R-4 | ~~终审 2 Major~~ | **已修**(e39ed68) | — |
| R-5 | 登记遗留 | R-2(XFF)/R-5(Origin:null)/哨兵伪造面纵深/decision not_found 映射/systemd 实装+部署参数(部署包) | 随部署包 |

## 十三、事实源同步

- `CURRENT.md`:总包收官终态(本轮完成账+观察项+待授权清单)
- `docs/CONTINUATION.md`:新窗口续接指令(更新)
- GitHub Issues:任务追踪(由后续窗口按需同步;本包证据以仓库文件为准)
