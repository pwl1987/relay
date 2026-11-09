# Relay 当前执行契约

- 状态：**P0-01A ACTIVE(持久状态与可靠执行内核)**。激活：2026-11-09,起点 `origin/main == 5901a06`(已冷启动核验,worktree clean,无其他 Writer)。
- 写者：**本 ZCode/VM80 会话(唯一)**。预算：**0 次模型调用**(本包不使用任何 LLM);PG 测试实例沿用 `relay-p000-pg`(127.0.0.1:55433,512Mi 上限,非生产)；测试数据按"每测试独立 schema"隔离,结束后清除。

## 唯一 Outcome

将 P0-00 已裁决语义(ADR-0007 + `p0-00/REPORT.md` §6)建设为正式最小状态层:

1. Drizzle migrations:`tasks` / `leases` / `audit_events`(append-only,含拒绝事件,PG 触发器阻断改写)/ `action_intents` / `task_gate_verdicts`(V08 最小门锁)。
2. 状态机(architecture §3):CREATED→READY→LEASED→RUNNING→SUBMITTED→VERIFYING→ACCEPTED,含 REWORK/NEEDS_RECONCILE/NEEDS_DECISION/PAUSED/BLOCKED/FAILED/CANCELLED;非法转移拒绝;VERIFYING→ACCEPTED 必须 gate PASS。
3. Lease/Fencing:单事务 claim/advance/heartbeat;fencing 单调递增;过期+非终态才可回收,回收必留审计;**TTL 窗口=权威窗口**(窗口内旧 Token 即使进程已死仍具权威——心跳续租是 Worker 义务,Supervisor 不得窗口内强收)。
4. Supervisor Tick:可回收→可领取→单任务的确定性 tick 函数;外部意图恢复先 Reconcile 三分类(确认/缺失安全重试/人工)。
5. Action Intent/Reconcile:RESERVED→EXECUTING→COMPLETED/CONFLICT;执行前核对 expected;恢复先查目标真实状态,绝不盲目重试。
6. exp-b/exp-c 语义升级为 Vitest 集成测试(真实 PG + 真实 SIGKILL + 本地 mock git 仓):V04/V05/V06/B2/B3b/heartbeat/tick/V08 最小/V02 最小;全新克隆可复现(`npm ci` + 测试 PG + `npm test`)。
7. 修复 `p0-00/exp-c` 的 node_modules 符号链接依赖(独立 package.json,不提交依赖目录/构建产物)。
8. 独立 Reviewer 复核(不同上下文)+ 快进 push main + 更新 `CURRENT.md` / `docs/CONTINUATION.md`。

## 可写范围(白名单)

`package.json` `package-lock.json` `tsconfig.json` `vitest.config.ts` `drizzle.config.ts` `src/**` `migrations/**` `test/**` `scripts/**` `p0-01a/**` `.gitignore` `CURRENT.md` `docs/CONTINUATION.md` `p0-00/exp-c/package.json`(及本地其 node_modules 修复,不提交)。

## 禁止(红线)

不修改 VM80 其他项目、共享 `~/.pi`、LoopX 注册表、生产环境;**不接入 Pi Runtime**(P0-01B)、**不访问真实 GitHub 写路径**(P0-02B,测试只用本地 mock git 仓)、不用生产凭据;不创建长期分支、不强推;测试失败不得通过放宽断言"转绿";不允许在共享用户环境执行 `pi install`。

## 停止条件

发现写者冲突、沙箱/Policy 旁路、双重有效 Writer 证据、不可确认的外部写入、需要扩大授权时:停止受影响路径并报告,不得自行扩大范围。验收映射:V04←B3/B3b,V05←C1/C2,V06←B1/B2,V02/V08 最小单测;全部必须真实数据库实测证据。

- 下一窗口完整入口:[docs/CONTINUATION.md](docs/CONTINUATION.md)。
