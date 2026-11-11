# Relay 当前执行契约

- 状态:**P0-ACCEPT REWORK-CLOSED-PACKAGE / IDLE(下一包 NOT_ACTIVE,待用户授权)**。完成:2026-11-11。终态以远端 `main` 为准(fast-forward 推送;推送前已核对远端无漂移)。
- 写者:**无 ACTIVE Writer**(P0-ACCEPT 写者随本包收尾释放)。
- 本包性质:验收与差距裁决包(合同 `git show 4bd4168:CURRENT.md`);以验证/审计/裁决为主,仅 3 处验收实锤的最小安全收口 + 1 处生产入口修复,零业务内核重构。

## 验收终账(全部证据绑提交链 `4bd4168..02c094f`;报告集见 `p0-accept/`)

- **MVP 判定:REWORK**(非 ACCEPTED;非整体 BLOCKED)——三个有界缺口:①US-02 P0 最小 Discovery 未实现(→REWORK-1);②US-04 CLI 未实现(→REWORK-2);③真实 GitHub 写入 BLOCKED(PAT 缺沙箱仓 Contents 写权限,git push 403 实证;API 认证 200——需用户补权后重跑 github-real,无需新授权)。
- **缺口 A VERIFIED**:live worker 隔离 FAIL-CLOSED(收口前生产默认即静默 host-fallback——指控属实,已修)+ 白名单完整传递(收口前 allowed_commands 从未传到执行器——已修)+ 允许/越权双向实证 + **真实模型联验 PASS**(Web/API→core→worker→docker 真模型 Coder 140s→真 Reviewer ACCEPTED→DELIVERED;ledger 6/8;Stub 未替代)。
- **缺口 E VERIFIED**:真实进程演练 E1~E7 全 PASS(SIGTERM/SIGKILL 重启恢复、Provider 离线 IDLE、PG 断连可见降级+自愈、300s 长稳基线 RSS 333MB);**24h/72h 长稳未跑满(如实;冻结阈值已交付)**。
- **缺口 F VERIFIED(V19 MVP 发布 Gate 达成)**:pg_dump→隔离一次性 PG 容器恢复→13 表全实体摘要一致→外部 Git 不变。
- **缺口 C/D 裁决**:模型发现/推荐诚实 NOT_IMPLEMENTED(不冒充);CLI 无 bin/pause 无入口;三入口中 API/Web 同调 Core ✓。
- **验收实锤修复 4 处**(最小,零重构):①worker 隔离 FAIL-CLOSED(c407cb0);②auth.ts 参数属性致**生产入口从未能启动**(042b4c5);③PG 断连进程崩(02c094f);④交付装配失败冒泡→D3 兜底(c9c53bd)。

## 测试与复核

- 全量(无并发窗口):**202 用例 = 193 passed + 6 skipped + 3 failed(48 文件)**;3 failed 隔离复跑定性:egress-proxy 1 例 = magpie 推理**间歇**挂起(写者时点隔离 6/6 绿、复核时点复现超时——环境型 R-9 同源,CI 无 magpie 不受影响);github-real 2 例 = PAT 写权限 403(BLOCKED 面,CI 无凭据自动 skip 不影响 CI 绿)。新增 6 例(worker-safety 4 + live-worker-e2e 门控 1 + backup-restore 门控 1);tsc 0;E2E 5/5。
- 模型预算:真实模型约 14 次(magpie 本地假密钥路由,零真实成本;全部经 budget_ledger,limit 8 内;零扩大)。
- 独立复核:见 `p0-accept/REVIEW.md`(Reviewer 全新上下文亲测)。

## 遗留检查单(结转 + 本包新增)

1. **真实 GitHub 写入(用户侧单点)**:为 fine-grained PAT 补 `pwl1987/relay-delivery-sandbox` **Contents RW** → `npx vitest run test/integration/github-real.test.ts` 闭环(无需新授权);禁宽权限 gh token。
2. **REWORK-1 模型驱动 Discovery(US-02 P0 最小)**:Goal 创建后一次真实模型分析(问题陈述/假设/风险/推荐/待决),可回放记录;失败如实降级规则面并标注。
3. **REWORK-2 最小 CLI(US-04/V03)**:src/cli.ts + bin;goal create/list/show、decision list/resolve/defer、task resume、worker tick、**pause(补入口)**、doctor;同调 Core。
4. 部署包:relay-worker 独立入口/周期 tick 编排/备份参数/24h~72h 长稳(阈值已冻结 333MB 峰值基线)。
5. 本机代理栈(env 8118/1080)上游断:宿主运维项(直连正常,不影响 CI/推送)。
6. 登记遗留维持:R-2(XFF 限速键)/R-5(Origin:null)/T01 模型级注入语料化/stage 仓回收/base 纵深(F-12)/toolEvents 对真实 pi 事件流为空(以 workspace tool-audit 权威,宿主副本落 detail 并入 REWORK-1)。

## 下一唯一建议:REWORK-2(最小 CLI,NOT_ACTIVE,待授权)

零依赖、直接闭合 US-04/V03 的 MVP Must 面;其次 REWORK-1(Discovery,依赖本地 magpie);github-real 随用户补权随时闭环。
