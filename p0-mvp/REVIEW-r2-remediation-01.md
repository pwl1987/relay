# REVIEW-R2-REMEDIATION-01:独立复核报告(模型输出上限硬编码修复 + 两次真实模型复验)

- 复核人:独立 Reviewer(全新上下文,只读复核;本文件为唯一写入产物,系复核指令要求)
- 复核时间:2026-11-13(网络劣化窗口;live GitHub API 不可达,如实记录)
- 复核对象:实现 `6d3eddb` + F2-R/F1-R 两次正式尝试(`0ecee26`/`67c89f2`);核验区间 `c97e9c4..67c89f2`
- 本地 HEAD:`67c89f2`;`origin/main` 已同步至 `67c89f2`(推送属实);CI 43274670524=success 系协调者转述,独立核验失败(gh api → `Forwarding failure`,与上游 502 同签名)
- 工作区状态:`CURRENT.md`、`p0-mvp/DEPLOY-03D-report.md` 有未提交修改 + 未跟踪 `config/`、`p0-mvp/soak-r3b/`——均属主写者后续工作(AUTOLOOP-REFERENCE-00 进行中),不在本包 diff 目标内,如实记录

## 结论:**PASS-WITH-FINDINGS**

工程 REMEDIATION(硬编码移除→运行时配置项)实现与证据全部核验通过;两次真实模型尝试失败的归因(上游 502 硬故障)由网关账本铁证支撑,成立。发现 2 项 Minor(措辞过度声明 + 证据自足性),不构成 REWORK。

## 一、逐项核验(亲测)

### 1. ADR 与报告
- `ADR/0011-max-output-tokens.md`:决策六条(配置项/默认 8192/上下界/fail-closed/Evidence 记录/Budget 独立)与实现一致;状态 ACCEPTED,合同来源=用户指令 2026-11-13。
- `p0-mvp/r2-remediation/REPORT-r2-remediation.md`:结构完整,含 F2-R/F1-R 失败归因、账本对账偏差、对照结论与未验证项(§5 明确"真实模型端到端能力对照不可判定""生产 32768 采值待新授权")。

### 2. 实现与提交
- `6d3eddb --stat`:12 文件 +214/-13,全部与本包合同相关(ADR/docs/6 源文件/2 夹具/1 单测)。
- `git diff c97e9c4..67c89f2 -- src/runtime/sandbox.ts src/runtime/runner.ts src/runtime/reviewer.ts src/runtime/discovery.ts src/server/worker.ts src/worker-entry.ts`:与报告声明逐条吻合。区间内另有 `src/server/app.ts` CSP `manifest-src 'self'` 1 行改动——归属 DEPLOY-03D 包(`ede154f`),非本包。

### 3. Pi contract(亲验,pi-coding-agent 1.5.0)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:75`:`maxTokens: override.maxTokens ?? model.maxTokens`
- 同文件 `:94-95`:`definition.maxTokens <= 0` → 抛 `invalid maxTokens`;`:110`:缺省 `16384`
- 写入点:`src/runtime/sandbox.ts:160` `maxTokens: appliedMaxOutputTokens(model)`(models.json providers 条目);复用 Pi 现成字段,未改 Pi Runtime,未新造配置。✔

### 4. 自动验证(亲跑)
- `npm run typecheck` → 绿(tsc --noEmit 零输出)。
- `npx vitest run test/unit/max-output-tokens.test.ts` → **7/7 通过**(28ms):默认值/透传/上下界/超界 fail-closed(9 组非法输入)/models.json 实读断言(:60-62 默认 8192、配置 32768、上界 128000)/prepareRunDirs 拒半配置(:65-69)/常量与 contextWindow 一致(:71-74)。

### 5. fail-closed 三链路(代码 + node 直跑亲测)
- **worker tick 路径**:`src/server/worker.ts:79-89` envModel 对非法 `RELAY_MAX_OUTPUT_TOKENS` 抛错;调用点 `src/server/worker.ts:127` 在 tick 最前、`goalLoopTick` 领取之前 ⇒ 抛错即本拍不领取;tick 异常由 `src/core/loop-safety.ts:41-52` 计数并审计,连续 ≥3 熔断(`:53-56`)。
- **worker-entry 启动路径**:`src/worker-entry.ts:47` 启动横幅前同步调用 `resolveMaxOutputTokens`,非法即抛 ⇒ 进程不启动。
- **Run 构造路径**:`src/runtime/sandbox.ts:60-67` 超界抛错 → `prepareRunDirs` 构造即拒。
- **node 直跑实测**(Node v24.21.0,strip-types):默认 applied=8192;配置 32768=32768;`999999`/`'abc'`/`1023` 均抛 `invalid maxOutputTokens:...(fail-closed 不启动)`;`''`/undefined=null→undefined;`prepareRunDirs('/tmp','host-fallback',{maxOutputTokens:999999})` 实测抛错。✔

### 6. Evidence 记录三处(additive)
- coder:`src/runtime/runner.ts:108-109`;discovery:`src/runtime/discovery.ts:238-239`;reviewer:`src/runtime/reviewer.ts:137-138`——均记 `maxOutputTokens` + `maxOutputTokensSource: "default"|"config"`,且仅增列 runs.budget jsonb,无逻辑变更(reviewer.ts 全量 diff 复核=纯增列)。
- `test/integration/run-lifecycle.test.ts:135` wallSeconds 断言原样保留,additive 未破坏。✔

### 7. 两次尝试证据链(亲验对账)
- **网关账本** `p0-mvp/r2-remediation/magpie-usage-evidence-20261113.jsonl` 共 17 条:
  - 行 1-8(route_id …75385-75392)= F2-R 窗口 01:26:02~01:27:53,**8 次 status=502** `proxyconnect tcp: 503 Forwarding failure`,`in=0/out=0` ✔
  - 行 9-13(…75393-75397)= 生产冒烟 01:45:03~01:45:40,**5 次 status=200**,in/out 真实非零(stop=tool_use)✔
  - 行 14-17(…75398-75401)= F1-R 窗口 01:50:40~01:51:32,**4 次 status=502**,`in=0/out=0` ✔
  - 合计 12×502 + 5×200,与报告 §3/§4/§5 及提交信息数字逐条一致。
- **运行日志**:`f2r-run-20261113.log`(Start 01:25:57,失败用例 116964ms≈117s,gate.reason=no_verdict:no_gate_verdict_fence);`f1r-run-20261113.log`(Start 01:50:38,63s,discovery 断言失败于 `f1-ux-journey.test.ts:155`)——与报告执行时间/时长/失败点一致。
- **F1 证据**:`test-evidence/f1/discovery.json` = `{ok:false, reason:"no_report:no_discovery_fence"}` ✔
- **F2 证据**:`test-evidence/f2/runs-detail.json`:coder run(run-f3bd40ca,SUCCEEDED)`detail.budget={tokensIn:20000,tokensOut:4000,actualCalls:4}` = 预留记账(4 调用×预留额度);reviewer run(run-5bece912,FAILED)reason=no_verdict。**对账偏差如实**:同窗口网关 8×502 零 token,与 ledger 20000/4000 矛盾——报告 §3"账本对账偏差(如实)"如实落账 ✔
- **reviewer 铁证**:`test-evidence/f2/gate-evidence.json` reviewer_output raw_output 含 3 次重试,全部 `stopReason:"error"`、`usage` 全零、errorMessage=proxyconnect 503 ✔(与报告"auto_retry×3 全败"一致)
- **无重跑证据**:账本仅各一个 F2-R/F1-R 请求窗口;每尝试各一份日志;与合同"失败不得自动重跑、两次授权尝试已消耗"一致 ✔

### 8. 合同符合性
- **唯一实验变量**:F1/F2 夹具 diff(`test/integration/f1-ux-journey.test.ts`、`f2-bug-fix.test.ts`)仅为 ①envModel 增加 RELAY_MAX_OUTPUT_TOKENS 透传+fail-closed(与 worker.ts 同构)②证据查询增列 `budget` 列;预算/wall/Fixture/Gate/Reviewer 条件零改动 ✔
- **无 MODEL-POLICY-01 实施**:`grep -rn "RunModelDecision" src/` 零命中;仅 `src/server/views/models-usage.ts:106` 观察性注记(冻结状态说明)✔
- **Budget/Reviewer/Gate 代码路径未触碰**:区间内 `src/core/budget.ts`、gate 相关文件零 diff;reviewer.ts 仅 budget jsonb 增列 ✔
- **续接记录**:`docs/CONTINUATION.md`(67c89f2 已更新 R-2 注记与大包排期);`CURRENT.md` 大包状态行(②R2-REMEDIATION-01 ✅工程/⏸能力对照)在工作区未提交版本中(主写者后续提交流,如实记录)。

## 二、特别审查点判定

### 1. 默认 8192 是否构成"另一个硬编码"?——**否,判定满足合同**
合同要求"不把 8192→128000 改成另一个硬编码;有默认值/上下界/可指定/透传/记录/fail-closed"。实现:值 8192 不再出现在写入点(sandbox.ts:160 为 `appliedMaxOutputTokens(model)`),而是具名导出常量 `DEFAULT_MAX_OUTPUT_TOKENS`(sandbox.ts:54,显式可测);配置可从 Worker env(worker.ts:85-89)与 ModelConfig 字段两层指定;上下界 1024~128000 强制(sandbox.ts:56-57);最终采用值+来源入 runs.budget(runner/discovery/reviewer 三处);超界 fail-closed。单测 :42-46 显式断言"不再散落硬编码"。默认值选择 8192 属行为兼容决策(ADR-0011 决策 2),与合同"不做二次硬编码替换"的语义一致——**这是一个带配置覆盖的命名默认值,不是硬编码**。

### 2. 生产采值决策(生产仍默认 8192)是否合理?——**合理**
- 本包授权仅覆盖两次复验尝试(唯一实验变量 32768);生产采值切换属新决策,待授权符合单写者/写入授权治理(AGENTS.md 规则 4)。
- 32768 本身合法(在 1024~128000 界内,低于 contextWindow 128000),切换是纯 env 配置(`RELAY_MAX_OUTPUT_TOKENS=32768`),无代码变更,风险低且可回滚——延后决策的成本仅是生产继续受 8192 钳制,而生产该钳制的存在已被如实记录(CURRENT.md/DEPLOY-03D 冒烟 Goal#1 复现历史 F2 签名)。

### 3. 归因是否成立?——**成立,证据等级高**
- 网关账本(第三方侧记录)12 次 502 全部 `proxyconnect tcp: 503 Forwarding failure (Privoxy@localhost)`、in=0/out=0 ⇒ 零补全送达,能力对照必然不可判定——归因"基础设施阻断非代码阻断"与数据一致。
- 时间线自洽:01:26 F2-R 全 502 → 01:45 生产冒烟 5×200(真实 token 流动,证明上游短暂恢复)→ 01:50 F1-R 全 502(再次断)。F1-R 的"上游选择依据"(01:44~01:46 全 200 判窗口可用)有账本行 9-13 直接支撑;01:50 起再断非执行方过错。
- 归因修正过程诚实:初版(0ecee26)"magpie 方差"归因在 67c89f2 依账本修正为"上游 502 硬故障",修正本身在报告 §3 留痕。
- 无相反证据:两次尝试期间无任何一次 200(两次窗口内),不存在"部分成功但被掩盖"的可能。

## 三、发现

### Major:无

### Minor
- **F-1(报告措辞过度声明)**:REPORT §3 称"已补——F1/F2 夹具证据查询增列 budget,**F1-R 起运行时采用值入证**"。实际:F1-R 测试在 discovery 首步即断(`f1-ux-journey.test.ts:155`),`runs-detail` 证据导出(约 :221-226)从未执行;`test-evidence/f1/` 无 runs-detail.json,discovery.json 亦不含 budget——**F1-R 的 maxOutputTokens=32768 运行时采用值实际未入证**(runs.budget 随临时测试库消亡)。夹具能力确已补齐(代码 diff 在案),但"起…入证"的表述超出 F1-R 实际证据。透传正确性仍由单测 7/7(models.json 实读)与同构 envModel 代码路径充分支撑,故降为 Minor。建议:后续报告将此句改为"入证能力已补;F1-R 因 discovery 首步即断,运行时采用值仍未捕获"。
- **F-2(证据导出自足性)**:F1/F2 夹具 runs-detail 导出列仍缺 `runtime`/`model_ref`(`test-evidence/f2/runs-detail.json` 中两者为 null)——合同落证清单含 model_ref;目前 model_ref 由网关账本(`req":"zcode/GLM-5.3"`)与夹具 env 间接落证,不构成违反,但导出自足性有缺口。建议:下轮复验导出增列这两列。

### 观察(不计发现)
- F2-R 窗口账本 8 次请求 vs coder 4 调用+reviewer 3 重试=7 次,1 次差额报告未逐笔解释(报告未做按角色分解,数字声明"8 次"与账本一致,不构成不一致)。
- 区间内非本包改动:app.ts CSP 1 行(DEPLOY-03D)、web/* 与 webux 测试(03D)、DEPLOY-03D 报告——已按提交归属区分,不影响本包判定。
- CI 43274670524=success 系转述;复核窗口内 GitHub API 实测不可达(`Forwarding failure`,与上游 502 同签名),按 AGENTS.md 规则 1/6 如实记录为未独立验证项。

## 四、未验证项(如实)
1. **真实模型端到端能力对照(8192 vs 32768)未完成**——两次授权尝试均被上游 502 硬故障否决(网关账本 12 条铁证),合同禁止重跑;UNRESOLVED(基础设施阻断)。
2. **生产 worker 32768 采值未切换、未验证**——生产仍默认 8192,切换待上游稳定窗口新授权。
3. CI 43274670524=success 未独立核验(网络劣化,gh api Forwarding failure);仅本地确认 `origin/main`=67c89f2。
4. F1-R/F2-R 运行时 maxOutputTokens=32768 的 runs.budget jsonb 实际值未入证(F2-R 缺口报告已认;F1-R 见 Minor F-1);透传正确性以单测 models.json 实读为准。

## 五、判定依据小结
实现 6/6 项亲测通过(typecheck/单测/Pi contract/三链 fail-closed/Evidence 三处/账本对账);两次尝试归因链完整且数字逐条吻合;合同红线(无重跑/唯一变量/无 MODEL-POLICY-01/Budget·Gate 未触碰)全部遵守。2 项 Minor 均属报告措辞与证据导出自足性,不影响工程结论与安全边界 ⇒ **PASS-WITH-FINDINGS**。
