# P0-ACCEPT 独立复核报告(REVIEW.md)

- 复核对象:P0-ACCEPT「验收与差距裁决包」(合同:`git show 4bd4168:CURRENT.md`,P0-ACCEPT ACTIVE Contract,先于验收独立提交)
- 写者提交链:`4bd4168`(合同)→ `c407cb0`(缺口 A 收口)→ `c9c53bd`(A-4 真实模型联验+propose 兜底)→ `511c2b6`(缺口 F)→ `042b4c5`(auth 参数属性修复)→ `02c094f`(缺口 E 收口+演练)→ `37d26b4`(报告集第一批)→ `544dc6b`(收尾;复核时 HEAD)
- 复核人:独立 Reviewer(全新上下文,与写者无关;仅依据仓库内事实与本人亲测,不采信写者自述)
- 复核时工作区状态:**clean**;`main` 领先 `origin/main` **8 个提交(未推送)**;合同提交 `4bd4168` 已在远端,远端与本地在合同点上无漂移
- 复核唯一写入物:本文件。未修改任何源码/测试/报告,未 commit、未 push

---

## §一 复核范围与方法

**范围**:合同五部分(六缺口 A~F 验收口径 / PRD 全覆盖矩阵 / 独立复核与缺口裁决 / 交付物 / 不可逾越边界)、写者全部报告(`p0-accept/` 7 份报告 + 7 份日志 + procs-e2e.sh)、5 个源码收口文件、3 个新测试文件、`CURRENT.md` 与 `docs/CONTINUATION.md` 终态、`git diff 4bd4168..HEAD` 越界审计。

**方法**(全部亲历):
1. `git log` / `git status` / `git show 4bd4168:CURRENT.md` 冷启动核对;
2. 通读合同原文与 7 份报告,交叉核对数字、SHA、结论一致性;
3. 代码面逐一核查 5 处收口(worker.ts / index.ts / db.ts / goal-loop.ts / auth.ts)+ package.json bin + src/ 强推面 grep;
4. 亲测复跑(真实运行,非仅读代码):tsc、5 组 vitest、magpie 直连探测;
5. 证据日志抽验(live-worker-e2e / procs-e2e / full-suite / github-real / backup-restore),并用 `git show c9c53bd:p0-accept/...` 核对证据在提交时点的原始形态;
6. 对照 `docs/PRD.md`、`docs/VALIDATION_PLAN.md` 审计三缺口裁决依据与漏判可能;
7. `git diff 4bd4168..HEAD --stat` 越界审计。

---

## §二 合同逐条对照表(六缺口 A~F)

| 缺口 | 合同验收口径要点 | 写者结论 | 复核人独立结论 | 关键证据(本人核实) |
| --- | --- | --- | --- | --- |
| **A. Live Worker 安全与权限** | ①隔离 FAIL-CLOSED 不得静默降级;②白名单完整传递链自证;③允许/越权双向实证;④真实模型 Run 联验(Stub 不能替代) | VERIFIED(收口后) | **同意 VERIFIED** | ①`worker.ts:128-136` 两分支真实存在(非 docker 且无 stub ⇒ `sandbox_not_isolated`;docker 不可用 ⇒ `docker_unavailable`,均不领取);`index.ts:63` 生产默认 docker;②`resolveTaskWhitelist`(`worker.ts:264`)从 tasks 表读取,且被 runTask 真实调用(`worker.ts:149`),空 commands ⇒ `[]` 全禁;③允许面=交付内容核验(result.txt sum=87 正确)+越权面=既有 pi-e2e(toolEvents 空已如实换口径,见 §五 OBS-1);④`live-worker-e2e.log` 时间线连贯:7 个 goal、2 次 TIMEOUT 试跑、3 次全链 `SUCCEEDED/ACCEPTED/DELIVERED`、`ledger used=6 limit=8 reserved=0`;测试门控(provider+docker+iptables)代码属实,CI 自动 skip |
| **B. GitHub 真实远端** | 沙箱仓限定;PAT 预检四态区分;跑 github-real;禁宽权限/强推 | BLOCKED(PAT 写权限 403);API 读面 VERIFIED | **同意 BLOCKED + 读面 VERIFIED** | `github-real-run.log`:CREDENTIAL_STATE wellformed、API 认证 200、两例 push/ls-remote 均 `403 Write access to repository not granted`;第一例失败在 ls-remote(写入零调用);终版定性"凭据权限不足"分类正确(非网络/非凭据无效);解除条件(用户补 Contents RW)合理;解除前远端零变化 |
| **C. Discovery 与模糊需求** | 三分类强制,不得用规则化冒充模型 | 缺口成立 → REWORK-1 | **同意缺口成立** | `capabilities.ts:48/55` `goal.discovery.model`/`goal.recommendation.model` 显式 NOT_IMPLEMENTED;US-02(P0 最小调研)无任何实现路径;无冒充面(goal 页徽章"确定性规则推导") |
| **D. CLI/API/Web 对等** | 核实 CLI 入口;三入口同调 Core | 缺口成立 → REWORK-2(CLI 缺) | **同意缺口成立** | `package.json` 无 bin 字段(grep 零命中);无 src/cli;PAUSED 态有转移表无入口;API/Web 同调 Core 面 P0-02C 未回退 |
| **E. 连续自治与故障恢复** | 真实进程启停/故障注入逐项/D3 语义/长稳先冻结阈值 | VERIFIED(观测段;24h/72h 未跑满如实) | **同意 VERIFIED(观测段)** | `procs-e2e.log`:E1~E7 全 PASS、无 FAIL 行;E5 SIGKILL→DB 事实源→旧会话 401;E6 收口后 `pool idle client error(不崩进程)` 可见降级;E7 300s(02:10:53→02:15:57)60/60 IDLE、RSS 333,496KB;24h/72h 未跑满按合同如实标注 |
| **F. 备份与恢复** | 实际备份;隔离实例恢复(非重启);全实体核对;外部 Git 核对 | VERIFIED(V19 达成) | **同意 VERIFIED(本人复跑)** | 亲测 `test/integration/backup-restore.test.ts` **1/1 绿**(隔离一次性 PG 容器真实起停、ON_ERROR_STOP 零错误、13 表行数+摘要一致、外部 bare HEAD 不变 da974b17);`backup-restore-run.log` 与报告一致(23,819B;实例 32769) |

**矩阵覆盖核对**:US-01..13(13 项)、V01..V20(20 项)、G0..G7(8 项)、F1..F3(3 项)合同要求全覆盖,矩阵逐项有六态结论与证据指针,无缺项。六缺口 A~F 逐项有结论 ✓。

---

## §三 代码面核查(全部真实存在)

| 项 | 结果 |
| --- | --- |
| `worker.ts` 隔离 FAIL-CLOSED | ✓ `128-136`:`sandbox_not_isolated`(live 非 docker 且无 stub 注入)与 `docker_unavailable`(docker 不可用)两分支均**不领取任务**;stub 测试注入路径豁免有 `worker-safety.test.ts` 显式用例锁定 |
| `resolveTaskWhitelist` 真实被调用 | ✓ 定义 `worker.ts:264-280`(SELECT allowed_scope/allowed_commands;空 ⇒ `[]`/回退 /workspace);`runTask` 内 `worker.ts:149` 真实调用并传入 executeRun spec |
| `index.ts` 生产默认 sandbox | ✓ `:63`:`RELAY_WEB_SANDBOX === "host-fallback" ? "host-fallback" : "docker"` —— 缺省 docker,host-fallback 须显式指定(收口属实) |
| `db.ts` pool error 监听 | ✓ `:33-34`:`pool.on("error", …)` 记录 stderr 不崩进程(E6 演练日志可见生效) |
| `goal-loop.ts` propose 兜底 | ✓ 代码真实存在(`:330-367`):try/catch ⇒ 落 D3 decisions 行 + `DELIVERY_PROPOSE_FAILED` 审计 + 不冒泡不回滚 ACCEPTED。**但见 §五 R-1:零测试覆盖,且"联验实锤触发"声称无证据支撑** |
| `auth.ts` 参数属性 | ✓ 已改显式字段赋值(`constructor(config){this.config=config}`);全 `src/` grep 参数属性仅 `git-candidate.ts:22` 的**注释**引用,无实际参数属性残留 |
| `package.json` bin | ✓ 无 bin 字段(US-04 CLI 缺失声称属实) |
| src/ 强推面 | ✓ `--force` 仅 2 处注释(刻意不带语义自证);无新增 child_process 面;无凭据面扩大 |

---

## §四 亲测记录(复核时 HEAD `544dc6b`;真 PG 127.0.0.1:55433(relay-p000-pg 在跑);magpie 路由 127.0.0.1:3425)

| 命令 | 结果(真实输出) |
| --- | --- |
| `npx tsc --noEmit` | **0 错误**(exit 0) |
| `npx vitest run test/integration/worker-safety.test.ts test/integration/web-api.test.ts` | **16 passed / 16**(worker-safety 4 + web-api 12),5.01s |
| `npx vitest run test/integration/backup-restore.test.ts` | **1 passed**(5.7s;隔离容器真实起停,`外部 Git HEAD 不变:da974b173638;13 表行数+摘要全部一致`) |
| `npx vitest run test/integration/goal-loop.test.ts` | **6 passed / 6** |
| `npx vitest run delivery.test.ts gate-binding.test.ts gate-orchestrator.test.ts v08-gate.test.ts` | **26 passed / 26**(覆盖写者"delivery+gate 22/22"口径的父集,全绿) |
| `npx vitest run test/integration/egress-proxy.test.ts`(隔离复跑 ×3) | **3 次均 1 failed / 5 passed** —— 失败恒为同一用例("代理改写生效…magpie 接受"),断言收到 `ERR:The operation was aborted due to timeout`。见 §五 R-2 |
| `curl POST :3425/v1/chat/completions model=group/gm`(60s 上限) | **60s 无响应**(超时;而 GET 类探测有响应)—— magpie 推理服务当前挂起实证,与 R-2 失败模式吻合 |

未验证项(如实披露):live-worker-e2e / gate-e2e / pi-e2e 等真实模型链路测试未复跑(当前 magpie 推理挂起,复跑必然超时,以日志证据+代码审读替代);GitHub 写入面(403 前置,本人未持有该 PAT 的写权限核验渠道,以 `github-real-run.log` 为准)。

---

## §五 发现(R-1..R-7)

### R-1(MAJOR,必列)propose 兜底的"验收实锤触发"声称无证据支撑;且该新增安全代码零测试覆盖

- **声称**:c9c53bd 提交信息、`REPORT.md` §7 表 #5、`security-fault-injection.md` §1 #8 三处声称:"propose 兜底路径由 delivery_not_captured 首跑真实触发""收口前异常冒泡出 tick(A-4 首跑实锤)"。
- **复核证据**:
  1. `test/` 全目录 grep `DELIVERY_PROPOSE_FAILED`:**0 命中** —— 兜底路径无任何测试断言(c9c53bd 的 `--stat` 亦确认 `goal-loop.test.ts` 未改动);
  2. `git show c9c53bd:p0-accept/live-worker-e2e.log`(33 行,append-only,测试无清空逻辑)与 HEAD 版逐行一致:共 5 次 tick 记录 —— 2 次 `run=TIMEOUT/ gate=undefined/ delivery=null`(gate 未 ACCEPTED,propose 根本不执行),3 次 DELIVERED 均 `propose ok=true`;**无任何 propose ok=false / DELIVERY_PROPOSE_FAILED 痕迹**;
  3. 兜底只在 `run SUCCEEDED ∧ gate ACCEPTED ∧ delivery.propose 抛异常` 时触发,日志中不存在该组合的失败实例。
- **影响**:代码本身经本人审读语义正确(D3 落记 + 审计 + 不冒泡,与 markConflict/markFailed 同语义),**不构成运行时缺陷**;但在以"证据/真实体验为 Gate"为本仓库第一原则的语境下,一个进入 REPORT §7"验收实锤缺陷"表格的声称,其"实锤方式"栏与提交的证据日志不符,属证据纪律问题;且新增安全收口无回归护栏。
- **要求(写者处置,本复核不代修)**:①补 1~2 个单测(注入 `delivery.propose` 抛异常 ⇒ 断言 D3 decisions 行存在、audit_events 含 DELIVERY_PROPOSE_FAILED、tick 正常返回、gate ACCEPTED 不回滚);②将 REPORT §7 #5、security-fault-injection.md #8 的"实锤触发"表述改为如实口径(如"代码审读+同语义类比;触发路径待单测覆盖"),或提交确实存在的原始触发证据——若无则必须改口径。

### R-2(MINOR,登记)"egress-proxy 自愈后隔离复跑 6/6 绿"在复核时点不可复得;magpie 推理挂起为间歇态

- 事实:本人 3 次隔离复跑该文件均 **1 failed / 5 passed**,失败用例恒为"代理改写生效:占位 key 经代理被换成真实 key(magpie 接受);计数精确 +1/请求",失败输出 `The operation was aborted due to timeout`;同窗口直接 curl `group/gm` chat completion 60s 无响应。magpie 进程活(错误类探测有响应)但推理路径挂起。
- 判定:失败定性为**环境型(magpie 上游)成立** —— 失败模式与被测代码(egress/runtime 层,本包 5 处收口均不触及)无因果;"全量绿权威口径=CI 隔离运行"的既有纪律是正确兜底。但写者"自愈后隔离复跑 6/6 绿"在复核时点**不可复现**,magpie 挂起属间歇态而非已自愈稳态,后续窗口(含 CI/REWORK-1 联验)须按"可能再次挂起"预设隔离复跑纪律。

### R-3(MINOR,登记)prd-coverage-matrix.md 内部三处 GitHub 终态结论互相矛盾

- `§1 US-08 行`:"BLOCKED(PAT 写权限 403)"(终版正确);`§4 横切专项`:"GitHub 交付 | **BLOCKED(网络)**"(旧结论);`§5 结论`:"US-08 真实 GitHub 写入 **NOT_VERIFIED(网络)**"(旧结论)。
- 544dc6b 修正缺口 B 终版结论(网络直连正常、403=凭据权限)时,同步了 REPORT/REPORT §3/github-delivery-verification.md/gaps §1,但**未同步本矩阵文件**。六态纪律要求唯一结论;应由写者把 §4/§5 两处更正为 403 凭据权限定性(六态取 BLOCKED)。

### R-4(MINOR,登记)REPORT §1 的 G 行计数与矩阵不符

- REPORT §1:"G:**6 VERIFIED** + 2 PARTIAL/NOT_VERIFIED";矩阵实际:G1..G5 共 **5** VERIFIED + G0/G7 PARTIAL + G6 NOT_VERIFIED(合计 8 项)。应为"5 VERIFIED + 2 PARTIAL + 1 NOT_VERIFIED"。US 行(6 VERIFIED + 2 PARTIAL + 2 缺口 + 3 N/A)与 V 行(15+2+3)核对无误。

### R-5(OBS,流程位置)收尾项未完成:8 commits 未推送;CI 对本包代码未验证

- `REPORT.md` §9.3 已如实声明"CI e2e/test job 对本包新增代码:推送前无法验证"。合同第五阶段"独立复核通过 → CI 成功 → main 快进推送"为顺序流程,推送与 CI 双绿属复核后的收尾动作(P0-02C 先例同)。**不构成虚报**,但本包完全关闭(合同退出条件)以「快进推送 + GitHub test/e2e 双绿」为必要条件,当前尚未发生。注意:CI 无凭据 ⇒ github-real 2 例 skip、无 docker iptables 面的部分门控用例 skip,与既有 CI 口径一致,不预期红。

### R-6(OBS)V14 判级略偏宽,但披露诚实

- V14(T01/T02/T03)验收口径为"OS/执行器阻断,无凭据泄露";矩阵判"VERIFIED(结构层)"并如实注明"模型级 prompt injection 语料化测试未做"。按六态严格语义(未测面存在)更贴近 PARTIAL。因结构层拒绝证据真实(pi-e2e 越权拒/scrubExecEnv/密钥隔离代理)且缺口已在 gaps §3 登记(T01),不要求改判,登记供后续包参考。

### R-7(OBS)A-4"允许/越权双向实证"的证据口径已在写者侧如实降级

- 允许面 = 交付内容核验(result.txt 由模型经白名单 `echo` 产生、Gate 内容核验一致),而非 toolEvents(toolEvents 对 pi 1.5.0 真实事件流为空,已如实记录于 live-worker-e2e.log 并登记 gaps §3.6);越权面 = 既有 pi-e2e(P0-01B 证据,非本包新增)。写者未夸大;REWORK-1 顺手项(tool-audit 副本落 detail)是正确补强方向。

---

## §六 三缺口 MVP 裁决的独立意见与漏判审计

### 6.1 对"MVP 判 REWORK(三缺口)"的独立意见:**同意**

| 写者缺口 | 复核意见 |
| --- | --- |
| US-02 P0 最小 Discovery 未实现 | **同意**。PRD `docs/PRD.md:56`(US-02 P0 最小)+ `:94`(Must/P0 明列"最小 Discovery");capabilities.ts 诚实登记 NOT_IMPLEMENTED;任何规则化分析均未冒充模型。合同缺口 C 三分类纪律得到遵守 |
| US-04 CLI 未实现 | **同意**。PRD `:62`(US-04 P0:"本地 CLI/API")+ `:94`(Must 明列"最小 CLI/API/Web");package.json 无 bin、无 src/cli,本人 grep 证实;V03 的"无 ChatGPT/无浏览器完整案例"因此不可达,必须 REWORK |
| US-08 真实 GitHub 写入 BLOCKED | **同意 BLOCKED 定性**(非 NOT_IMPLEMENTED、非纯网络故障)。403 实证清晰(github-real-run.log),安全失败语义(FAILED 非 DELIVERED、写入零调用、远端零变化)成立;PRD Must 明列"GitHub 安全提交"。解除条件(用户补 Contents RW)单一明确 |
| 判 REWORK 而非 ACCEPTED | **必须成立**:合同第三部分"安全或 P0 必需未满足 ⇒ MVP 判 BLOCKED/REWORK" —— US-02/US-04 均为 P0 必需未满足 |
| 判 REWORK 而非整体 BLOCKED | **同意**:安全/P0 机制面(隔离 FAIL-CLOSED、白名单传递、崩溃恢复、预算账本、D3 语义、备份恢复)大面积 VERIFIED 且本人独立复验真实 |

### 6.2 漏判缺口审计(US-01..13 逐项重裁)

逐一对照 PRD 原文与矩阵六态,**未发现"该判缺口但被标 VERIFIED/PARTIAL"的漏判**:

- US-01 PARTIAL / US-02 NOT_IMPLEMENTED(→REWORK-1)✓;US-04 PARTIAL(CLI+pause 缺,→REWORK-2)✓;US-08 BLOCKED ✓;
- US-03/05/06/07/09/10 VERIFIED 的证据链本人抽验成立:US-03(白名单传递本包收口+parity/pi-e2e 越权既有证据)、US-05(V04 库级+E5 真实进程)、US-06(D3 源码自证+反例5+J2)、US-07(gate-e2e 真模型+A-4 真 Reviewer ACCEPTED)、US-09(账本 FAIL-CLOSED+A-4 真实计数 6/8+E4)、US-10(J1..J5+A-4 DELIVERED 同链);
- US-11/12/13 NOT_APPLICABLE:PRD 明列 P1/P2 范围,且 RSI 被验收包边界明令禁止 ✓(V16/V17/V18 同);
- V19/F 判 VERIFIED 经本人复跑成立;G7 长稳 PARTIAL 与"E⑤ 不足 24h 如实标注"合同口径一致(PRD `:118` SLO 冻结纪律同向);
- 仅存判级偏差为 R-6(V14 VERIFIED 结构层 vs 语料未做),属披露完整的保守偏宽,不构成漏判缺口。

**六缺口 A~F 逐项有结论** ✓(见 §二表)。`gaps-and-next-workpackages.md` 的有界拆包(REWORK-2 CLI 先行 → REWORK-1 Discovery → github-real 补权闭环 → 部署包+长稳)依赖关系正确、范围有界,符合合同"不得并入一个无限扩大包"。

### 6.3 越界审计

`git diff 4bd4168..HEAD --stat`(26 文件,+1711/−51):5 个源码文件(db/goal-loop/auth/index/worker,全部为登记的最小安全收口)+ 3 个新测试 + `stub-pi.mjs`(+7 env 回显)+ `p0-accept/` 报告与日志 + `CURRENT.md`/`docs/CONTINUATION.md`。**无业务内核重构、无生产部署脚本、无凭据面扩大、无 CI 变更、无其他分支** ✓。`procs-e2e.sh` 操作面审计:自建临时库(自清)、自启进程(SIGTERM/SIGKILL 后必 wait)、`docker stop relay-p000-pg` 后必 start、`curl --noproxy` 本机端口 —— 全部受控,无越界 ✓。合同五条不可逾越边界(零部署/零 RSI/零权限扩大/零预算扩大/main-only 禁强推)逐条未发现违背 ✓。

---

## §七 最终裁决

**裁决:PASS-WITH-FIXES**

依据:
1. 验收包主体真实且质量高:六缺口 A~F 逐项有结论且与证据相符;5 处代码收口全部真实存在并经代码审读确认;隔离 FAIL-CLOSED/白名单传递/备份恢复/进程演练/403 定性均经本人独立复验或日志核验成立;越界审计干净。
2. MVP 判 REWORK(三缺口)裁决,本人独立重裁后**完全同意**(§六);漏判审计无新增缺口;REWORK 拆包顺序合理。
3. 必修项为 R-1(propose 兜底:补测试 + "实锤触发"表述改如实口径 —— 证据声称与日志不符,在本仓库证据纪律下不可带病关闭);登记项 R-2/R-3/R-4(文档数字与结论一致性)、R-5(推送+CI 收尾前置)、R-6/R-7(OBS)。

**随裁决的处置清单(写者收尾时逐项落实)**:
- [ ] R-1:补 propose 兜底单测(≥1 例,断言 D3 行 + DELIVERY_PROPOSE_FAILED 审计 + 不冒泡 + ACCEPTED 不回滚);修正 REPORT §7 #5 与 security-fault-injection.md #8 的"联验实锤触发"表述(或补充真实存在的原始证据);
- [ ] R-2:magpie 间歇挂起事实并入 R-9 同档纪律(隔离复跑;CI 为权威口径),无需代码动作;
- [ ] R-3:prd-coverage-matrix.md §4/§5 两处 GitHub 结论更正为"BLOCKED(PAT 写权限 403)",与 §1 终版一致;
- [ ] R-4:REPORT §1 G 行计数更正为"5 VERIFIED + 2 PARTIAL + 1 NOT_VERIFIED";并全文统一"46 文件"→"48 文件"(full-suite.log 实测 48);
- [ ] R-5:快进推送 `origin/main == HEAD` 后,以 GitHub CI test+e2e 双绿作为本包"全量绿"的最终兑现(CI 无凭据/无 docker 面 skip 属既有口径,不预期红);
- [ ] R-6/R-7 维持登记,不阻塞。

- 复核人:独立 Reviewer(全新上下文)
- 复核时点:2026-11-11(HEAD `544dc6b`,工作区 clean)
- 本报告为本次复核唯一写入物;未修改任何其他文件
