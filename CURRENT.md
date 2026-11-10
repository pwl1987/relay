# Relay 当前执行契约

- 状态:**P0-02B 补验包 COMPLETE-WITH-PENDING / IDLE(下一包 P0-02C NOT_ACTIVE)**。补验完成:2026-11-10。最终 HEAD 以远端 `main` 为准(收尾提交后 fast-forward 推送)。
- 写者:**无 ACTIVE Writer**(P0-02B 写者已释放;补验由同一会话接管并释放)。
- 本包交付:**GitHub 安全交付集成**——交付链 `Candidate ChangeSet → Git Commit → Gate → Action Proposal → Policy → Action Intent → Scoped GitHub Executor → Observation/Reconcile → DELIVERED`:
  - **D-1 三 SHA 区分**(清单 sha ≠ git tree sha ≠ git commit sha);**D-2 候选 Commit**(隔离 stage 克隆 + 树==清单逐文件往返核验;失败即阻断并清理半成品);**D-3 绑定重核**(树 sha 即内容承诺,漂移 ⇒ 拒绝重验);
  - **D-4/D-5 Proposal+Policy**(授权基础=已消费绑定 PASS;默认拒绝:仓库白名单/**host 白名单(默认仅 github.com)**/端口维度/仅 main/capability/credential_missing);**userinfo URL 一律拒**(凭据不得入 URL/argv 面);
  - **D-6/D-7 Intent 两阶段+Scoped Executor**(非 force;凭据 0600 store 文件,argv/env/错误文本零令牌;HOME=/nonexistent 断 gitconfig 侧信道);**D-8 DELIVERED 硬判定**(远端 HEAD==payload **且** fetch-by-sha 逐文件==候选清单双核对;结果不明 ⇒ NEEDS_RECONCILE);**D-9/D-10 幂等+全链审计**(CONSUMED 不可翻转)。
- **补验包(第二轮授权)**:①测试夹具**零强推**(剥离注释后的可执行代码面自证)+ 目标**固定**沙箱仓库(env 不可改指)+ 每轮读真实远端 HEAD 建候选 + 外部写者**正常快进**;②历史未丢断言(祖先关系 + 提交数**恰好 +1** + 旧头对象仍在);③候选 base **恒等于 `runs.input_commit_sha`**(runner 取 Run 前记录 + stage 复位 + Proposal 一致性校验,失配 ⇒ `base_commit_mismatch`);④**relay_exec/relay_read 拒绝提示可行动化**(审计码不变,提示仅进模型可见文本;工具描述披露授权命令清单);⑤Reviewer 预算再平衡 4+4≤8 且提示明确可读范围(**断言未放宽、Gate 语义未降级**);⑥G-4 后 Reviewer 工具审计读回 `runs.detail`(恢复 Worker 侧可观测性)。
- 安全门禁:**G-3 代理持钥 0600 文件化**(env 注入面废除,inspect 零可见)、**G-4 Reviewer FS 级只读挂载**(OS 层 EROFS 实测)、G-1/G-2 机制全就绪(0600 凭据文件→store/仓库+host 双白名单)。
- 测试:**158 用例 = 156 passed + 2 skipped**(skip = 真实远端写入/漂移两例,凭据门诚实跳过);新增 `test/unit/delivery-policy.test.ts`(9 例);全新克隆复现 **144 passed + 11 skipped + tsc 0**(内嵌 SHA)。
- 独立复核:全新上下文 Reviewer 两轮——P0-02B 首轮 **PASS-WITH-FIXES** → 处置 → 复验 **PASS**;补验包首轮 **PASS-WITH-FIXES**(6 MINOR + 7 OBS,无 BLOCK)→ 全部处置 → 复验;见 `p0-02b/REVIEW.md` §一/§六/§七、`p0-02b/REPORT.md` §1/§8。
- CI:`.github/workflows/ci.yml`(typecheck + 全量 vitest:PG16 service + 模型/凭据门自动 skip + 容器确定性门真跑);补验后 CI 绿并快进推送。
- 模型预算:本包新增功能与补验用例 **0 模型调用**;全量回归触发既有测试固有消耗(gate-e2e 6 次经账本 6/8 + pi-e2e ~5 次 legacy 未走账本,如实披露)——全部 magpie 本地假密钥路由,零真实成本。

## 遗留检查单

1. **真实远端写入 + 漂移实验(P0-02B 唯一待办)**:宿主凭据文件 `~/.relay/credentials/github-sandbox-pat` 存在(0600)但**内容不是有效 GitHub 令牌**(11 字节、无 `github_pat_` 前缀);GitHub API 四端点 **401** ⇒ 两例诚实 skip。**已实测的真实远端安全失败**:鉴权被拒 ⇒ 交付 FAILED、changeset 非 DELIVERED、写入动作零调用(`perform_calls=0`)、远端零变化;API 核验留证 `p0-02b/github-api-verification.log`。有效细粒度 PAT(仅 `pwl1987/relay-delivery-sandbox` 的 Contents RW)就位后运行 `npx vitest run test/integration/github-real.test.ts` 即闭环并补录日志(**合同内既定实验,无需新授权**)。
2. **base 一致性纵深**(Reviewer F-12):`executeDelivery` 不复校 commit 绑定与 base 一致性(提案行自包含 commitSha/expectedRemoteSha,风险低)。
3. **候选 base 不可达边界**:若工作区 base 仅存于 reflog(不可达),stage 复位失败 ⇒ `git_failed` ⇒ 阻断(诚实失败;原可交付的边缘场景变为阻断)。
4. gh 经典令牌(`ghp_*`,scope 含 admin:*/repo/workflow)仍在本机 gh 配置——**仅限开发者一次性 infra**,严禁进入任何 Relay Operator 路径(补验源码自证:不读 hosts.yml、不调 gh CLI、不读 GH_TOKEN)。
5. 候选 stage 仓库(`refs/relay-candidates` + stageRepoDir)DELIVERED 后留存供审计,无自动回收(量级小,ops 清理)。

## 宿主改动残留

- 出口代理/规则/网络:测试后全量撤除(`relay-egress-fwd` 容器、`relay-egress-net`、RELAY-EGRESS 链、DOCKER-USER/INPUT 规则零残留,已核验);重建入口 `ensureEgress()`(持钥需宿主 0600 文件)。

## 下一唯一建议:P0-02C(Web 控制台,NOT_ACTIVE)

按 `docs/CONSTRUCTION_PLAN.md` P0-02C 行起草激活合同(需新的明确授权)。入口 `docs/CONTINUATION.md`。
- 边界:不生产部署、不 RSI、不做真实 GitHub 写路径之外的权限扩大(真实写入实验随 PAT 补录,不需要新授权)。
- 模型预算按阶段分段计数经 budget_ledger 预留;独立复核、快进 push、核验 origin/main==HEAD 且 worktree clean、更新 CURRENT.md 与 docs/CONTINUATION.md。
