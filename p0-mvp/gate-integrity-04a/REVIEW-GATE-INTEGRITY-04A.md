# RELAY-GATE-INTEGRITY-04A 独立 Reviewer 报告

- Reviewer:独立隔离上下文(与实施者无共享对话),全部结论基于亲自读取的代码与亲自运行的探针
- 审查对象:提交链 1764c61(收口基线)→ 2648577(合同登记)→ 6d92ba2(反例留证)→ **8d7b209(实施)**
- 审查日期:2026-11-14;工作区 HEAD 实测 = 8d7b209(`git log --oneline -3` 核实);脏文件均为历史截图/日志(与本包无关,未触碰)
- 测试库:127.0.0.1:55433/relayp000(relay-p000-pg 容器,实测可达;p01a_ schema 隔离,每次运行独立建/删)
- 零真实模型、零远端写入、未触碰 config/ 与 p0-mvp/soak-r3b/

---

## 裁决:**PASS**

一句话理由:完整性双门与工作区安全边界真实落地——独立重放反例 A/B 均不再成立(A=漂移候选被 `candidate_manifest_verify_failed` 拦截、B=缺工作区被 `workspace_missing` 拦截且检查零启动),全仓 grep 证实生产 Gate/检查路径零 `process.cwd()` 回退,越界挂载 FAIL-CLOSED 且零 docker 交互经独立探针实证,既有成功路径(方案 A/abort/交付停止/防重/docs-only 豁免)全部回归绿,无合同违反、无过度设计。

---

## 一、反例重放(亲自运行,非引用实施者结果)

命令:`npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample.mts`,退出码 0。脚本自带 defect-verdict 判据(成立 ⇔ A:`ACCEPTED && manifestVerifyCalls===0 && 零完整性证据`;B:`process.cwd() 被传给执行器 && mountinfo 实证挂载 && ACCEPTED`)。

**反例 A(修复前证据 6d92ba2:ACCEPTED + manifestVerify 调用 0;修复后实测):**
```
A.drift-setup: candidate_sha=a07514e517d2… 写入漂移文件后真实复验 ok=false(预期 false=完整性必败)
A.result: status=NEEDS_DECISION reason=candidate_manifest_verify_failed
A.manifestVerify-calls=1(修复后前置复验即拦截,post 不再执行)
A.evidence-kinds=[candidate_manifest_verify:FAIL]
A.defect-verdict: 不成立(需人工核查)
```
→ 漂移候选 + 功能检查通过 + Reviewer PASS 的组合被前置完整性门拦截,任务 NEEDS_DECISION,Reviewer 未烧。

**反例 B(修复前证据 6d92ba2:process.cwd() 被真实挂载 mountinfo `rw` + inode 相同;修复后实测):**
```
B.docker-probe: passed=false env.mode=sandbox-fail-closed
B.docker-probe mountinfo=null(挂载源=/home/ubuntu/dev/relay,rw)
B.docker-probe inode: 宿主仓库根=23505976 容器/workspace=n/a ⇒ 挂载绑定实证=no
B.orchestrator: status=NEEDS_DECISION reason=workspace_missing
B.orchestrator-check-ran=no 传给执行器的工作区=null
B.defect-verdict: 不成立(需人工核查)
```
→ 执行器层:`validateCheckWorkspace` 先于 docker 探测拒绝仓库根(零挂载);编排层:缺 workspaceDir 保守停机,spyRunner 零调用,Reviewer 零烧。

结论:**两个反例对修复后代码均不再成立,修复生效。**

---

## 二、独立探针清单与结果(全部亲自编写、亲自运行;脚本在 /tmp/review-gi04a/,未污染仓库)

### 探针 1:validateCheckWorkspace 边界 + dockerCheckRunner 越界拒绝(`/tmp/review-gi04a/probe-boundary.mts`,退出码 0,38/38)
- 合法 tmpdir 工作区放行;宿主仓库根、/home/ubuntu、仓库 config/ → `workspace_out_of_scope`
- 自身符号链接 → `workspace_symlink`;**父目录符号链接**(symlink→仓库根/下钻 src)→ realpath 解析后 `workspace_out_of_scope`;symlink→tmpdir 内合法目录 → realpath 后正确放行
- 相对路径/空字符串/非字符串(null)→ `workspace_not_absolute`;尾随斜杠合法路径 → 放行(realpath 规范化);不存在路径 → `workspace_missing`;普通文件 → `workspace_not_directory`
- 显式 allowedRoots 注入面按注入范围生效(仅测试可注入;生产缺省 [tmpdir()])
- dockerCheckRunner 对仓库根/config/symlink/相对路径/空串/null/不存在路径 全部 `passed=false + env.mode=sandbox-fail-closed + rawOutput 含 WORKSPACE_INVALID`,且 **dockerAvailableFn 计数 = 0(校验先于 docker 探测,零 docker 交互)**;合法工作区时探测被调用 1 次(校验不误伤)

### 探针 2:双门漂移检出 + 不误伤对照(`/tmp/review-gi04a/probe-drift.mts`,退出码 0,10/10)
- stub coder run(host-fallback,tmpdir 一次性工作区)→ 检查执行器在执行时向候选工作区写入 DRIFT-DURING-CHECK.txt → 编排结果 `NEEDS_DECISION / candidate_drift_after_checks`
- manifestVerify 调用恰为 2(pre+post);证据链 = `candidate_manifest_verify:PASS:pre_checks → deterministic_test:PASS → candidate_manifest_verify:FAIL:post_checks`;审计含 `CANDIDATE_DRIFT_AFTER_CHECKS`
- **对照组(无漂移,同一编排)ACCEPTED,证据 4 条(pre+check+post+reviewer)—— 双门不误伤正常成功路径**
- 说明:首轮退出码 1 为探针自身 Reviewer 桩缺陷(reviewer runs 行 task_id 写死第一个任务导致 record 校验 `reviewer_run_task_mismatch`),修正桩后全过;被测代码行为无变化

### 探针 3:cwdWorkspace=false 语义保持(`/tmp/review-gi04a/probe-cwdro.mts`,退出码 0,12/12)
- buildCheckDockerArgs 静态断言:false ⇒ `-v <ws>:/workspace:ro` + `-w /tmp`;true ⇒ `-v <ws>:/workspace`(rw)+ `-w /workspace`;均含 `--network none` + `--user 10001:10001`
- 真实容器执行:false ⇒ 容器内写 /workspace 被 OS 拒(只读)、写 /tmp 成功、`pwd`=/tmp、宿主工作区零写入;true ⇒ 容器内写 /workspace 成功且**落回宿主工作区**(漂移检出机制对应面)
- 权限面补充实测:目录 0770(umask 默认)时容器 UID 10001 无写权(Permission denied);仅当目录 0777(生产 `prepareRunDirs` 显式 chmod,src/runtime/sandbox.ts:154)时 rw 落回成立 —— 宿主目录权限本身构成额外缓解层

### 探针 4:post-verify→record/consume 漂移窗口实证(`/tmp/review-gi04a/probe-window.mts`,退出码 0)
- host-fallback(无 FS 只读)桩下,Reviewer 回调期间向候选工作区写入 DRIFT-AFTER-POST-VERIFY.txt 后返回 PASS ⇒ **Gate 仍 ACCEPTED** —— post-verify 之后编排层无第三次复验兜底(见"漂移窗口结论")

### 官方测试(亲自运行,理解断言后判定;非仅看绿)
- `npx vitest run test/integration/gate-integrity-dual.test.ts test/integration/check-sandbox-isolation.test.ts test/integration/gate-machine-evidence.test.ts test/integration/task-abort.test.ts test/integration/delivery-stop.test.ts test/integration/control-audit.test.ts` → **6 文件 58 用例全过,退出码 0**
  - gate-integrity-dual 8 用例断言逐一核对:双门放行含 pre+post 两条 phase 证据;前置拒绝(candidate_manifest_verify_failed,reviewer.calls=0);漂移检出(检查内写 drift-during-check.txt ⇒ candidate_drift_after_checks + 审计 1 条);功能失败+清单正确(REQUIRED_EVIDENCE_FAILED,前置复验通过留档——双门互不顶替);manifestVerify 未注入(integrity_verify_unavailable,零检查执行);缺工作区(workspace_missing,runnerCalls=0);docs-only 无工作区(审计留痕 + 豁免照常 ACCEPTED);docs-only 有工作区(检查照常执行)
  - check-sandbox-isolation 含新增工作区边界 5 用例(仓库根越界/符号链接/缺失+相对路径/合法 tmpdir 不误伤/validateCheckWorkspace 断言),真实 docker 容器反例(A2 只读面/A4 超时杀容器/A5 禁网)仍全过
- 补跑实施 diff 触碰的其余测试:`gate-orchestrator / gate-e2e / delivery / delivery-propose-fallback` → 18 passed + 1 skipped(gate-e2e 1 例条件跳过,`describe.skipIf`,退出码 0)
- `npm run quality:quick` → PASS(lint/typecheck/unit 105 用例,退出码 0)

---

## 三、代码审查要点(全部亲自读源码,行号取自 8d7b209)

### 1. 双门真实实现(src/core/gate-orchestrator.ts)
- 门适用面:`integrityGateApplies = machineEvidenceRequired && hasFunctionalChecks`(L356;docs-only 或未配功能检查时走 2.5 既有语义,不重复设门)
- 前置门(§2.6,L357-404):缺 workspaceDir ⇒ `conservativeStop("workspace_missing", GATE_WORKSPACE_MISSING)`;manifestVerify 未注入 ⇒ `conservativeStop("integrity_verify_unavailable", GATE_INTEGRITY_UNVERIFIABLE)`;复验失败 ⇒ `conservativeStop("candidate_manifest_verify_failed")`;证据 kind=`candidate_manifest_verify`、env.phase=`pre_checks`(L391)
- 后置门(§3.6,L479-511):复验失败 ⇒ `conservativeStop("candidate_drift_after_checks")`,env.phase=`post_checks`(L497)
- 失败路径一致性:所有拦截均经 `conservativeStop`(VERIFYING→NEEDS_DECISION + D3 决策行 + 终止验证租约 + 审计,L265-301),advance 被拒 ⇒ FAILED;**全部先于 Reviewer(L523)return,Reviewer 零烧**;3.5 必需检查失败(L466-474)在前置门之后仍保留,功能失败不被完整性通过掩盖
- 工作区守卫(L407-462):`checksToRun.length>0 && !input.workspaceDir` ⇒ 仅审计 GATE_WORKSPACE_MISSING、**不启动任何检查**(此处只剩 docs-only 豁免可达,代码变更候选已在 2.6 拦截);L448 直接传 `input.workspaceDir`,旧 `?? process.cwd()` 已移除(diff 对照 6d92ba2 证实)

### 2. workspaceDir 回退面(全仓 grep,不只看 diff)
- `src/` 中 Gate/检查/挂载路径(gate-orchestrator.ts、evidence.ts、check-sandbox.ts、runner.ts、reviewer.ts、worker.ts)**零 `process.cwd()`**;残留仅:src/cli.ts:271/415(stub-pi 路径)、src/server/app.ts:123 与 server/index.ts:81(web 静态目录)——均与候选检查工作区无关
- `test/helpers/check-runner.ts:11` 的 `process.cwd()` 仅 `cwdWorkspace===false` 测试 stub 分支,src/ 零引用(grep 证实)
- 结论:宿主目录隐式回退面已在生产路径消除

### 3. validateCheckWorkspace(src/runtime/check-sandbox.ts:57-88)
- 校验链:类型/空串/绝对路径 → 存在(lstat)→ 自身非符号链接 → 目录 → realpath → 前缀匹配允许根(`real === root || real.startsWith(root + sep)`,L85)
- 缺省根 `defaultWorkspaceRoots()=[tmpdir()]`(L48-50)与生产 `prepareRunDirs(tmpdir(),…)`(runner.ts:207、reviewer.ts:146)一致
- 绕过面评估:父目录符号链接被 realpath 全路径解析捕获;尾随斜杠被 realpath 规范化;相对路径/空串/非字符串被前置拒绝 —— 均经探针证实。唯一放行的边界:`real === root`(tmpdir 本身)会被接受,见 Minor-1

### 4. dockerCheckRunner(src/runtime/check-sandbox.ts:159-280)
- 工作区校验(L177-189)先于 `dockerOk()` 探测(L192)⇒ 越界零 docker 交互(探针计数证实)
- cwdWorkspace=false 语义与 RELAY-CONTROL-SAFETY-04 保持一致:`-v ws:/workspace:ro` + `-w /tmp`(L122/L134,探针真实容器证实);UID 10001/cap-drop ALL/no-new-privileges/只读根/tmpfs /tmp/禁网/资源上限 argv 全部未变(L99-137)
- 无宿主执行回退:fail-closed 路径(sandbox-fail-closed)与 P0-A 既有语义一致

### 5. Reviewer 对候选工作区的挂载权限(src/runtime/reviewer.ts:201 + sandbox.ts:270-271)
- `workspaceReadOnly = spec.sandbox === "docker" && Boolean(spec.workspaceDirOverride)`(L201)
- **docker(live 生产)**:候选面以 `:ro` 挂载(sandbox.ts:271),写/删/替换在 OS 层被拒;工具审计落一次性 HOME(reviewer.ts:289、sandbox.ts:280)
- **host-fallback(stub 测试专用)**:无 FS 级只读,仅靠 `allowedCommands: []`(reviewer.ts:207)+ relay_read-only 工具面(relay-tools.extension.ts 仅注册 relay_read)+ prompt 级禁令;live 下 host-fallback 已被 worker.ts:186-195 FAIL-CLOSED 拒绝领取(`sandbox_not_isolated`),worker.ts:155 host-fallback 仅 stubInjection 可达
- 结论:生产 Reviewer 与 Gate 使用一致候选由 OS 级只读强制;host-fallback 为已知测试面,live 不可达

### 6. worker.ts 接线(L307-337)
- checkRunner:显式注入 > docker ⇒ dockerCheckRunner > 否则缺省(failClosedCheckRunner,FAIL-CLOSED 方向)
- manifestVerify ⇒ `verifyCandidateManifest(spec.workspaceDir, spec.candidateSha, spec.changedFileCount)`(L318-319,纯确定性重采比对,workspace-manifest.ts:61-81)
- reviewRun ⇒ workspaceDirOverride=input.workspaceDir(L334);input.workspaceDir 来自 `result.sandboxSpec.workspaceDir`(L296)= prepareRunDirs(tmpdir())/relay-run-*/ws,与校验白名单同范围

### 7. 既有成功路径回归
- 方案 A/abort(前置 2.4、采集期轮询、后置 4.5)/交付停止/并发防重/幂等:task-abort(7)、delivery-stop(10)、control-audit(6)、gate-orchestrator、gate-e2e、delivery、delivery-propose-fallback 全绿
- docs-only 豁免不退化:两用例(缺工作区跳过检查+审计、有工作区检查照常)均绿;且顺带消除旧路径"docs-only+checks+无工作区把宿主 cwd 挂出去"的隐患
- 消费侧把关未被削弱:gates.ts record(L114-134)与 consume(L268-299)对 evidenceIds 全量核验(绑定+digest+功能证据必需),`stale_candidate`(L249-258)比对 DB candidateSha——双门证据自然纳入同一核验链

---

## 四、Major / Minor 发现

**Major(安全缺口/合同违反/修复未生效):无。**

**Minor(改进建议,均不构成放行风险):**

1. **validateCheckWorkspace 允许 `real === root`**——src/runtime/check-sandbox.ts:85。若调用方显式传 tmpdir() 本身,会把整个 /tmp(含其他 Run 工作区)挂为候选面。生产路径不会出现(workspaceDir 恒为 runDir/ws 深层路径),属纵深防御缺口:建议拒绝等于允许根本身的路径(生产工作区永远是 `relay-run-*/ws` 形态)。
2. **post-verify→record/consume 之间无第三次完整性复验**——src/core/gate-orchestrator.ts:479-627;record/consume 侧 `stale_candidate` 只比对 DB 中 changeset.candidateSha,不复核工作区实际内容(src/core/gates.ts:249-258)。合同字面("测试期间修改候选工作区必须识别漂移并在功能测试后重新验证")已满足,生产 live 由 Reviewer :ro 挂载缓解;可在 ACCEPTED 路径 consume 前落一条终验证据进一步收紧,或登记为已知残余(见下节)。
3. **host-fallback 下 Reviewer 候选面无 FS 级只读**——src/runtime/reviewer.ts:201(`sandbox==="docker"` 才置 workspaceReadOnly)。live 已被 worker.ts:186 FAIL-CLOSED 阻断,风险面仅限 stub 测试;若未来引入新宿主执行面需重审该判定。
4. **反例脚本 B-1 note 文案为"修复前"语境**——p0-mvp/gate-integrity-04a/evidence/counterexample.mts:168-170("挂载绑定本身已实证…"),对修复后代码重放时与实测(mountProven=no)自相矛盾,易误读。仅证据脚本文案问题,不影响修复有效性;建议后续提交注明该 log 为修复前留证。
5. **2.5 分支缺工作区时不落 GATE_WORKSPACE_MISSING 审计**——src/core/gate-orchestrator.ts:302-348(`machineEvidenceRequired && !hasFunctionalChecks` 且 manifestVerify 有而 workspaceDir 缺 ⇒ 直接 `functional_evidence_unconfigured` 停机)。行为保守正确(反正 NEEDS_DECISION),仅可观察性动作名与 2.6/§3 不一致;如需统一可补审计。

---

## 五、漂移窗口结论(如实评估)

- **pre-verify → 功能检查 → post-verify**:检查(cwdWorkspace=true 时容器内 /workspace 为 rw)期间对候选工作区的任何修改,被 post-verify 复验检出 ⇒ `candidate_drift_after_checks` 保守停机。已由独立探针(检查执行器写漂移文件)与官方测试双重实证。合同 §三.5/6 满足。
- **post-verify → Reviewer → record/consume(残余窗口,如实登记)**:编排层在此区间无第三次 manifest 复验;探针 4 实证 host-fallback 桩下该窗口内写入候选面后 Gate 仍 ACCEPTED。缓解面:(a) 生产 live 默认 docker,Reviewer 候选面 OS 级 `:ro` 挂载(reviewer.ts:201 + sandbox.ts:271),模型/容器内不可写;(b) 候选工作区位于 tmpdir 下由 worker 进程生命周期管理(runDir 归属哨兵 + safeRm),窗口内写者需宿主权限;(c) record/consume 的绑定核验(candidateSha/attempt/digest/功能证据)未被削弱。残余风险 = 持有宿主写权限的进程在 post-verify 之后、consume 之前修改候选面的 TOCTOU,属分布式固有窗口,现有缓解合理;建议按 Minor-2 后续收紧或显式登记残余。
- **Reviewer 挂载权限(docker vs host-fallback)**:docker ⇒ 候选面 `:ro` + 工具审计落一次性 HOME;host-fallback ⇒ 无 FS 只读(仅工具白名单 + prompt 禁令),live 不可达(FAIL-CLOSED)。见 Minor-3。
- 附件说明:snapshotManifest 跳过符号链接、排除 .relay/.git(workspace-manifest.ts:12,31),复验器本身无链接逃逸面。

---

## 六、过度设计评估

**无过度设计。** 实施新增面仅:① `validateCheckWorkspace`/`defaultWorkspaceRoots`(check-sandbox.ts:48-88,约 40 行,纯函数无状态);② 编排双门块(复用既有 `recordEvidence`/`workerEnv`/`conservativeStop`/审计设施,无新表);③ dockerCheckRunner 前置校验分支;④ worker.ts 注释更新。完整复用合同指定设施(snapshotManifest/verifyCandidateManifest/ChangeSet candidateSha/Evidence/Gate),未新增第二 Gate、质量数据库、规则引擎或新服务;存量测试适配为最小改动(manifestVerify 注入 + 2 处断言按双门语义更新)。

---

## 七、亲自执行过的命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `git log --oneline -5` / `git status --porcelain` / `git remote -v` | 0 | HEAD=8d7b209;脏文件为历史截图/日志 |
| `git show 6d92ba2 --stat` / `git diff 6d92ba2..8d7b209`(src+test) | 0 | 实施 diff + 反例证据核对 |
| 全仓 `grep -rn "process.cwd()" src/ test/ scripts/` | 0 | 生产 Gate/检查路径零回退 |
| `npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample.mts` | 0 | A/B defect-verdict 均"不成立",修复生效 |
| `npx tsx /tmp/review-gi04a/probe-boundary.mts`(自写) | 0 | 38/38(边界+越界拒绝+零 docker 交互) |
| `npx tsx /tmp/review-gi04a/probe-drift.mts`(自写;首轮 1=探针桩缺陷,修正后) | 0 | 10/10(漂移检出+对照不误伤) |
| `npx tsx /tmp/review-gi04a/probe-cwdro.mts`(自写;首轮 1=探针语法/目录权限,修正后) | 0 | 12/12(cwdWorkspace=false 语义) |
| `npx tsx /tmp/review-gi04a/probe-debug.mts`(自写,权限面调查) | 0 | 0770 拒写 / 0777 落回,与 prepareRunDirs 一致 |
| `npx tsx /tmp/review-gi04a/probe-window.mts`(自写) | 0 | post-verify→record 窗口实证(ACCEPTED) |
| `npx vitest run`(6 个指定集成测试文件) | 0 | 58 用例全过 |
| `npx vitest run`(gate-orchestrator/gate-e2e/delivery/delivery-propose-fallback 补充) | 0 | 18 过 + 1 条件跳过 |
| `npm run quality:quick` | 0 | PASS(lint/typecheck/unit 105) |

环境事实:测试库 relay-p000-pg 于 127.0.0.1:55433 实测可达(TCP 探测 + createTestDb 实际连接),docker 可用(探针内真实容器执行);全程零真实模型调用、零远端写入、未触碰 config/ 与 p0-mvp/soak-r3b/。

---

## 结论

裁决 **PASS**:修复真实有效且最小化;双门语义、FAIL-CLOSED 方向、docs-only 豁免保留、cwdWorkspace=false 与 Docker 边界不变均经独立代码审读与独立探针证实;残余窗口(Reviewer 挂载权限缓解后的宿主侧 TOCTOU)如实登记为 Minor/残余项,不构成放行风险。
