# RELAY-CONTROL-SAFETY-04 独立 Reviewer 复核报告

- 审查对象:实施提交 `9106446`(范围 = `git diff 9feeb3d..9106446`,32 文件 +3782/-1342)
- 审查上下文:独立 Reviewer,与实现窗口完全隔离;全部结论来自本窗口自行读码、自行运行探针与测试,未采信实现方任何自述
- 审查方法:读码(全量 diff + 相关源文件全文)+ 独立探针(argv 断言、真实 docker 容器、DB 竞态窗口)+ 独立测试运行(vitest 5 个套件)+ 生产接线核对
- 复核日期:2026-11-14;工作树:main @ 9106446,受跟踪文件零修改(复核仅写本报告文件,未动 src/ 与 test/)

## 总裁决:**REWORK**(1 Major;必须修复项见 §12)

安全主线(宿主执行面清零、docker 沙箱边界、fail-closed 全覆盖、交付停止三边界、C5 数据库级互斥)经独立实证全部成立、质量高;但 P0-B 交付停止回执存在一处**可实证的虚假陈述窗口**(Major-1),恰好落在本包合同的核心目标(B1 五态判别 / B4 回执如实)之内,必须修复后方可收口。

---

## 1. 核查一:宿主执行面清零 —— PASS

**命令与证据**

```
grep -rn --include='*.ts' -E '\bexecFile\b|\bspawn\b|\bexec\b\(|execSync|spawnSync' src/
```

全仓 src/ 的 child_process 引用共 14 个文件,逐一读码判定:

| 站点 | 用途 | 是否执行 CheckSpec.command |
| --- | --- | --- |
| src/core/evidence.ts | **已无任何 child_process import**;`runCheck` 函数已删除(全仓 grep `runCheck` 仅存于注释与测试 helper 注释) | 否(旧宿主执行面已移除) |
| src/runtime/check-sandbox.ts:165 | `execFile(DOCKER_BIN, argv, ...)` —— 只启动 docker CLI,候选命令作为容器 argv 传入 | 否(这是沙箱边界本身) |
| src/runtime/sandbox.ts | spawnSync(docker version 探测)、PiRpcSession.spawn(Run/Pi 启动,ADR-0003 Run 面) | 否 |
| src/runtime/pi-rpc.ts | spawn = Pi 进程(Run 面;live 必须 docker 隔离,host-fallback 仅 stub 测试注入口) | 否 |
| src/runtime/relay-tools.extension.ts | relay_exec 工具 = 模型 Run 期间的工具命令,受 task.allowed_commands 白名单(空=禁 exec,FAIL-CLOSED);与检查执行面完全分离 | 否 |
| src/runtime/git-candidate.ts | git 绑定核验(D-3) | 否 |
| src/runtime/runner.ts:210 | chmod 工作区(o+rwX,使容器 UID 10001 可写)+ git stage | 否 |
| src/core/executors/git-push.ts / github-push.ts | 交付 push 执行器(合同交付面) | 否 |
| src/server/api.ts:957 / views/projects.ts / views/system.ts / cli.ts / pi-version.ts / egress.ts | 只读 git diff/rev-parse、pi --version、docker/iptables 探测 | 否 |

**结论**:`CheckSpec.command` 的唯一执行面 = `collectCheckEvidence → CheckRunner` 端口;生产 runner = `dockerCheckRunner`(容器内),缺省 = `failClosedCheckRunner`。宿主直接执行候选检查命令的路径为 **0**。既有宿主 spawn(Run/Pi/git/delivery)与候选检查执行严格区分,无混用。

## 2. 核查二:沙箱边界真实性 —— PASS(独立 argv 断言 + 真实容器探针)

**2a. buildCheckDockerArgs argv 断言**(Reviewer 自写探针,直接调用生产函数打印 argv):

```
ARGV(cwdWorkspace=true, no-egress): ["run","--rm","--name","relay-check-probe1","--user","10001:10001",
"--cap-drop","ALL","--security-opt","no-new-privileges","--read-only","--tmpfs","/tmp:rw,size=134217728,mode=1777",
"--memory","512m","--cpus","1.0","--pids-limit","128","--network","none","-v","/tmp/ws-A:/workspace",
"-e","HOME=/tmp","-e","PATH=/usr/local/sbin:...","-e","TERM=dumb","-e","NO_COLOR=1","-e","LANG=C.UTF-8",
"-w","/workspace","node:24-bookworm-slim","node","-e","console.log('hi')"]
```

断言结果:--user 10001:10001 / --cap-drop ALL / no-new-privileges / --read-only / tmpfs /tmp / --network none / 512m·1.0·128 上限 / 无 docker.sock 挂载 / 仅一个 -v 挂载(工作区)/ env 白名单恰 5 项(HOME/PATH/TERM/NO_COLOR/LANG,零宿主变量透传)/ cwdWorkspace=false ⇒ `-v ws:/workspace:ro` + `-w /tmp` / allowEgressNetwork=true 但未验证 egress ⇒ argv 仍 network=none(纵深)—— 全部 PASS。探针初跑 2 个 FAIL 为探针自身把候选命令里的 `-e` 误计,复核后排除。

**2b. 真实容器探针**(docker 29.1.3,image node:24-bookworm-slim 本地存在;Reviewer 自写脚本调用生产 `dockerCheckRunner`):

```
P1 passed=true env.mode=docker
P1 HOME_is_tmp=YES  sentinel_leak=NO           # 宿主哨兵 env 读不到
P1 env_keys=KEYS=HOME,HOSTNAME,LANG,NODE_VERSION,NO_COLOR,PATH,PWD,TERM,YARN_VERSION
                                                # 仅镜像内建 + 白名单,零 Worker 环境继承
P1 probe_in_workspace=YES                       # probe.txt 落在 workspace(经 rw 挂载)
P2 etc_write_denied=YES                         # /etc 写被拒(只读根 FS + 非 root)
P3 host_path_write_landed=NO                    # 宿主路径哨兵未落盘(容器路径空间隔离)
P4 network_denied=YES                           # fetch(example.com) 被阻断(--network none)
P5 ro_workspace_write_denied=YES cwd="/tmp"     # cwdWorkspace=false ⇒ 工作区只读,cwd=/tmp
P6 timeout_elapsed_ms=3090 ... timeout_marker=YES  # 超时 3s ⇒ 整容器 kill(未等 30s 常驻),[exit=TIMEOUT]
```

P6 容器级终止经 `docker ps -a` 复核零残留(测试套件内 `waitContainerGone` 同样断言容器消失)。**全部 6 项边界成立**。env.mode=docker 且 env 记录 user/image/network/limits/container(A7 沙箱事实绑定)。

## 3. 核查三:绕过面 —— PASS(一处纵深建议,见 Minor-6)

- **checkRunner 未注入 ⇒ FAIL-CLOSED**:`gate-orchestrator.ts:338` `const runner = gate.checkRunner ?? failClosedCheckRunner`;`failClosedCheckRunner`(core/evidence.ts:131)返回 `passed:false` + `SANDBOX_RUNNER_UNAVAILABLE`,不执行任何命令。worker.ts:307-311:显式注入 > docker 缺省(生产)> 不注入(host-fallback/stub)= fail-closed。实测:`test/integration/check-sandbox-isolation.test.ts` 的 failClosed / collectCheckEvidence 缺省 runner 两用例 + 回归绿。
- **cwdWorkspace=false 无宿主绕过**:worker-entry.ts:79-85 显式归一(非布尔 ⇒ 启动即抛;false 保留);执行面 = 容器内 /tmp + 工作区 :ro(探针 P5 实证)。
- **allowEgressNetwork fail-closed**:worker-entry.ts:74-76 类型收口(非布尔拒绝);check-sandbox.ts:133-152 执行期二次校验(`eg.ok && subnet && hostIp && modelPort && verifyEgressRules(...)`,否则 `EGRESS_UNAUTHORIZED` 不执行);argv 纵深(未验证 ⇒ network=none)经探针证实。`verifyEgressRules`(egress.ts:312)实核 iptables ACCEPT/DROP 规则 + forwarder 存活。
- **kind 白名单**:worker-entry.ts:56-60 仅接受 `FUNCTIONAL_EVIDENCE_KINDS`(gates.ts:27 = deterministic_test/api_behavior);reviewer_output / candidate_manifest_verify 等非功能性 kind ⇒ 启动即抛(fail-closed)。worker-evidence-checks 回归(6/6)覆盖。
- **生产接线**:createLiveWorkerDriver 全部 3 个消费点(worker-entry.ts:117、cli.ts:284/299、server/index.ts:62)均无宿主 runner 通道;`RELAY_WEB_SANDBOX=host-fallback` 下 live 驱动 `sandbox_not_isolated` 不领取任务(FAIL-CLOSED)。
- **git-candidate/git-push/pi-rpc 等不经 CheckSpec**:已逐站点核实(见核查一)。

## 4. 核查四:P0-B 停止窗口 —— 一处 Major(详见 §11 Major-1),其余成立

**停止检查点顺序(实读 goal-loop.ts §a.6 / delivery.ts / intents.ts)**:

1. `goalLoopTick` a.6(Gate ACCEPTED 后、propose 前):`isAbortRequested` ⇒ 不 propose(goal-loop.ts:355-363,既有防线保留);
2. `executeDelivery` 入口(delivery.ts:456-470):旗标已置 ⇒ `STOPPED`,零 intent 零外部写入,proposal 保持 POLICY_APPROVED,审计 `DELIVERY_STOPPED_BEFORE_EXTERNAL`;
3. `executeIntent` perform 前(intents.ts:190-206):预留后旗标到达 ⇒ intent=FAILED,零外部副作用,审计 `EXECUTE_STOPPED_BEFORE_PERFORM`;此后 perform 已在途 ⇒ 不可拦截,交核对/Reconcile。

**ACCEPTED 分支判定(代码+测试+探针三重证实)**:

| 场景 | 实现 | 证据 |
| --- | --- | --- |
| 无交付(无 changeset/proposal) | 拒绝 `state_terminal:ACCEPTED` | delivery-stop.test.ts:340-349(绿) |
| PROPOSED/未开始 | 置旗(set-if-null)+ TASK_ABORT_REQUESTED 审计(controlState=not_started) | delivery-stop.test.ts:145-178(绿);executeDelivery 入口 STOPPED、远端 HEAD 不变、零 intent 行、proposal 保持 POLICY_APPROVED 均有断言 |
| DELIVERING + intent EXECUTING | `external_in_progress` 诚实回执,不虚报停止 | delivery-stop.test.ts:221-281(绿,真实 git push 隔离 bare 仓库);实现者放行后真实 DELIVERED,无虚构 STOP_CONFIRMED 审计 |
| DELIVERED | `already_delivered`,不置旗、不撤销 | delivery-stop.test.ts:283-309(绿):旗标保持 NULL、远端保持候选 SHA |
| 版本/幂等 | 旧版本拒绝;重复请求 alreadyRequested 审计仅一次 | delivery-stop.test.ts:313-338(绿) |
| 五态判别 | deliveryStopPhase none/not_started/external_in_progress/already_delivered | delivery-stop.test.ts:351-380(绿)—— **但未覆盖 intent COMPLETED 窗口,见 Major-1** |

**测试运行**:`npx vitest run test/integration/delivery-stop.test.ts` ⇒ **8/8 passed**(真实 bare 仓库推拉,非恒真断言)。

**Major-1 实证**(Reviewer 独立 DB 探针,播种 changeset=DELIVERING + intent=COMPLETED + proposal=POLICY_APPROVED + task=ACCEPTED,即 perform 已完成、markDelivered 未达的真实窗口):

```
WINDOW(delivering+intent COMPLETED) deliveryStopPhase = not_started
requestTaskAbort: {"ok":true,"fromState":"ACCEPTED","phase":"delivery","controlState":"not_started"}
audit.controlState = not_started
audit.note = 交付阶段停止请求(RECEIVED):边界检查将阻止未开始的外部写入;尚未发生外部写入
abort flag set = true
```

该窗口在生产 = `executeIntent` 写 COMPLETED 回执之后 → `markDelivered` 之前,中间含 `executor.check`(远端 HEAD)+ `verifyRemoteContent`(远端内容核对)两次真实远端调用,**秒级可达**;此窗口内操作者经 /abort|/takeover 停止,得到的回执与**append-only 审计记录**均为"尚未发生外部写入",与事实(外部提交已落远端)相反。API note 亦输出"外部写入尚未开始,边界检查将阻止其发生"。无控制权损失(push 先于停止请求),但违反合同 B1 五态判别("外部提交已发生"必须可区分)与 B4 回执如实;虚假陈述落在持久审计内。

## 5. 核查五:C5 幂等 —— PASS(一处 Minor,见 §11 Minor-2)

**SQL 独立读判**(api.ts:524-539):锁与 NOT EXISTS 检查+插入在**同一事务同一连接**(`deps.db.transaction`),`pg_advisory_xact_lock(hashtext(goalId), hashtext(content))` 为事务级互斥 ⇒ 同键并发第二事务在锁上阻塞,首事务提交后其 NOT EXISTS 必见已提交行 ⇒ 不插入。READ COMMITTED 下语义成立;不同 (goal,content) 哈希碰撞仅导致无害串行化。全仓 `INSERT INTO goal_messages ... execution_request=true` 仅此一处(api.ts:527),无绕过锁的直接插入路径(api.ts:436 为 gate_closed 语义的显式拒绝记录、:481 为普通发送 false,均非执行请求)。

**测试**:`npx vitest run test/integration/control-audit.test.ts` ⇒ **6/6 passed**,含:确定性交错(A 未提交持锁 ⇒ B 400ms 内不得返回;A 提交后 B 零插入,终态恰 1 行)+ 8 连接真并发探针(恰 1 行)。测试内 SQL 与 api.ts 生产语句逐行一致(本 reviewer 人工核对)。

## 6. 核查六:接管 ≠ 改名 abort —— PASS(C2 落实)

对比 api.ts:828-917:/abort 与 /takeover 均调 `requestTaskAbort`(同一旗标、同一五态判别),区别 = takeover 追加 `TASK_TAKEOVER_REQUESTED` 审计;两者回执**均携带 `phase` 与 `controlState`**,run 相位 controlState=`stop_pending_confirmation`,note 明确"停止确认前不构成获得人工控制权(STOP_CONFIRMED 以审计为准)"、"请求回执不构成接管成功;交还 AI 经方案 A 显式执行请求或既有 resume"。delivery 相位回执按真实交付态分档(external_in_progress/already_delivered/not_started)。回执语义诚实、C1/C2 落实。(already_delivered 相位 abort 零审计的细节见 Minor-3。)

## 7. 核查七:C4 审计失败 —— worker.ts 站点达标;gate-orchestrator 站点为部分达标(Minor-1)

- 生产 `TASK_ABORT_CONFIRMED` 共两个产出点:
  1. `src/server/worker.ts:270`(Run 期停止,run=CANCELLED)⇒ **走 appendAuditSafe**:重试 3 次(250ms 间隔)+ 结构化 `AUDIT_WRITE_FAILED` console.error(含 action/taskId/事件原文/错误/at),返回 false。旧实现(本 diff 前)为**静默吞掉**,已按 C4 修复。control-audit.test.ts 2 用例(持续失败 ⇒ 1 次告警+返回 false;瞬时失败 ⇒ 重试成功无告警)绿。
  2. `src/core/gate-orchestrator.ts:206`(VERIFYING 停止,F-1 路径)⇒ 普通 `appendAudit`;失败 = 异常沿 orchestrateGate→goalLoopTick→startSafeLoop 传播,经 loop-safety 计数 + onTickError/auditTickError + 熔断,**可观察但无重试、无 AUDIT_WRITE_FAILED 结构化告警**(core 分层不能 import server 层 helper)。非静默,但未满足合同"重试+可观察告警"全文 ⇒ Minor-1。
- 全仓 grep 无其他 TASK_ABORT_CONFIRMED/STOP_CONFIRMED 产出点;runner.ts/reviewer.ts 内既有同名 helper(非本 diff 引入)与停止确认无关。

## 8. 核查八:反例 / 过度设计 / hostTestCheckRunner —— PASS

- **测试真实性**:三个新套件均为真实故障注入 —— 沙箱反例用真 docker 容器 + 哨兵 env + 宿主路径探针 + 容器消失断言;delivery-stop 用真实 git push 到隔离 bare 仓库 + 阻塞桩制造 EXECUTING 窗口;control-audit 用双真连接确定性交错 + 8 连接并发。未发现恒真断言(抽查断言均绑定 DB/远端/宿主可观察事实)。
- **无第二系统**:CheckRunner 单端口复用既有 SANDBOX_IMAGE/DOCKER_BIN/egress 设施;停止语义复用同一 abort 旗标 + Intent 两阶段(零第二生命周期/零第二状态机);无新平台、无新调度器、无规则引擎。
- **hostTestCheckRunner**(test/helpers/check-runner.ts):grep 全仓 —— src/ **零引用**;test/ 15 个测试文件显式注入(与实现声明"16 个测试文件"差 1,实为 15 文件 + 1 helper 本身,纯计数误差,见 Minor-4)。cli.test.ts / worker-evidence-checks.test.ts 未注入是正确的(前者断言保守停机,后者测配置面/启动 fail-closed)。

## 9. 核查九:回归 —— PASS

```
npx vitest run test/integration/gate-orchestrator.test.ts test/integration/gate-machine-evidence.test.ts \
  test/integration/worker-evidence-checks.test.ts test/integration/task-abort.test.ts \
  test/integration/check-sandbox-isolation.test.ts
 ⇒ Test Files 5 passed (5) / Tests 40 passed (40)(21.66s;含 12 个真实 docker 反例)
```

注入抽查(git diff 逐行):gate-orchestrator.test.ts(+import+5 处注入,断言零改动)、gate-machine-evidence.test.ts(+2 注入)、task-abort.test.ts(+3 注入)、delivery.test.ts(+1 注入)、worker-evidence-checks.test.ts(+2 个**新增**配置面用例,断言 fail-closed 抛错)。大改动的 f1-ux-journey/f2-bug-fix/live-worker-e2e/pi-e2e/gate-e2e 等文件 diff 经抽样核对 = Biome 重排(对象字面量换行)+ 注入行,**断言未削弱**。B8(VERIFYING abort 前后检查全保留)由 task-abort.test.ts 7/7(前置/后置拦截 + goalLoop 交付防线)证实未回退。

## 10. 核查十:合同逐条符合性

| 合同项 | 判定 | 依据 |
| --- | --- | --- |
| P0-A CheckRunner 端口(core 不 import runtime) | ✅ | evidence.ts 无 runtime import;check-sandbox 反向 import core |
| A docker 执行器边界(非root/cap-drop/env白名单/无docker.sock/一次性工作区+tmpfs/默认禁网+egress单独授权/CPU·内存·进程·超时/超时或abort杀整容器) | ✅ | §2 argv 断言 + 真容器探针全过 |
| A 宿主 execFile 移除 + FAIL-CLOSED | ✅ | §1/§3 |
| A cwdWorkspace=false/任意 argv/脚本间接调用不构成绕过 | ✅ | §2(P5)、§3 |
| A 证据绑定 SHA/attempt/环境(含沙箱事实)/命令/退出码/原始日志 | ✅ | collectCheckEvidence 绑定 taskId/attempt/candidateSha;env.mode=docker+user/image/network/container;rawOutput 含 `$ 命令` 与 `[exit=N]` |
| A Gate 标准不降(SAFETY-CLOSE-02) | ✅ | manifest 硬门 + 功能性证据必需逻辑零改动(gate-orchestrator §2.5/§3.5 原样) |
| B1 五态判别 | ⚠️ **Major-1** | intent COMPLETED 未记录窗口误判 not_started |
| B2 复用旗标+Intent 两阶段,零第二生命周期 | ✅ | §8 |
| B3 三处确定性边界(propose 前/入口/perform 前) | ✅ | §4(1/2/3 全部实读+测试) |
| B4 external_in_progress 诚实回执 / 禁止虚假 STOP_CONFIRMED | ⚠️ EXECUTING 窗口✅;COMPLETED 未记录窗口 ✗(Major-1) | §4 |
| B5 副作用未知 ⇒ NEEDS_RECONCILE | ✅ | delivery.ts postverify 路径 + reconcileDelivery 零改动 |
| B6 不声称撤销已发生写入 | ✅ | already_delivered 回执 + note |
| B7 ACCEPTED+PROPOSED/DELIVERING 可用;版本校验/幂等/其余终态拒绝不变 | ✅ | §4;expectedStateVersion 可选语义与旧代码一致(git show 9feeb3d 核对) |
| B8 VERIFYING abort 检查全保留 | ✅ | task-abort.test.ts 7/7 |
| C1/C2 回执 phase+controlState,确认前不声称控制权 | ✅ | §6 |
| C3 ControlCommand 审计最小字段 | ✅(一处细节 Minor-3) | runId/expectedStateVersion/idempotencyKey/requestTime/actualResult/controlState 双相位齐备;拒绝事件带 expected/actual |
| C4 CONFIRMED 审计失败重试+告警 | ⚠️ Minor-1 | worker.ts ✅;gate-orchestrator 可观察但无重试/告警 |
| C5 advisory xact lock + 真并发探针 | ✅ | §5 |
| C6 handback 停止 + 最小决策说明 | ⚠️ 待收口义务 | 未实施 handback(正确);最小决策说明目前仅 api.ts:899 note + ops.ts:198 注释,独立决策说明须随收口报告交付(见 §13 残余 5) |

## 11. 发现分级

### Major(必须修复后收口)

- **Major-1(P0-B B1/B4:停止回执在"外部提交已发生、未记录"窗口虚假陈述)**
  - 位置:src/core/ops.ts `deliveryStopPhase`(L233-236)对 `delivery_state='DELIVERING'` 仅区分 `intent_state='EXECUTING'`,把 `intent_state='COMPLETED'`(perform 已完成、COMPLETED 回执已写、markDelivered 未达)判为 `not_started`;连带 requestTaskAbort 在该窗口置旗并以 `controlState=not_started` 回执 + 审计 note"尚未发生外部写入";api.ts:864/914 输出"外部写入尚未开始,边界检查将阻止其发生"。
  - 实证:§4 探针输出(真实 DB 播种,返回与审计均为虚假陈述)。
  - 危害:违反合同 B1"明确区分…外部提交已发生…五态"与 B4"回执如实";append-only 审计被写入与事实相反的陈述;操作者将误信"阻止了写入",而该写入已落远端。无控制权损失(push 先于停止请求),但本包的存在理由即停止语义的诚实性。
  - 必须修复项(REWORK 清单):
    1. `deliveryStopPhase` 对 `DELIVERING + intent_state='COMPLETED'`(以及一切"intent 已离开 RESERVED/EXECUTING 但 changeset 未达 DELIVERED"的组合)按"外部提交已发生"语义如实返回(复用 already_delivered 的不置旗/不虚报处理,或新增明确相位,禁止 not_started);
    2. 相应修正 requestTaskAbort 审计 note 与 api.ts 两处回执 note 的分档;
    3. delivery-stop.test.ts 五态判别用例补该窗口断言。

### Minor(不阻断,建议随修复轮消化或登记)

- **Minor-1(C4 letter)**:gate-orchestrator 的 TASK_ABORT_CONFIRMED(VERIFYING 停止)用普通 appendAudit,失败可观察(异常→tick 错误→熔断)但无重试/无结构化 AUDIT_WRITE_FAILED 告警。建议将 appendAuditSafe 下沉至 core/audit.ts 供两处产出点共用。
- **Minor-2(C5 测试同源性)**:control-audit.test.ts 复制生产 SQL 而非引用;api.ts 语句漂移时测试不报警。当前逐行一致(已核对)。
- **Minor-3(审计一致性)**:abort 在 already_delivered 相位返回 ok:true 零审计(takeover 同相位仍有 TASK_TAKEOVER_REQUESTED;run 相位幂等分支同样零审计为既有语义)。C3"实际结果"字段在该路径缺席。
- **Minor-4(声明计数)**:实施声明"存量 16 个测试文件注入"实为 15 测试文件 + 1 helper(纯计数误差,无实质影响)。
- **Minor-5(标记语义)**:check-sandbox.ts 输出超 4MB maxBuffer 时 Node 以 killed=true 终止 ⇒ 被标记为 TIMEOUT 并 docker kill。结果安全(容器终止),但退出标记失真(非真超时)。
- **Minor-6(纵深建议)**:gate-orchestrator.ts:349 `input.workspaceDir ?? process.cwd()` —— 生产 worker.ts 恒传 Run workspace,该缺省不可达;但 core 直调(测试/未来调用方)退化时会把 Worker 进程 cwd(部署 checkout)以 rw 挂载进容器 /workspace(执行仍在容器内,非宿主逃逸)。建议后续缺省拒绝或要求显式传入。

## 12. 残余登记(合同语义内,不算缺陷)

1. **perform 在途不可撤销**:executeIntent perform 后外部动作不可拦截 ⇒ 诚实回执 external_in_progress + 结果交远端核对/NEEDS_RECONCILE —— B4/B5 语义内(合同原文允许)。
2. **已发生外部提交不可撤销**:already_delivered 不置旗、如实告知 —— B2/B6 语义内。
3. **STOPPED 交付无工具化恢复路径**:abort_requested_at 全仓无清除路径,ACCEPTED 终态无 ops 恢复入口;"恢复仅经人工处置"实际=DB 级人工操作(与 C6 停止决策一致:不新增第二恢复通道)。登记为已知边界;若需工具化恢复应走新授权包。
4. **采集期 abort 轮询延迟上限 ~1.5s**(编排 1s + runner 500ms):窗口内检查容器被整容器 kill;检查无外部副作用面(仅一次性工作区/tmpfs 写),不产生合同意义上的外部写入。
5. **C6 最小决策说明尚未成文**:实施仅以 api.ts takeover note + ops.ts 注释承载("交还 AI 经方案 A 显式执行请求或既有 resume,不冒充完整 handback");合同要求"交付最小决策说明",须在收口报告/决策文档中独立成文(收口前义务,非本次代码缺陷)。
6. **本窗口未验证项**:quality:quick/full/release 全量(仅按任务要求运行 5 个定向套件共 62 用例,全绿);生产 Worker/重启(禁止触碰);真实模型/真实远端写入(合同禁止)。

## 13. 最终裁决

**REWORK**。必须修复项 = §11 Major-1(1 项;预计改动面:ops.ts deliveryStopPhase + requestTaskAbort note、api.ts 两处 note 分档、delivery-stop.test.ts 补窗口断言)。修复后本包其余部分(P0-A 全部、P0-B 三边界、P1-C 主体)已达 PASS 水平。

- 复核证据文件(Reviewer 自写探针,位于 /tmp,不入库):argv-probe.mts / docker-probe.mts / phase-window-probe.mts / env-debug.mts
- 复核测试运行:delivery-stop 8/8、control-audit 6/6、gate-orchestrator+gate-machine-evidence+worker-evidence-checks+task-abort+check-sandbox-isolation 40/40
- 零真实远端写入、零模型调用、零生产触碰;未修改任何 src/ 或 test/ 代码;未 git commit/push

---
---

# 第二轮复核(REWORK 消化 `acdd961`;2026-11-14)

- 审查范围:`git diff f78e804..acdd961`(5 文件 +190/-39)。附:f78e804 本身仅为单测试文件 Biome 格式重排(3 行,零语义),经 `git diff 9106446..f78e804` 全文核实。
- 方法:全量 diff 读码 + Reviewer 自写 DB 探针**重放第一轮 Major-1 反例**(不信实现方测试)+ 真实 docker 溢出探针 + 独立复跑回归。以下结论全部来自本窗口自行运行的结果。

## R2-1. Major-1 修复真实性 —— VERIFIED(Reviewer 探针重放第一轮反例)

Reviewer 独立探针(round2-probe.mts;隔离 schema、真实 bare 仓库推拉,三场景):

**探针 A = 第一轮 Major-1 反例窗口重放**(changeset DELIVERING + intent COMPLETED + proposal POLICY_APPROVED,真实 push 已落远端):

```
A phase=external_write_done
A receipt={"ok":true,"phase":"delivery","controlState":"external_write_done","alreadyRequested":null}
A audit.controlState=external_write_done audit.actualResult=no_op audit.idempotencyKey="abort:t-..." audit.requestTimeType=string
A note="外部提交已发生(perform 完成、交付回执未落):停止请求不撤销已发生的提交,不置旗;交付收尾照常核对(DELIVERED 或 NEEDS_RECONCILE)"
A note_no_false_claim=YES  note_has_done=YES      # 不含"尚未发生外部写入",含"外部提交已发生"
A flag_set=false                                   # 不置旗
A reexec={"ok":true,"state":"DELIVERED",...} changeset=DELIVERED remote_head_is_candidate=true
                                                   # 置旗(未置)后的重执行不被入口边界拦截;
                                                   # CONSUMED 恢复路径核对补记 DELIVERED,零重复推送
```

**探针 B = DELIVERING + intent FAILED 窗口**:

```
B phase=external_outcome_unknown receipt={"ok":true,"controlState":"external_outcome_unknown"} flag_set=true
B note="交付执行已失败/冲突:外部副作用是否发生不能确定(结果以核对/Reconcile 为准);停止请求阻止后续外部写入"
B reexec={"ok":false,"state":"STOPPED","reason":"abort_requested_before_external"} remote_head_unchanged=true
                                                   # 置旗 ⇒ 重执行被入口边界拦截(STOPPED,零外部写入)
```

**探针 C = already_delivered(真实完整交付后)**:

```
C delivered=DELIVERED receipt={"ok":true,"controlState":"already_delivered"} flag_set=false
C audit.actualResult=no_op audit.controlState=already_delivered audit.idempotencyKey="abort:t-..." note="交付已完成:停止请求不撤销已发生的外部提交(零状态变更,诚实回执)"
```

代码面核对:ops.ts `deliveryStopPhase` DELIVERING 分档 EXECUTING⇒external_in_progress / COMPLETED⇒external_write_done / FAILED·CONFLICT⇒external_outcome_unknown / 其余⇒not_started,与声明一致且无遗漏组合;requestTaskAbort 对 already_delivered/external_write_done 走 no_op 审计分支(actualResult=no_op + C3 字段齐备 + 如实 note),external_outcome_unknown 走置旗分支(note 含"不能确定…阻止后续外部写入")。api.ts /abort 与 /takeover 两处 note 分档与各相位事实一致(external_write_done⇒"无法撤销已发生的写入";external_outcome_unknown⇒"不能确定…已阻止后续外部写入")。

**语义符合性判定(R2 请求第 7 项)**:external_write_done 不置旗+重执行放行 = 合同 B2/B4 语义内 —— 已发生提交不可撤销(回执如实"无法撤销"),收尾核对(markDelivered)是簿记+远端核对而非新外部写入(intent COMPLETED ⇒ executeIntent 直接返回,探针 A 实证远端零重复推送);external_outcome_unknown 置旗 = 操作者"停止=不再有外部写入"意图的正确落实(入口边界+perform 前边界双拦截),结果不确定性交既有 Reconcile。**均不构成新缺陷**。

## R2-2. Minor-1(gate-orchestrator C4)—— VERIFIED(读码)

abortStop 内 TASK_ABORT_CONFIRMED:首次失败 ⇒ 250ms 后重试 1 次;仍失败 ⇒ 结构化 console.error(`[gate-orchestrator] AUDIT_WRITE_FAILED…` 含 action/taskId/changesetId/error/at),不再抛出,状态推进(CANCELLED)保持生效。满足合同 C4"重试+可观察告警,不得静默吞掉"(与 worker.ts 站点同标准;次数差异=1 次重试 vs 3 次尝试,均为"重试"语义,判定达标)。附注:该路径无专属测试(既有 gate-orchestrator 5 用例走成功路径),以读码为准 —— 登记为观察项,不阻断。

## R2-3. Minor-3(already_delivered/external_write_done 命令回执审计)—— VERIFIED

探针 A/C 实证两相位均写 TASK_ABORT_REQUESTED 审计(actualResult=no_op、controlState=相位、idempotencyKey/requestTime/runId 齐备);delivery-stop.test.ts 已把原"零审计"断言改为 no_op 审计断言(diff 核对,断言加强而非削弱)。

## R2-4. Minor-5(OUTPUT_OVERFLOW)—— **修复在当前运行时不生效**(新 Minor M2-1,不阻断)

Reviewer 真实 docker 探针(6MB stdout,maxBuffer=4MB):

```
D passed=false marker="[exit=ERR_CHILD_PROCESS_STDIO_MAXBUFFER]"
D marker_is_overflow=NO marker_not_timeout=YES
```

配套直接探针确认 Node v24.21.0 行为:execFile maxBuffer 超限 ⇒ `err.code="ERR_CHILD_PROCESS_STDIO_MAXBUFFER"`、`killed=undefined`、message="stdout maxBuffer length exceeded"。因此 check-sandbox.ts 新增的 `err.code === "ENOBUFS"` 分支在当前运行时**永不命中**(死代码),实际标记为原始错误码 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 而非声明的 `OUTPUT_OVERFLOW`;提交信息"≠TIMEOUT,如实"与实际运行时不符。缓解事实:(a) 实际标记本身诚实(含 MAXBUFFER 字样,非虚假 TIMEOUT —— 第一轮 Minor-5 担心的"killed=true 被标 TIMEOUT"在 Node 24 并不发生,round-1 该项前提经实测修正);(b) 结果恒 passed=false,安全方向不变;(c) killed=undefined ⇒ 不触发 killContainer,容器自然退出或由 timeout 路径兜底,无残留。**判定:Minor(登记项)** —— 建议后续把判定改为同时匹配 `ENOBUFS` 与 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`(或按 message 判定)并补一条专属断言;不阻断收口。

## R2-5. 回归(Reviewer 独立复跑)—— 40/40 全绿

```
npx vitest run delivery-stop control-audit task-abort gate-orchestrator check-sandbox-isolation
 ⇒ Test Files 5 passed (5) / Tests 40 passed (40)
   delivery-stop 10/10(+2 新窗口用例)/ control-audit 6/6 / task-abort 7/7 / gate-orchestrator 5/5 / check-sandbox-isolation 12/12
```

新用例真实性抽查(diff 逐行):Major-1 回归用例以真实 bare 仓库构造窗口,断言 receipt 相位、审计 note 双向(不含"尚未发生"、含"外部提交已发生")、旗标 NULL、重执行 DELIVERED;FAILED 用例断言置旗+重执行 STOPPED —— 全部绑定 DB/远端/审计可观察事实,**非恒真断言**。delivery-stop.test.ts 旧"零审计"断言改为 no_op 审计字段断言(加强)。

## R2-6. 修复引入新问题检查 —— 未发现

- 全部改动限于 5 文件;无新文件、无断言削弱、无第二生命周期。
- external_write_done 早返回分支跳过幂等分支的边界情形(旗标在更早 Run 期已被置位且当前相位=external_write_done 时,回执缺 alreadyRequested 标记)——回执相位仍如实,影响可忽略,登记观察。
- external_write_done 窗口若 Worker 在 markDelivered 前崩溃 ⇒ changeset 停留 DELIVERING(旗标未置),恢复=既有 DB 级人工处置(与第一轮残余登记 #3 同一边界,范围未扩大)。

## R2-7. 复核期间工作树并发写者观察(登记,Reviewer 不处置)

第二轮复核收尾时(2026-11-14 01:50~01:52)工作树出现 39 个证据产物文件的修改(p0-02c/ 日志与截图、p0-mvp/webux-02/screenshots/、p0-webux-03d/screenshots/);进程核实 = 另一并发进程 `npm exec vitest run test/e2e`(PID 2388065,01:50 启动,含 Playwright/Chromium 子进程)正在再生 e2e 证据 —— **非本 Reviewer 进程**(本窗口全部 vitest 运行均为 `npx vitest run test/integration/...` 且已结束)。按治理规则(单写者/脏工作区只读)Reviewer 零处置、零 restore。影响判定:脏文件全部为证据产物,**src/ 与 test/ 零修改** —— 本报告全部读码与探针均针对 HEAD=`acdd961` 内容,裁决不受影响;该并发活动归属实现方窗口,收口时须由其按既有提交纪律(evidence 再生与实现提交分离)自行处置,不得混入实现提交。

## 第二轮裁决:**PASS**

- 第一轮 Major-1:已修复并经 Reviewer 独立探针重放反例证实(回执/审计/旗标/重执行四面全部如实)。
- Minor-1/3:已修复并证实;Minor-2/4/6 按声明登记不改码(可接受:均为建议/计数类)。
- 新登记 Minor M2-1(OUTPUT_OVERFLOW 死分支)与两项观察(gate-orchestrator 重试无专属测试;幂等标记边界情形)不阻断,须在收口报告如实载明。
- 残余登记(延续第一轮 §12):perform 在途不可撤销 / 已交付不可撤销 / STOPPED 与回执窗口崩溃的 DB 级人工恢复 / C6 最小决策说明须随收口报告成文 / 本轮未验证项=quality 全量与生产触碰(合同禁止)。

- 第二轮复核证据文件(Reviewer 自写,位于 /tmp,不入库):round2-probe.mts / overflow-probe.mts / execfile-err-probe.mjs
- 零真实远端写入(bare 仓库)、零模型调用、零生产触碰;未修改任何 src/ 或 test/ 代码;未 git commit/push
- 收口前义务清单:①收口报告载明 M2-1(OUTPUT_OVERFLOW 死分支)与 R2-6/R2-7 两项观察;②C6 最小决策说明独立成文;③并发 e2e 再生产物由实现方按提交纪律处置
