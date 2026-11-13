# REVIEW-GATE-INTEGRITY-04A-R2(独立 Reviewer 终裁报告)

- Reviewer:独立隔离上下文(不信任实现者陈述,全部结论基于仓库事实与亲自运行结果)
- 审查对象:提交链 96db097(合同)→ 5138094(反例留证)→ a9d78be(实施);基线 bd53f9a
- 审查日期:2026-11-14
- 审查时仓库状态:本地 main=a9d78be(ahead of origin 3 提交,未推送);工作区仅受保护未跟踪 `config/`、`p0-mvp/soak-r3b/`(零触碰)

---

## ① 裁决

**PASS**(0 Major + 4 Minor;Minor 均登记不阻断)

两项修复均经我亲测证实有效且精确:

1. **Fix 1(Gate 直接调用完整性绕过,反例 C)**:`gates.ts` record/consume 双侧新增 `integrity_evidence_missing` 硬规则,与既有 `functional_evidence_missing` 同构同位、功能性规则在前。亲测:直录"仅功能证据"PASS 被拒(integrity_evidence_missing)且任务停 VERIFYING;直录旧格式 PASS 行 consume 被拒并落 GATE_CONSUME_REJECTED 审计;docs-only 与 candidateSha=null 豁免不误伤;补齐完整性证据后照常放行。
2. **Fix 2("/tmp" 非本 Run 工作区挂载,反例 D)**:`runner.ts` insertRun 持久化 `runs.detail.workspace_dir`、updateRun 改 COALESCE 合并语义;`gate-orchestrator.ts` 新增 2.45 归属绑定校验(位于 2.5/2.6 双门之前)。亲测:mismatch ⇒ NEEDS_DECISION/workspace_provenance_mismatch、GATE_WORKSPACE_PROVENANCE_MISMATCH 审计、检查与 Reviewer 零执行;match ⇒ 照常 ACCEPTED(生产路径不误伤);无绑定记录 ⇒ 跳过(R2-D3 行为锁定);尾斜杠与 "/." 反射变体均拦截(失配即停,不做路径等价猜测)。

diff 最小(10 文件,其中 3 个为反例证据载体);未引入第二 Gate/规则引擎/质量数据库;未触碰 config/ 与 p0-mvp/soak-r3b/;无迁移文件;无超范围改动(runner.ts 其余改动为 biome 格式化重排,逐行核对语义等价)。

---

## ② 审查方法

- **Diff 范围**:`git diff 96db097..a9d78be`(逐文件通读全部 10 文件;`git diff 5138094..a9d78be` 确认反例日志自 5138094 起未改写)。
  - 生产代码 3 文件:`src/core/gates.ts`(+12,record/consume 双侧完整性规则)、`src/core/gate-orchestrator.ts`(+21,2.45 归属绑定)、`src/runtime/runner.ts`(+118/-76,insertRun detail+workspace_dir、updateRun COALESCE 合并,其余为格式化重排)。
  - 测试 4 文件:`gate-integrity-dual.test.ts`(新增 R2-C/R2-D/R2-D3 三用例)、`gate-binding.test.ts`(setupVerifying 预置完整性证据+4 个 PASS 站点补引用,其余为格式化)、`pi-e2e.test.ts`(真实工作区生产同源复验+补引证据;模型门控 skipIf,本地不跑)、`test/setup/gate-helper.ts`(recordBoundGate 对 candidateSha≠null 的 PASS 补播 manifest 证据)。
  - 证据 3 文件:counterexample-r2.mts / counterexample-r2.log / counterexample-r2-reverify-after-fix.log。
- **亲测命令**(关键项;完整清单见文末):反例重放、10 组独立探针(/tmp 脚本)、7 个指定集成测试文件(backup-restore 以其门控环境变量补跑)、quality:quick 亲测、旁路 grep、diff 逐文件审读。
- **quality:full/release 不重跑**(按边界避免浏览器截图噪音;仅核对实现者已入库证据)。

---

## ③ 反例重放结果(本人运行 `npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample-r2.mts`,退出码 0)

修复后(对 a9d78be 工作树实测)关键输出:

- 反例 C:`C.record: ok=false reason=integrity_evidence_missing`;`C.consume: state=n/a(任务状态=VERIFYING)`;`C.integrity-evidence: … candidate_manifest_verify 行数=0`;`C.defect-verdict: 不成立(需人工核查)`。
- 反例 D:`D.layer1-validateCheckWorkspace: ok=true`、`D.layer2-verifyCandidateManifest: ok=true`(既有两层照旧放行,与设计一致);`D.layer3-orchestrateGate: status=NEEDS_DECISION reason=workspace_provenance_mismatch`;`D.checks-executed-in=null(…本 Run 工作区…全程未被使用)`;`D.integrity-evidence: 0 条复验证据`;`D.defect-verdict: 不成立(需人工核查)`。

与入库对照一致:修复前红态 `git show 5138094:p0-mvp/gate-integrity-04a/evidence/counterexample-r2.log` 显示 `C.record: ok=true`+`C.consume: state=ACCEPTED(任务状态=ACCEPTED)`+零完整性证据、`D.layer3-orchestrateGate: status=ACCEPTED`+检查在外来目录真实执行——缺陷实证成立;与 8d7b209(上一包)无关。修复后复验日志 `counterexample-r2-reverify-after-fix.log` 与我的亲测输出同构。日志尾部"对未修复代码 bd53f9a"为静态文案(Minor-R2-3,见⑦),以 defect-verdict 行为准。

---

## ④ 独立探针结果(/tmp/r2-reviewer-probe.mts,隔离 p01a_ schema,零模型;10/10 PASS,退出码 0)

**a. record 侧豁免精确性**
- a1 `candidateSha=null` 纯分析 PASS + 单条 reviewer_output 证据 ⇒ `ok=true`(无变更集纯分析豁免照常)。
- a2 `candidateSha=null` 且 evidenceIds 空 ⇒ `ok=false reason=evidence_missing`(零证据仍不行,豁免≠免证据)。
- a3 docs-only 变更集(candidateSha≠null,changedFiles={"added":["README.md"]})PASS 仅功能证据 ⇒ `ok=true`(完整性豁免不误伤 docs-only)。

**b. consume 侧旧格式直录**
- 直插旧格式 PASS 行(evidence_ids 仅含 functional,绕过 record 校验形态)⇒ consume `ok=false reason=integrity_evidence_missing`,审计 `GATE_CONSUME_REJECTED` 恰 1 条,任务状态保持 VERIFYING。

**c. 归属绑定三态(编排层)**
- match:input.workspaceDir == runs.detail.workspace_dir ⇒ `ACCEPTED`(merge 语义有效:run 收尾 updateRun 后 workspace_dir 仍存留并被校验读取;生产同源路径不误伤)。
- mismatch:内容相同外来目录 ⇒ `NEEDS_DECISION/workspace_provenance_mismatch` + `GATE_WORKSPACE_PROVENANCE_MISMATCH` 审计 1 条 + checkRunner 0 次调用 + Reviewer 0 次调用(拦截先于一切检查/复验/Reviewer)。
- 无 workspace_dir 键 + 本 Run 工作区 ⇒ 校验跳过,既有双门照常 ⇒ `ACCEPTED`(R2-D3 行为一致)。
- 无 workspace_dir 键 + 外来目录 ⇒ 亦跳过 ⇒ `ACCEPTED` 且检查在外来目录执行(残留面实证:无记录即不拦截;与合同登记的 R2-D3 残留同类,见 Minor-R2-2)。

**d. 反射变体(失配即停)**
- 尾斜杠变体(ownWs + "/")⇒ `NEEDS_DECISION/workspace_provenance_mismatch` + 审计 + Reviewer 0 次。
- "/." 归一化变体 ⇒ 同样拦截。不做路径等价猜测,符合"失配即停"设计。

---

## ⑤ 测试结果

指定 7 文件(`npx vitest run`,退出码 0):**44 passed + 1 skipped**;backup-restore 以 `RELAY_BACKUP_E2E=1` 补跑 **1 passed**(该文件为既有授权门控设计,非本包引入)。

- gate-integrity-dual(11):含新增 R2-C/R2-D/R2-D3 全绿;既有双门 8 用例无退化。
- gate-binding(5)/gate-machine-evidence(10)/delivery-stop(10)/goal-loop(6)/verify-lease(2):全绿——docs-only 豁免、方案 A 链路、abort/交付停止、幂等防重、旧 PASS 绑定失配语义均未破坏。

额外回归(超出要求,自查):run-lifecycle + gate-orchestrator(12 passed)、goal-message-authorization + heartbeat-leased-chain(18 passed)。

quality 证据核对(实现者已入库,亲验存在性与 PASS):
- `test-evidence/quality-quick-2026-11-13T22-52-20/evidence.json`:verdict=PASS(lint/format/typecheck/unit)。
- `test-evidence/quality-full-2026-11-13T22-52-46/evidence.json`:verdict=PASS(+pg/tests/browser)。
- `test-evidence/quality-release-2026-11-13T22-58-42/evidence.json`:verdict=PASS(+backup-restore;releaseReadiness=READY)。
- 三者 sha 均绑定运行时 HEAD=5138094 且 gitDirty=true:运行时间(UTC 22:52~23:04 = 本地 11-14 06:52~07:04)在实施提交 a9d78be(07:04:57)之前,实施内容以未提交工作区参与验证。提交内容即该工作区快照,覆盖等价;但证据未绑定最终头 —— 登记 Minor-R2-1。

本人独立复跑 `npm run quality:quick`:**PASS**(105/105 用例;证据 test-evidence/quality-quick-2026-11-13T23-13-43/,git-ignored 不入库)。

---

## ⑥ 旁路排查结论(全仓 grep 亲查)

1. **recordGateVerdict/consumeGateVerdict 生产调用方**:仅 `src/core/gate-orchestrator.ts:636/659`(编排内部同事务);其余全部为 test/test-helper 引用(circuit-recovery.test.ts:265 为 `void` 导入抑制;src/server/capabilities.ts:100 为能力清单字符串)。直录绕过面已闭合。
2. **UPDATE runs SET detail 其余站点**:`reviewer.ts:293/336`、`discovery.ts:384/419` 均为全量替换,但只作用于各自 role=reviewer/role=discovery 的 run 行(WHERE id=各自 runId);coder run 行的 workspace_dir 仅由 `runner.ts` insertRun 写入、updateRun 合并保留,不可能被覆盖。
3. **recordChangeset 生产调用方**:仅 `runner.ts:488`(Run 收尾自录)⇒ changeset.runId 恒为 coder run,且编排层步骤 2 强制 `changeset.runId === input.coderRunId`(gate-orchestrator.ts:172)⇒ 2.45 读取的 runs 行必为产生变更集的 coder run,无法用无关 runId 混淆。
4. **2.45 校验位置**:gate-orchestrator.ts 309-322 行,位于 2.5 预检(323)/2.6 双门前置复验(371+)与 Reviewer 之前;abort 检查(2.4)仍在其前,控制优先级未变。探针 c2 实证失配时检查与 Reviewer 零执行。
5. **LiveWorker 生产同源**:`src/server/worker.ts:296` runTask 返回 `workspaceDir: result.sandboxSpec.workspaceDir`,与 insertRun 记录源(`sandbox.workspaceDir`)完全同源;goal-loop.ts:338 原样透传 ⇒ 生产路径恒 match(探针 c1 实证 ACCEPTED)。
6. **workspaceDir 缺失不构成绕过**:input.workspaceDir 为空时 2.45 跳过,但 2.5(无功能检查⇒保守停机)与 2.6(有功能检查⇒workspace_missing FAIL-CLOSED)仍拦截;既有用例("缺少工作区⇒不启动任何检查")亲测仍绿。

---

## ⑦ Major/Minor 明细

**Major:0 条。**

**Minor(4 条,登记不阻断):**

- **Minor-R2-1(证据绑定,不阻断)**:quality quick/full/release 三级证据 sha 绑定运行时 HEAD=5138094(gitDirty=true),最终实施 SHA a9d78be 无独立重跑。实施内容以未提交工作区参与验证、提交即该快照,覆盖实质等价,但与"证据绑定 SHA"纪律存在表面缝隙。建议:收口推送后若安排后续包,可在新包冷启动 quality:quick 顺带覆盖最终头;或在本报告登记后不再补跑。
- **Minor-R2-2(已登记残留的精确化)**:2.45 归属绑定在 runs 行无 workspace_dir 键(R2-D3 已锁定)及 runs 行完全不存在时均跳过(探针 c3b 实证外来目录在无记录形态下仍 ACCEPTED 且检查在外来目录执行)。缓解事实:recordChangeset 生产唯一调用方=runner.ts(coder run 行必存在);伪造行需直写 DB,超出进程内调用方威胁模型。建议:后续包可将"行不存在"与"有行无键"区分审计留痕(如 GATE_WORKSPACE_PROVENANCE_UNRECORDABLE),不要求本包修复。
- **Minor-R2-3(证据脚本静态文案,不阻断)**:counterexample-r2.mts 头尾静态文案"对未修复代码 bd53f9a"在修复后运行时与实际对象不符(我亲测时即为修复后代码)。实现者按"反例留证不改正文"纪律(Minor-4)不改写,以 defect-verdict 行与 counterexample-r2-reverify-after-fix.log 区分,处置如实。建议:后续允许时为脚本增加运行时 HEAD 打印。
- **Minor-R2-4(测试辅助同构性观察,不阻断)**:gate-helper.recordBoundGate 为 candidateSha≠null 的 PASS 合成 `candidate_manifest_verify` 证据(rawOutput="verify=ok",非真实复验)。其同构的是"引用完整性证据"这一绑定形态,真实复验由编排层用例(builtinManifestVerify 生产同源)覆盖,不构成证据链漏洞(测试辅助非生产面)。建议:保持现状;后续允许时 helper 可改调 verifyCandidateManifest 生成真实输出。

---

## ⑧ 残余与 NOT_RUN(如实)

**已登记残余(合同明示,非缺陷)**:runs 行无绑定记录(旧格式/测试桩/行不存在)⇒ 2.45 校验跳过,由既有双门与工作区边界把关(用例 R2-D3 锁定该行为;探针 c3b 佐证)。
**既有登记不变**:M-4 完整 handback/STOPPED 交付工具化恢复/ControlCommand 审计结构化收敛/生产部署配置包、上一包 Minor-2/3/5,均不属本包。

**NOT_RUN / 未验证(Reviewer 侧)**:
- 真实模型 Run 与 pi-e2e(模型门控 skipIf,零模型约束;本包对 pi-e2e 的适配仅经静态审读+实现者 targeted 记录,未运行)。
- exact-head CI 与 main-only 快进推送(裁决时尚未推送——本地 ahead 3 提交;属裁决后收口步骤,由 Writer 按合同执行)。
- quality:full/release 未由 Reviewer 重跑(按边界仅核对已入库证据,存在且 PASS);CURRENT.md/docs/CONTINUATION.md 收口更新属裁决后步骤,尚未发生(实施提交不含,符合合同顺序)。
- 生产 worker/web 未重启(合同禁止;线上行为以重启为界)。

**Reviewer 写入面声明**:本次审查仅创建本报告文件;未修改任何源码/测试/文档;探针脚本置于 /tmp(未入库);亲跑 quality:quick 产生的证据目录位于 git-ignored 的 test-evidence/(不入库);git push/commit/分支/强推均未发生。

---

## 附:Reviewer 运行的关键命令与退出码清单

| # | 命令 | 退出码 | 结果摘要 |
| --- | --- | --- | --- |
| 1 | `git status && git log --oneline -5 && git rev-parse HEAD` | 0 | main=a9d78be;未跟踪仅 config/、p0-mvp/soak-r3b/ |
| 2 | `git diff 96db097..a9d78be`(含 --stat 与逐文件) | 0 | 10 文件;无 migrations;范围核对通过 |
| 3 | `git show 5138094:p0-mvp/gate-integrity-04a/evidence/counterexample-r2.log` | 0 | 修复前红态实证(C record ok=true+ACCEPTED;D ACCEPTED 且外来目录执行) |
| 4 | `git diff 5138094..a9d78be -- …counterexample-r2.log` | 0(空 diff) | 入库反例日志未改写 |
| 5 | `npx tsx p0-mvp/gate-integrity-04a/evidence/counterexample-r2.mts` | 0 | C=record 拒 integrity_evidence_missing 停 VERIFYING;D=workspace_provenance_mismatch 零检查;两组 defect-verdict 均不成立 |
| 6 | `npx tsx /tmp/r2-reviewer-probe.mts`(独立探针 a-d,10 组) | 0 | 10/10 PASS(a1/a2/a3/b/c1-match/c2-mismatch/c3a/c3b/d1/d2) |
| 7 | `npx vitest run test/integration/gate-integrity-dual.test.ts test/integration/gate-binding.test.ts test/integration/gate-machine-evidence.test.ts test/integration/delivery-stop.test.ts test/integration/verify-lease.test.ts test/integration/goal-loop.test.ts test/integration/backup-restore.test.ts` | 0 | 44 passed + 1 skipped(backup-restore 门控) |
| 8 | `RELAY_BACKUP_E2E=1 npx vitest run test/integration/backup-restore.test.ts` | 0 | 1 passed(补齐第 7 文件覆盖) |
| 9 | `npx vitest run test/integration/run-lifecycle.test.ts test/integration/gate-orchestrator.test.ts` | 0 | 12 passed(额外回归) |
| 10 | `npx vitest run test/integration/goal-message-authorization.test.ts test/integration/heartbeat-leased-chain.test.ts` | 0 | 18 passed(方案 A/租约链额外回归) |
| 11 | `npm run quality:quick` | 0 | PASS(105/105;lint/format/typecheck/unit) |
| 12 | `node -e "require('…evidence.json')"` ×3(quick/full/release 2026-11-13T22-*) | 0 | 三级 verdict=PASS;release releaseReadiness=READY;sha=5138094+gitDirty=true(Minor-R2-1) |
| 13 | grep:recordGateVerdict/consumeGateVerdict、UPDATE runs SET、INSERT INTO runs、recordChangeset、workspaceDir(worker/goal-loop/runner) | 0 | ⑥ 旁路排查全部结论的检索依据 |

(探针与重放均于隔离 p01a_ schema 执行并自动清理;零模型调用、零真实远端写入、零生产触碰。)
