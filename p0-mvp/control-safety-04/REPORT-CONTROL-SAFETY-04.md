# RELAY-CONTROL-SAFETY-04 最终报告

裁决:**PASS**(独立 Reviewer 两轮:第一轮 REWORK[1 Major+6 Minor]→修复→第二轮 PASS[0 Major,独立探针重放反例交叉验证];最终报告按真实 SHA 与实测数据)

日期:2026-11-14
合同:9feeb3d(CURRENT.md「RELAY-CONTROL-SAFETY-04」ACTIVE 登记;开工冷启动 live main=579d535,exact-head CI 43431291559@579d535 双 job success)

## 1. 基线与 Writer

- 开工冷启动:live main = origin = 本地 `579d535b1fbf2eb9bdf68df10498c877ab46349c` 一致(gh run list 亲测 CI 双绿);未跟踪受保护 `config/`、`p0-mvp/soak-r3b/` 全程零触碰;Writer=本窗口唯一,main-only 快进。
- 提交链:`9feeb3d(合同)→ e21f240(反例留证,对旧代码实测)→ 9106446(实施,30 文件 +3553/-1342)→ f78e804(cwdWorkspace 显式归一)→ acdd961(Reviewer REWORK 消化 Major-1+Minor-1/3/5)→ 0da454a(第二轮 PASS+M2-1 修复+复核报告入库)→ 收口提交`。
- 生产影响:零部署/零生产库写入/零模型调用/零真实远端写入(全部交付停止竞争测试使用隔离 bare 仓库与桩 Executor);生产 worker/web 未重启。

## 2. 反例留证(修复前,对旧代码 9feeb3d 实测;evidence/counterexample.log)

| # | 反例 | 旧代码实测结果 |
| --- | --- | --- |
| A1 | 候选检查读取 Worker 哨兵 env | 泄漏(LEAK=cx-secret-…;env.mode=worker-host 全量继承) |
| A2 | cwdWorkspace=false | 落宿主仓库根(CWD=/home/ubuntu/dev/relay) |
| A3 | 写工作区外宿主哨兵路径 | 宿主落盘(任意路径可写) |
| A4 | 子进程创建孙进程后超时 | execFile 只杀直接子进程,孙进程宿主残留 |
| B1 | ACCEPTED 请求 abort | 被拒 state_terminal(交付阶段零停止入口) |
| B2 | abort 旗标已置、propose 后 executeDelivery | 仍完成外部提交(bare 仓库实推,DELIVERED) |
| C1 | TASK_ABORT_REQUESTED 审计字段 | 缺 runId/幂等键/版本/请求时间/实际结果/控制权状态 |
| C5 | 同内容执行请求真并发双插 | 两连接交错 NOT EXISTS 双通过(重复授权面) |

## 3. 交付内容(三子项)

### P0-A 功能检查执行器安全隔离(A1~A8)

- **宿主 execFile 出生产路径**:core/evidence.ts 移除宿主执行,新增 `CheckRunner` 端口(core 不 import runtime,分层不变)+ `failClosedCheckRunner`(runner 未注入 ⇒ 检查按失败落库 SANDBOX_RUNNER_UNAVAILABLE,绝不退回宿主执行)。
- **runtime/check-sandbox.ts docker 执行器**:非 root UID 10001、`--cap-drop ALL`、no-new-privileges、只读根 FS + 一次性 tmpfs /tmp(128MB)、显式 5 项 env 白名单(HOME/PATH/TERM/NO_COLOR/LANG,零宿主凭据/模型密钥/服务环境透传)、不挂载 docker.sock、仅挂载一次性 Run 工作区、默认 `--network none`(allowEgressNetwork=true 须 egress 白名单验证通过否则 fail-closed)、CPU 1.0/内存 512m/进程数 128/超时上限(worker-entry 校验 1s~600s)、超时或 abort 旗标翻转 ⇒ `docker kill` 整容器(全进程组含孙进程);cwdWorkspace=false ⇒ 容器内 /tmp + 工作区只读(任意 argv/脚本间接调用一律容器内,无宿主绕过面)。
- **Gate 编排接线**:orchestrateGate 注入 checkRunner(docker 沙箱生产缺省;host-fallback 且未显式注入 ⇒ FAIL-CLOSED)+ 采集期 1s abort 轮询(旗标翻转 ⇒ 终止执行进程组并立即 STOP,不进 Reviewer)。
- **证据绑定(A7/A8)**:env 如实记录 mode/image/user/network/limits/container;rawOutput 含命令原文与退出码(TIMEOUT/ABORTED/OUTPUT_OVERFLOW/SANDBOX_UNAVAILABLE/EGRESS_UNAUTHORIZED 语义分档);candidate SHA/attempt 绑定不变;manifest 完整性硬门与功能性证据必需不降级(不建第二测试系统)。
- **独立探针验证(Reviewer 第二轮)**:宿主执行面清零(14 个 child_process 站点逐一判定);真实容器 6 项探针(HOME=/tmp、哨兵 env 零泄漏、宿主路径零落盘、/etc 不可写、禁网、只读工作区、超时 3.09s 整容器 kill 零残留)。
- **测试**:check-sandbox-isolation 12 用例(真实 docker 逃逸反例)+ worker-evidence-checks 配置面用例(cwdWorkspace=false 保留/allowEgressNetwork 校验);存量 15 个测试文件显式注入 `hostTestCheckRunner`(test/helpers,生产零宿主执行面;与 reviewRun/argvOverride 注入同模式)。

### P0-B 交付阶段停止控制闭环(B1~B8)

- **语义**:requestTaskAbort 扩展 ACCEPTED 且交付未完成时可用(同一 abort 旗标,零第二生命周期/第二状态机);`deliveryStopPhase` 相位判别(含 proposal 面——propose 只建 proposal 行不改 changeset 交付态,B7 竞争测试实证):not_started / external_in_progress(EXECUTING)/ **external_write_done**(COMPLETED:perform 完成、回执未落)/ **external_outcome_unknown**(FAILED/CONFLICT:副作用不确定 ⇒ Reconcile)/ already_delivered / none。
- **三处确定性停止边界**:goalLoopTick propose 前(03 包既有防线保留)+ executeDelivery 入口(旗标已置 ⇒ STOPPED:零 intent、零外部写入,proposal 保持 POLICY_APPROVED)+ executeIntent perform 前(intent FAILED + EXECUTE_STOPPED_BEFORE_PERFORM 审计,零外部副作用)。
- **诚实回执(B2/B4)**:external_in_progress ⇒ 不声称 STOP_CONFIRMED,结果以远端核对为准;external_write_done ⇒ 不撤销已发生的提交、不置旗(交付收尾核对须继续)、回执审计 actualResult=no_op;external_outcome_unknown ⇒ 置旗阻止后续外部写入 + note"不能确定";already_delivered ⇒ no_op 回执;副作用未知 ⇒ 既有 NEEDS_RECONCILE/reconcileDelivery。
- **C3 命令回执审计**:TASK_ABORT_REQUESTED detail 补 runId/expectedStateVersion/idempotencyKey/请求时间/实际结果/控制权状态(actor 顶层+append-only 不变)。
- **B8**:VERIFYING abort 前后检查、Runner 取消链、goal-loop 交付防线全保留(回归绿)。
- **测试**:delivery-stop 10 用例(入口边界/perform 前/EXECUTING 诚实回执/Major-1 两窗口回归/already_delivered/版本与幂等/相位判别/回执丢失恢复)。

### P1-C 接管与控制审计收敛(C1~C6)

- **C1/C2**:/abort 与 /takeover 回执携带 phase(run/delivery)+ controlState(stop_pending_confirmation/交付真实相位);接管回执明示"停止确认前不构成获得人工控制权,以 STOP_CONFIRMED 审计为准"——不再是改名 abort 的虚假成功。
- **C4**:appendAuditSafe(worker.ts 站点,承载 TASK_ABORT_CONFIRMED)重试 3 次(250ms)+ 结构化 `AUDIT_WRITE_FAILED` console.error 告警(journald 可观察、事件原文随告警保留);gate-orchestrator abortStop 站点重试 1 次+同标准告警(Reviewer Minor-1 消化)。
- **C5**:显式执行防重(同 Goal 同内容)检查+插入整体置于 `pg_advisory_xact_lock(hashtext(goal),hashtext(content))` 之下——同键真并发串行化,后到者必见先到者已提交行,可证明唯一(8 连接并发探针恰 1 行+确定性交错证明)。
- **C6 handback:按合同停止子项**(最小决策说明):完整 handback 须核对人工修改、Git 事实、计划版本、预算、权限与未决副作用后方可授权新 Run,现有状态机中 CANCELLED/ACCEPTED 为终态、无"控制权持有"事实模型,安全实施必须扩展核心生命周期/权限架构 ⇒ 按合同 C6 停止条件停止单项。当前安全路径不变:交还 AI=方案 A 显式执行请求(派生同 Goal 受控 Task,scope 继承)或 PAUSED 既有 resume;不以普通 resume/新建 Task 冒充完整 handback。与 03 包 M-4 登记合并为后续包。

## 4. 独立 Reviewer(两轮)

- **第一轮:REWORK**(1 Major+6 Minor,报告=p0-mvp/control-safety-04/REVIEW-CONTROL-SAFETY-04.md):P0-A 全部成立(宿主执行面清零+真实容器探针);Major-1=DELIVERING+intent COMPLETED 窗口(perform 完成、回执未落)被判 not_started ⇒ 停止回执/审计虚假陈述"尚未发生外部写入"(独立 DB 探针实证)。
- **修复(acdd961)**:Major-1=相位分档新增 external_write_done/external_outcome_unknown,ops 审计与 API 回执按相位如实分档,五态判别测试+两窗口新用例;Minor-1(CONFIRMED 审计重试+告警)/Minor-3(no_op 命令回执审计)/Minor-5(输出溢出标记)消化;Minor-2(测试 SQL 复制)/Minor-4(计数表述)/Minor-6(workspaceDir 纵深建议)登记不改码。
- **第二轮:PASS**(0 Major):Major-1 修复经独立探针重放验证(探针 A/B/C 全过:诚实回执、零"尚未发生"陈述、收尾不阻断、置旗拦截);新 Minor M2-1=Node 24 实测 maxBuffer 错误码为 ERR_CHILD_PROCESS_STDIO_MAXBUFFER,原 ENOBUFS 分支死代码 ⇒ 修复 0da454a(双码识别,真实容器 6MB 探针 marker=OUTPUT_OVERFLOW 生效);回归 40/40 绿;无新绕过面、零过度设计。

## 5. 测试与质量证据

- `quality:quick` PASS;`quality:full` PASS(单测+真 PG 集成+容器安全门+浏览器旅程:方案 A C5/C6/M5/M6 全绿);`quality:release` PASS ×3(实施后 17-18-49、REWORK 消化后 17-46-16;backup-restore 13 表一致;github-real 授权门下零远端写入)。证据目录=test-evidence/quality-*-2026-11-13T17-*/。
- 定向:check-sandbox-isolation 12/12(真实 docker)、delivery-stop 10/10、control-audit 6/6、worker-evidence-checks 6/6、task-abort 7/7、gate-orchestrator 5/5、gate-machine-evidence、gate-e2e、delivery、delivery-propose-fallback 全绿(40/40 Reviewer 独立复跑确认)。
- 再生截图/日志按 evidence 再生分离纪律 restore 处置,未混入提交(Reviewer R2-7 登记)。

## 6. 生产影响、回滚与登记

- **生产影响**:worker/web 未重启 ⇒ 线上行为不变;重启后:①功能性机器检查一律容器内执行(生产 worker 缺省 docker 沙箱执行器;RELAY_EVIDENCE_CHECKS_JSON 配置面新增 cwdWorkspace=false 与 allowEgressNetwork,均 fail-closed 校验)②abort/takeover 可停止验收后交付阶段(未开始⇒阻止;在途⇒诚实回执;已发生⇒如实告知不可撤销)③显式执行防重获得数据库级串行化保证。
- **回滚**:`git revert 0da454a acdd961 f78e804 9106446`(加列迁移无;沙箱执行器回退后旧宿主执行语义恢复——不建议,保留修复)。
- **残余登记(合同语义内,如实)**:perform 在途不可撤销、已交付不可撤销(B4/B6);STOPPED 交付无工具化恢复(abort 旗标无清除路径=DB 级人工,与 C6 停止决策一致);Reviewer Minor-2(测试 SQL 与生产语句为复制而非同源引用,已人工核对一致)/Minor-6(orchestrateGate workspaceDir??process.cwd() 纵深建议,生产路径不可达)。
- **登记后续包**:①M-4 完整 handback(AGENT_CONTROL §4 核对流程,需生命周期扩展授权;含 C6 决策说明)②STOPPED 交付工具化恢复(旗标清除的 ops 入口+审计)③ControlCommand 审计结构化 detail 收敛(M-5 延续)④生产部署配置包(RELAY_EVIDENCE_CHECKS_JSON 取值+重启窗口,需独立授权)。

## 7. NOT_RUN/未验证(如实)

- 真实 GitHub 远端写入(合同禁止;隔离 bare 仓库+桩 Executor 覆盖竞争语义)。
- 真实模型 Run 上的停止演练(零模型约束;信号链与竞争面已用 stub+真实进程实证)。
- 生产部署验证与 worker 重启(未触碰)。
- 沙箱对 gpu/特定原生工具链的覆盖(镜像=SANDBOX_IMAGE node:24-bookworm-slim;取值=部署包决策)。
