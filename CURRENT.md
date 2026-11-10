# Relay 当前执行契约

- 状态:**P0-01C ACTIVE**。激活:2026-11-10。起点 `origin/main == HEAD == 7836333`(已核对一致,worktree clean,无写者冲突)。
- 写者:**本会话(VM80,P0-01C 唯一 Writer)**。远端 HEAD 前移或非本人提交 → 立即停止写入并只读上报。
- 目标(`docs/CONSTRUCTION_PLAN.md` P0-01C 行 + 架构 §3/§6 + SECURITY_MODEL T07/T09):受控 Goal Loop——简单目标→任务→有界自治执行;自治运行安全收口;机器强制预算;D0–D4 决策分级与恢复。

## 分段实施(顺序执行,每段可独立验证)

### C-1 自治运行安全收口(承 P0-01B REVIEW F-2/F-3/F-7/F-8 遗留)

1. 心跳 DB 异常止损:心跳事务**连续抛错**(区别于业务拒绝)≥2 次 ⇒ 终止 Run(INTERRUPTED),有故障注入测试。
2. `relay_exec` 收敛:tasks.allowed_commands(默认空=禁 exec)+ 命令前缀白名单 + shell 控制字符全禁(`;&|` 反引号/换行);越权 DENIED 留双通道审计(workspace 文件为辅,**Worker 侧持久化为主**)。
3. 工具事件可信持久化:runner 经 RPC 事件流捕获 tool_call 事件原文,Worker(宿主侧)写 `runs.detail.toolEvents`;workspace 内 tool-audit.jsonl 降级为辅助证据。
4. **网络出口约束(本包核心新增)**:专用 bridge `relay-egress-net` + `DOCKER-USER` iptables 白名单(仅宿主模型端口;该子网其余 FORWARD 全 DROP)。实验依据(2026-11-10 实测):bridge 容器默认可出外网(npmjs 200)= 危险;bridge→宿主 3425 被 ufw 拦 ⇒ 用 DOCKER-USER 显式 ACCEPT(该链先于 ufw)。规则带注释标记、幂等创建、作用域仅限本子网(不影响 VM80 其他项目)。**宿主防火墙改动属本合同显式授权范围**(用户明确要求"对无人值守 Run 施加网络出口约束");仅限 DOCKER-USER 链,不改 ufw 策略、不改宿主服务。
5. 真实密钥隔离**设计**(不实现):egress 代理持密钥+改写 Authorization,Run 容器内零密钥;文档化于 REPORT,未验证前继续假密钥(magpie 本地路由)。

### C-2 机器强制预算(架构 §6/SECURITY_MODEL T09/V11)

- 新表 `budget_ledger`(scope goal/task/run × kind model_calls/tokens_in/tokens_out/wall_seconds;limit/reserved/used);**先预留再执行后核算**,预留失败 = Run 不启动。
- 上限来自 goals.budget + task 覆盖;达到上限自动停:任务 RUNNING→BLOCKED(budget_exhausted),不烧模型。
- Token 从 RPC `message_end.usage` 实测提取;**不可测即保守估算并 FAIL-CLOSED**;模型调用计数按 assistant 回合数。
- **本包自证**:C-2 交付后,本包剩余全部真实模型调用(含 E2E/重试/调试)必须经同一账本预留——狗粮自吃,超限机械阻断。

### C-3 Decision 与 Goal Loop(架构 §6,D0–D4,T07)

- 新表 `goals` + `decisions`;确定性 Planner(无模型):goal spec → goals + tasks(CREATED→READY);WorkPackage 裁剪为 task.goal_id 直挂(声明于 REPORT)。
- D0/D1 作用域内自动;**D2 仅执行事先授权的 fallback**(decisions 行创建时校验 fallback 已声明);**D3 永不超时自动批准**(deadline 仅标记 EXPIRED_STILL_BLOCKED,状态停留 NEEDS_DECISION,T07);D4 拒绝创建/直接 BLOCKED。
- 恢复 API(`src/core/ops.ts`):resolveDecision/releasePause/unblockBlocked——actor 授权校验(env RELAY_OPERATORS)+ expected state_version + 合法转移 + 审计;权限不符拒绝。
- 人工不响应:D3 任务停 NEEDS_DECISION,**其余任务不受阻**(claim 按任务独立)——测试证明 D3 停滞 + 另一 task 走到 ACCEPTED。

### C-4 自治恢复(V11/V15/US-09)

- tasks.retry_not_before + 指数退避;run 失败(RUNNING 态)→ 有界 REWORK→READY(attempt 预算沿用);相同失败签名连续 ≥K(默认 3)→ 熔断 task FAILED(CIRCUIT_OPEN 审计)。
- Goal Loop tick:supervisorTick + 退避释放 + 停滞识别 + 预算检查 + **模型断供探测(不烧 token 的 TCP 探测,失败即 IDLE)**;无可安全执行的工作 → IDLE,不循环烧模型。
- 进程重启从 PG 恢复事实状态(状态全在库,loop 无内存权威);重复 Tick 并发安全(SKIP LOCKED)故障注入。

## 可写范围(白名单,超界即停)

- `src/core/`:schema.ts(goals/decisions/budget_ledger + tasks 增列 retry_not_before/allowed_commands)、lease.ts(仅 claim 的 retry_not_before 过滤)、supervisor.ts(退避/熔断/IDLE 钩子)、lifecycle.ts(仅注释级)、**新增** budget.ts / decisions.ts / goals.ts / ops.ts;
- `src/runtime/`:runner.ts(心跳止损/工具事件/预算接线)、sandbox.ts(egress 网络/命令白名单 env)、relay-tools.extension.ts(命令白名单);**新增** egress.ts;
- `migrations/0002_*.sql` + meta;`scripts/`(egress 规则脚本,幂等);`test/**`、`vitest.config.ts`(如需);
- `package.json`(补 typebox 显式 devDep,P0-01B F-8 顺手项);`docs/`、`CURRENT.md`、`p0-01c/**`。
- **禁止**:真实 GitHub 写路径、完整 Gate 编排(P0-02A)、Web、生产部署、RSI、长期分支、强推、ufw 策略修改、修改 VM80 其他项目。

## 成本预算(机器强制,自证)

- 开发/测试期:**0 真实模型调用**(全部用 stub);最终验收 E2E 经 budget_ledger 预留执行,**上限 ≤ 8 次请求**(含断连重试);账本达到上限 = 机械停止,不再申请追加。
- 模型用量不可测场景(如 RPC usage 缺失)按保守估算入账并 FAIL-CLOSED。

## 停止条件

- DOCKER-USER 规则无法建立或验证失败 → 停无人值守 Run 路径(网络约束是硬门禁,不得以 host 网络降级通过);
- 沙箱/白名单越权证据 → 停相关路径;写者冲突/远端前移 → 停写入;
- 模型预算触顶 → 停模型相关路径并报告(不放宽);需要改 ufw/宿主服务/扩大权限 → 停止并请示。

## 验收标准(全部可机器核验)

1. Vitest + 真实 PG 集成测试全绿;心跳连续 DB 异常故障注入证明 Run 停止;
2. 未授权 shell/网络/文件访问被阻断且有双通道证据(白名单 DENIED + DOCKER-USER DROP 实测);
3. 无人工干预多 Task 有界执行(stub 编排全链 + ≥1 个真实模型自治 goal 闭环,经账本预留);
4. D3 超时绝不执行,其他安全任务继续(集成测试);
5. 无限失败场景预算强制生效(熔断+账本触顶,零模型亦可测);
6. 心跳失败/Worker SIGKILL/重复 Tick/进程重启恢复四类故障注入;
7. 测试数据与其他 VM80 项目完全隔离(独立 schema + 专用网络子网,不影响他人);
8. 独立 Reviewer 验证;证据绑定实现 SHA;通过后快进 push main,更新 CURRENT.md、docs/CONTINUATION.md、p0-01c/REPORT.md。
