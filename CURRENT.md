# Relay 当前执行契约

- 状态:**P0-01B ACTIVE**。激活:2026-11-10。起点 `origin/main == HEAD == 66a2c5c`(已核对一致,worktree clean)。
- 写者:**本会话(VM80,P0-01B 唯一 Writer)**。旧 P0-01A 写者已释放;如远端 HEAD 前移或出现非本人提交 → 立即停止写入并只读上报。
- 目标(唯一定义见 `docs/CONSTRUCTION_PLAN.md` P0-01B 行 + `ADR/0003`):将 P0-01A 持久内核与 Pi RPC 子进程连接,形成**可运行、受限、可中断、可恢复**的单任务执行闭环。

## 可写范围(白名单,超界即停)

- `src/core/lease.ts`(仅限 F-3 残余窗口修复:heartbeat leased-chain 校验)及其测试文件;
- `src/core/schema.ts` + `migrations/0001_*.sql`(新增 runs/sessions 两表,按架构 §2 裁剪);
- `src/runtime/**`(新增:pi-version / pi-rpc / sandbox / runner / context / relay-tools.extension);
- `test/**`(新增集成测试与 helper)、`vitest.config.ts`(如需超时调整);
- `package.json` + `package-lock.json`(唯一依赖变更:vendored `@earendil-works/pi-coding-agent@1.5.0` 精确版本 devDep);
- `scripts/**`(provider 探测/verify 脚本);
- `p0-01b/REPORT.md`、`p0-01b/evidence/**`;
- `CURRENT.md`、`docs/CONTINUATION.md`。

**禁止**:触碰 `p0-00/**`、`p0-01a/**`(只读引用);构建产物/依赖目录入 git;全局 `pi` 依赖(必须用 vendored 路径);暴露 docker.sock/SSH agent/宿主 GitHub 凭据给 Run;真实 GitHub 写路径;Goal Loop(P0-01C);Web(P1);RSI;长期分支/强推。

## 本包承诺 Outcome(验收标准,全部可机器核验)

1. **F-3 残余窗口修复**:heartbeat 增加"任务须处 leased-chain"校验;真实 PG 回归测试覆盖两条路径(worker 合法 advance→NEEDS_RECONCILE 后活租约心跳、reclaim 后旧 token 心跳),均必须拒绝并留审计。
2. **Pi 版本锁定**:`@earendil-works/pi-coding-agent@1.5.0` 以精确版本入 package-lock(vendored),启动时校验 vendored 包版本(不符即拒启);运行路径永不解析到全局 `pi`。
3. **双层隔离缺一不可(ADR-0003)**:
   - 工具层:Run 一律 `--no-builtin-tools` 启动;经扩展仅注入 Relay Policy 授权的工具(作用域文件读 + 受限命令执行,语义对齐 V02);越权调用必须 DENIED 且留机器可读痕迹(`.relay/tool-audit.jsonl`);
   - OS 层:正式路径 Run 在 Docker 容器内(`--cap-drop ALL`、非 root UID、仅挂载 run 工作区 + 一次性 HOME + 只读 vendored node_modules、无 docker.sock/SSH_AUTH_SOCK/GH 凭据/sentinel);宿主直启仅允许作为测试显式 fallback 并在 run 记录中如实标注 `sandbox=host-fallback`。
4. **Run 生命周期**:runs/sessions 落库(runtime/model_ref/budget/outcome/sandbox/resume_mode);wall-clock 超时(SIGKILL→TIMEOUT)、取消(CANCELLED)、心跳循环(续租被拒 ⇒ 立即终止 Pi 子进程,失效 Run 不再产生副作用——有测试证明);Session Context + 结构化 Handoff(解析 relay-handoff 块;**恢复=从 DB 重建上下文,resume_mode=context_rebuild,不假装恢复模型内部状态**)。
5. **真实故障注入(真实信号+真实进程)**:Pi RPC 断连、Worker SIGKILL、超时、重启恢复(supervisor tick 回收 → fencing+1 重领 → context_rebuild 再跑);旧 token 非法推进被拒在恢复链中断言。
6. **真实 Pi RPC 端到端 Run ≥1 个**:Provider 按当前实际可用性探测+环境变量驱动(不硬编码历史 Magpie 假设;当前探测:127.0.0.1:3425 magpie group/gm 可用);E2E 证明:允许操作成功、越权操作被拒、handoff 落库、任务推进至 VERIFYING、Gate PASS 后 ACCEPTED。
7. **测试基建延续**:Vitest + 每测试文件独立 PG schema;全新克隆 `npm ci && npm run db:up && npm test` 非模型测试全绿;E2E/沙箱测试在缺 provider/docker 的环境**显式 skip(不假装)**,本机证据落盘。
8. **收尾**:独立 Reviewer(全新上下文)复核;证据绑定最终 SHA;快进 push 唯一 main(核验 `origin/main==HEAD` + worktree clean);更新 `CURRENT.md`、`docs/CONTINUATION.md`、`p0-01b/REPORT.md`。

## 成本预算与模型调用

- 代码/测试 0 付费 API 调用;E2E 走 magpie 本地路由(假密钥 `magpie`,上游经本地路由,非 Relay 直连付费端点)。
- 本包真实模型请求**总上限 ≤ 12 次**(E2E 主链路 + 恢复重跑);超限即停止模型相关路径并报告。

## 停止条件(任一触发即停受影响路径,不放宽门禁)

- 沙箱越权证据(容器内读到 sentinel/写 /etc/见宿主凭据)→ 停 Run 路径,如实报告;
- 写者冲突 / 远端 HEAD 前移 / 工作区脏分叉 → 停写入;
- 外部副作用不可确认 → 停执行路径(本包无真实外部写,若出现即停);
- 需要扩大权限(生产凭据、新容器权限、宿主服务改动)→ 停止并请示;
- 工具层 DENIED 失效(越权调用未被阻断)→ BLOCK,不得以"模型没试"掩盖。

## 红线重申

Pi Runtime 仅为 RPC 子进程,**不拥有工作流状态**;任何 Run 的成功不等于任务 ACCEPTED(VERIFYING→ACCEPTED 必须过 Gate,V08 延续);Agent 文本 DONE 不作为验收。
