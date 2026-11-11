# P0-ACCEPT 交付报告:MVP 最终验收、设计实现一致性审计与缺口裁决

- 状态:**REWORK-CLOSED-PACKAGE**(验收完成;MVP 判定 **REWORK**——三个有界缺口,详见 §6;github-real 2 例 BLOCKED 于 PAT 写权限;推送条件已具备:远端无漂移)
- 合同:`git show 4bd4168:CURRENT.md`(P0-ACCEPT ACTIVE Contract,先于验收独立提交)
- 提交链:`f4c1248`(P0-02C 终态基线)→ `4bd4168`(合同)→ `c407cb0`(缺口 A 收口)→ `c9c53bd`(A-4 真实模型联验)→ `511c2b6`(缺口 F)→ `042b4c5`(生产入口 auth 修复)→ `02c094f`(缺口 E 收口+演练)→ `37d26b4`(报告集)→ 本提交(REPORT 终账/B 修正/CURRENT/CONTINUATION 终态)
- 独立复核:见 `p0-accept/REVIEW.md`(Reviewer 全新上下文亲测复跑,不采信本报告自述)

## §1 验收范围与总账

| 维度 | 结论 |
| --- | --- |
| 六缺口 A~F | A **VERIFIED**(收口+真模型联验)/ B **BLOCKED(PAT 写权限 403;API 读面 VERIFIED)** / C **缺口成立(→REWORK-1)** / D **缺口成立(→REWORK-2;CLI 缺)** / E **VERIFIED(演练 7 项 PASS)** / F **VERIFIED(V19 达成)** |
| PRD 矩阵 | US:6 VERIFIED + 2 PARTIAL + 2 NOT_IMPLEMENTED/缺口 + 3 N/A;V:15 VERIFIED + 2 PARTIAL + 3 N/A;G:6 VERIFIED + 2 PARTIAL/NOT_VERIFIED;F1 PARTIAL / F2 F3 VERIFIED —— 逐项证据见 `prd-coverage-matrix.md` |
| MVP 判定 | **REWORK**(非 ACCEPTED):US-02 P0 最小 Discovery 未实现、US-04 CLI 未实现、US-08 真实 GitHub 写入未验证(网络)——三项均 PRD Must/P0;有界 REWORK 包与顺序见 `gaps-and-next-workpackages.md` |
| 安全收口(本包 3 处,均为验收中实锤的最小修复) | ① live worker 静默降级 host-fallback ⇒ 隔离 FAIL-CLOSED(c407cb0);② PG 断连进程崩溃 ⇒ pool error 收口(02c094f);③ 交付装配失败冒泡 ⇒ D3 落记兜底(c9c53bd);另:auth.ts 参数属性致生产入口无法启动 ⇒ 修复(042b4c5) |

## §2 缺口 A:Live Worker 安全与权限 —— VERIFIED(收口后)

1. **隔离 FAIL-CLOSED**:`src/server/worker.ts`——live(真实模型)执行默认要求 Docker OS 隔离;非 docker 且无 stub 注入 ⇒ `sandbox_not_isolated` 不领取;docker 不可用 ⇒ `docker_unavailable`;无静默降级路径。**收口前实锤**:`index.ts` 原默认值即 host-fallback(缺口 A 指控属实,已修)。
2. **白名单完整传递**:`resolveTaskWhitelist`(worker.ts)从 `tasks.allowed_scope/allowed_commands` 读取 → executeRun spec → 沙箱 env;空 commands ⇒ `[]` 全禁(缺省拒绝)。收口前 runTask 硬编码且 **allowedCommands 根本未传**(DB 白名单永远无效——缺口实证)。
3. **允许与越权双向实证**:允许面=A-4 联验真实模型 `echo`(白名单内)真实成功并 DELIVERED;越权面=pi-e2e 真实容器+真实模型 `/etc/passwd` 被拒(outside_allowed_root)+ command-scope 对抗 8 样本 + parity 12 例。
4. **真实模型联合验证(A-4,Stub 未替代)**:`test/integration/live-worker-e2e.test.ts`(门控:provider+docker+iptables;CI 无模型自动 skip)——Web API 登录→POST /api/goals(经 core planGoal)→ live tick(**docker 容器内真实 magpie 模型** Coder Run 140s)→ 独立 Reviewer(真实模型)ACCEPTED → 本地 bare **DELIVERED**(远端 HEAD==commit)→ **budget_ledger used=6/limit=8,reserved=0**。证据:`p0-accept/live-worker-e2e.log`。

## §3 缺口 B:GitHub 真实远端 —— BLOCKED(PAT 写权限);API 读面 VERIFIED

- **网络实情修正**:本机代理栈(env 8118/1080)上游断,但**直连出口正常**(`env -u http_proxy git ls-remote origin main` 成功;远端 HEAD==f4c1248 无漂移)——早期"网络故障"归类修正;
- PAT 预检 PASS:93B、`github_pat_` 前缀、0600、**API 认证 200**(读面 VERIFIED);
- **写面 403 实证**:`github-real.test.ts` 真实写入与漂移两例 —— `git push` ⇒ **HTTP 403 "Write access to repository not granted"**(executor_error;写入零调用;远端零变化;FAILED 非 DELIVERED——安全失败语义两度实证:401 路径 P0-02B + 403 路径本包);
- 分类纪律:401/403/404/网络四态严格区分(合同要求)——终态=**凭据权限不足**,非网络、非凭据无效;
- 解除条件(用户侧,本包无权替代):为该 fine-grained PAT 补 `pwl1987/relay-delivery-sandbox` 的 Contents RW ⇒ 重跑 github-real 闭环(无需新授权);不采用宽权限 gh token;
- 明细见 `github-delivery-verification.md`(终版)。

## §4 缺口 C:Discovery 与模糊需求 —— 缺口成立(→REWORK-1)

- US-01 确定性面 VERIFIED(J1:原话保留/建议含依据+验证方式/徽章标注规则推导);**模型面 NOT_IMPLEMENTED**(capabilities 诚实登记;页面不伪造 AI);
- US-02(P0 最小:本地代码/文档调查)**完全未实现**——不得以规则化分析冒充模型自主发现;判 REWORK-1(有界,见 REWORK 清单)。

## §5 缺口 D:CLI/API/Web 对等

- **API/Web**:同调唯一 Core ✓(写路径全经 core;读模型 35 SQL 全 SELECT;P0-02C 面未回退);
- **CLI:NOT_IMPLEMENTED**(package.json 无 bin/无 src/cli/无 relay 命令)——PRD Must 明列 ⇒ REWORK-2;
- **pause 入口**:PAUSED 态在转移表但无操作面入口(并入 REWORK-2);
- relay-server 生产入口存在(index.ts)但**从未能真实启动**(auth 参数属性缺陷,042b4c5 修复后才可启动——见 §7);
- relay-worker 独立进程入口未实现(external 占位;部署包)。

## §6 缺口 E:连续自治与故障恢复 —— VERIFIED(观测段)

`p0-accept/procs-e2e.sh` 真实进程演练(E1~E7 全 PASS,证据 `procs-e2e.log`):
E1 生产入口就绪+认证门;E2 Web API 建 Goal;E3 SIGTERM 重启+实体保留;E4 Provider 离线 ⇒ IDLE_PROVIDER_DOWN(零副作用);E5 SIGKILL→重启→DB 事实源+旧会话失效 401;E6 PG 断连 ⇒ 可见降级+恢复自愈+零推进(**收口前实锤:进程崩**);E7 长稳基线 300s(60/60 IDLE,RSS 峰值 333MB<400MB 冻结阈值)。
**24h/72h 长稳未跑满(如实;不宣称通过)**——冻结阈值+起跑基线见 `long-stability-budget.md`;完整长稳归部署包。

## §7 验收中发现并收口的真实缺陷(全部最小修复,零重构)

| # | 缺陷 | 实锤方式 | 收口 | HEAD |
| --- | --- | --- | --- | --- |
| 1 | live worker 生产默认 sandbox=host-fallback(静默降级,非安全边界) | 代码核查 + worker-safety 测试 | tick FAIL-CLOSED + index 默认 docker | c407cb0 |
| 2 | task.allowed_commands 从未传递到执行器(DB 白名单无效) | 传递链核查 + 测试 | resolveTaskWhitelist 完整传递 | c407cb0 |
| 3 | **auth.ts TS 参数属性 ⇒ 生产入口裸 node 启动即崩**(relay-server 此前从未真实启动过) | E 演练首跑(ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) | 显式字段赋值 | 042b4c5 |
| 4 | PG 断连 ⇒ server 进程崩(Pool error 无监听) | E6 首跑(docker stop ⇒ health 000) | pool.on(error) 可见降级 | 02c094f |
| 5 | 交付装配失败异常冒泡出 tick(违反交付层失败语义) | A-4 首跑(delivery_not_captured) | propose try/catch + D3 落记 | c9c53bd |

## §8 测试账(写者侧;全量绿权威口径 = CI 隔离运行)

- 新增测试:worker-safety 4 例 + live-worker-e2e 1 例(门控)+ backup-restore 1 例(门控)= **6 例**;
- 回归亲测(本包内):web-api 12/12、web-app 4/4、goal-loop 6/6、delivery+gate 22/22、E2E 5/5(真 Chromium)、tsc 0;
- **全量终账(无并发窗口,202 用例 = 193 passed + 6 skipped + 3 failed;46 文件,`full-suite.log`)**:
  - 3 failed 全部隔离复跑定性:**egress-proxy 1 例 = magpie 推理服务暂时挂起**(4 个 defunct worker 僵尸;自愈后隔离复跑 **6/6 绿**——环境型,R-9 同源);**github-real 2 例 = PAT 缺沙箱仓写权限(403 实证,BLOCKED 面)**——凭据权限态的如实呈现,非代码回归(CI 无凭据 ⇒ 该 2 例 skip,不影响 CI 绿);
  - 6 skipped = github-real 门禁前置 3 + e2e RELAY_E2E 门 3(既有口径);
- 模型预算:真实模型请求约 14 次(magpie 本地假密钥路由,零真实成本;全部经 budget_ledger;goal limit 8 内结算,未扩大)。

## §9 未验证项与诚实声明

1. **真实 GitHub 写入:BLOCKED(PAT 缺沙箱仓 Contents 写权限,403 实证)**——API 读面 VERIFIED(认证 200);用户补权后重跑 `github-real.test.ts` 闭环;
2. **24h/72h 长稳:未跑满**(300s 基线;冻结阈值已交付);
3. **CI e2e/test job 对本包新增代码**:推送前无法验证(网络阻断;推送后以 CI 为最终门);
4. T01 模型级 prompt injection 语料测试未做(结构层防线已证;登记);
5. 本包**未发生**:生产部署、公网暴露、RSI、GitHub 权限扩大、模型预算扩大、其他仓库/分支/强推(diff 与凭据面可证;src/ 无新增 child_process 面)。

## §10 裁决

**MVP 判定:REWORK**(非 ACCEPTED;非整体 BLOCKED)。安全与 P0 机制面已大面积 VERIFIED 且证据真实;三个有界缺口(Discovery/CLI/真实 GitHub 写入)按 `gaps-and-next-workpackages.md` 顺序消化:REWORK-2(CLI,零依赖)→ REWORK-1(Discovery)→ 网络恢复后 github-real 闭环 → 部署包+长稳。所有阻断关闭后方可裁 MVP ACCEPTED。
