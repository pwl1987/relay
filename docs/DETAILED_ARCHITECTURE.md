# Relay 详细架构设计（可施工基线）

状态：**FROZEN（职责、状态不变量、边界） / OPEN（数据类型及技术 POC）**。与 [架构基线](../ARCHITECTURE_BASELINE.md)、[领域模型](../DOMAIN_MODEL.md)、[核心契约](../CONTRACTS.md) 一致；不另造第二套产品权威。

## 1. 逻辑/部署架构

```text
Mac / VM80 Local CLI / browser / future ChatGPT Client
        │  HTTP(S) / local Unix socket
        ▼
   relay-server
   ├── Goal Intake + Discovery Service
   ├── Work Planner + Lifecycle State Machine (唯一控制者)
   ├── Decision/Policy Engine + Approval Inbox
   ├── Quality Gate Evaluator + Evidence Catalog
   ├── Project/ChangeSet API + Read Models
   └── Observability + Audit
        │ PostgreSQL transactions / events / lease / outbox
        ▼
   relay-worker（可同机、独立进程；P0 单 Worker）
   ├── Supervisor Tick + Lease/Fencing + Budget/Progress Guard
   ├── AgentRuntime Adapter: Pi（不等于模型）
   ├── Bounded Session Context / Handoff / Context Pack
   └── Action Proposal -> Policy recheck -> Scoped Executor
         ├── FS/Shell/Git (P0, 沙箱中)
         ├── GitHub API (P0 最小权限)
         └── Browser/Search/SSH/Deploy (P1 插件)
        ▼
   Project workspace (独立临时 checkout) / 目标 GitHub main / CI
```

推荐 3 个逻辑长驻组件：server、worker、PostgreSQL；P0 可用同一 TypeScript 项目、两个启动入口，避免不必要的微服务。脚本/CI/Chromium 等短生命周期启动。Server 负责 API/政策与状态，Worker 负责有限任务；二者共用类型 Schema 不共享超出 Port 的可变内存。

## 2. 领域数据的持久化草图

**实现现状（2026-11-14）**：下表候选字段已按 P0-00 实测结论固化为 `migrations/0000..0009`（Drizzle），实际列以迁移文件与 live main 为准；本表保留为设计叙述。

| 聚合/表（候选） | 关键字段 | 写入者 |
| --- | --- | --- |
| projects | id, name, settings_ref, policy_version, created_at | server |
| repositories | id, project_id, canonical_url, default_branch, allowlisted_path, last_observed_sha | server/reconciler |
| goals | id, project_id, raw_input, proposed_outcome, acceptance_ref, state, budget, policy_snapshot | server |
| work_packages | id, goal_id, contract_ref, parent_version, state | server（P0 可轻量） |
| tasks | id, goal_id, work_package_id?, depends_on, allowed_scope, acceptance_ref, state, state_version, priority | state machine |
| runs | id, task_id, attempt, runtime, model_ref, input_commit_sha, budget, started_at, ended_at, outcome | worker/event writer |
| leases | task_id, owner_id, fencing_token, lease_expires_at, heartbeat_at | supervisor transaction |
| sessions | run_id, checkpoint_ref, handoff_ref, context_digest, resume_mode | worker |
| decisions | id, scope, risk, authority, deadline, fallback, effect_scope, state, assumption_ref | policy/server |
| action_intents | id, run_id, capability, target, args_digest, idempotency_key, grant_ref, state, reconcile_rule | scoped executor |
| evidence | id, run_id, commit_sha, environment_ref, type, object_ref, digest, producer, captured_at, validity | evidence collector |
| changesets | id, project_id, target_repo, base_sha, candidate_sha, gate_verdict, delivery_sha | state machine |
| audit_events | id, seq, actor, authority, target, action, before/after digest, outcome, timestamp | append-only transaction |

P0 的 WorkPackage/ChangeSet 先以结构化记录/少量表完成关联，不强迫完整 ERP 模式。物理存储可合并部分表，但不得混淆所有权。大型日志/截图置于受控 Artifact 存储（可从文件系统起步），PostgreSQL 存路径/Hash/保留策略，不把二进制塞入任务行。

## 3. 状态机与重入语义

六个阶段 `DISCOVER / DESIGN / BUILD / VERIFY / DELIVER / OPERATE` 是 SDLC **阶段**，不是细粒度 Task 状态。Task 状态候选如下：

```text
CREATED -> READY -> LEASED -> RUNNING -> SUBMITTED -> VERIFYING -> ACCEPTED
                  └─[失效] NEEDS_RECONCILE ──> READY / BLOCKED
RUNNING / VERIFYING -> REWORK -> READY（新 attempt，受限）
READY / RUNNING -> NEEDS_DECISION / PAUSED / BLOCKED / FAILED
```

任何从状态 A→B：
- 使用 `expected_state_version`、合法转移表、独占 Lease/fencing token（需要时）、Decision/grant 校验；
- 在单个 DB 事务更新状态及 `audit_events`，写 `outbox`（若有跨进程通知）；
- 不直接由 Agent 文本 DONE、MCP/ACP 事件或 Shell exit 0 转 ACCEPTED。
- Cancel、Timeout、Retry、Reopen 都是可审计事件，不能覆盖历史 run/evidence。

Lease 过期不证明外部操作未执行。旧 Worker 恢复后即使仍持有旧参数，也因 fencing token 失效而不得进一步申请新的动作；**已发出的外部动作**必须按目标系统 reconcile。

## 4. 外部副作用的两阶段动作日志

`Proposal → Authorize → Reserve(Intent) → Execute → Observe → Reconcile/Commit Result`

一次外部动作存 `action_intents`：范围、参数 hash、目标唯一键、前置预期状态（例如 git SHA）、idempotency key、deadline、reconciliation handler。执行器接收**短效 grant**而不是模型传的原始凭据。

失败分类：
- 执行前 Policy DENIED：绝不开始；
- 执行明确失败且无副作用：可按预算重试；
- 执行成功且可查询：写 Observation；
- **执行中断/返回未知**：NEEDS_RECONCILE，先读取 GitHub/目标服务真实状态，确定是否已完成再决定跳过、补偿、重做或人工停止；
- 已执行但结果与预期不符：BLOCKED/ESCALATE，不能用“重新推送”掩盖冲突。

**原子承诺仅在 DB 内部事务有效**；对 GitHub、Shell、SSH、Deploy 不承诺端到端 exactly-once。Git push 使用远端 HEAD 预期 SHA 并只允许 fast-forward；写 `main` 需唯一 Writer 协调、满足 Gate 与策略。不要把临时 detached worktree 误认为“创建了新长期分支”。

## 5. Agent/Session/Context

AgentRuntime Port（逻辑）：
- `start(runSpec)` 返回 run handle；
- `streamEvents(handle)` 输出结构化 progress、tool_proposal、observation、terminal/error；
- `interrupt(handle)`、`cancel(handle)`；
- `reconstruct(runSpec, handoff)` 重新建立运行上下文，不承诺恢复模型 KV cache；
- `capabilities()` 暴露工具/模型上下文限制。

**Pi first；SDK/RPC 取舍已由 P0-00 实测裁决（ADR-0003：RPC 子进程+双层隔离）**；进程隔离并不自动等于 OS 沙箱。预设 Runtime 与 ModelProvider 独立；本地模型 API 不得影响生命周期控制。

Handoff 最少 `objective, requirement, current_state, decisions, changed_files, known_risks, failed_attempts, evidence, open_questions, next_action`，以有界大小和来源引用构成，不注入所有历史。ContextResolver 首版可为简单检索/模板函数，后续 Memory/CodeGraph 是 Plugin，不是第二事实源。

## 6. 决策和门禁

Decision D0/D1 可自行执行（必须在权限作用域内）；D2 需要**先前明确授权的 fallback**；D3 需要人批准；D4 禁止。按 `risk, reversibility, confidence, blast_radius, cost, environment, capability` 判定，Policy 由确定性规则实现，模型建议只提供辅助证据。

Quality Gate 编排只由 Core 完成：
- Task Gate：满足相应 G0–G5 的证据、独立 Reviewer/测试和禁止越权条件；
- ChangeSet Gate：对**最终候选 commit**复核集成范围、变更影响、测试/Review、GitHub policy；
- Project Acceptance：对原始 Goal 的成果做实际用户路径/运行检查；不能直接把 Task 全绿聚合为项目成功。

Gate 输入对 `goal_spec_version, commit_sha, environment_digest, test_run_id, reviewer_run_id` 锁定，任何代码变更导致相关旧证据失效（需重跑，不抹除历史）。

## 7. API / CLI 合同（提议，字段级 OPEN）

统一 `/api/v1` 的最小接口草案：

| 方法/路径 | 目的 | 最小约束 |
| --- | --- | --- |
| POST /projects | 注册允许的 Repo/Workspace | 身份认证、仓库许可范围 |
| POST /goals | 录入 rawInput / acceptance / budget | Idempotency-Key |
| GET /goals/:id | 状态/阻塞原因/工作包/ChangeSet | 只读 |
| POST /goals/:id/pause | 停止新工作、请求中断运行 | 需权限，保留现场 |
| POST /goals/:id/resume | 重新校验授权/预算再调度 | expectedVersion |
| GET /tasks/:id/runs | 运行、失败、模型、成本/证据 | 分页与脱敏 |
| GET /decisions?state=pending | 审批收件箱 | 过滤作用域 |
| POST /decisions/:id/resolve | accept/reject/override | 审核身份+deadline/version |
| GET /changesets/:id | diff 摘要、门禁、base/result SHA | 精确版本绑定 |
| POST /changesets/:id/deliver | 请求授权的安全集成 | D3/Policy、expected remote SHA |
| GET /events?after=cursor | 增量状态流（可长轮询/SSE） | 中断后可重读 DB |
| GET /health/live, /health/ready | 生命周期/依赖可用性 | 不暴露凭据 |

P0 CLI 可有 `relay project add`、`goal create/list/show`、`run show`、`decision list/resolve`、`pause/resume`、`evidence show`、`doctor`。API 错误使用稳定 `code, message, correlationId, retryable`。写接口必须有授权、幂等键或条件版本，防止双击/断线重复提交。OpenAPI/Zod Schema 在 P0-01 由真实消费者驱动冻结，当前路线并不强求先建立庞大 SDK。

## 8. 模块依赖方向与可替代性

`src/server`、`src/worker-entry.ts`、`web/`、`src/cli.ts` 依赖 `src/core`（lifecycle/policy/contracts）与 `src/runtime`、`src/server/views` 等适配层；`core` **不得直接依赖** Pi/GitHub/React/Playwright（实际布局=src/ 单体目录，非 apps/ 分包）。只有出现实际第二实现需求才抽象额外 Provider。迁移 Database Schema 和配额策略需要可回滚或故障安全停机路径。

## 9. Open/POC/避免伪承诺

- **已裁决/已实现（2026-11-14 收敛）**：DBOS=ADR-0007 REJECT（自研 PostgreSQL 事务+租约+fencing）；Pi SDK/RPC=ADR-0003（RPC 子进程+双层隔离）；沙箱=双层隔离+docker 检查沙箱已实现；精确 schema=migrations/0000..0009；认证=口令 0600+session 已实现；外部副作用 Reconcile=intents.ts 两阶段意图日志已实现。
- **OPEN（仍开放）**：分层质量阈值实测数值；性能基线；接管/多 Agent 会话控制实现。
- **RESEARCH/P1**：ACP v1 稳定互通（v2 草案另行验证）、MCP、Session-to-Session、Multi-Repo、Memory 与 Model Router。
- **不保证**：离线时模型仍生产、进程永不故障、跨 GitHub/DB 的分布式事务、自动发布生产环境、内核自升级无限可靠。

技术参考（须在 POC 再查版本）：https://github.com/badlogic/pi-mono ，https://agentclientprotocol.com/ ，https://docs.dbos.dev/typescript/tutorials/workflow-tutorial 。