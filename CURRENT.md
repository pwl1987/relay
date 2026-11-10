# Relay 当前执行契约

- 状态:**P0-02B ACTIVE**。写者:VM80 唯一 Writer 会话(2026-11-10 授权激活)。base SHA:`22e93ba`(origin/main == HEAD,worktree clean,冷启动核对完成)。
- 授权范围:GitHub 安全交付集成。**合同先于实现独立提交**(P0-02A F-4 流程改进延续)。main-only;不创建功能分支;不引入 PR 作为必需流程;禁止强推。

## 一、安全前置门禁(G-1..G-5,真实远端写的硬前提)

- **G-1 凭据面**:建立仅限测试仓库 Contents 读写的**细粒度 PAT**(不授 PR/Administration/Workflows);宿主侧只存 0600 文件(经路径注入执行器);**令牌不得进入 Pi/Reviewer/候选工作区/测试日志**,不出现在 argv/env 可见面。Token 缺失或权限不足 ⇒ 安全失败(credential_missing/auth_failed),无部分状态。经典 `ghp_*` 超范围令牌**禁止供 Relay Operator 使用**(仅限开发者一次性 infra:建沙箱仓库)。
- **G-2 仓库白名单**:真实远端写只允许专用非生产沙箱仓库(`pwl1987/relay-delivery-sandbox`,私有);`pwl1987/relay` 及其它一切仓库默认拒绝。
- **G-3 代理持钥 0600 化**:出口代理的真实模型 key 从 docker 环境变量改为宿主 0600 文件只读挂载;`docker inspect` 可见面零 key;改写 Authorization 机制经容器实测不变。
- **G-4 Reviewer FS 级只读挂载**:docker 模式 Reviewer 对候选工作区使用 `:ro` 挂载;实测证明可读候选文件、写/删/替换在 OS 层被拒绝。host-fallback(测试路径)保持 prompt 级隔离并如实标注。
- **G-5 推送安全语义**:仅 fast-forward;禁 `--force`/`--force-with-lease`/远端 reset;`expected_remote_sha` 漂移 ⇒ CONFLICT,绝不覆盖。
- 门禁不通过 ⇒ 只允许本地 Mock Git(bare 仓库)测试,**不得实际写 GitHub**。

## 二、交付链建设任务(D-1..D-10)

链路:Candidate ChangeSet → Git Commit → Gate → Action Proposal → Policy → Action Intent → Scoped GitHub Executor → Observation/Reconcile → DELIVERED。

- **D-1 三 SHA 区分**:workspace manifest SHA(既有 base_sha/candidate_sha)、Git Tree SHA、Git Commit SHA 三者独立建模(变更集新增 git_* 列),不得混用;测试断言三者两两不等且各有语义。
- **D-2 候选 Git Commit**:使用隔离 detached worktree(临时目录,用后即删)基于 git_base_commit_sha 应用变更集生成 commit;不创建长期分支;commit 后做**树==清单往返核验**(逐文件内容 sha256 对比候选清单),不一致 ⇒ 阻断(commit_tampered/content_mismatch),不得进入 Proposal。
- **D-3 Gate 证据绑定 Git 内容**:Gate 证据/裁决既绑定 candidate_sha/requirement(继承 P0-02A 绑定层),Proposal 前重核 commit 绑定(树 SHA 与清单均未漂移);commit 后内容变化 ⇒ 旧绑定失效,必须重新验证。
- **D-4 Action Proposal**:新表 `action_proposals`(task/attempt/changeset/**gate_verdict_id(授权基础=已消费 PASS)**/capability/target/branch/expected_remote_sha/commit_sha/state);无已消费 PASS 授权基础 ⇒ 拒绝(未过 Gate 的候选不得推送)。
- **D-5 Policy(确定性,默认拒绝)**:capability 必须 == `github.push`;repo 必须命中显式白名单(默认空=全拒);branch 必须 == `main`;不授任何 PR/Administration/Workflows/删除能力;凭据缺失 ⇒ credential_missing,不产生 intent、不触发任何 git 命令。
- **D-6 Action Intent 两阶段**:复用 `intents.ts`(RESERVED→EXECUTING→COMPLETED/CONFLICT/FAILED + Reconcile 三决策);意图六要素齐备:目标仓库/分支/期望 SHA/提交 SHA(payload_sha)/授权(proposal 关联)/幂等标识(idempotency_key = sha256(task+changeset+commit+expected))。
- **D-7 Scoped GitHub Executor**:check = `ls-remote` 读目标分支真实头;perform = 非 force push `git_commit_sha:refs/heads/main`(GIT_TERMINAL_PROMPT=0;凭据经 0600 credential 文件由执行器进程读取,**不进 argv/env/日志**);执行面仅白名单仓库的 refs/heads/main。
- **D-8 Observation/DELIVERED**:COMPLETED 后必须核对远端:HEAD == payload_sha **且** 远端 commit 树内容逐文件 == 候选清单 ⇒ 才标 `delivery_state=DELIVERED`;任何失败/异常 ⇒ 不得标 DELIVERED;goal 聚合语义不变,**DELIVERED ≠ 用户 ACCEPTED**。
- **D-9 幂等**:重复交付请求 ⇒ 同一 intent 单行、单次推送;已完成 ⇒ no-op;远端不产生重复提交。任务 Gate 已过(ACCEPTED 为终态)——交付层失败/漂移不回滚质量结论,仅落 CONFLICT + D3 决策行(人工恢复)。
- **D-10 可观测/审计**:每阶段审计(PROPOSAL_CREATED/POLICY_DENIED/INTENT_*/DELIVERY_*/RECONCILE);漂移 ⇒ intent CONFLICT + changeset CONFLICT + D3 决策行。

## 三、验收反例(9 条,逐条专属测试,断言具体拒绝/恢复原因)

1. 未授权仓库写入必须拒绝(POLICY_DENIED,0 intent,0 git 调用)。
2. Token 缺失或权限不足必须安全失败(credential_missing 拒绝;401 ⇒ intent FAILED,changeset 非 DELIVERED)。
3. 未经 Gate PASS 的候选不得推送(无已消费 PASS ⇒ proposal 拒绝)。
4. 远端 HEAD 漂移必须拒绝(bare 仓库外部推进后 expected 失配 ⇒ CONFLICT,无覆盖)。
5. push 成功但回执丢失(崩溃窗口)⇒ Reconcile 先查真实状态,SIDE_EFFECT_CONFIRMED ⇒ COMPLETED,不重复推送(远端提交数不变)。
6. 候选内容与实际 Git Commit 不一致 ⇒ 阻断(树往返核验失败/绑定后篡改 ⇒ commit_tampered)。
7. Reviewer 尝试修改候选文件 ⇒ OS 层被拒绝(:ro 挂载实测 EROFS;写失败 ⇒ 无裁决)。
8. 重复触发交付请求 ⇒ 单提交单 intent,幂等 no-op。
9. 远端提交失败 ⇒ ChangeSet 不得被误标 DELIVERED(pre-receive 拒绝 ⇒ FAILED)。

## 四、测试与交付

- 先本地 bare Git 仓库验证全部失败窗口(确定性),再门禁通过后用专用沙箱仓库完成**一次真实 main 写入 + 远端漂移实验**(漂移实验:外部推进 main 后验证拒绝,不污染交付状态)。
- Vitest + 真实 PostgreSQL(独立 schema)+ 真实 Git + 故障注入;独立 Reviewer 复核(REPORT/REVIEW 落盘)。
- 建立最小 GitHub Actions CI:类型检查 + 非模型测试 + PostgreSQL service 集成(模型/容器测试按既有门显式 skip);CI 配置随本包提交。
- 模型预算:**阶段 A=0 模型调用**(全链确定性/stub 可证;如需真实模型 E2E 另行申请并经 budget_ledger 预留)。
- 验收达标后快进推送 Relay main,报告最终 SHA/CI/独立复核/真实远端写入证据;更新 CURRENT.md 与 docs/CONTINUATION.md。
- 边界:不做 Web(P0-02C)、不生产部署、不启动 RSI;Relay Operator 代码面禁止触碰 pwl1987/relay 及其它业务仓库(写者对 relay main 的快进推送是开发者动作,非被测系统行为)。
