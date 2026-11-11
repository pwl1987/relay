# P0-REWORK-2 报告:最小 CLI 与控制面闭环(总执行包·阶段 A)

- 合同:本包 ACTIVE 合同 `382edf7`(CURRENT.md);实现链:`382edf7..HEAD`
- 日期:2026-11-11;环境:VM80,Node v24.21.0(裸 node strip-types),真实 PG(每文件独立 schema)
- 裁决目标:闭合 P0-ACCEPT 遗留缺口 ②(US-04 CLI 未实现 / PAUSED 无置入入口)与 V03 验收
- **独立复核:`p0-rework2/REVIEW.md` 判 PASS-WITH-FIXES(Reviewer 全新上下文亲测,HEAD=f748441);两处 Major 已在本包内修复并补回归测试(见 §8),Reviewer 建议采纳**

## 1. 交付面

| 项 | 内容 | 证据 |
| --- | --- | --- |
| Core `pauseTask` | READY→PAUSED 置入入口(此前 PAUSED 无任何置入途径):actor 授权 + expected state_version + 合法转移 + 审计,与 resumeTask 同口径;仅 READY 置入(租约链不打断,副作用归租约/Intent/Reconcile) | `src/core/ops.ts` |
| CLI | `src/cli.ts`(零新依赖、零 CLI 框架)+ `bin/relay.mjs` 薄壳 + package.json `"bin": {"relay": "./bin/relay.mjs"}`;命令:`goal create/list/show`、`decision list/resolve/defer`、`task resume`、`pause`、`worker tick`、`status`、`doctor` | `src/cli.ts`、`bin/relay.mjs` |
| 三入口同 Core | 读=server views 同一视图函数;写=core.ops(operatorAllowed+expectedStateVersion,同 API);tick=复用 `createLiveWorkerDriver`(FAIL-CLOSED 同 server live:provider 未配置/非 docker 隔离不领取);**零直接 SQL 改状态、零第二状态机** | `src/cli.ts` 分发层 |
| API 对等 | `POST /api/tasks/:id/pause`(同一 pauseTask;409/403/404 口径同 resume) | `src/server/api.ts` |
| 能力登记表 | 新增 `cli.entry` 与 `task.pause` 两行(IMPLEMENTED;不夸大) | `src/server/capabilities.ts` |
| doctor | 只读诊断:13 表迁移面+audit append-only 守卫、provider 配置可见性(不探测不打印值)、Pi 版本、docker、GitHub 凭据**存在性+权限位**(零内容)、任务/未决决策分布、`--probe` 可选出口探测(不改变退出码);每项独立容错,未迁移环境报 `db.ok=false` + 退出码 5 | `src/cli.ts:cmdDoctor` |
| 退出码 | 0 成功 / 1 内部 / 2 用法 / 3 业务拒绝(actor/version/transition/not_pending)/ 4 未找到 / 5 环境不可用 | `src/cli.ts:EXIT` |

## 2. 语义边界(总执行包 A2 逐条落实)

- **Pause 首先阻止领取**:`claimNextReady` 只查 `state='READY'` ⇒ PAUSED 不被领取——测试实证(先 pause 再 claim ⇒ `no_ready_tasks`)。
- **执行中副作用不打断**:pause 仅从 READY 置入;LEASED/RUNNING/SUBMITTED/VERIFYING 持租约,由既有租约回收/Intent/Reconcile 管理(不新增打断机制)。
- **Resume 过 actor+版本+合法转移检查**:复用 `recoverTransition` 单事务(授权/版本/转移/审计)。
- **D3 不被绕过**:resolve/defer 语义未动;D3 永不自动批准;pause/resume 不触碰 decisions 行。
- **CLI/API/Web 同一 Core**:pause 写路径只有 `core.ops.pauseTask` 一个实现(CLI `pause` 与 API `/api/tasks/:id/pause` 均调它;测试同断言)。

## 3. 验收结果(V03 + A4 六项)

1. **无 ChatGPT、无浏览器完整案例**:`p0-rework2/v03-journey.sh` 真实进程全程:doctor → goal create → pause(READY→PAUSED)→ 重复 pause(版本失配 exit 3)→ resume(PAUSED→READY)→ worker tick --stub --seed(PROGRESSED,run SUCCEEDED,gate ACCEPTED)→ goal show → decision list → status;日志 `v03-cli-journey.log`。
2. **CLI/API/Web 状态一致**:读路径同一视图函数(goalDetailView/decisionListView/dashboardView);测试断言 CLI create 的 goal 出现在同一 list 视图;API pause 与 CLI pause 操作同一任务的状态版本连续(API 暂停后 CLI 以 API 递增后的版本 resume 成功)。
3. **未授权/旧版本/重复操作正确拒绝**:exit 3 + 审计 `*_REJECTED` 行 + 状态零变更(测试:state_version 仍 0、`TASK_PAUSED_REJECTED` ×2)。
4. **SIGKILL 后可恢复**:既有 V04 语义未动(CLI 只经 Core 状态机,零旁路);本包不重复 V04 注入。
5. **确定性退出码**:usage=2/not_found=4/ok=0/denied=3/env=5 全部有断言(bin 薄壳真实进程两口径:迁移库 exit 0、缺迁移 exit 5)。
6. **CLI 控制面零模型请求**:控制命令全程 runs 表零行(断言);tick 显式命令才执行(stub 模式 argv 注入,`model` 仅满足 FAIL-CLOSED 门,零网络调用)。

## 4. 测试账

- `test/integration/cli.test.ts`:复核处置后 **13 例全绿**(详见 §8);tsc --noEmit 0。
- 演练:`p0-rework2/v03-cli-journey.log`(stub 如实标注 `workerMode: "stub"`;不冒充真实模型)。

## 5. 过程中发现并修复的真实缺陷(本包自证价值)

1. **单字命令 dispatch 缺陷**:`pause <taskId>` 的 taskId 被子命令槽吞掉 ⇒ 修复为按主命令分支(冒烟抓出)。
2. **布尔旗标值泄漏**:`--stub` 的值 `"true"` 被当桩路径 ⇒ `node /ws/true` MODULE_NOT_FOUND(run FAILED,runs.detail 实锤)⇒ 修复布尔取值。
3. **bin 双重执行**:`isMain` 误把 relay.mjs 判为主入口 + bin 壳再调一次 ⇒ 收敛为仅 `node src/cli.ts` 自跑。
4. **doctor 整段崩溃**:未迁移库上第二项查询抛错 ⇒ 改为每项独立容错(诊断面不因部分环境崩)。
5. **stub 角色环境未区分**:coder/reviewer 共用 env 会互相污染 ⇒ `STUB_REVIEWER_*` 命名空间(Reviewer 缺省 verdict PASS)。

## 6. 如实边界(不夸大)

- CLI `worker tick` 未挂交付工厂(候选交付装配属阶段 E relay-worker 编排):gate ACCEPTED 后任务停 ACCEPTED,changeset 停 CAPTURED 语义如实展示;真实交付链已由缺口 A 联验(Web/API 侧)覆盖。
- V03 演练的执行拍为 stub(报告内 `workerMode: "stub"` 显式标注);真实模型面由缺口 A `live-worker-e2e` 联验承担,本包零真实模型调用。
- doctor 的 egress 探测默认关闭(只读诊断不发起网络;`--probe` 可选)。
- `--stub` 仅支持 `--stub` / `--stub=<path>` 语法(布尔旗标吞空格值,帮助文本已如实标注)。

## 7. 独立复核结论与处置(REVIEW PASS-WITH-FIXES)

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| RUNNING(活跃租约)任务可被 pause,在飞执行被 fencing 打断,与"仅 READY 置入"声明矛盾 | Major-1 | **已修**:`pauseTask` 加 READY 状态门(非 READY ⇒ 拒绝 `pause_requires_ready:<from>` + `TASK_PAUSED_REJECTED` 审计;状态门先于版本门);CLI/API 同一 Core 即刻生效;回归测试:RUNNING+活跃租约 pause 被拒、任务/租约不变 |
| CLI `decision defer` 无 operator 门(intruder 可改截止时间;Core 层无授权检查,API 靠全局写门补偿) | Major-2 | **已修**:`deferDecision` 下沉 `operatorAllowed` 至 Core(拒绝 + `DECISION_DEFER_REJECTED` 审计),三入口同一权威;回归测试:CLI 直调 intruder exit 3、截止时间不变、审计落库 |
| 阻断测试未断言 claim 失败 reason | Minor | **已修**:断言 `reason === "no_ready_tasks"` |
| `--stub <path>` 空格语法与注释不符 | Minor | **已修**:帮助文本/注释统一为 `--stub=<path>` |
| CLI worker tick 无 operator 门(与 API tick 口径不一致) | Minor | **已修**:tick 前置 operatorAllowed(--actor,缺省 owner) |
| 全量计数口径浮动(49/50 文件) | Minor | **已修**:统一以"50 文件(随门控环境浮动)"口径记录 |
| goal create 无 goal 级审计 | Minor | 维持登记(planGoal 已落 GOAL_PLANNED/TASK_PLANNED 审计;与 API 行为一致) |

## 8. 测试账(复核处置后)

- `test/integration/cli.test.ts`:**13 例全绿**(原 10 例 + Major-1/Major-2/Minor tick 门回归 3 例)。
- 回归面:web-api/goal-loop/delivery-propose-fallback 32 例全绿(修复触及 core ops/decisions);tsc 0;全量以 CI 隔离运行为权威口径(R-9)。
- 全量(本机无并发窗口,复核处置后终账):**216 例 = 207 passed + 7 skipped + 2 failed(50 文件)**;2 failed 均为 github-real PAT 403 凭据面(用户侧单点;CI 无凭据自动 skip);本轮 egress-proxy 与 live-worker-e2e 均通过(前轮间歇失败=magpie 环境型,隔离复跑可绿,与本包改动无关,CI 自动 skip)。

## 9. 遗留

无新增遗留;阶段 A 闭合 US-04/V03 的 MVP Must 面。下一步:阶段 B(REWORK-1 模型驱动 Discovery,依赖本地 magpie)。
