# Relay 当前执行契约

- 状态:**P0-02B COMPLETE-WITH-PENDING / IDLE(下一包 P0-02C NOT_ACTIVE)**。完成:2026-11-10。最终 HEAD 以远端 `main` 为准(收尾提交后 fast-forward 推送)。
- 写者:**无 ACTIVE Writer**(P0-02B 写者已释放)。
- 本包交付:**GitHub 安全交付集成**——交付链 `Candidate ChangeSet → Git Commit → Gate → Action Proposal → Policy → Action Intent → Scoped GitHub Executor → Observation/Reconcile → DELIVERED`:
  - **D-1 三 SHA 区分**(清单 sha ≠ git tree sha ≠ git commit sha,列分离+断言);
  - **D-2 候选 Commit**(隔离 stage 克隆仓库构建——合同 detached worktree 的机制偏差,Reviewer 裁决可接受:run 目录证据采集后即删,链接 worktree 会消亡;树==清单逐文件往返核验,失败即阻断+清理半成品;refs/relay-candidates 非 分支防 gc);
  - **D-3 绑定重核**(Proposal 前核 commit 对象/树 sha/父 base;树 sha 即内容承诺,漂移 ⇒ 拒绝重验);
  - **D-4/D-5 Proposal+Policy**(授权基础=已消费绑定 PASS;默认拒绝:仓库白名单/仅 main/capability==github.push/credential_missing 安全失败);
  - **D-6/D-7 Intent 两阶段+Scoped Executor**(复用 intents;六要素幂等键;执行器非 force、GIT_TERMINAL_PROMPT=0、凭据 0600 store 文件——argv/env/错误文本零令牌,HOME=/nonexistent 断 gitconfig 侧信道);
  - **D-8 DELIVERED 硬判定**(远端 HEAD==payload **且** fetch-by-sha 逐文件==候选清单双核对;结果不明 ⇒ NEEDS_RECONCILE 先查真实状态;CONFLICT/FAILED 不回滚 ACCEPTED,落 D3 行永不自动批准);
  - **D-9/D-10 幂等+全链审计**(UNIQUE(changeset_id)+xmax 判 INSERT;CONSUMED 不可翻转;写后核验抛错 ⇒ NEEDS_RECONCILE)。
- 安全门禁:**G-3 代理持钥 0600 文件化**(FWD_REAL_KEY env 注入面废除,inspect 零可见,容器实测 6/6)、**G-4 Reviewer FS 级只读挂载**(docker `:ro`+审计移出候选面;OS 层 EROFS 实测+宿主零写入+rw 对照组)、G-1/G-2 机制全就绪(0600 凭据文件→store/仓库白名单默认全拒)。
- 测试:**144 用例 = 142 passed + 2 skipped**(github-real 凭据门诚实 skip);新增 5 文件 21 用例(delivery 11 含 goal-loop 全链 DELIVERED / git-candidate 6 / reviewer-readonly 2 / github-real 2 / egress-proxy 增 G-3 断言);9 条合同反例逐条专属断言。全新克隆复现:**133 passed + 11 skipped + tsc 0**(模型/凭据门 skip,内嵌 SHA)。
- 独立复核:全新上下文 Reviewer 两轮——首轮 **PASS-WITH-FIXES**(G-1..G-5/D-1..D-10 全 VERIFIED+亲测 tsc0/16/16/2/6;F-1 MINOR/F-2 MINOR/F-3..F-7 OBS)→ 处置 `28c1b8a` → 复验 **PASS**;见 `p0-02b/REVIEW.md`、`p0-02b/REPORT.md`。
- CI:`.github/workflows/ci.yml`(typecheck + 全量 vitest:PG16 service + 模型/凭据门自动 skip + 容器确定性门真跑),随本包落盘。
- 实施期修复留痕(11 条,含两件前包遗留):① TS 参数属性崩裸 node strip-types 子进程 helper(GitCandidateError 改显式字段);② **pi-e2e 前包遗留破损自愈**(自 P0-02A 起未在带 provider 全量真跑过:不自备 egress + executeRun 未传 allowedCommands;修复后真模型 2/2,期间模型行为完全正确——诚实 handoff"relay_exec 全部被拒");③ egress-proxy 改写测试重试;④ journal 缺 0004;⑤ xmax 判 INSERT;⑥ executor.check 抛错穿透;⑦ 往返核验未转阻断;⑧ blob utf8 散列破坏二进制;⑨-⑪ 见 REPORT §3。
- 模型预算:本包新增功能 **0 模型调用**(全链 stub/确定性可证);全量回归触发既有测试固有消耗(gate-e2e 6 次经账本 + pi-e2e ~5 次 legacy 未走账本,如实披露)——全部 magpie 本地假密钥路由,零真实成本。

## 遗留检查单(接真实密钥/后续包前)

1. **真实远端写入实验(P0-02B 唯一待办)**:细粒度 PAT 就位后运行 `npx vitest run test/integration/github-real.test.ts`(一次真实 main 写入 + 远端漂移实验,含 GitHub REST API 独立核对),日志补录 `p0-02b/`。PAT 创建:仅 `pwl1987/relay-delivery-sandbox` 的 Contents: Read and write,不授 PR/Administration/Workflows;放 `~/.relay/credentials/github-sandbox-pat`(0600)。沙箱仓库已建(私有)。
2. **交付 Policy 加固(F-3/F-4,Reviewer 排后续)**:normalizeRepoSlug 钉 host(github.com);执行器 target 入参拒绝含 userinfo(`://...@`)形态。当前纵深:store 按 host 键(非 github.com 无凭据必败)、target 仅来自受信编排面。
3. **候选 base 语义加固(F-5)**:runner 候选 commit 的 base 应与 `runs.input_commit_sha` 比对(当前事后重探测;内容面已被树往返核验兜死,仅祖先语义弱化)。
4. gh 经典令牌(`ghp_*`,超范围)仍在本机 gh 配置——仅限开发者一次性 infra 用,**严禁**进入任何 Relay Operator 面;后续包若需 GitHub API,一律走细粒度 PAT 文件注入。
5. 候选 stage 仓库(`refs/relay-candidates` + stageRepoDir)DELIVERED 后留存供审计,无自动回收(量级小,ops 清理)。

## 宿主改动残留

- 出口代理/规则/网络:测试后全量撤除(`relay-egress-fwd` 容器、`relay-egress-net`、RELAY-EGRESS 链、DOCKER-USER/INPUT 规则均零残留,已核验);重建入口 `ensureEgress()`(src/runtime/egress.ts,持钥需宿主 0600 文件)。

## 下一唯一建议:P0-02C(Web 控制台,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-02C 行起草激活合同(需新的明确授权)。启动沿用冷启动纪律 + 合同先于实现提交落盘;入口 `docs/CONTINUATION.md`。
- 边界:不生产部署、不 RSI、不做真实 GitHub 写路径之外的权限扩大(真实写入实验随 PAT 补录,不需要新授权)。
- 模型预算按阶段分段计数经 budget_ledger 预留;独立复核、快进 push、核验 origin/main==HEAD 且 worktree clean、更新 CURRENT.md 与 docs/CONTINUATION.md。
