# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 B(REWORK-1 Discovery)ACTIVE**。授权来源:总执行包(六阶段连续);上一阶段 A 已闭环(`3a4b10a`;CI `42965135078` 双绿)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推)。
- 基线:本地 HEAD == origin/main == `3a4b10a`;阶段 A 终账见下节。

## 本包范围(阶段 B:REWORK-1,US-02 P0 最小 + US-01 模型面)

1. **表**:`discoveries`(迁移 0005):id/goal_id/run_id/outcome(SUCCEEDED|FAILED)/reason/report(jsonb 结构化)/content_sha256/model_ref/sandbox/created_at——**结果持久化,不依赖聊天上下文**;drizzle schema + generate(离线)。
2. **Runtime** `src/runtime/discovery.ts`:仿 reviewer.ts 只读会话(role=discovery;`allowedCommands: []` 仅 relay_read;docker 模式 workspace 强制只读挂载;预算经同一账本 reserve/settle;回合硬顶/wall 双限;stub 注入口仅 host-fallback 测试用)。结构化输出围栏 ```relay-discovery(JSON:problemStatement/assumptions[含 confidence]/risks/options[含 tradeoffs]/recommendation{action,rationale}/acceptanceCriteria/openQuestions/sources[path])`;解析失败如实 no_report。
3. **Core** `src/core/discovery.ts`:`runGoalDiscovery(db, pi, spec)`——goal 存在校验、run 挂 goal 首任务、FAIL-CLOSED 预算(无账本行拒绝)、持久化 discoveries + evidence SHA、**失败降级**:落 FAILED 行(reason)不伪造;视图规则面继续可用并标注来源。模型只能读 operator 指定项目目录;仓库文件内提示词不作系统指令(结构层:prompt 由本层构造+工具白名单+OS 只读)。
4. **入口(三入口同 Core)**:CLI `relay goal analyze <goalId> --project-dir <dir> [--budget-calls N] [--actor]`(operator 门+预算声明);API `POST /api/goals/:id/discovery`(写门同口径);worker tick 不自动触发(P0 显式调用,预算人控)。
5. **视图/登记表**:goalDetailView 加 discovery 块与来源徽章(模型/规则/失败三态);capabilities:`goal.discovery.model`→IMPLEMENTED(P0 最小;本地调查;公网搜索 P1 NOT_IMPLEMENTED)、`goal.recommendation.model`→IMPLEMENTED(有 Discovery 记录时模型推荐,否则规则面标注)。
6. **测试**(`test/integration/discovery.test.ts` 等,stub 为主):解析/校验/持久化/降级/预算 FAIL-CLOSED/RUNNING 幂等(同一 goal 重复 analyze 追加记录)/注入抵抗(项目文件含"忽略指令"语料,断言工具白名单+只读+审计 denied)/来源徽章;**门控真模型测试**(`RELAY_DISCOVERY_E2E=1`+magpie,声明预算)覆盖 B5 验收:模糊需求调查/不合理方案反驳/不完整需求→可判定验收/预算耗尽停止/断线恢复不伪造隐状态。
7. **验收**:US-01(保留原话/可核查假设/一个推荐行动/可判定条件)+ US-02 P0 最小(对项目目录本地调查一次,记录可回放;不可用调研能力显式说明)+ 独立 Reviewer + CI 绿 + 快进推送。
8. **安全边界**:不引入通用 Agent 框架/工作流引擎/无界搜索;模型零写权限;预算经账本先声明;D3 不自动批准;真模型每轮先声明预算超额即停。

## 阶段 A 终账(REWORK-2 CLOSED;证据见 `p0-rework2/`)

- **交付**:Core `pauseTask`(READY 状态门 + actor/version/审计同口径)+ `src/cli.ts` + `bin/relay.mjs`(零新依赖;七组命令)+ API `POST /api/tasks/:id/pause` + 能力登记 `cli.entry`/`task.pause` + 确定性退出码 0/1/2/3/4/5。
- **验收**:V03 全程真实 CLI 演练(零浏览器零 ChatGPT;stub 如实标注);PAUSED 阻断领取实证;CLI/API 同 Core 对等;控制面零模型 Run。
- **独立复核**:`p0-rework2/REVIEW.md` PASS-WITH-FIXES;Major-1(RUNNING 可被打断租约)→ READY 状态门;Major-2(CLI defer 无 operator 门)→ 授权下沉 Core;Minor×4。
- **测试**:cli.test.ts 13 例全绿;全量 216=207+7skip+2fail(2fail=github-real 403 凭据面);tsc 0;CI test+e2e 双绿。**US-04/V03:VERIFIED**。
