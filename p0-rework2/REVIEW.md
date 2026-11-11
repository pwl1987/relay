# P0-REWORK-2(阶段 A)独立复核报告(REVIEW.md)

- 复核人:独立 Reviewer(与实现者零共享假设;不采信任何完成声明,一切以本机亲自读取与运行结果为准)
- 复核时点:2026-11-11;复核 HEAD:`f748441a212bdbaa72b21bec7dbcb8b26bb36d66`(本地已提交未推送;复核期间 HEAD 未变,复核结束工作区已恢复 clean)
- 合同:`git show 382edf7:CURRENT.md`(REWORK-2 ACTIVE);实现 diff:`382edf7..f748441`(12 文件,+1561/-11)
- 环境:VM80,Node v24.21.0,PG 容器 relay-p000-pg(PostgreSQL 17.11,127.0.0.1:55433/relayp000)
- 方法:冷启动读合同/源码/diff → 目标测试 → 一次性 schema 真实进程 CLI 全程 → Core 反例实证(import src/core)→ 容器内 psql 直查审计(不经被测代码)→ doctor 泄密加压 → 全量回归

## 1. 实际执行的命令与结果(全部亲测)

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npx vitest run test/integration/cli.test.ts` | **10/10 绿**(4.64s) |
| 2 | `npx tsc --noEmit` | **0 错误**(exit 0) |
| 3 | `npx vitest run`(全量) | **213 例 = 204 passed + 7 skipped + 2 failed**(50 文件:47 过 + 1 失败 + 2 skip);2 failed 均为 `github-real`(PAT 403 "Write access to repository not granted",凭据面,与本包改动无关);REPORT/CURRENT 称的 egress-proxy、live-worker-e2e 间歇失败**本轮均通过**——与"间歇"定性相容,计数随环境浮动 |
| 4 | 真实进程 CLI 全程(一次性迁移 schema):`node bin/relay.mjs` doctor / goal create / pause / 旧版本重复 pause / intruder pause / task resume / goal show / status / decision list / unknown-cmd / goal show nonexistent / pause not-found / pause 缺版本 / pause 坏版本 / bare / help | 退出码依次 **0/0/0/3/3/0/0/0/0/2/4/4/2/2/2/2**,全部与合同映射一致;`state_version_mismatch`/`actor_not_authorized`/`goal_not_found`/`task_not_found` 错误码逐一对上 |
| 5 | 反例脚本(node ESM 直接 `import src/core/supervisor.ts`、`src/core/ops.ts`、`src/core/lease.ts`) | 见 §3 |
| 6 | 容器内 psql 直查 `audit_events`(SET search_path=一次性 schema) | 见 §4 |
| 7 | doctor 泄密加压:`RELAY_PI_API_KEY=github_pat_XXXXfakeTOKEN…` 运行 doctor;`grep -oE "github_pat_|gh[posr]_…|[A-Za-z0-9_-]{40,}"` 扫描输出;`doctor --probe` | 见 §5 |

## 2. 验收面逐项裁决

### 2.1 目标测试与类型检查 — **VERIFIED**
10/10 绿、tsc 0,与 REPORT §4 声明一致。

### 2.2 V03 真实进程全程 — **VERIFIED**
一次性 schema + `node bin/relay.mjs` 真实进程:goal create(exit 0)→ pause READY→PAUSED(exit 0)→ 旧版本重复 pause(exit 3,`state_version_mismatch`)→ resume PAUSED→READY(exit 0)→ goal show(exit 0,`stateVersion: 2` 与暂停/恢复两次 +1 一致)→ doctor(exit 0,13 表 + append-only 守卫 ok)。`p0-rework2/v03-journey.sh` 与 `v03-cli-journey.log` 与我复跑的路径一致;日志 112 行如实输出 `"workerMode": "stub"`、gate reason `cli-stub PASS`(不冒充真实模型)。全程无浏览器、无 ChatGPT、无真实模型调用(REPORT §3.1 与实测一致)。

### 2.3 PAUSED 阻断领取 + resume 后可领取(fencing 正常)— **VERIFIED**
直接 import Core 实证(不经 CLI、不经被测路径外的包装):
- `pauseTask(db, taskId, {actor:"owner", v})` → `{ok:true, fromState:"READY", toState:"PAUSED"}`;
- 紧接 `claimNextReady(db, "w-review", 60)` → **`{ok:false, reason:"no_ready_tasks"}`**,且 SQL 直查 `tasks WHERE state='READY'` 候选数 = 0(双重佐证);
- `PAUSED` 上以正确版本再 pause → `{ok:false, reason:"illegal_transition:PAUSED->PAUSED"}`(重复操作正确拒绝);
- `resumeTask` → READY;`claimNextReady` → **`{ok:true, taskId 匹配, fencingToken:1, attempt:1}`**,leases 行 `fencing_token=1` 落库。
结论:pause 阻断领取、resume 恢复、fencing 链不打断,全部实证成立。

### 2.4 审计如实落库(独立 SQL 直查)— **VERIFIED**
不经被测代码,容器内 psql 直查:
- `TASK_PAUSED`(owner, OPERATOR, before READY→after PAUSED)✓
- `TASK_PAUSED_REJECTED` `detail={reason:"state_version_mismatch", expected:0, actual:1}` ✓
- `TASK_PAUSED_REJECTED` `detail={reason:"actor_not_authorized"}`,actor=intruder ✓
- `TASK_RESUMED`(PAUSED→READY)✓
- 另有我反例触发的 `TASK_PAUSED_REJECTED(illegal_transition:PAUSED->PAUSED)`、`ADVANCE_REJECTED` 均如实留痕。
`*_REJECTED` 行 before/after 为空且状态零变更(实测 state 仍 READY、version 仍 0),拒绝不改状态成立。

### 2.5 doctor 泄密面 — **VERIFIED**
- 正常输出:githubCredential 仅 `{exists, path, mode:"600", sizeBytes, contentShown:false}`;`github_pat_`/`ghp_`/40+ 位串扫描**零命中**;
- 加压:env 注入假 `github_pat_` 形态 API key 后,输出仍零命中(provider 项只打 `{name, set}` 布尔,不打值);
- `--probe` 可选探测不改变退出码(实测 exit 0);
- 每项独立容错(`safe()` 包裹)与"未迁移环境 exit 5"测试断言一致。

### 2.6 三入口同调 Core / 唯一写实现 / 零直接 SQL — **VERIFIED(含 1 处例外见 Major-2)**
- **PAUSED 唯一置入实现**:grep 全 `src/`,写 PAUSED 的只有 `core/ops.ts pauseTask → recoverTransition`;`UPDATE tasks SET state` 的写点全部位于 core(lease/intents/goal-loop/ops/supervisor/gates),**CLI 与 API 层零直接状态 SQL**;
- CLI 读路径 = `src/server/views.ts` 同一函数(goalListView/goalDetailView/decisionListView/dashboardView);写路径 = core.ops 同口径;tick = `createLiveWorkerDriver`(FAIL-CLOSED 同 server live;`stubInjection` 为 worker.ts 既有参数,c407cb0 已引入,非本包新造);
- goal create:CLI 显式 `operatorAllowed(actor)` 前置(✓ 校验 operator);默认口径与 API `deriveDefaultPlan` 一致(单任务、`/workspace`、`["echo"]`、priority 0、maxAttempts 3,实测源码逐字段对上);
- API `POST /api/tasks/:id/pause`:同一 `pauseTask`,置于会话门 + 全局写门(verifySameOrigin+CSRF+`operatorAllowed(session.role)`)之后,409/403/404 映射与 resume 同口径(测试 401/200/409 实证);
- capabilities 登记表新增 `cli.entry`/`task.pause` 两行(IMPLEMENTED),措辞不夸大;
- lifecycle 表 READY→PAUSED、PAUSED→READY 均合法,`pauseTask` 复用 `recoverTransition`(授权/版本/转移/审计单事务)。

### 2.7 假绿排查 — **未发现恒真断言/自证循环;1 处断言偏弱(Minor-1)**
- 关键断言均有独立 DB 直查对照(budget_ledger 计数、audit 行数、`taskState()` 直查 tasks 表),非被测代码自证;
- "PAUSED 不被领取"测试断言 `claim.ok === false` **但未断言 reason**——测试内先将其他 READY 任务置 BLOCKED 形成候选隔离、resume 后 claim 成功构成对照,实质成立;我在反例中已直接实证 reason=`no_ready_tasks`,故不构成假绿,但建议补 reason 断言(Minor-1);
- stub tick 测试:断言 `workerMode === "stub"`(如实标注桩),输出含 run/gate 落库直查;不冒充真实模型;
- "控制面零模型 Run"断言 runs 表零行:依赖测试顺序(在 stub tick 用例之前),顺序一致、结论成立;
- API pause 测试用注入 Auth(401/200/409 断言真实;真实 auth 中间件由既有包覆盖,可接受);
- bin 真实进程测试 spawnSync 真退出码 0/5。

### 2.8 REPORT.md 一致性抽查 — **主体一致;2 处不实(见 Major)/3 处口径偏差(见 Minor)**
- "10 例全绿 / tsc 0 / 10 项测试内容" ✓;"过程修复 5 缺陷"逐条在代码可证:①单字命令 dispatch(`cmdTaskTransition` 以 sub 位承接 taskId)✓ ②布尔旗标 `knownBoolean` ✓ ③bin 双重执行收敛(`isMain` 判 `endsWith("cli.ts")`,bin 壳不自跑)✓ ④doctor 每项 `safe()` 容错 ✓ ⑤`STUB_REVIEWER_*` 命名空间 ✓——**无夸大**;
- V03 演练日志与脚本一致、stub 如实标注 ✓;
- **不实 1**:REPORT §1/§2 及 `ops.ts` docstring 称"仅 READY 置入(租约链不打断)"——实测 RUNNING 任务可被 pauseTask 置入并打断在飞执行(§3 反例);
- **不实 2**:REPORT §1 称"写=operatorAllowed+expectedStateVersion 同 API"——CLI `decision defer` 实测无 operator 校验(§3 反例);
- 口径偏差:REPORT §4 "49 文件" vs CURRENT "50 文件" vs 实测 **50 文件**;全量计数 REPORT/CURRENT 称 202+7+4,实测 204+7+2(失败均 github-real 403 凭据面,间歇项本轮通过——定性相容,计数浮动未注明)。

## 3. 关键反例实证(发现问题的证据链)

**反例 A(→ Major-1):RUNNING 任务可被 pauseTask 置入,在飞执行被打断。**
脚本直接 import Core 执行:
1. `claimNextReady` 真实领取(ttl=3600s,活跃租约,fencing=1)→ `advanceTask(LEASED→RUNNING)` 成功;
2. `pauseTask(db, taskId, {actor:"owner", expectedStateVersion:当前})` → **`{ok:true, fromState:"RUNNING", toState:"PAUSED"}`**;
3. SQL 直查:任务落库 `PAUSED`(version+1),**租约行仍存在且 `lease_expires_at > now()`(active=true)**;
4. worker 侧以正确 fencing 调 `advanceTask(RUNNING→SUBMITTED)` → **`{ok:false, reason:"state_mismatch:PAUSED"}`**,审计落 `ADVANCE_REJECTED`。

即:在飞 run 的结果永远无法提交,任务停 PAUSED+活租约,需人工介入。这与 REPORT §1/§2("仅 READY 置入;租约链不打断;不新增打断机制")及 `ops.ts` docstring("本入口只允许从 READY 置入,避免与 fencing 竞争")直接矛盾——代码只查 `isLegalTransition(fromState,"PAUSED")`,而 lifecycle 表(既有)`RUNNING→PAUSED` 合法,pauseTask 未做 fromState 收窄。合同语义"执行中外部副作用由既有租约/Intent/Reconcile 管理(不新增打断机制)"被绕出一条新打断路径。

**反例 B(→ Major-2):CLI `decision defer` 未授权 actor 可成功。**
NEEDS_DECISION 任务 + OPEN 决策,真实进程 `node bin/relay.mjs decision defer <id> --task <t> --deadline 2027-06-01T00:00:00Z --expected-state-version N --actor intruder` → **exit 0**,deadline 被改为 2027-06-01,审计落 **`intruder : DECISION_DEFERRED`**。根因:`core/decisions.ts deferDecision` 无 `operatorAllowed` 检查;API defer 靠 `handleApi` 全局写门(`operatorAllowed(session.role)`)补偿,而 **CLI 无补偿门**。违反合同"写=operatorAllowed+expectedStateVersion 同 API"。同 CLI 的 pause/resume/resolve 对 `--actor intruder` 均拒绝(exit 3),授权面不对称。缓解:defer 仅改 deadline(状态不变、D3 永不自动批准),且 CLI 为本地工具、`RELAY_OPERATORS` 本为调用方可配——实践风险有限,但契约口径与审计归属(以声明 actor 落库)确实失守。

## 4. 发现问题分级

**Blocker:无。**

**Major:**
1. **pauseTask 未限制 fromState=READY,RUNNING(含活跃租约)可被打断**(§3 反例 A)。修法二选一:`pauseTask`/`recoverTransition` 调用处加 fromState 守卫(如 `pauseTask` 内先校验 task.state==="READY" 再走 recoverTransition),或如实改 REPORT/docstring/能力表承认 RUNNING→PAUSED 为合法运维动作并写明租约残留与在飞 run 的处置。前者与现有声明一致,推荐。
2. **CLI `decision defer` 缺 operator 授权门**(§3 反例 B)。修法:CLI defer 前置 `operatorAllowed`(与 `cmdGoalCreate` 同壳,拒绝时 exit 3),或在 `deferDecision` 补授权检查(API 已有全局门不受影响)。

**Minor:**
1. `cli.test.ts` 阻断实证未断言 claim 失败 reason(建议补 `reason === "no_ready_tasks"`);
2. 全量计数/文件数口径不一:REPORT "49 文件"、CURRENT "50 文件"、实测 50;计数随间歇失败浮动(202+4 ↔ 204+2),建议统一并注明浮动属性;
3. `src/cli.ts` 注释称"`--stub <path>` 用指定桩",但 `parseArgs` 将 `stub` 列为布尔旗标:空格语法下路径被静默吞为位置参数(实测 `--stub /path` 仍用默认桩,仅 `--stub=/path` 生效)——注释与行为不符,建议改注释或修取值;
4. CLI `worker tick` 无 operator 门,而 API `POST /api/worker/tick` 受全局写门 `operatorAllowed` 约束——与"三入口同口径"表述不符(本地工具威胁面,风险低,建议至少在 help/文档注明);
5. CLI goal create 不写 goal 级审计(API 写 `WEB_GOAL_CREATED`);`planGoal` 自带 `TASK_PLANNED`,可接受,仅记录不对称。

## 5. 复核过程副作用声明(如实)

- 复核产生的唯一文件写入即本报告(`p0-rework2/REVIEW.md`);反例/演练脚本与输出均在 `/tmp/rw2-review/`,一次性 schema `p01a_review_rw2a` 已 DROP,`git status` 已恢复 clean;
- 全量回归时既有测试 `live-worker-e2e.test.ts` 按其自身设计向 `p0-accept/live-worker-e2e.log` 追加了运行记录(该测试为 P0-ACCEPT 包引入的真实模型联验,本轮真跑通过并完成一次真实远端交付);该追加属测试自身行为,已 `git checkout --` 恢复至 HEAD 原状。未 commit、未 push、未触碰任何其他文件。

## 6. 最终结论

**PASS-WITH-FIXES。**

核心交付与验收标准全部实证成立:目标测试 10/10、tsc 0;真实进程 CLI 全程退出码确定性正确;**PAUSED 阻断 `claimNextReady` 领取(含 reason 实证)与 resume 后 fencing 正常**;审计 `TASK_PAUSED`/`TASK_PAUSED_REJECTED`(两种 reason)/`TASK_RESUMED` 如实落库且拒绝零状态变更;doctor 零泄密(含 token 形态加压扫描);三入口同调 Core、PAUSED 写实现唯一、CLI 零直接状态 SQL;V03 演练真实进程且 stub 如实标注;全量回归失败均为既有 github 凭据面(PAT 403),与本包改动无关。

两个 Major(REWORK-2 pauseTask 未收窄 fromState 至 READY、CLI defer 缺 operator 门)不推翻验收面,但属于实现与自身声明/合同口径的实质偏离,须在进入阶段 B 前修复并复核;三个 Minor 建议随手清(断言 reason、计数口径、`--stub` 注释)。
