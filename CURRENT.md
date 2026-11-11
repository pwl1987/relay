# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 A(REWORK-2 最小 CLI)ACTIVE**。授权来源:用户 2026-11-11"MVP 收敛与最终验收总执行包"(六阶段 A~F 连续执行授权;每子包仍须独立合同/实现/复核/CI/推送)。上一包 P0-ACCEPT 已闭环(`3069aa1`,CI success)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推/禁其他分支)。
- 冷启动基线(2026-11-11 复核):本地 HEAD == origin/main == `3069aa101df8b1ecbe505fa846a761870acbaa5e`;工作区 clean;CI run `42952099140` success;PG 容器健康;Node v24.21.0。

## 本包范围(阶段 A:REWORK-2,US-04/V03 闭合)

1. **Core 最小增量**:`src/core/ops.ts` 新增 `pauseTask`(任务级暂停置入入口;lifecycle 转移表已支持 READY→PAUSED):actor 授权 + expectedStateVersion + 合法转移 + 审计,与 `resumeTask` 同口径。**Pause 语义**:PAUSED 任务不被 `claimNextReady` 领取(阻断领取);执行中外部副作用由既有租约/Intent/Reconcile 管理(不新增打断机制);D3 不因 Pause/Resume 被绕过。
2. **CLI**:`src/cli.ts`(裸 node strip-types 直跑;零新依赖、零 CLI 框架)+ package.json `"bin": {"relay": "./bin/relay.mjs"}` 薄壳。命令集:`goal create/list/show`、`decision list/resolve/defer`、`task resume`、`pause`、`worker tick`、`status`、`doctor`。三入口同调 Core:goal create=planGoal(同 API deriveDefaultPlan 口径)、读=model views 同源、写=operatorAllowed+expectedStateVersion 同 API、tick=复用 `createLiveWorkerDriver`(FAIL-CLOSED 同 server live;外部 relay-worker 编排属阶段 E)。**禁止直接 SQL 改状态**。
3. **API 对等**:POST `/api/tasks/:id/pause`(同一 Core `pauseTask`;同 CSRF/operator/409 口径)+ 能力登记表加 CLI 行。
4. **doctor(只读)**:DB 连接+迁移版本、provider 配置可见性、Pi 版本、docker、egress、GitHub 凭据存在性(仅存在性/权限位,不打印内容)、当前阻断原因;不探测模型路由(0 模型调用)。
5. **退出码(确定性)**:0 成功;1 内部错误;2 用法错误;3 业务拒绝(actor/version/transition);4 未找到;5 环境不可用(DB/docker 等)。
6. **测试 ≥8 例**(`test/integration/cli.test.ts` 等):goal create→list→show 一致性;decision resolve 批准/拒绝;defer 只改截止;resume+version 失配拒绝;pause 置入 + **PAUSED 不被 claimNextReady 领取(实证)** + resume 恢复;未授权 actor 拒绝;doctor 输出(凭据零明文);退出码映射;控制面命令零模型请求断言。
7. **V03 演练**:`p0-rework2/` 落盘——无浏览器/无 ChatGPT 环境 CLI 全程(goal create→tick→decision→pause→resume→show);worker tick 用 stub 注入**如实标注 stub**(机制演示;真实模型面已由缺口 A 联验 live-worker-e2e 覆盖,本包不重复烧模型预算);CLI/API 对相同实体一致性抽查。
8. **收尾**:`p0-rework2/REPORT.md` + 独立 Reviewer 复核(`REVIEW.md`)→ CI 绿 → 快进推送 main → CURRENT.md/CONTINUATION.md 更新 → 释放写者,进入阶段 B。

## 验收标准(不可降低)

- V03:不连 ChatGPT、不开浏览器,控制操作全部经 CLI 独立完成且状态与 API/DB 一致。
- 未授权 actor、旧 state_version、非法转移、重复操作正确拒绝且有审计行。
- 全部命令确定性退出码;控制面命令不触发任何模型请求。
- PAUSED 实证阻断领取;SIGKILL 后状态不丢(既有 V04 语义不被 CLI 破坏)。

## 安全边界(总包继承)

不生产部署;不 RSI;不扩大 Token/模型预算/文件权限/仓库写入范围;D3 永不自动批准;不触碰其他业务仓库;禁宽权限 gh token;遇到 D3/生产风险/权限扩大/预算扩大/数据破坏风险即阻断并说明。
