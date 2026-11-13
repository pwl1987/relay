# RELAY-GATE-INTEGRITY-04A 最终报告

裁决:**PASS**(独立 Reviewer 隔离上下文一轮:0 Major + 5 Minor;Minor-1 已修复,Minor-2/3/4/5 登记不改码;反例重放与独立探针由 Reviewer 亲测)

日期:2026-11-14
合同:2648577(CURRENT.md「RELAY-GATE-INTEGRITY-04A」ACTIVE 登记;开工冷启动 live main=1764c61,exact-head CI 43478093473@1764c61 双 job success)

## 1. 基线与 Writer

- 开工冷启动:live main = origin = 本地 `1764c6103c831e5fed35b36058e0113b9ab35aac` 一致(gh run list 亲测 CI 双绿);未跟踪受保护 `config/`、`p0-mvp/soak-r3b/` 全程零触碰;Writer=本窗口唯一,main-only 快进,零生产重启/零模型调用/零真实远端写入。
- 提交链:`2648577(合同)→ 6d92ba2(反例留证,对未修复代码 1764c61 实测)→ 8d7b209(实施,13 文件 +772/-47)→ 785aa27(Reviewer PASS 入库+Minor-1 修复+修复后复验日志)→ 收口提交`。

## 2. 反例留证(修复前,对 1764c61 实测;evidence/counterexample.log)

| # | 反例 | 修复前实测结果 |
| --- | --- | --- |
| A | 配置 deterministic_test/api_behavior 时 manifestVerify 是否被跳过 | **成立**:candidate_manifest_verify 门被完全跳过(manifestVerify 调用=0、零完整性证据);候选工作区写入漂移哨兵后真实复验 ok=false(完整性必败),但 功能检查通过+Reviewer PASS ⇒ **ACCEPTED** —— 功能测试与 Reviewer 顶替了完整性验证 |
| B | workspaceDir 未提供时是否以 process.cwd() 作 Docker 挂载源 | **成立**:orchestrateGate 把 `process.cwd()`=`/home/ubuntu/dev/relay` 传给检查执行器(检查被启动);执行器层真实容器 mountinfo 实证挂载源=`/home/ubuntu/dev/relay /workspace rw`、容器内 /workspace inode 与宿主仓库根相同(23505976);Gate 照常 ACCEPTED(检查验证的是仓库根而非候选内容)。如实记录缓解面:容器 UID 10001 因宿主目录权限(0750/0770)暂不可穿越读取,挂载绑定本身已实证,不夸大可利用性 |

## 3. 交付内容

### 完整性双门(src/core/gate-orchestrator.ts)

- **前置复验(2.6)**:配置功能性检查(deterministic_test/api_behavior)的代码变更候选,功能检查**前**必须 manifestVerify 复验候选工作区与 candidate_sha 一致(功能测试不能代替完整性验证);通过 ⇒ 落 `candidate_manifest_verify`(env.phase=pre_checks)证据;失败 ⇒ 保守停机 `candidate_manifest_verify_failed`(不进 Reviewer,零模型预算)。
- **后置复验(3.6)**:功能检查**后**重新复验候选内容 —— 测试期间修改候选工作区 ⇒ 漂移必被识别,保守停机 `candidate_drift_after_checks`(审计 CANDIDATE_DRIFT_AFTER_CHECKS;已测内容 ≠ Gate 绑定面 ⇒ 完整性失败不得 ACCEPTED);通过 ⇒ 落 phase=post_checks 证据,进 Reviewer。
- **双门并行不互替**:manifestVerify 未注入 + 功能检查 ⇒ FAIL-CLOSED `integrity_verify_unavailable`(GATE_INTEGRITY_UNVERIFIABLE 审计;功能证据不能顶替完整性验证);功能检查失败 + 清单正确 ⇒ `REQUIRED_EVIDENCE_FAILED`(前置复验通过不掩盖功能失败)。
- **工作区守卫(§四)**:`input.workspaceDir ?? process.cwd()` 隐式回退**彻底移除**。代码变更候选 + 功能检查 + 缺工作区 ⇒ FAIL-CLOSED `workspace_missing`(GATE_WORKSPACE_MISSING 审计,不启动任何检查);docs-only 候选 + 检查已配置 + 缺工作区 ⇒ 检查跳过(审计留痕)+ 豁免路径照常(合法 docs-only 豁免不退化)。
- 复用现有 snapshotManifest/verifyCandidateManifest/ChangeSet candidateSha/Evidence/Gate/conservativeStop;零新表、零第二 Gate、零规则引擎、零质量数据库。

### 工作区安全边界(src/runtime/check-sandbox.ts)

- **validateCheckWorkspace(§四.3)**:候选检查挂载源必须为绝对路径/存在/目录/自身非符号链接/realpath 后属于允许根范围**之下**(缺省 `tmpdir()`,与生产 `prepareRunDirs(tmpdir(),…)` 同范围,可注入 allowedWorkspaceRoots);等于允许根本身亦拒绝(Minor-1:挂整个 /tmp 非合法候选工作区语义)。
- **FAIL-CLOSED(§四.5)**:越界 ⇒ `WORKSPACE_INVALID` 检查失败(env.mode=sandbox-fail-closed,workspaceReason 如实入证),**校验先于 docker 探测 ⇒ 零 docker 交互**(不启动 Docker 检查);绝不挂载宿主仓库根/生产配置/不受控目录。
- **语义保持(§四.6/7)**:cwdWorkspace=false 容器内 /tmp+工作区只读不变;Docker UID 10001/cap-drop ALL/只读根 FS/默认禁网/CPU·内存·进程数·超时上限全部不变(Reviewer 独立探针复核)。

### 测试(反例先行:红→绿)

- 新增 `test/integration/gate-integrity-dual.test.ts` 8 用例:双门放行(pre/post 两条 phase 证据)/前置拒绝/漂移检出/功能失败+清单正确/复验器缺失 FAIL-CLOSED/缺工作区不启动检查+零 runner 调用/docs-only 豁免不退化×2。修复前 8/8 红(失败模式与反例一一对应),修复后 8/8 绿。
- 新增 `check-sandbox-isolation.test.ts` 工作区边界 5 用例(真实 docker):宿主仓库根越界(零 docker 交互实证)/符号链接/缺失+相对路径/合法 tmpdir 不误伤/validateCheckWorkspace 边界断言(含 tmpdir 本身拒绝)。
- 存量适配:6 文件 manifestVerify 注入(gate-orchestrator/gate-machine-evidence/gate-e2e/task-abort/delivery/delivery-propose-fallback;直接构造 gate options 的测试显式注入生产同源复验;LiveWorker 系测试经 worker.ts 接线自动获得)+ 2 处断言按双门语义更新(预复验证据行)。方案 A/abort/交付停止/幂等/docs-only 既有回归全绿。

## 4. 独立 Reviewer(隔离上下文,一轮)

- **裁决 PASS(0 Major + 5 Minor)**;报告=p0-mvp/gate-integrity-04a/REVIEW-GATE-INTEGRITY-04A.md(Reviewer 亲写入库)。
- 反例重放(Reviewer 亲测,对修复后代码):A ⇒ NEEDS_DECISION/candidate_manifest_verify_failed,B ⇒ NEEDS_DECISION/workspace_missing + 检查零调用,defect-verdict 双双"不成立"(evidence/counterexample-reverify-after-fix.log)。
- 独立探针 12 组全部 exit 0:38 项路径边界拒绝(仓库根/config/父目录符号链接/相对/空串/null/文件/缺失)/10 项漂移检出(pre_checks:PASS→检查→post_checks:FAIL→拦截,clean 对照不误伤)/12 项 cwdWorkspace=false 语义(argv :ro+-w /tmp、真实容器写 /workspace 被 OS 拒、宿主零写入)/残余窗口实证/指定 6 测试文件 58 用例全绿+diff 触碰面补跑/quality:quick PASS。
- Minor 消化:Minor-1 修复(validateCheckWorkspace 拒绝允许根本身+边界测试);Minor-2(post-verify→record/consume 残余窗口:生产 docker 下 Reviewer 对候选面 OS 级 :ro 挂载缓解,宿主侧 TOCTOU 为固有残余,如实登记)/Minor-3(host-fallback 模式 Reviewer 无 FS 只读;生产 worker 已被 FAIL-CLOSED 阻断,登记)/Minor-4(反例脚本为修复前证据不改写,修复后复验另存 reverify 日志)/Minor-5(2.5 分支[无功能检查]缺工作区不落 GATE_WORKSPACE_MISSING 审计的留痕建议,登记)。

## 5. 测试与质量证据

- `quality:quick` PASS(lint+typecheck+unit 105/105);`quality:full` PASS(单测+真 PG 集成+容器安全门+浏览器旅程;适配前 5 失败均为双门新语义的预期拦截,适配后全绿);`quality:release` PASS(**READY**,备份恢复一致;性能/模型门禁/真实部署按 NOT_RUN 登记不虚构)。证据目录=test-evidence/quality-*-2026-11-13T18-*/。
- 定向:gate-integrity-dual 8/8、check-sandbox-isolation 17/17(真实 docker)、gate-orchestrator 5/5、gate-machine-evidence 10/10、gate-e2e/task-abort/delivery/delivery-propose-fallback 全绿。
- 修复后反例复验:counterexample-reverify-after-fix.log(A/B defect-verdict 均不成立)。

## 6. 生产影响、回滚与登记

- **生产影响**:worker/web 未重启 ⇒ 线上行为不变;重启后:①配置功能性检查的代码变更候选,Gate 在功能检查前/后各做一次候选完整性复验(漂移/不一致/零编辑 ⇒ 保守停机 NEEDS_DECISION,人工处置)②RELAY_EVIDENCE_CHECKS_JSON 配置功能性检查时,manifestVerify 由 worker.ts 接线自动提供,无需新配置③缺显式工作区 ⇒ 检查不启动(生产 LiveWorker 恒传 sandboxSpec.workspaceDir,行为不变;防御纵深增强)④越界/符号链接工作区 FAIL-CLOSED。
- **回滚**:`git revert 785aa27 8d7b209`(无迁移加列;双门为编排层逻辑,回退后恢复旧语义 —— 不建议,保留修复)。
- **残余登记(合同语义内,如实)**:Minor-2 post-verify→record 残余窗口(生产 docker 下 Reviewer :ro 缓解;第三态复验属架构扩展,登记不实施)/Minor-3 host-fallback Reviewer FS 权限(生产已被 FAIL-CLOSED 阻断)/Minor-5 审计留痕建议;宿主侧进程级 TOCTOU 为固有 OS 残余。
- **登记后续**:上一包既有登记不变(M-4 handback/STOPPED 工具化恢复/审计结构化收敛/生产部署配置包);本包新增=生产部署准入确认后,下一阶段才安排生产部署配置与验收(本包不含部署动作)。

## 7. NOT_RUN/未验证(如实)

- 生产部署验证与 worker 重启(未触碰;通过后下一阶段才安排生产部署配置与验收)。
- 真实 GitHub 远端写入(合同禁止;全部测试使用隔离 bare 仓库/桩)。
- 真实模型 Run(零模型约束;全部检查/Reviewer 为受控桩)。
- 非 tmpdir 自定义 baseDir 的生产部署形态(当前生产与测试均为 prepareRunDirs(tmpdir());若未来引入自定义 baseDir,须同步注入 allowedWorkspaceRoots —— 已在 DockerCheckRunnerOptions 预留)。
