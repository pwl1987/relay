# RELAY-GATE-INTEGRITY-04A-R2 最终报告

裁决:**PASS**(独立 Reviewer 隔离上下文一轮:0 Major + 4 Minor,全部登记不阻断;反例重放与 10 组独立探针由 Reviewer 亲测)

日期:2026-11-14
合同:96db097(CURRENT.md「RELAY-GATE-INTEGRITY-04A-R2」ACTIVE 登记;开工冷启动 live main=origin=本地 bd53f9a,CI 43488654679@bd53f9a 双 job success)

## 1. 基线与 Writer

- 开工冷启动:live main = origin = 本地 `bd53f9a409fa4c03cd311094bef64112ba2034f9` 一致(gh run list 亲测双绿);上一包 04A 六提交链已全部在 origin,**无未推提交**(用户指令"优先快进推送 04A 合同及反例"已在上一窗口完成,如实记录未做空推送);未跟踪受保护 `config/`、`p0-mvp/soak-r3b/` 全程零触碰;Writer=本窗口唯一,main-only 快进,零生产重启/零模型调用/零真实远端写入。
- 提交链:`96db097(合同)→ 5138094(反例留证,对未修复 bd53f9a 实测 C/D 两组)→ a9d78be(实施,8 文件 +494/-76)→ c0ea65b(Reviewer PASS 入库)→ 本报告 → 收口提交`。

## 2. 反例留证(修复前,对 bd53f9a 实测;evidence/counterexample-r2.log)

| # | 反例 | 修复前实测结果 |
| --- | --- | --- |
| C | 绕过编排直录 Gate:recordGateVerdict(PASS,代码变更候选,仅功能性证据)+ consumeGateVerdict | **成立**:record ok=true(权威边界只强制功能性证据,不要求完整性)+ consume ⇒ **ACCEPTED**,任务证据中 candidate_manifest_verify 行数=0 —— 完整性缺失不得 ACCEPTED 的语义在 record/consume 边界不成立 |
| D | "/tmp" 非本 Run 工作区挂载:外来 /tmp 目录(内容与候选完全相同)跑完整编排 | **成立**:既有层全部放行(validateCheckWorkspace ok=true 属 tmpdir 范围 + verifyCandidateManifest ok=true 内容哈希一致[完整性只绑定内容不绑定归属])+ 编排 **ACCEPTED**,检查在外来目录真实执行,本 Run 工作区全程未使用 —— runs 行不持久化工作区路径,workspaceDir 与 Run 无归属绑定 |

- 与反例 B(04A,缺工作区回退 process.cwd(),已修复)的关系:D 为**独立残余** —— 本次是显式提供了**错误归属**的工作区,既有层全部放行。

## 3. 交付内容

### Fix 1:Gate 直录完整性硬规则(src/core/gates.ts,record/consume 双侧)

- **record 侧**:代码变更候选(candidateSha≠null 且非 docs-only)的 PASS 必须引用 ≥1 条 `candidate_manifest_verify` 完整性证据,缺失 ⇒ `integrity_evidence_missing`;与既有 `functional_evidence_missing` 同构同位(同一豁免条件、同一规则块),功能性规则先于完整性规则(既有反例"仅 reviewer_output/仅 manifest"拒绝原因不变)。
- **consume 侧**:同规则复验 —— 直录旧格式 PASS 行(evidence_ids 仅功能性)在消费侧同样拒绝 + `GATE_CONSUME_REJECTED` 审计(防绕过编排直录;gates.ts 消费侧既有"防直录旧格式"设计意图的完整性延伸)。
- 豁免精确(Reviewer 探针证实):docs-only 变更与 candidateSha=null 纯分析不受影响;零证据仍被 evidence_missing 先行拦截。
- 语义闭环:功能测试不能代替完整性验证,反之亦然 —— 编排层双门(04A)+ record/consume 双侧硬规则(本包)= 三重权威闸,无第二 Gate/规则引擎/质量数据库。

### Fix 2:工作区归属绑定(src/runtime/runner.ts + src/core/gate-orchestrator.ts)

- **持久化**:insertRun 在 runs.detail 写入 `workspace_dir`(宿主路径);updateRun 改 `COALESCE(detail,'{}'::jsonb) || 新detail` **合并语义** —— 调用方键优先,workspace_dir 绑定键不覆盖(无迁移加列)。
- **编排层 2.45 校验**(位于 2.5 机器证据预检/2.6 双门/3 证据采集/Reviewer **之前**):input.workspaceDir 已提供且 coderRun 行(且 task_id 匹配)记录了 workspace_dir ⇒ 不一致即 FAIL-CLOSED `workspace_provenance_mismatch` 保守停机(VERIFYING→NEEDS_DECISION + D3 决策行 + 终止租约 + `GATE_WORKSPACE_PROVENANCE_MISMATCH` 审计);**零检查/零复验/零 Reviewer**。字符串变体(尾斜杠/"/.")同被拦截(失配即停,不猜测路径等价;Reviewer 探针证实)。
- **三态语义**:mismatch⇒拦截;match⇒照常(生产 LiveWorker 传入的 result.sandboxSpec.workspaceDir 与 insertRun 记录同源,恒 match,不误伤);runs 行无 workspace_dir 键(旧格式行/测试桩)⇒ 校验跳过、由既有双门与工作区边界把关 —— **登记残留,不虚构拦截**(用例 R2-D3 锁定该行为;缓解面=changeset 仅由 runner.ts 产出,生产 coder run 行恒有绑定,Reviewer 旁路排查证实)。
- 归属绑定的必要性证明(反例 D):内容级完整性复验(verifyCandidateManifest)只绑定内容哈希 —— 内容相同的外来目录语义上"验证通过",但生产语义要求检查/复验/交付绑定本 Run 工作区(prepareRunDirs 为每 Run 独立创建);归属绑定补上该缺失维度。

## 4. 测试(反例先行:红→绿)

- 新增 3 用例(test/integration/gate-integrity-dual.test.ts):**R2-C**(直录 PASS 仅功能证据 ⇒ record/consume 双侧拒绝 integrity_evidence_missing + 补齐完整性证据后同一绑定照常放行的对照)、**R2-D**(外来 /tmp 目录 ⇒ workspace_provenance_mismatch + 检查/Reviewer 零执行 + 审计行)、**R2-D3**(无绑定记录 ⇒ 归属校验跳过,既有双门照常,登记残留)。修复前 C/D 红(失败模式与反例一一对应)、D3 绿;修复后 11/11 绿。
- 适配(语义=直录辅助与生产编排同构):gate-helper recordBoundGate 对 candidateSha≠null 的 PASS 自动补播 candidate_manifest_verify 证据行(delivery/github-real/run-lifecycle/v08 等直录受益);gate-binding setupVerifying 预置完整性证据行 + 4 个 PASS 站点补引用(拒绝类站点语义不变);pi-e2e 对真实 docker 工作区执行生产同源 verifyCandidateManifest 并落证据后 PASS。
- 定向:16 个测试文件 101 用例全绿(gate-integrity-dual 11/gate-binding 5/gate-machine-evidence 10/delivery-stop 10/delivery 系列/gate-orchestrator/gate-e2e/task-abort/verify-lease/v08/v04/run-lifecycle/changesets/goal-loop/backup-restore/check-sandbox-isolation 17[真实 docker])。
- 修复后反例复验:evidence/counterexample-r2-reverify-after-fix.log —— C=record 拒 integrity_evidence_missing(任务停 VERIFYING)、D=workspace_provenance_mismatch(检查零执行),defect-verdict 双双不成立。(复验日志尾部"对未修复代码 bd53f9a"为脚本静态文案;按 Minor-4 纪律反例脚本为修复前证据不改写,复验另存日志,以 defect-verdict 行为准。)

## 5. 独立 Reviewer(隔离上下文,一轮)

- **裁决 PASS(0 Major + 4 Minor)**;报告=p0-mvp/gate-integrity-04a/REVIEW-GATE-INTEGRITY-04A-R2.md(Reviewer 亲写入库,c0ea65b)。
- 反例重放(Reviewer 亲测):C/D defect-verdict 双不成立,与 5138094 修复前红态留证形成红→绿闭环。
- 独立探针 10 组全过:record 侧豁免精确(candidateSha=null/docs-only 不误伤、零证据仍 evidence_missing)/consume 旧格式行拒+审计/归属绑定三态/尾斜杠与 "/." 反射变体拦截;指定 7 测试文件 45 用例 + 回归 4 文件 30 用例全绿 + 亲跑 quality:quick PASS。
- 旁路排查:record/consume 生产调用方仅 gate-orchestrator;reviewer/discovery 的 runs.detail 更新只作用自身 run 行,不可能覆盖 coder 行(changeset 仅 runner.ts 产出 ⇒ changeset.runId 恒为 coder run);2.45 先于一切检查/Reviewer;LiveWorker 与 insertRun 的 workspaceDir 同源;无第二 Gate/规则引擎/质量数据库/无迁移。
- Minor 消化:**Minor-R2-1**(三级质量证据绑定运行时快照 5138094[dirty tree]非最终 SHA —— 本报告与收口提交后的最终 HEAD 重跑 quality:quick 绑定证据,full/release 证据经 Reviewer 核对 evidence.json PASS,exact-head CI 双作业为最终 SHA 的权威验证)、**Minor-R2-2**(runs 行无键/行缺失 ⇒ 绑定跳过 = 合同登记残留,生产唯一 changeset 写入方缓解)、**Minor-R2-3**(反例脚本静态尾部文案易误读,Minor-4 纪律权衡)、**Minor-R2-4**(gate-helper 合成 manifest 证据为绑定形态同构而非真实复验,测试辅助面)—— 均登记不阻断。

## 6. 测试与质量证据

- `quality:quick` PASS(lint+typecheck+unit 105/105);`quality:full` PASS(单测+真 PG 集成+容器安全门+浏览器旅程全绿);`quality:release` PASS(**READY**,备份→隔离实例恢复 13 表全实体核对一致;性能/模型门禁/真实部署按 NOT_RUN 登记不虚构)。证据目录=test-evidence/quality-*-2026-11-13T22-*/(evidence.json 经 Reviewer 核对);最终 HEAD 复跑 quick 证据见收口提交记录。

## 7. 生产影响、回滚与登记

- **生产影响**:worker/web 未重启 ⇒ 线上行为不变;重启后:①直录/编排所有路径对代码变更候选 PASS 强制完整性证据(生产编排恒提供,无行为变化;仅堵直录旁路)②Gate 编排校验工作区归属 —— 生产 LiveWorker 传入本 Run 工作区恒 match,无行为变化;仅错误归属(测试桩/异常调用方)被拦截保守停机 ③runs.detail 新增 workspace_dir 键(jsonb,无迁移)。
- **回滚**:`git revert c0ea65b a9d78be`(无迁移;回退恢复旧语义 —— 不建议,保留修复)。
- **登记后续**:上一包既有登记不变(M-4 完整 handback/STOPPED 工具化恢复/ControlCommand 审计结构化收敛/生产部署配置包需独立授权);本包 Minor-R2-1/R2-2/R2-3/R2-4 登记不实施;完整性证据硬规则未来若需"三态复验/检查后归属重核"属架构扩展,不在本包。
- 生产部署准入:上一包 04A 报告结论不变 —— 通过后下一阶段才安排生产部署配置与验收(本包不含部署动作)。

## 8. NOT_RUN/未验证(如实)

- exact-head CI 与推送:属裁决后收口步骤,结果以 CURRENT.md 收口块与 gh run view 亲测记录为准(本报告提交时尚未运行,不虚构)。
- 真实模型 Run / pi-e2e 模型调用(零模型约束;全部检查/Reviewer 为受控桩)。
- 真实 GitHub 远端写入(合同禁止;隔离 bare 仓库/桩覆盖)。
- 生产重启与生产部署验证(未触碰;生产 worker/web 未重启,线上行为不变)。
- Reviewer 未重跑 quality:full/release(核对实现者证据目录 evidence.json;fast 证据链=三级全 PASS + Reviewer 亲测 quick)。
