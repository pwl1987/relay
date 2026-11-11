# P0-REWORK-2 报告:最小 CLI 与控制面闭环(总执行包·阶段 A)

- 合同:本包 ACTIVE 合同 `382edf7`(CURRENT.md);实现链:`382edf7..HEAD`
- 日期:2026-11-11;环境:VM80,Node v24.21.0(裸 node strip-types),真实 PG(每文件独立 schema)
- 裁决目标:闭合 P0-ACCEPT 遗留缺口 ②(US-04 CLI 未实现 / PAUSED 无置入入口)与 V03 验收

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

- `test/integration/cli.test.ts`:**10 例全绿**(goal 一致性/pause 阻断领取/resume/版本失配/越权/D3 批准/拒绝+defer/doctor 凭据零明文+未迁移 exit5/确定性退出码+零模型 Run/API pause 对等/bin 真实进程/stub tick 单拍 ACCEPTED)。
- 全量回归:见 CURRENT.md(本轮 49 文件);tsc --noEmit 0。
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

## 7. 遗留

无新增遗留;阶段 A 闭合 US-04/V03 的 MVP Must 面。下一步:阶段 B(REWORK-1 模型驱动 Discovery,依赖本地 magpie)。
