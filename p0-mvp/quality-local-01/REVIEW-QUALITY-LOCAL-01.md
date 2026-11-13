# RELAY-QUALITY-LOCAL-01 独立复核报告（阶段 G）

Reviewer：隔离上下文独立 Agent（全新会话，与实现窗口无共享推理）
复核方式：全 diff 逐行 + 调用面 grep + 只读实验（tsc/biome 实跑）+ 证据文件比对；未运行 vitest 全量（避免与后台 release 相互干扰），类型/格式/Lint 独立实跑验证。
复核基线：工作区未提交改动（14 tracked modified + biome.jsonc / scripts/quality.mjs / gate-machine-evidence.test.ts / p0-mvp/quality-local-01/）。

## 逐项结论

| 项 | 结论 | 关键证据 |
| --- | --- | --- |
| A 功能正确性（D1-D7） | PASS | record/consume 双侧同规则（gates.ts:23-26/120-122/281-286）；唯一 ACCEPTED 路径封闭（GATED_TRANSITIONS 仅 VERIFYING->ACCEPTED + countGatePass 次级锁）；绕过面封闭（recordGateVerdict 独立重查 changeset，无 null 逃逸）；isDocsOnlyChanges 确定性；证据绑定未动；零新表/零第二系统 |
| B 权限边界 | PASS | 无新权限/凭据/网络面；config/ 与 soak-r3b/ 零触碰 |
| C 过度设计 | PASS | 三级预检为最小实现；worker 只算不落库、orchestrator 单点落库；Minor：两段 NEEDS_DECISION ~60 行可提 helper |
| D 证据真实性 | PASS | 反例日志逐字节一致、时间线自洽；release 证据与宣称逐字一致；独立实跑 tsc/biome 全过；Minor：证据路径表述、测试注释、脏树 SHA 失真 |
| E 空证据/虚假测试误放行 | PASS | 攻击者走查三条路均封闭；注记：生产默认机器证据=候选清单完整性复验（弱于功能测试），为 CURRENT D1 授权内显式下限且已如实登记 |
| F 原有成功路径 | PASS | 生产链经 manifestVerify 兜底照常 ACCEPTED；cli.test 未改而通过；夹具变更语义未掩盖 |
| G 回滚 | PASS | 单提交原子回滚；无 schema 变更；回滚即回到 reviewer-only 语义（已声明） |
| H 测试资源成本 | PASS | 顺序 fail-fast、PG 复用、release 实测约 6.5 分钟；Minor：模型门 env 未剥离 |

## Major（必须修复）

**M-1** quality.mjs `changedFiles()` 与 biome.jsonc `files.includes` 不相交 ⇒ 干净树上 quality:quick/full 确定性假 FAILED（Reviewer 亲测：`npx biome format config/projects.json` → "No files were processed" exit=1）。修复方向：按 includes 根过滤 + 显式排除 config/**、p0-mvp/**、p0-*/**；或 "No files were processed" 归 NOT_RUN。

## Minor（择期）

m-1 模型门 env 未剥离（C9 加固）；m-2 evidence.json 应记 dirty 标志；m-3 测试注释"见 git 历史"改为指向入库日志；m-4 REPORT 证据路径统一；m-5 NEEDS_DECISION 块去重；m-6 mv 证据补入 evidenceSummaries。

## 提交纪律警告

复核期间后台 release 复跑再生 45 个 tracked 证据文件（p0-02c/*、webux 截图等）——不得混入实现提交（已按既有纪律 restore 处置，提交须逐文件点名）。

## 最终裁决

**REWORK（范围收窄）**：阶段 D Gate 机器证据修复本体语义正确、证据真实、测试充分，可达 PASS；唯一阻断项 M-1。修复 M-1 + 消化 m-3/m-4 后，无需重开全项复核，仅验 quality:quick 在干净树通过即可转 PASS。

## 消化记录（实现侧，同日）

- M-1：changedFiles() 改为按 includes 根（src/web/test/scripts/bin + biome.jsonc）过滤，显式排除 config/** 与 p0-*/**；空集 ⇒ format NOT_RUN（no_changed_files）。干净树模拟验证通过。
- m-1：quality.mjs 子进程 env 显式 delete RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E/RELAY_E2E/RELAY_BACKUP_E2E（release 的 backup 步骤除外，由步骤参数显式传入）。
- m-2：evidence.json 增 gitDirty 标志。
- m-3：测试注释改为指向 p0-mvp/quality-local-01/evidence/counterexample-prefix-run.log。
- m-4：REPORT 证据路径统一为入库路径。
- m-5：orchestrator 两段 NEEDS_DECISION 合并为带 reason/question 参数的单一 helper。
- m-6：mv 证据行同步加入 evidenceSummaries。
- 复验：typecheck 绿；quality:quick（含变更文件）PASS；干净树 changedFiles 模拟=空 ⇒ NOT_RUN 语义正确；gate-machine-evidence 7/7 复跑绿。

## 第二轮复验（REWORK 消化后，同日）

- M-1 实证关闭：修复后内联模拟 config/projects.json 与根级 package.json/package-lock.json 均不在变更集；干净树模拟=空集 ⇒ format NOT_RUN；`npx biome format <13 项 in-scope>` exit 0 与 changedFiles() 输出完全一致；修复后 quality:quick 证据 PASS。
- m-1~m-6 全部消化确认（childEnv 九变量剥离、gitDirty 标志、注释/路径修正、conservativeStop 语义等价逐行核对、mv 证据入 summaries）。
- Reviewer 独立实跑：tsc exit 0；biome lint 0 error/93 warn+3 info 零漂移；format 13 文件 0 差异；45 个再生证据文件确认已 restore。
- 残留登记（不阻断）：r-1=37/37 为实施方自述，权威口径=exact-head CI；r-2=push 仅删 in-scope 文件时 format 会响亮失败（两版共有，非本轮引入，择期）。
- **最终裁决：PASS**（条件：①逐文件点名提交不混再生证据；②exact-head CI 双 job 绿为权威终验；③按真实 SHA 收口）。
