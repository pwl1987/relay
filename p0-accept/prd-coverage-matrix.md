# P0-ACCEPT:PRD 全覆盖审计证据矩阵

- 审计对象:live main `02c094f`(P0-ACCEPT 提交链:`4bd4168` 合同 → `c407cb0` 缺口 A 收口 → `c9c53bd` A-4 联验 → `511c2b6` 缺口 F → `042b4c5` 生产入口修复(auth)→ `02c094f` 缺口 E 收口+演练)
- 基线:`f4c1248`(P0-02C 终态)及其全部历史包证据
- **六态定义**:VERIFIED(真实证据亲测)/ PARTIAL(部分真实证据,缺口明列)/ NOT_IMPLEMENTED(能力不存在,如实)/ NOT_VERIFIED(实现存在但未获运行时证据)/ BLOCKED(外部阻断)/ NOT_APPLICABLE(P0 MVP 范围外)
- 纪律:不以测试数量代替覆盖率;不以 Mock/Stub 冒充真实能力;Stub 只佐证机械面并显式标注。

## §1 用户故事(US-01~US-13)

| 项 | 裁决 | 证据(文件:行 / 测试 / 日志;产出/验证 HEAD) |
| --- | --- | --- |
| US-01 模糊目标(P0) | **PARTIAL** | 确定性面 VERIFIED:原话保留+建议含依据/验证方式+可判定条件——`test/e2e/web-journey.test.ts` J1(真 Chromium;`p0-02c/e2e-journey.log`,HEAD 4c8118e);能力表 `goal.analysis.deterministic`(`src/server/capabilities.ts:41`)。缺口:模型自主理解/假设生成未实现——`goal.discovery.model`/`goal.recommendation.model` NOT_IMPLEMENTED(`capabilities.ts:48/55`;J1 页面徽章「确定性规则推导(非模型)」)。本包复验:同代码链,见 C 项审计 |
| US-02 主动质疑与调研(P0 最小) | **NOT_IMPLEMENTED** | 无模型调研/质疑/回放路径;能力表诚实登记 NOT_IMPLEMENTED(`capabilities.ts:48`);Goal 页 model-analysis-notice 显式「未实现」(`web/goal.js`;J1 截图)。**裁决:缺口成立 → REWORK-1(见 §6)** |
| US-03 有界工作包(P0) | **VERIFIED** | V02 作用域双层矩阵 12 例(`test/integration/extension-policy-parity.test.ts`)+ 命令白名单对抗 8 样本(`test/integration/command-scope.test.ts`,P0-01C);白名单**完整传递链**(DB→worker→spec→沙箱 env)本包收口:`src/server/worker.ts: resolveTaskWhitelist` + `test/integration/worker-safety.test.ts`(HEAD c407cb0);真实越权实拒:`test/integration/pi-e2e.test.ts`(真实容器+真实模型,/etc/passwd ⇒ outside_allowed_root,P0-01B) |
| US-04 控制(P0) | **PARTIAL** | API 全通(创建/查看/审批/恢复/推进;`test/integration/web-api.test.ts` 12 例);Web 四页(J1..J5);resumeTask/resolveDecision/deferDecision ✓。缺口:**CLI 未实现**(package.json 无 bin、无 src/cli、无 relay 命令——本包核查证据);**pause 入口未实现**(lifecycle 转移表有 PAUSED 态 `src/core/lifecycle.ts:42/63`,但无任何操作面置入)。→ REWORK-2(CLI 最小入口)/登记 pause |
| US-05 断线恢复(P0) | **VERIFIED** | 库级:P0-01A V04(SIGKILL→fencing→重领)、P0-01B run-crash-recovery/run-lease-loss;进程级(本包):`p0-accept/procs-e2e.log` E5(SIGKILL→重启→DB 事实源→旧会话失效 401,HEAD 02c094f);恢复=context_rebuild 纯 DB 重建(不承诺模型隐状态 ✓) |
| US-06 决策超时(P0) | **VERIFIED** | D3 永不自动批准:源码自证单测 + web-api 反例5(EXPIRED_STILL_BLOCKED)+ J2(D3 卡住他人推进)+ deferDecision 仅改 deadline(P0-02C);本包 E2 演练复核决策面未变 |
| US-07 独立质量门(P0) | **VERIFIED** | gate-e2e 真模型全闭环(`test/integration/gate-e2e.test.ts`,P0-02A);fake-self-approve 拒(反例);V09 绑定失效(`test/integration/gate-binding.test.ts`);**本包 A-4 联验:真实 Reviewer(真实模型)独立裁决 ACCEPTED**(`p0-accept/live-worker-e2e.log` HEAD c9c53bd:"result.txt 内容 sum=87 与 brief.txt 中三数 12+30+45 的正确和一致…满足需求且无缺陷") |
| US-08 GitHub 安全集成(P0) | **NOT_VERIFIED**(真实 GitHub 写入)/ VERIFIED(交付链机械面) | 交付链到远端:本地 bare 全通(J4 + A-4 联验 DELIVERED,远端 HEAD==commit);Policy 白名单/userinfo 拒/非 force(P0-02B 补验);漂移拒绝:intent-drift/外部写者快进(P0-02A/02B);**真实 GitHub 写入未验**——凭据形态预检 PASS(93B github_pat_ 0600)但出口网络故障(HTTP 000/超时,BLOCKED);此前已实测真实远端**安全失败**路径(401 ⇒ FAILED 非 DELIVERED,写入零调用,`p0-02b/github-api-verification.log`)。→ 随网络恢复跑 `github-real.test.ts` 闭环(无需新授权) |
| US-09 持续运行与预算(P0) | **VERIFIED** | 预算账本 FAIL-CLOSED+先预留再执行+回合硬顶(P0-01C C-2,c1/budget 测试);V11 退避/熔断(`goal-loop.test.ts` 6/6);V15 IDLE 不烧 token;**本包 A-4:ledger used=6/limit=8/reserved=0 真实计数**;本包 E4:provider 离线 tick IDLE_PROVIDER_DOWN |
| US-10 真实交付可见(P0) | **VERIFIED** | 四页面+三 SHA 分列+Gate+交付状态+运行记录(V12 J1..J5 Playwright 真浏览器,`p0-02c/`);A-4 联验同链真实 DELIVERED |
| US-11 多仓 ChangeSet(P1) | **NOT_APPLICABLE** | P0 MVP 范围外(PRD §6 Should) |
| US-12 Runtime/模型切换(P1) | **NOT_APPLICABLE** | 同上 |
| US-13 Self-improvement 提案(P1/P2) | **NOT_APPLICABLE** | 同上;且验收包边界明令禁 RSI |

## §2 验证矩阵(V01~V20)

| 项 | 级别 | 裁决 | 证据 |
| --- | --- | --- | --- |
| V01 模糊输入(US-01/02) | P0 Gate | **PARTIAL** | J1(确定性面)+ 模型面 NOT_IMPLEMENTED(同 US-01/02) |
| V02 越权文件写(US-03) | P0 BLOCK | **VERIFIED** | parity 12 例 + realpath 符号链接逃逸阻断 + DENIED 审计;真实容器 pi-e2e 越权拒 |
| V03 无 ChatGPT 完整案例(US-04) | P0 Gate | **PARTIAL** | API/Web 全链真通(web-api 12 例 + J1..J5 + A-4 Web 入口联验);**CLI 面缺**(US-04 缺口);控制面不依赖浏览器长连接 ✓(HTTP 无状态会话) |
| V04 Worker SIGKILL 恢复(US-05) | P0 Gate | **VERIFIED** | P0-01A v04 全链 + P0-01B crash-recovery + 本包 E5(真实进程) |
| V05 丢响应不双重写(T06) | P0 BLOCK | **VERIFIED** | P0-01A v05-lost-receipt(EXECUTING 窗口 SIGKILL→SIDE_EFFECT_CONFIRMED→不重推)+ v05-reexecute-safe(恰一次) |
| V06 并发 fencing(NFR-02) | P0 BLOCK | **VERIFIED** | P0-01A B1(6 并发恰 1 赢家)+ B2(fencing 单调/旧 token 拒) |
| V07 D3 超时+并行任务(T07) | P0 BLOCK | **VERIFIED** | J2 + web-api 反例5 + D3 永不自动批准源码自证;多任务独立推进(stub 多任务链) |
| V08 虚构 DONE/Reviewer 阻断(T10) | P0 Gate | **VERIFIED** | fake-self-approve 反例(围栏独立性校验拒)+ v08 gate_not_passed 门锁 + garbage-review 路径 |
| V09 修改候选后旧 Gate 失效(US-07) | P0 Gate | **VERIFIED** | gate-binding.test.ts(绑定版消费/旧 PASS 不跨 attempt/候选) |
| V10 远端 HEAD 改变(T04) | P0 BLOCK | **VERIFIED** | intent-drift(CONFLICT+REJECT_NO_FORCE_PUSH)+ 外部写者快进测试 + 历史未丢断言(P0-02B 补验);夹具零强推(剥注释自证) |
| V11 相同错误重复(US-09) | P0 Gate | **VERIFIED** | goal-loop.test.ts(退避/熔断/attempt 预算);回合硬顶(budget_turns_cap) |
| V12 Web 真实交互(US-10) | P0 Gate | **VERIFIED** | J1..J5(Playwright 真 Chromium;渲染值==PG;截图 8 张;`p0-02c/`) |
| V13 服务重启 smoke(US-07) | P0 Gate | **VERIFIED** | 本包 E1/E3/E5(真实进程重启 smoke;health/登录/实体) + CI test job(PG16 service) |
| V14 injection/绕过/密钥(T01-T03) | P0 BLOCK | **VERIFIED(结构层)** | 双层隔离(docker cap-drop/uid 10001/无 socket 无凭据 env)+ scrubExecEnv 剥凭据 + 密钥隔离代理(容器零真实 key)+ 工具边界不依赖提示词。注:模型级 prompt injection 语料化测试未做——防线在结构层(工具白名单+OS 隔离+Policy 服务端执行),如实注明 |
| V15 无任务/Provider 离线(US-09) | P0 Gate | **VERIFIED** | providerProbe 早退不领取(goal-loop)+ IDLE 语义 + 本包 E4(真实进程 provider 离线 tick) |
| V16 多仓部分失败(US-11) | P1 | **NOT_APPLICABLE** | P0 范围外 |
| V17 Runtime/弱模型切换(US-12) | P1 | **NOT_APPLICABLE** | P0 范围外 |
| V18 自改候选(US-13) | P2 | **NOT_APPLICABLE** | P0 范围外(RSI 禁令) |
| V19 备份恢复(数据) | **MVP 发布 Gate** | **VERIFIED** | 本包缺口 F(HEAD 511c2b6):pg_dump(23819B)→ **隔离一次性 PG 容器**恢复(ON_ERROR_STOP 零错误)→ 13 表行数+全行摘要 md5 两库一致 → 外部 Git HEAD 不变(`p0-accept/backup-restore-run.log`);非简单重启 |
| V20 锁冲突/脏 worktree(治理) | P0 BLOCK | **VERIFIED** | P0-02B 夹具零强推自证 + 单 Writer 会话纪律(本包全程 main 快进链)+ AGENTS 规则;V20 的"人为锁冲突"场景由 fencing(V06)+intent-drift(V10)覆盖 |

## §3 门矩阵(G0~G7)与 Fixtures(F1~F3)

| 项 | 裁决 | 证据/缺口 |
| --- | --- | --- |
| G0 Requirement | **PARTIAL** | 目标/验收可判定 ✓(planGoal FAIL-CLOSED + 建议 verifiableBy);模型假设/调查缺(同 US-02 → REWORK-1) |
| G1 Impact | **VERIFIED** | scope 交集核验(candidate_changesets.impact_scope)+ Policy 白名单 + 命令白名单传递(本包收口) |
| G2 Build | **VERIFIED** | tsc 0(各包+本包);CI test job 绿(f4c1248 run 42819458010);真实 exit 落证据 |
| G3 Independent Review | **VERIFIED** | 各包 REVIEW.md 独立 Reviewer 两轮制;本包 REVIEW 待落(§6 流程) |
| G4 Test | **VERIFIED** | Vitest 全量(本包终账见 REPORT §测试账)+ 独立 schema 真实 PG |
| G5 Reality | **VERIFIED** | J1..J5 真浏览器 + A-4 真实模型/docker/交付联验 + E 进程演练(非静态截图/非 Mock) |
| G6 Release | **NOT_VERIFIED** | 真实 GitHub 发布面(同 US-08);本地 bare 交付的授权/预期 SHA/回滚面 VERIFIED(P0-02B);**真实远端写入随网络恢复补验** |
| G7 Runtime | **PARTIAL** | 心跳/健康/故障恢复记录 ✓(E 演练 + A-4);**长稳 24h/72h 未跑满**(如实:本包交付冻结阈值+300s 起跑基线,RSS 333MB<400MB、tick 60/60 IDLE)→ 长稳报告 |
| F1 模糊 UX | **PARTIAL** | J1 覆盖「识别问题+可核查建议+有界候选+真 Playwright+证据 SHA」;**模型调研面缺(US-02)**;「用户能看到证据与 SHA」✓(changeset 页) |
| F2 明确 Bug | **VERIFIED(等价面)** | 回归测试保留+Reviewer 独立检查+HTTP/DB 集成+Gate 绑定 exact commit+快进:gate-e2e(真模型 sum=87 含回归断言)+A-4 联验同构;沙箱仓 main fast-forward 面待 V19/US-08 网络恢复 |
| F3 故障注入越权 | **VERIFIED** | 重复失败熔断(V11)+越权拒(V02)+旧 SHA 拒(V10)+Reconcile(V05)+其他任务继续(V07);**不自报 ACCEPTED** 由 Gate 绑定/独立 Reviewer 保证 |

## §4 横切专项

| 专项 | 裁决 | 证据 |
| --- | --- | --- |
| 安全与权限(缺口 A) | **VERIFIED(本包收口后)** | 隔离 FAIL-CLOSED(worker.ts sandbox_not_isolated/docker_unavailable,c407cb0)+ 白名单传递(resolveTaskWhitelist)+ 允许/越权双向(A-4 允许面 + pi-e2e 越权面)+ 真实模型联验(A-4 全链,Stub 未替代) |
| 预算 | **VERIFIED** | 账本先预留后核算;FAIL-CLOSED;回合硬顶;A-4 真实计数 6/8 |
| 状态恢复 | **VERIFIED** | V04/V05/E5 + fencing/Reconcile |
| 独立 Reviewer | **VERIFIED** | 两轮制各包;A-4 真 Reviewer 裁决;本包 REVIEW 流程在 §6 |
| GitHub 交付 | **BLOCKED(网络)** | 见 US-08 |
| 真实浏览器交互 | **VERIFIED** | V12/V13(J1..J5 + E 演练 HTTP 面) |

## §5 结论

- **MVP 判定:REWORK**(非 ACCEPTED;非全量 BLOCKED)——依据第四阶段标准:安全/P0 必需面中 US-02(P0 最小 Discovery)NOT_IMPLEMENTED、US-04 CLI 面 NOT_IMPLEMENTED、US-08 真实 GitHub 写入 NOT_VERIFIED(网络)构成三个有界缺口;其余 US/V/G/F 大面积 VERIFIED 且真实证据充分。
- 有界 REWORK 工作包与顺序见 `gaps-and-next-workpackages.md`。
- 全部证据绑 HEAD `02c094f`(提交链 `4bd4168..02c094f`);基线历史证据绑各包 REPORT 所记 HEAD。
