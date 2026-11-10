# P0-02B 交付报告:GitHub 安全交付集成

状态:**COMPLETE-WITH-PENDING**(真实远端写入实验待细粒度 PAT;其余合同项全部交付,全量回归绿)。执行:VM80 唯一 Writer 会话,2026-11-10,起点 `origin/main == 22e93ba`。合同 `79187dd`(**先于实现独立落盘**)→ 实现 `61139d5`。最终 HEAD 以远端 main 为准。

## 0. 交付标识

| 项 | 值 |
| --- | --- |
| 新增 core | `delivery.ts`(Proposal/执行/Reconcile 映射/DELIVERED 判定/D3 行)/ `delivery-policy.ts`(确定性默认拒绝+仓库规范化)/ `executors/github-push.ts`(Scoped Executor:非 force/凭据 0600 store/argv-env 零令牌) |
| 新增 runtime | `git-candidate.ts`(候选 Commit:stage 克隆→覆写候选→树==清单往返核验;绑定重核;远端内容核验)/ `github-credentials.ts`(原始 PAT 0600 文件→会话级 credential-store) |
| 变更 | `changesets.ts`(git_* 三列 + bindCandidateCommit + ChangesetRow 交付字段)/ `goal-loop.ts`(gate ACCEPTED → propose/execute 注入式交付)/ `runner.ts`(deliveryStaging 接线)/ `sandbox.ts`(workspaceReadOnly :ro + buildDockerRunArgs 抽出)/ `reviewer.ts`(共享候选面强制 ro)/ `workspace-manifest.ts`(MANIFEST_EXCLUDE 增 .git)/ `egress.ts`(G-3:持钥 0600 文件只读挂载,env 注入面废除) |
| 迁移 | `0004_delivery.sql`(手写)+ meta/_journal.json 条目:candidate_changesets 七交付列 + action_proposals 表 |
| CI | `.github/workflows/ci.yml`:typecheck + 全量 vitest(真 PG16 service + RELAY_PI_BASE_URL 不可达门;模型/egress 门自动 skip,容器确定性门真跑) |
| 测试 | 全量 **143 用例 = 141 passed + 2 skipped**(skip = github-real 凭据门,诚实跳过);新增 4 文件 20 用例:delivery 10(反例 1/2a/2b/3/4/5/6/8/9 + 正链 + goal-loop 全链 DELIVERED)/ git-candidate 6 / reviewer-readonly 2(容器 OS 实测)/ github-real 2(凭据门控) |
| 模型调用 | 新增交付链测试 **零模型**(stub/确定性);全量回归时**既有**测试固有消耗:gate-e2e 6 次(经 budget_ledger 6/12)+ pi-e2e ~5 次(legacy 未走账本,如实披露)——全部 magpie 本地假密钥路由,**零真实成本** |

## 1. 合同对照(G-1..G-5 / D-1..D-10)

### 安全门禁
- **G-1 凭据面** ✅(机制):`github-credentials.ts` 强制原始 PAT 文件 0600/常规/非空(FAIL-CLOSED);会话级 store 文件 0600;执行器经 `credential.helper=store --file=` 注入——**令牌本体不出现在 argv/env/错误文本**(错误文本另有 `redactCredentials` 纵深脱敏);子进程 env 最小化(`GIT_TERMINAL_PROMPT=0`、`HOME=/nonexistent`、`GIT_CONFIG_NOSYSTEM=1` 阻断宿主 gitconfig 侧信道)。经典 `ghp_*` 超范围令牌未进入任何 Relay Operator 面(仅开发者一次性 infra:建沙箱仓库)。**待办**:细粒度 PAT 本体尚未就位 ⇒ github-real 诚实 skip(见 §5)。
- **G-2 仓库白名单** ✅:`DEFAULT_DELIVERY_POLICY.allowedRepos=[]`(默认全拒);normalizeRepoSlug 仅接受 owner/repo 或 GitHub URL;本地路径目标仅在白名单**显式**含该路径时放行(测试/演练用;生产配置不会含)。测试:反例 1(白名单外 ⇒ repo_not_allowed,0 intent)+ Policy 拒绝行留痕。
- **G-3 代理持钥 0600 化** ✅(容器实测):`FWD_REAL_KEY` 环境变量注入面**废除**;宿主 0600 文件只读挂载 `/run/relay-fwd/real-key`;ensureEgress 对 0600 不满足 FAIL-CLOSED(`real_key_file_invalid`)。egress-proxy 全套 6/6 容器实测含新断言:`docker inspect` 零 `FWD_REAL_KEY`、全文零 key、挂载源路径正确;改写/计数/白名单语义不变。
- **G-4 Reviewer FS 只读挂载** ✅(容器实测):docker 模式共享候选面 `:ro` 挂载(接线断言)+ 工具审计移出候选面(/pihome);OS 层实测:同款约束(--user 10001 --cap-drop ALL)下读候选成功、写/删 EROFS 拒绝、宿主侧确认零写入、**rw 对照组写成功**(证明拒绝来自 ro 本身)。
- **G-5 推送安全语义** ✅:执行器无 force 面(argv 仅 `push <target> <sha>:refs/heads/main`);前置核对漂移 ⇒ CONFLICT(反例 4 实测:外来提交不被覆盖);git 自身非 fast-forward 拒绝双保险。

### 交付链
- **D-1 三 SHA 区分** ✅:candidate_sha(清单)/git_tree_sha/git_commit_sha 三列独立;正链测试断言三者两两不等。
- **D-2 候选 Commit** ✅(机制偏差如实声明):合同原文"隔离 detached worktree";实现为**隔离 stage 克隆仓库**(clone --no-local --no-hardlinks → 覆写候选内容 → commit → 树==清单逐文件往返核验 → refs/relay-candidates/<changesetId> 防 gc 引用,非分支、不推送)。偏差原因:沙箱 run 目录在证据采集后删除,链接 worktree 会随宿主目录消亡,候选 commit 必须存活于调用方持有的独立对象库。隔离语义达成(无长期分支、无 base 污染、用后可删),机制差异留 REVIEW 裁决。阻断路径:content_mismatch(清单失配)/base_parent_mismatch(父基线漂移)/not_a_git_workspace,半成品自动清理(实测)。
- **D-3 证据绑定 Git 内容** ✅:Proposal 前强制绑定重核(commit 对象在、树 sha==记录、父==base;树 sha 即内容承诺)——记录值漂移 ⇒ `commit_binding_tree_sha_drift` 拒绝(反例 6 实测);runner 在 recordChangeset 后即建 commit 并绑定(git 列 null ⇒ Proposal 拒 `no_commit_binding`)。
- **D-4 Action Proposal** ✅:`action_proposals` 行含授权基础(gate_verdict_id=**已消费**绑定 PASS)/task/attempt/changeset(UNIQUE 幂等)/capability/target/branch/expected_remote_sha/commit_sha/policy_detail;无授权 ⇒ 拒(反例 3);任务非 ACCEPTED ⇒ 拒(状态机门)。
- **D-5 Policy** ✅:capability==github.push / 白名单精确 / branch==main / SHA 格式 / credentialPresent —— 默认拒绝,逐项具体 reason。
- **D-6 Intent 两阶段** ✅:复用 intents.ts;六要素齐备(target/branch/expected/payload=commit/task/幂等键=sha256(task+changeset+commit+expected));RESERVED→EXECUTING→COMPLETED/CONFLICT/FAILED + Reconcile 三决策。
- **D-7 Scoped Executor** ✅:check=ls-remote 分支真实头(空分支="");perform=非 force push;仅白名单目标的 refs/heads/main。
- **D-8 Observation/DELIVERED** ✅:写成功 ≠ DELIVERED——远端 HEAD==payload **且**远端树逐文件==候选清单(fetch-by-sha + cat-file 校验)双核对后才置 DELIVERED;写后核对不可达 ⇒ NEEDS_RECONCILE(结果不明先查真实状态);CONFLICT/FAILED 不回滚 ACCEPTED(质量结论终态),落 D3 决策行(永不自动批准)。
- **D-9 幂等** ✅:同 changeset 单 proposal(UNIQUE+xmax 判 created);已 CONSUMED ⇒ 核对后 no-op 不重推(反例 8:远端提交数不变、单 intent)。
- **D-10 审计** ✅:PROPOSAL_CREATED/POLICY_DENIED/GIT_COMMIT_BOUND/INTENT_*/DELIVERY_DELIVERED/CONFLICT/FAILED/NEEDS_RECONCILE/RECONCILE 全链审计;append-only 守卫覆盖。

## 2. 反例对照(合同第三节 9 条)

| # | 反例 | 测试 | 结果 |
| --- | --- | --- | --- |
| 1 | 未授权仓库写入必须拒绝 | delivery(反例1) | ✅ repo_not_allowed;0 intent;POLICY_DENIED 留痕 |
| 2 | Token 缺失/权限不足安全失败 | delivery(反例2a/2b) | ✅ credential_missing(0 intent);本地 401 服务模拟 ⇒ intent FAILED、changeset 非 DELIVERED、远端零触碰 |
| 3 | 未经 Gate PASS 不得推送 | delivery(反例3) | ✅ no_gate_authorization + task_not_accepted |
| 4 | 远端 HEAD 漂移必须拒绝 | delivery(反例4)+ github-real(真实远端版,凭据门控) | ✅ CONFLICT、外来提交未被覆盖、D3 行、任务保持 ACCEPTED |
| 5 | push 成功回执丢失不能重复副作用 | delivery(反例5) | ✅ 崩溃窗口模拟 ⇒ SIDE_EFFECT_CONFIRMED ⇒ DELIVERED,远端提交数不变 |
| 6 | 候选内容与 Commit 不一致必须阻断 | git-candidate(content_mismatch)+ delivery(tree_sha_drift) | ✅ |
| 7 | Reviewer 修改候选 OS 层被拒 | reviewer-readonly(容器实测) | ✅ :ro 接线断言 + EROFS + 宿主零写入 + rw 对照组 |
| 8 | 重复触发不得重复提交/错误状态 | delivery(反例8) | ✅ 单 proposal/单 intent/单提交;CONSUMED no-op |
| 9 | 远端提交失败不得标 DELIVERED | delivery(反例9) | ✅ pre-receive 拒 ⇒ FAILED + DELIVERY_FAILED 审计,远端零变化 |

## 3. 实施中修复的缺陷(留痕)

1. **裸 node strip-types 子进程不支持 TS 参数属性**(全量回归暴露:circuit/run-crash 两文件 3 例崩)——`GitCandidateError` 改显式字段声明;全仓 grep 确认无其他参数属性。
2. **pi-e2e 潜在破损自愈**(本包头条发现,两处复合):(a) 该文件不自备 egress、依赖他文件残留的全局栈(P0-02A 的 FAIL-CLOSED 收紧使此假设失效);(b) `executeRun` 未传 `allowedCommands`/任务未授权 ⇒ relay_exec 全拒,模型只能读不能写——**该测试自 P0-02A 起从未在带 provider 的全量中真跑**(8 个 skip 恰为 provider 门文件),属前包遗留而非本包回归。修复:自备 ensureEgress+verify(FAIL-CLOSED 自洽)+ `allowedCommands:["echo"]`(gate-e2e 先例);真模型 2/2 过。诊断期间模型行为完全正确(诚实 handoff "relay_exec 全部被拒"),证明拒执链按设计工作。
3. **egress-proxy 改写测试 15s 无重试**(magpie 高负载偶发超时,全套件下失败)——带 3 次重试(与 verifyEgressEffective 同纪律),计数断言按实际请求数精确。
4. **迁移 journal 缺 0004 条目**(applyMigrations 按 journal 序,手写 SQL 需登记)——补 idx 4。
5. **ON CONFLICT DO UPDATE 的 RETURNING 总返回行**(created 判定失真)——`xmax = 0` 判 INSERT。
6. **executor.check 抛错在 executeIntent 内不被捕获**(401/网络断会穿透)——executeDelivery 三处 try/catch:执行前 check ⇒ FAILED(安全失败)、写后核对 ⇒ NEEDS_RECONCILE、Reconcile 核验 ⇒ CONFLICT。
7. **往返核验结果未转换为阻断错误**(verifyTreeAgainstManifest 返回 {ok:false} 被忽略)——抛 GitCandidateError content_mismatch。
8. **blob 内容按 utf8 散列会破坏二进制比对**——cat-file 改 buffer 编码后按原始字节散列(与清单同构)。
9. 测试自身问题(记录备查):反例1 intent 计数未按 task 过滤(同 schema 跨测试污染);绑定重核"篡改 stage"用例误用 amend(commit 对象不可变,漂移只能发生在记录面)——改为记录值漂移断言,语义更准确。
10. **CONSUMED proposal 记录面可被翻转**(写者自查 + Reviewer F-1 复核确认,`0207a6a`):已交付 proposal 重复 propose 会翻回 POLICY_APPROVED 且 expected 变化产生第二个 intent(git 同 SHA push 是 no-op,无重复副作用,但违反 D-9 记录面语义)——ON CONFLICT 加 `WHERE state <> 'CONSUMED'` 守卫 + 幂等读回 + PROPOSAL_ALREADY_CONSUMED 审计 + 专属断言。
11. **两处 `io.verifyRemoteContent` 调用无 try/catch**(Reviewer F-2,收尾处置修复):核验实现抛错会穿透 executeDelivery(CONSUMED 恢复路径与写后核对路径)——补 try/catch ⇒ NEEDS_RECONCILE(结果不明先查真实状态,绝不误标 DELIVERED);专属测试:注入抛错核验 ⇒ NEEDS_RECONCILE、changeset 非 DELIVERED、Reconcile 补 DELIVERED 且无重复推送。

## 4. 模型预算如实账(合同第四节)

- 本包新增功能与测试:**0 模型调用**(交付链全链用 stub/确定性测试证明,含 goal-loop 全链 DELIVERED)。
- 全量回归运行(验收需要):触发**既有**测试的真实模型路径——gate-e2e 6 次(budget_ledger 6/12,预留内)+ pi-e2e 约 5 次(legacy 测试无账本,如实披露)。全部经 magpie 本地假密钥路由,零真实成本;无一次绕过出口代理的模型调用;无预算扩大。

## 5. 未解决项与边界(诚实清单)

1. **真实远端写入实验挂起(唯一待办)**:细粒度 PAT 未就位(创建需用户在 GitHub UI 操作,API 无此能力)。`github-real.test.ts` 已就绪且门控完备:凭据文件缺失 ⇒ 显式 skip(全新克隆复现中即为 11 skip 之二);PAT 放置 `~/.relay/credentials/github-sandbox-pat`(0600)后运行 `npx vitest run test/integration/github-real.test.ts` 即完成"一次真实 main 写入 + 远端漂移实验"(含 GitHub REST API 独立核对路径)。沙箱仓库 `pwl1987/relay-delivery-sandbox`(私有)已建。
2. **合同机制偏差**:候选 Commit 用 stage 克隆而非 detached worktree(§1 D-2,原因如上);Reviewer 裁决该偏差可接受性。
3. **实验夹具的 force-push**:github-real 的**夹具自清理**步骤(把沙箱远端拉回 base 起点)用 `--force`——这是测试夹具对自家沙箱仓库的预置动作,**非 Relay 交付链行为**(Relay 执行器/Policy 全程无 force 面);已注释声明,REVIEW 裁决。
4. **credential_missing 的 Policy 面与执行器面分离**:Policy 收 `credentialPresent` 布尔事实(调用方校验),执行器侧再以 `credentialFileValid`(0600 常规文件)二次防御——两道闸,但"调用方如实上报"依赖编排方纪律(与 P0-02A 证据采集同构信任模型)。
5. **stage 仓库生命周期**:DELIVERED 后留存供审计(ops 清理);goal-loop 长跑场景的 stage 堆积未做自动回收(记录在案,量级小)。
6. **重试计数断言的宽松化**:egress-proxy 改写测试重试后按实际请求数对账(1 请求=1 计数的精确性保持,但"恰好一次请求"变成"实际 N 次")。
7. 未做:真实 GitHub 写路径实验本体(待 PAT)、Web(P0-02C)、生产部署、RSI、PR 必需流程(合同明确不做)。

## 6. 复现命令

```bash
git clone https://github.com/pwl1987/relay && cd relay
npm ci && npm run db:up
RELAY_PI_BASE_URL=http://127.0.0.1:1/v1 npm test   # 132 passed + 11 skipped(模型/凭据门显式 skip,零模型)
npx tsc --noEmit                                    # 0 错误
# 交付链全量(bare Git + 真 PG,零模型):
npx vitest run test/integration/delivery.test.ts test/integration/git-candidate.test.ts   # 16/16
# 容器门(需 docker;egress 另需 sudo iptables + 本地 provider):
npx vitest run test/integration/egress-proxy.test.ts test/integration/reviewer-readonly.test.ts
# 真实远端实验(PAT 就位后):
npx vitest run test/integration/github-real.test.ts
```

## 7. 证据索引

| 证据 | 内容 |
| --- | --- |
| `p0-02b/full-suite.log` | VM80 全量(最终 HEAD 重跑,内嵌 SHA/时间/预算说明头) |
| `p0-02b/fresh-clone-repro.log` | 全新克隆(头内嵌 SHA):非模型全量 + tsc 0 错误 |
| `p0-02b/github-api-verification.log` | GitHub API 只读核验(四端点状态码 + 凭据形态;无令牌明文) |
| 合同时序 | `22e93ba`(基线)→ `79187dd`(合同,先于实现)→ `61139d5`(实现)→ `aad67bd`(REPORT)→ `0207a6a`(自查加固=Reviewer F-1)→ `28c1b8a`(复核处置)→ `9691292`(证据终版)→ `bcb821c`(P0-02B 收尾)→ 补验包(见 §8) |
| 反例-测试映射 | §2 表(9/9 有专属断言;7 条含 bare Git 失败窗口) |
| 独立复核 | `p0-02b/REVIEW.md`(全新上下文 Reviewer:首轮 PASS-WITH-FIXES + 处置 + 复验) |
| 待补证据 | `github-real` 真跑日志(有效 PAT 就位后补录,测试自带 GitHub API 独立核对) |

## 8. 补验包(P0-02B 安全收敛,2026-11-10 第二轮授权)

授权范围:补验与必要的测试夹具安全修复;不调用模型;不改分支;不强推;不触其它业务仓库。

### 8.1 补验授权逐条对照

| # | 授权要求 | 落地 | 证据 |
| --- | --- | --- | --- |
| 1 | 冷启动核对 live main/Writer/工作区,记录范围 | HEAD==origin/main==`bcb821c`,worktree clean,main-only,唯一 Writer(本会话) | §8.5 |
| 2 | 两处 `git push --force` 改为不改写历史的测试方式 | **两处全部删除**:测试改用「每轮读真实远端 HEAD → 复位本地工作区 → 基于该 HEAD 建候选 → 普通 push」;外部写者**正常快进**推送;夹具自证:本文件与两个 push 执行器剥离注释后的**可执行代码面**零强推标志 | github-real.test.ts 自证用例 |
| 3 | 测试仓库固定,env 不得指向生产仓库 | 目标硬编码 `pwl1987/relay-delivery-sandbox`;`RELAY_DELIVERY_SANDBOX_REPO` 全仓仅被守卫读取、**无消费点**;异值 ⇒ 响亮失败;生产仓库清单 `pwl1987/relay` 显式排除 | 自证用例 + 守卫断言 |
| 4 | 每轮读真实远端 HEAD;基于当前 HEAD 建提交;外部写者快进 | `buildCandidateOnRemoteHead` 每轮 `ls-remote` → 远端可读即 `reset --hard`(仅本地)→ 候选 base = 真实头;外部写者 `git push origin HEAD:refs/heads/main`(非 FF 必被 git 拒) | 漂移用例 |
| 5 | 回归断言:流程自身无强推;历史未丢 | 强推自证(3 文件,剥离注释后)+ 历史断言:`merge-base --is-ancestor`(旧头仍是新头祖先)、提交数**恰好 +1**(非恒真)、旧头对象仍可 `cat-file` | 历史断言三件套 |
| 6 | Policy 收敛:github.com host 校验 / userinfo URL 拒绝 / 候选 base 与 runs.input_commit_sha 一致性 | `allowedHosts`(默认 `["github.com"]`,空=全拒)+ 端口维度(非标端口拒)+ userinfo 拒绝(先于放行)+ **base 一致性**:runner 用 `runs.input_commit_sha` 建候选、stage 复位到 base、Proposal 阶段校验 `cs.gitBaseCommitSha == runs.input_commit_sha`(失配 ⇒ `base_commit_mismatch`) | 新单测 9 例 + 反例用例 |
| 7 | PAT 缺失安全跳过;绝不用宽权限 gh 凭据替代 | 缺失 ⇒ 真实远端整块 skip;经典 `ghp_/gho_/ghs_/ghu_` ⇒ 明确拒绝;形态非法 ⇒ 拒绝;**不读** `~/.config/gh/hosts.yml`、不调 gh CLI、不读 `GH_TOKEN`/`GITHUB_TOKEN`;git 子进程 env 全替换(`HOME=/nonexistent`、`GIT_CONFIG_NOSYSTEM=1`) | 源码自证 + 凭据门用例 |
| 8 | PAT 就位后运行真实写入与漂移实验,保存 API 核验/完整输出/SHA | **凭据未就位 ⇒ 真实写入与漂移两例显式 skip(诚实不假装)**;已保存:`github-api-verification.log`(四端点 401 + 凭据形态)、全量与克隆复现日志(内嵌 SHA)。**真实远端安全失败路径已实测**:凭据被拒 ⇒ 交付 FAILED、changeset 非 DELIVERED、**写入动作零调用**(`perform_calls=0`) | §8.3 |
| 9 | 独立 Reviewer 复核 → CI 绿 → 快进 push → 更新文档 | 补验包首轮 **PASS-WITH-FIXES**(6 MINOR + 7 OBS,无 BLOCK)→ 逐项处置 → 复验;CI(`.github/workflows/ci.yml`)绿后快进推送;四份文档已更新 | `p0-02b/REVIEW.md` §七 |

### 8.2 补验期间发现并修复的真实缺陷

1. **relay_exec 拒绝提示不可行动**(由真实 E2E 暴露):模型用 `echo … && cat …`(复合命令被禁)后,拒绝文本只说"不允许",模型改试 python3/ls,5 回合耗尽 ⇒ E2E 触顶。修复:审计码保持稳定,**模型可见文本补可执行提示**(并向模型披露本任务授权命令清单);`relay_read` 拒绝同样补提示。
2. **Reviewer 预算不足以完成独立核验**:Reviewer 需读变更文件 + 至多 1 个上下文文件再裁决(4 回合),预留只有 3 ⇒ 触顶 ⇒ 保守 NEEDS_DECISION。修复:gate-e2e 预算再平衡 **4+4 ≤ 8**(总额未增),Reviewer 提示明确可读范围;**断言未放宽、Gate 语义未降级**(Reviewer 独立核验已独立完成)。
3. **G-4 后 Reviewer 工具审计不可观测**:只读挂载把审计移到一次性 HOME,随 run 目录消亡 ⇒ Worker 看不到 Reviewer 的工具决策。修复:读回审计摘要入 `runs.detail`(docker 读 HOME 路径、host-fallback 读工作区路径;缺失显式标记 `missing`)。
4. **候选 base 事后重探测**(F-5):模型在 Run 期间自行 commit 时,base 漂移。修复:base 取自 `runs.input_commit_sha`(Run 前记录)+ stage 复位 + Proposal 一致性校验。
5. **首次写入(空分支)路径不可达**:Policy 要求 40 位十六进制的 expected sha,而空分支远端头为 ""。修复:Policy 允许空串(= 分支须不存在;远端若已有分支仍 CONFLICT)。
6. **测试 git 调用无超时**:网络偶发挂起时整例 300s 超时(实测一次)⇒ 显式 60s 超时。
7. **Policy host 归一吞掉端口**(F-6):非标端口目标面未被排除 ⇒ 端口维度收敛(标准端口视为无端口)。

### 8.3 真实远端实验状态(如实)

- 沙箱仓库 `pwl1987/relay-delivery-sandbox`(私有)已建,**main 分支当前为空**。
- 宿主凭据文件 `~/.relay/credentials/github-sandbox-pat` 存在(0600),但**内容不是有效 GitHub 令牌**(11 字节可打印 ASCII,无 `github_pat_` 前缀);GitHub API 四个端点全部 **401**。
- 因此:**真实 main 写入与远端漂移两例从未成功执行**(测试显式 skip,不做假成功)。已实测并留证的是**真实远端的安全失败路径**:鉴权被拒 ⇒ 交付 `FAILED`、changeset 非 `DELIVERED`、**写入动作零调用**(`perform_calls=0`)、远端零变化。
- 有效细粒度 PAT 就位后,一条命令即可闭环(测试已就绪,自动读取文件):
  `npx vitest run test/integration/github-real.test.ts` ⇒ 真实 main 写入(DELIVERED + 远端/树/API 三重核对)+ 远端漂移实验(拒绝覆盖 + 历史完整),日志补录 `p0-02b/`。
- **绝不回退**:本机 `gh` 经典令牌(scope 含 admin:*/repo/workflow)仅属开发者 infra,**未进入任何 Relay Operator 路径**(源码自证:不读 hosts.yml、不调 gh CLI、不读 GH_TOKEN)。

### 8.4 补验后测试账

全量 **158 用例 = 156 passed + 2 skipped**(skip = 真实远端写入/漂移,凭据门);新增/改动:`test/unit/delivery-policy.test.ts`(9 例)、`test/unit/denial-hints.test.ts`(5 例:提示不得含禁止字符)、`delivery.test.ts`(+1 反例:base 失配 ⇒ 拒绝)、`git-candidate.test.ts`(F-5 用例 + 语义澄清)、`github-real.test.ts`(重写:门禁自证 + 凭据事实 + 真实远端三例)。补验新增用例**零模型调用**。

**覆盖条件说明(N-7)**:「历史未丢」的精确计数断言(`countAfter === countBefore + 1` + 旧头对象仍在)位于「远端此前已存在 main」的分支内;沙箱仓库当前 main 为空 ⇒ 首次真实写入走「创建分支」路径,该断言不参与 —— 待第二次运行(远端已有 main)时自动生效。祖先关系断言同理按分支适用。

### 8.5 补验时序与治理留痕

- 冷启动:`bcb821c` == origin/main,worktree clean;写者=本会话(唯一)。
- 复核窗口内 HEAD 前进(补验实现 `5d859f8` → 证据 `d66bc8e`):Reviewer 已如实记录该时序,并声明结论针对代码面 `5d859f8`(证据日志更新不含代码面变更)。
- 补验包复核首轮 **PASS-WITH-FIXES**;处置 6 MINOR(F-1 恒真断言、F-2 空分支路径、F-3 审计路径、F-4 提示示例反引号、F-5 缺反例、F-6 端口维度)+ 4 OBS(F-8 语义澄清、F-9 死分支/工具描述、F-10 判定口径、F-11 自证覆盖面)全部落地;F-7 治理项(四份文档更新)随本节完成。
