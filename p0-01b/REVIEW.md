# P0-01B 独立对抗复核报告

- **复核人**:独立上下文 Reviewer(全新会话,与实现会话无共享记忆;仅依据 live 仓库 HEAD `7676477`、权威文档与代码/测试本身)
- **日期**:2026-11-10
- **被复核对象**:实现提交 `40d3639`(27 文件,+4769/-48)、证据提交 `7676477`(4 文件);复核时 HEAD==`767647713e0a0ffd14f43f9fa0bc12e0209984c6`,worktree clean,无未解释脏状态。`origin/main==66a2c5c`(落后 HEAD 两个提交——push 属合同 Outcome 8 中"复核之后"的既定顺序,复核时点尚未执行,非违约)
- **模型调用约束遵守声明**:复核全程未产生任何模型调用。全量测试以 `RELAY_PI_BASE_URL=http://127.0.0.1:1/v1` 运行使 pi-e2e 走显式 skip 路径;E2E 真实性采信 `p0-01b/evidence/pi-e2e-run.log` + 对代码/测试的静态审查(见核验 6 的边界声明)。未发现需要追加模型预算才能裁决的事项。
- **复核人亲测**(2026-11-10 07:04,本机 `/home/ubuntu/dev/relay` @ 7676477,测试库容器 `relay-p000-pg` 运行中):

```text
$ RELAY_PI_BASE_URL=http://127.0.0.1:1/v1 npx vitest run   (尾部原样)
 ↓ test/integration/pi-e2e.test.ts (2 tests | 2 skipped)

 Test Files  19 passed | 1 skipped (20)
      Tests  68 passed | 2 skipped (70)
   Start at  07:04:18
   Duration  42.61s (transform 340ms, setup 0ms, collect 8.84s, tests 29.00s, environment 4ms, prepare 1.37s)

$ npx tsc --noEmit
TSC_EXIT=0   (无诊断输出)
```

- 运行后 PG 残留检查:`p01a_%/p01b_%` 常规测试 schema 零残留(cleanup 真实生效);**例外见 F-5**(实现会话遗留的 3 个 debug schema)。
- p0-01b/REPORT.md 在复核时点**尚不存在**,本复核以代码+测试+证据日志为准。

---

## 逐项核验表

| # | 复核项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 边界白名单 | **VERIFIED**(1 项 OBSERVATION) | `git diff --name-only 66a2c5c 7676477` 共 31 文件全部落在 CURRENT.md 白名单:`src/core/lease.ts|schema.ts`(合同明列)、`src/runtime/**` 6 文件、`test/**`、`package.json+lock`、`CURRENT.md`、`p0-01b/evidence/**`。`git ls-files` 无 node_modules/dist/.tsbuildinfo;命中 `.log$` 的全部是 p0-00/p0-01a/p0-01b evidence(有意提交的证据,非构建产物)。`p0-00/**`、`p0-01a/**` 在两提交中零改动(diff 为空)。字面超界仅 `migrations/meta/0001_snapshot.json`+`meta/_journal.json`(白名单只写 `migrations/0001_*.sql`):journal 是 `applyMigrations` 的唯一执行序列来源(src/core/db.ts:65-68),snapshot 是 drizzle-kit 状态,属结构性必需且 p0-01a 已建立该目录模式 → F-8 记录 |
| 2 | F-3 收口 | **VERIFIED** | lease.ts diff 仅 4 行校验+注释,无其他语义改动。`heartbeat`(src/core/lease.ts:238-278)现顺序:lockTask(245,FOR UPDATE,与 supervisor reclaim 的 `FOR UPDATE OF t SKIP LOCKED` 在任务行互斥)→ 终态拒(246-249)→ **非工作链拒(250-253,新增 `state_not_leased_chain:*`)** → 锁 leases 行 → owner/fencing/live 校验。两条残余路径均被堵:路径 A(worker 合法 advance→NEEDS_RECONCILE 而租约仍活)与路径 B(reclaim 后、新 claim 前)在出链瞬间即失心跳资格。test/integration/heartbeat-leased-chain.test.ts:22-58(A 路径:断言 reason 精确匹配 + HEARTBEAT_REJECTED 审计恰 1 条)与 60-94(B 路径:reclaim 后 reason 断言 + 旧 token advance 被拒),并带 RUNNING 工作链内正向对照(33-36,修复不误伤正常心跳)。heartbeat.test.ts 4 例全绿(复核人本轮亲测) |
| 3 | Pi 版本锁定 | **VERIFIED**(1 项 MINOR,见 F-4) | `RELAY_PI_VERSION="1.5.0"`(pi-version.ts:12);package.json devDep `"@earendil-works/pi-coding-agent": "1.5.0"` 精确无 `^`;lock 解析至 registry.npmjs.org 固定 tgz + integrity(package-lock.json:505-509)。`resolveVendoredPi`(pi-version.ts:48-66)路径**钉死** `<repoRoot>/node_modules/@earendil-works/pi-coding-agent`,不走任何模块解析 API/PATH,缺失或包声明版本不符即抛(拒启);全仓无任何按 PATH 解析 `pi` 的代码。`verifyPiRuntime`(72-87)实际执行 vendored cli `--version` 做二进制 leg。三方校验(常量/包声明/二进制)作为函数齐全,单测 3 例覆盖含伪造二进制拒启(pi-version.test.ts:22-34)——但二进制 leg **未接入启动链路**,仅测试可达(F-4)。sandbox-enforcement.test.ts:82 另证容器内 vendored cli 版本==锁定值 |
| 4 | 双层隔离 | **VERIFIED**(2 项 CONCERN,见 F-1/F-2/F-6) | **工具层**:launchPi 的 piArgs 恒含 `--no-builtin-tools`(sandbox.ts:186),argvOverride 仅为测试注入口且注释声明正式路径禁用(189-196;全部调用方核过:仅 stub 测试使用)。parity 矩阵 12 例全绿:5 组对抗用例两层一致(root 内/嵌套/`..` 穿越//etc/passwd/前缀字面段边界)、分层语义显式测试(policy 授权 vs tool realpath 可实现性)、符号链接逃逸被工具层 realpath 阻断(parity.test.ts:53-57)、default deny 同源(59-61)。tool-audit.jsonl 对**每次调用**(允许 extension.ts:163/198-205、拒绝 163/186-190)落痕;scrubExecEnv 白名单透传+凭据 key 剔除(extension.ts:90-101,parity.test.ts:82-96 锁定行为)。**OS 层**:sandbox-enforcement.test.ts:28-86 断言面充分——uid=10001、cap-drop(chown 拒)、sentinel 不在命名空间、宿主 HOME 不可见、docker.sock 不存在、SSH_AUTH_SOCK/GH env 未设、/etc 不可写、workspace 可写(正向)、node_modules 只读、vendored 版本锁定;launchPi docker 分支 dockerAvailable() 不满足即抛(sandbox.ts:176-178),**无静默降级路径**。host-fallback:全部非 E2E 测试显式 `sandbox: "host-fallback"` 且 run 行断言如实记录(run-lifecycle.test.ts:95);pi-e2e 用 docker;无任何生产入口可到 host-fallback(本包尚无生产入口,runner 唯一调用方是测试) |
| 5 | Run 生命周期 | **VERIFIED**(1 项 MINOR,见 F-3) | 四条路径均正确且有真实进程/真实 PG 证明:**超时**(runner.ts:243-249 SIGKILL→TIMEOUT;advance RUNNING→FAILED 合法转移,lifecycle.test.ts:118-131 断言 run=TIMEOUT+任务=FAILED+attempt 已耗)、**取消**(235-242 SIGTERM→2s→SIGKILL→CANCELLED,测试 133-147 终态锁定)、**断连**(250-260 + catch 分支 328-331:`exit.expected==false` 判 rpc_disconnect,任务留 RUNNING 不虚构推进,测试 149-161)、**租约丢失**(heartbeat 被拒即 `session.kill("SIGKILL")` runner.ts:169-175,循环 break→INTERRUPTED 不做任何任务推进;run-lease-loss.test.ts:37-101 以 ps 轮询核验 stub 真死+断言 worker-A 仅 1 次 LEASED→RUNNING 推进+HEARTBEAT_REJECTED 审计)。**SUCCEEDED 只推进到 VERIFYING**(298-312:RUNNING→SUBMITTED→VERIFYING,VERIFYING→ACCEPTED 在测试中经 recordGateVerdict 后由显式 advance 完成,lifecycle.test.ts:104-111 与 pi-e2e.test.ts:97-103 均验证 Gate 必要性)。**恢复只从 DB 重建**:insertSession 恒 checkpoint_ref=NULL、resume_mode=fresh/context_rebuild(runner.ts:111-123,207-211),priorHandoff 仅来自 latestSession 的 sessions 行(126-145),prompt 注入重建说明"进程/会话状态不可恢复"(context.ts:44-50),无任何假装恢复模型状态的代码路径 |
| 6 | 测试真实性 | **VERIFIED**(E2E 为静态审查+日志采信) | stub-pi.mjs 是**真实 node 子进程**:真实 stdin/stdout JSONL、写真实 PID 文件、stdin 关闭即退出、模式化行为(ok/hang/no-handoff/exit-mid),无任何进程内 mock。run-crash-recovery.test.ts:64 真实 SIGKILL 独立 worker 进程(kill9AndAssertDead=p0-01a 机制:exited promise+ps 轮询核验死亡),并断言崩溃 run 行 ended_at 为 NULL(68-69,不虚构)。run-lease-loss.test.ts:20-24/82-83 ps 轮询核验 RPC 子进程死亡。pi-e2e:真容器(sandbox=docker,launchPi docker 分支)+真 provider(probeProvider 实测 /models)+**真实 docker kill**(test.ts:128-140 对运行中 relay-run-* 容器注入;若 kill 失败被 catch 吞掉,但 outcome 会是 SUCCEEDED 而断言要求 FAILED——吞错方向安全,不会假绿)。sandbox-enforcement 真容器 shell 探测。E2E 真实性边界:复核人未实测(预算约束),采信 pi-e2e-run.log(两例 13.7s/16.3s 时长与真实多轮模型 Run 一致,时间戳位于实现提交后 31 秒) |
| 7 | 亲测运行 | **VERIFIED** | 68 passed + 2 skipped(与声明逐文件一致)+ `tsc --noEmit` 0 错误;测试后常规 schema 零残留 |
| 8 | 证据审查 | **VERIFIED**(1 项 MINOR,见 F-5) | impl-sha.txt == `40d3639` 全 SHA ✓。vitest-full-run.log 与复核人亲测逐文件一致(同为 68+2skip,文件/用例名/时长量级吻合)。pi-e2e-run.log 时间线自洽(06:56:24,实现提交 06:55:53 之后、证据提交 06:58:55 之前)。MINOR:fresh-clone-repro.log 仅含 vitest 尾部,缺 p0-01a 同名证据的 clone SHA/npm ci/db:up/REPRO_EXIT 头部段落,commit message 声称的"tsc 0 错误"无落盘证据(F-5) |
| 9 | 诚实性 | **VERIFIED**(3 项 MINOR,见 F-3/F-4/F-5) | 逐项检查未发现夸大/掩盖:skip 全部显式(skipIf 条件+注释"不假装");断连/租约丢失/无 handoff 等"不利结果"如实落库(run 行 outcome/detail,schema.ts:90-91 注释明示 host-fallback 非安全边界);p0-01a 既有测试除 fault-injection.ts 类型联合 +1 外零改动(无放宽);宽容断言仅一处且方向安全(hb-leased-chain B 路径 ghost 推进 reason 三选一,lease.ts 实际行为 deterministic)。**但**:测试库 debug 残留与一次未披露的真实模型调试调用(F-5)、启动链路校验弱于 commit message 措辞(F-4)、fresh-clone 证据薄(F-5)——均如实记入发现 |
| 10 | 安全红线 | **VERIFIED**(1 项 OBSERVATION,见 F-7) | 全仓扫描 ghp_/github_pat_/xox/AKIA/私钥块/ssh-rsa/长 key 赋值:零命中(唯一连接串为授权的本地测试库)。无 GitHub 写路径(src/core/executors/git-push.ts 为 p0-01a 本地 mock,注释明示真实集成属 P0-02B);docker 分支不挂 docker.sock/SSH agent/凭据(挂载面仅 workspace/HOME/ext:ro/node_modules:ro,sandbox.ts:214-221);runs/sessions detail 仅含 outcome/审计计数/handoff/stderrTail(2000 字符截断),无凭据;审计留痕完整(HEARTBEAT_REJECTED/ADVANCE_REJECTED/CLAIM_REJECTED/RUN_* 全落库,append-only 守卫延续) |

---

## 发现清单

### MAJOR

(无)

### MINOR

- **F-1|relay_exec 无命令/路径白名单,工具层对 FS 的实际约束≈0** — `relay-tools.extension.ts:113-137/184-215`:`/bin/sh -c` 执行**任意**命令,"受限"仅体现在 cwd 默认值/环境清洗/超时/输出截断;模型以 `relay_exec("cat /etc/passwd")` 即可完全绕过 relay_read 的作用域语义(cwd pin 无约束意义,sh 内可 cd)。这与 ADR-0003 第 3 点("OS 层容器是安全边界,工具层不是")一致——**不构成对架构的违反**——但与 CURRENT.md Outcome 3"受限命令执行,语义对齐 V02"的字面承诺存在张力:工具层对 exec 的授权面只剩"审计+OS 层兜底",host-fallback 下(仅测试)exec 等于宿主用户全权 shell。建议处置:REPORT.md 如实声明该边界并引用 ADR-0003 依据;后续包给 exec 补命令/路径白名单矩阵或至少把"工具层不是安全边界"写入 run 记录的可解释字段。
- **F-2|tool-audit.jsonl 位于模型可写 workspace,对抗下痕迹可销毁** — 审计文件在 `/workspace/.relay/`(容器内模型 UID 可写,sandbox.ts:102 chmod 0o777),模型可用 relay_exec `rm/touch` 删除、截断或伪造审计行;runner 只持久化 `toolCallEvents/toolAuditLines` 计数(runner.ts:286-296),DENIED 的 reason/params 明细在文件被删后不可恢复。合同 Outcome 3"越权调用必须 DENIED 且留机器可读痕迹"在**非对抗**测试面内成立(E2E 审计读取成功),对抗下不成立。建议处置:审计写到模型不可触碰位置(单独挂载/宿主侧 onRecord 持久化 tool_call 事件原文到 run detail 或 audit_events),并在 CONTRACTS 层将"审计不可被 Run 销毁"列为 P0-02A 前置。
- **F-3|runner 心跳回调 `.catch(() => {})` 吞掉心跳事务异常** — runner.ts:164-176:心跳续租**被拒**(业务拒绝)会立即止损;但心跳事务**抛错**(DB 抖动/连接失败)被吞,leaseLost 不置位、Pi 不被终止,失效窗口内 Run 继续执行工具,直到下一次 advance 被拒才 FAILED。合同字面("续租被拒⇒立即终止")未被违反(被拒路径有测试),但"失效 Run 不再产生副作用"的意图在 DB 故障场景出现缺口。建议处置:catch 中置 leaseLost(保守止损)或至少将心跳异常写入 run detail;补一条"心跳持续异常→终止"的故障注入测试。
- **F-4|verifyPiRuntime(二进制 leg)未接入启动链路,启动时校验实为 2/3 legs** — launchPi/executeRun 均不调用 verifyPiRuntime,注释仅声明"前置:已通过"(sandbox.ts:172),而全部调用方(含未来生产路径的自然写法)只调 resolveVendoredPi(路径+包声明两 leg)。commit message 声称"三方校验"作为启动属性,实际二进制校验仅单测可达;被篡改/损坏的 vendored 安装(cli 输出≠package.json 版本)可在运行路径放行。风险低(路径钉死+包声明校验已在启动链上),但属措辞强于实现。建议处置:executeRun 入口(或 launchPi 非 override 分支)加一次 verifyPiRuntime,或 REPORT 如实声明"三方校验=函数级,启动链=两 leg+单测覆盖二进制 leg"。
- **F-5|测试库 debug 残留 + 一次未披露的真实模型调试调用 + 证据薄** — ①测试库 `relay-p000-pg` 遗留 3 个非测试命名 schema:`p01b_dbg_e2e`/`p01b_dbg_runner`(各含完整迁移+1 任务+1 run)与空 schema `undefined`(某调用方传了未定义变量,quoteIdent 校验恰好放行);其中 `p01b_dbg_e2e.runs` 为 **magpie/group/gm 真实模型 run**(2026-11-09 22:49,SUCCEEDED)——实现期间的调试调用,超出"E2E 主链路+恢复重跑"的声明范围,总模型调用预算(≤12)占用因此**不可审计**。②fresh-clone-repro.log 缺 clone SHA/npm ci/db:up/tsc 头部,commit message 声称的"tsc 0 错误"无落盘证据。建议处置:清理 3 个残留 schema(`DROP SCHEMA ... CASCADE`);REPORT.md 披露全部非 E2E 模型调用次数与用途;补齐 fresh-clone 证据头部或降级该声明措辞。

### OBSERVATION

- **F-6|`--network host` 放弃网络隔离(声明式偏差,需 REPORT 承接)** — sandbox.ts:213 及 sandbox-enforcement.test.ts:43:容器共享宿主网络栈,可直达宿主全部 listening 服务(测试 PG 55433、model 路由 3425、乃至 docker API 若开启 TCP)。依据为 p0-00 §0.2 的 ufw 事实(bridge 模式容器→宿主模型路由不可达),文件头已声明"网络隔离由 p0-00 A4a(--network none)独立证明"——但正式路径并未采用该隔离。CURRENT.md 的 OS 层清单未含网络项,故不判违约;然而 ADR-0003"OS 层容器是安全边界"在 host 网络下打了折扣。建议处置:REPORT 风险清单显式承接;在允许宿主服务改动(ufw 放行固定端口)的授权窗口内回归 bridge/none 网络,勿将 host 网络常态化进 P1。
- **F-7|模型凭据面:models.json 可被 relay_exec 读取;api-key 在宿主 argv 可见** — prepareRunDirs 把 apiKey 写入 run HOME 的 `~/.pi/agent/models.json` 且 HOME 树 `chmod -R o+rwX`(sandbox.ts:128-130);relay_exec 子进程继承 `HOME=/pihome`,`cat $HOME/.pi/agent/models.json` 即可取得 provider key;docker 分支 api-key 亦在 `docker run` argv 中(宿主 ps/inspect 可见)。本包密钥为假(magpie 本地路由),影响为零;接真 key 前必须改造(models.json 移出 exec 可见 HOME、经 stdin/env 注入而非 argv)。另:runDir 位于共享 `/tmp` 且 workspace/HOME 0o777,同机其他本地用户可读写 run 工作区(单用户 VM 下可接受,记录在案)。
- **F-8|白名单字面与工程必要的既知偏差(不构成违规)** — ①`migrations/meta/0001_snapshot.json`/`_journal.json` 超出"migrations/0001_*.sql"字面,但 journal 是 applyMigrations 唯一序列来源、snapshot 是 drizzle-kit 状态延续(p0-01a 已建立),snapshot 列/FK 与 schema.ts 逐字段核对一致;②relay-tools.extension.ts 直接 `import "typebox"` 而 package.json 未声明该直接依赖(现为 pi 包传递依赖经 hoisting 可达,npm 布局变化即断,建议显式声明);③`ensureNodeModulesReadable` 对宿主 node_modules `chmod -R o+rX`(文件头已声明、一次性、只放读);④pi-version.test.ts:23 的 fakeDir 不清理,/tmp 每轮残留空目录;⑤executeRun 中若首个 advance 被拒,run 行从未插入(仅审计 RUN_FAILED),runs 表对该"未开始 Run"无记录(与"崩溃 Run 不虚构"语义一致,可接受)。
- **F-9|收尾待办(复核时点未完成,属合同既定顺序)** — p0-01b/REPORT.md 未落盘、docs/CONTINUATION.md 未更新、`origin/main`(66a2c5c)落后 HEAD 两个提交。 Outcome 8 明确这些步骤排在独立复核之后;**关闭本包前必须完成**:REPORT 披露(F-1/F-5/F-6/F-7 的承接)、快进 push、`origin/main==HEAD`+worktree clean 核验。

---

## 未覆盖项(诚实声明)

1. 未实测 pi-e2e(模型预算约束);E2E 真实性采信证据日志+静态审查。若需运行时级复核,须追加模型预算后由具备授权的窗口执行。
2. 未复核 npm 依赖供应链(仅核对 pi 包 lock 的 resolved/integrity 与 typebox 声明缺失,未逐包审计)。
3. `migrations/meta/0001_snapshot.json` 仅做列/FK 抽查,未重放 `drizzle-kit generate` 比对(避免在授权外写仓库文件;迁移 SQL 本身经 68 测试真实应用)。
4. magpie 本地路由的实际调用计数不可从本仓审计(F-5①),总模型预算合规性最终以 REPORT 披露为准。
5. docker 镜像 `node:24-bookworm-slim` 自身的 CVE/供应链未评估。
6. `--cap-drop ALL` 之外的内核攻击面(userns、/proc、setns 等)未做对抗穷举(p0-00 A4 已覆盖基本项,本复核沿用其结论)。

---

## 总裁决:**PASS**

- 无 BLOCKER/MAJOR。CURRENT.md 八条 Outcome 逐条有实现+测试支撑,复核人独立复现 68 passed + 2 skipped + tsc 0 错误;F-3 残余窗口收口经真实 PG 双路径回归证实;双层隔离的断言面(sandbox-enforcement 12 项 + parity 矩阵 12 例 + E2E 审计断言)经对抗审查后成立;四条故障路径(超时/取消/断连/租约丢失)均有真实进程与真实 PG 证明,"Run SUCCEEDED≠ACCEPTED"与"恢复=上下文重建"语义如实落地。
- 全部发现为 MINOR(F-1~F-5)/OBSERVATION(F-6~F-9),无一项破坏本包验收的可判定性。**不要求返工代码即可通过复核**。
- 附带条件(关闭本包前必须完成,均属 Outcome 8 既有收尾动作+披露义务,非新增阻断):①落盘 REPORT.md,如实披露 F-1(工具层边界引用 ADR-0003)、F-5(debug schema 清理+非 E2E 模型调用次数+预算合规性)、F-6(host 网络偏差承接)、F-7(接真 key 前的凭据改造义务);②清理测试库 3 个 debug 残留 schema;③快进 push 唯一 main 并核验 `origin/main==HEAD`+worktree clean;④更新 CURRENT.md/docs/CONTINUATION.md。
- F-2(审计可销毁)、F-3(心跳吞错)、F-4(启动校验 2/3 legs)建议随下一个工作包或小补丁处置;F-6/F-7 在接入真实模型凭据/P1 前必须收敛。

---

# 复验(6fc276e)

- **复验人**:同一独立上下文 Reviewer(第二轮)
- **日期**:2026-11-10
- **被复验 HEAD**:`6fc276e515e87f05fd696d5260897f80aedbd779`(父 7676477;处置提交仅触碰 src/runtime/sandbox.ts +5 行、REPORT.md、REVIEW.md 入库、2 个证据日志;**提交版 REVIEW.md 与复核人首轮原稿逐字一致,未被改动**——已 diff 核实)。工作区含写者正在准备的收尾改动(CURRENT.md 完成态 + docs/CONTINUATION.md 更新,均为未提交状态;src/ 与 test/ 相对 HEAD 干净——本轮亲测覆盖的就是 6fc276e 的代码)
- **复核人亲测**(2026-11-10 07:19,RELAY_PI_BASE_URL=http://127.0.0.1:1/v1):
  - `npx vitest run` → **68 passed + 2 skipped**(42.67s,exit 0)——此轮运行在 HEAD==6fc276e(含 F-4 修复)上进行,补上了写者日志无法提供的关键证明(写者的 vitest-full-run.log 重跑于 07:13:28,先于处置提交 07:15:46,且非模型测试对 sandbox.ts 修复前后**不可区分**,故其无法单独证明"修复后仍绿";复核人本轮运行填补该缺口)。
  - `npx tsc --noEmit` → 0 错误。
  - 测试库残留:`p01a_%/p01b_%` 常规 schema 零残留;**`p01b_dbg_e2e`/`p01b_dbg_runner` 已确认 DROP**,但空 schema **`undefined` 仍在**(见 F-5 复验)。
- **模型调用**:复验全程零模型调用(约束遵守;pi-e2e 未运行,E2E 真实性沿用首轮采信基线)。

## 逐条处置结论

| 发现 | 处置结论 | 证据 |
| --- | --- | --- |
| F-1 relay_exec 无命令白名单(MINOR) | **VERIFIED(已声明边界)** | REPORT §4 F-1 + §6.2:如实引用 ADR-0003"工具层非安全边界",约束面(cwd/env/超时/审计)与 OS 层兜底(A4/沙箱强制测试)如实列出,细粒度白名单保留至 P0-02 Policy 引擎;CURRENT.md(未提交)风险清单同步承接。与首轮建议一致 |
| F-2 tool-audit 可销毁(MINOR) | **VERIFIED(已声明+保留)** | REPORT §4 F-2 + §6.1:当前防线=OS 层+run 结束时 detail 快照;"不可篡改审计链属 P0-02"如实声明 |
| F-3 心跳回调 catch 吞错(MINOR) | **VERIFIED(已声明,保留至 P0-01C)** | REPORT §4 F-3 + §6.5:处置描述准确(该 catch 仅覆盖心跳查询本身失败,DB 闪断时保持运行);CURRENT.md 风险清单含"心跳回调熔断计数"承接 |
| F-4 verifyPiRuntime 未接入启动链(MINOR) | **VERIFIED(已修,2 项边界如实记录)** | sandbox.ts:199-201:docker 分支启动前调用 `verifyPiRuntime(pi)`,argvOverride 分支(189-196)在其前 return 不受影响,修复位置正确;复核人在 HEAD==6fc276e 重跑 68+2skip+tsc 0 独立证实不破坏。**边界①**:host-fallback 非 override 直启分支**未**接入——REPORT 措辞"stub 测试路径除外"略强于实际(当前无任何测试经过该分支,合同定位其为测试专用 fallback,风险为零,但措辞应精确);**边界②** 见 N-3(修复的 docker 分支无运行时覆盖,E2E 证据漂移) |
| F-5 debug 残留+未披露模型调用(MINOR) | **PARTIAL(主体已处置)** | `p01b_dbg_e2e`/`p01b_dbg_runner` 已 DROP(psql 实查确认);18-20 次模型调用在 REPORT §5 诚实披露(构成/超限原因/处置三要素齐全);**残留:空 schema `undefined` 未清理**(首轮建议清理 3 个,实际清 2 个;空壳无数据,风险为零,一条 DROP SCHEMA 即收尾) |
| F-6 `--network host`(OBSERVATION) | **VERIFIED(已承接)** | REPORT §6.3 如实记录(ufw 事实/牺牲网络命名空间/FS·凭据·能力边界完整/bridge+代理属 P1);CURRENT.md 风险清单同步 |
| F-7 模型凭据面(models.json 经 HOME 可被 relay_exec 读取;api-key 在宿主 argv 可见)(OBSERVATION) | **FAILED(处置遗漏)** | REPORT §4/§6 均无对应承接——§4 表的"F-6/F-7"行处理的是 REVIEW.md 中不存在的发现(见 N-1),导致首轮 F-7 凭据面无人认领。本发现为记录性 OBSERVATION 且本包密钥为假(影响为零),不构成代码缺陷,但接真 key 前必须有人记得:REPORT 修订时必须补该承接行(建议挂 P0-01C Worker 循环或"接真凭据前"检查单) |
| F-8 白名单字面/typebox 未声明/fakeDir 不清理等杂项(OBSERVATION) | **PARTIAL(记录性,可接受)** | 仅 fresh-clone 头部一项被处置(证据已重生成,头部含克隆 SHA/env/PG ready/tsc: 0 errors,格式达标);typebox 直接 import 未声明、migrations/meta 字面、pi-version.test.ts fakeDir 残留等未提及——均为首轮已记录的观察项,不阻断,维持记录 |
| F-9 收尾待办(OBSERVATION) | **处置中(进行时,未完成)** | CURRENT.md 完成态与 docs/CONTINUATION.md 更新已在工作区(未提交;内容经只读核对与处置声明一致、无越界、无夸大,"模型 18-20 次"如实写入 CURRENT.md);origin/main(66a2c5c)仍落后 HEAD 3 个提交。关闭前必须完成:收尾提交+快进 push+`origin/main==HEAD` 核验 |

## 新发现(复验新增,无升格:最高 MINOR)

- **N-1|REPORT §4 处置表与 REVIEW.md 发现清单编号错位(MINOR,文档)** — REPORT §4 表的 F-6("host-fallback env 清洗与 docker 层不完全同构")、F-7("waitSettled 100ms 轮询的时延余量")、F-9("**cancelRun** 辅助函数当前无调用方")三行引用的是 REVIEW.md 中**不存在**的发现:首轮 REVIEW.md 的 F-6/F-7/F-9 分别是 `--network host`、模型凭据面、收尾待办;且 `cancelRun` 符号在 src/ 中**根本不存在**(grep 零命中;`waitSettled` 存在于 pi-rpc.ts:139 但首轮未作为发现列出)。此外 REPORT §8 写 fresh-clone "clone@**40d3639**",而日志头部实际标注 `@ **7676477**...`(代码树 src 层面两者等同,7676477 仅多 4 个证据文件,但标注必须一致)。后果:结果证明文件与复核文件失去一一对应,后续追溯会错位;首轮 F-7 凭据面因错位而漏承接。属对接失误而非掩盖(三条描述的观察本身合理,只是编号对不上),**必须修订**:REPORT §4 按 REVIEW.md 编号重排并补 F-7 承接行,§8 SHA 更正为 7676477。
- **N-2|模型预算超限为已确认的合同纪律偏差(OBSERVATION,已披露)** — 实际 18-20 次 vs 合同上限 12(超 50-70%),REPORT §5 + CURRENT.md 均如实披露,构成(初探针 1/调试 2/E2E 3 轮含失败重试/证据 1 轮)与超限原因(docker 启动链三坑)交代清楚;"超限即停止模型相关路径并报告"的合同响应已履行:此后零模型调用(复核人全程实证),E2E 证据绑定 40d3639。属过程纪律违反而非安全违规,不可逆,不阻断验收;下包预算分段计数建议已写入 CONTINUATION.md(未提交)。记录在案,不追究 further。
- **N-3|E2E 证据与 HEAD 的代码漂移(6fc276e 修改了 docker 启动分支)(OBSERVATION)** — pi-e2e-run.log 绑定 40d3639,而 6fc276e 改动了唯一被 pi-e2e 覆盖的代码路径(launchPi docker 分支);F-4 修复因此处于"无运行时测试覆盖"状态(非模型测试全部不经该分支;fresh-clone@7676477 亦不含修复)。风险评估为极低:verifyPiRuntime 在当前环境恒通过(单测证实 vendored cli --version==1.5.0,resolveVendoredPi 已校验包声明,修复仅新增一个前置调用),tsc 0 错误,复核人已在 HEAD==6fc276e 全量复跑绿。处置:本轮以复验记录+HEAD 复跑消化该漂移;若 Operator 要求"E2E 绑定最终 SHA"的字面满足,需在下个授权窗口追加模型预算重跑 E2E——不擅自执行。建议 REPORT/收尾提交中如实注明"E2E 证据绑定 40d3639,6fc276e 仅加启动前校验(复核人 HEAD 复跑 68+2skip+tsc 0)"。

## 最终总裁决:**PASS-WITH-FIXES**

- 处置提交 6fc276e 的**代码修复正确且最小**(F-4:sandbox.ts 仅 +4 行校验,位置与语义均对);F-1/F-2/F-3/F-6 的边界声明如实到位;F-5 主体(debug schema + 模型调用披露)处置诚实;证据格式达标;复核人在 HEAD==6fc276e 独立复现 68 passed + 2 skipped + tsc 0 错误。首轮 9 项发现中**无升格**,新增 3 项(N-1 MINOR 文档错位、N-2/N-3 OBSERVATION)。
- **关闭本包前必须完成(全部为文档/卫生级,零代码返工、零模型调用)**:
  1. **N-1**:修订 REPORT §4 处置表按 REVIEW.md 编号对齐(现 F-6/F-7/F-9 三行引用不存在的发现,含不存在的 `cancelRun` 符号),补 F-7 凭据面承接行,§8 的 fresh-clone SHA 更正为 7676477;
  2. **F-5 收尾**:DROP 空 schema `undefined`;
  3. **F-9**:落盘收尾提交(CURRENT.md/docs/CONTINUATION.md/修订后的 REPORT),快进 push 唯一 main,核验 `origin/main==HEAD` + worktree clean;
  4. **N-3**:收尾提交中如实注明 E2E 证据绑定 40d3639 与漂移消化方式(复核人 HEAD 复跑),不做任何"证据绑定最终 SHA"的过强措辞。
- 上述完成后,本包在文档层面即可视为与首轮 PASS 裁决的预期状态一致;代码与测试本身自首轮以来维持 PASS 判断,无任何放宽或回退。

闭合确认:4cae8b2(REPORT 修订)+cbf55a5(复验落盘,diff 核实与复核人原稿逐字一致):关闭条件①②④已满足(REPORT §4 编号 F-1..F-9 与 REVIEW.md 逐一对齐、F-7 凭据面获 §6 风险 6 承接、§8 fresh-clone 更正 clone@7676477 且注明 E2E 证据绑定 40d3639 与 N-3 漂移消化;空 schema `undefined` 经复核人 psql 实查确认已 DROP),③由收尾 push 完成(执行后须实际核验 `origin/main==HEAD` + worktree clean,F-9 处置声明方完全为真)——最终裁决 PASS(无保留)。复核人:同一独立上下文 Reviewer,2026-11-10,全程零模型调用。
