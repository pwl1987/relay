# R-2 对照实验包 独立复核记录

- 复核对象:提交 2018c2a(纯证据再生)+ 7ddae1e(报告+归因+治理同步);复核时 HEAD=7ddae1e。
- 复核人:**独立 Reviewer(全新上下文 subagent,与实施者无共享记忆;只读亲测)**;复核时间:2026-11-12 11:1x~11:2x+0800。
- 复核方法:对 routing-window 全量重算聚合(未轻信报告数字)、权威路由日志(~/.config/magpie/routing/2026-11-12.jsonl 全天 105 行)窗口外零 pi 调用取证"零重跑"、git diff adb713b..HEAD 取证边界、泄密 grep 扫描、sandbox.ts/pi model-runtime.js 消费链代码核对、/v1/models 只读探测。

## 裁决:**PASS-WITH-FINDINGS(零 Major,3 Minor,已全部消化)**

### 核验项清单(6/6 PASS)

1. **证据与报告一致性 PASS**:聚合独立重算逐位吻合(F2 in=20475/out=7984/147.2s;F1 in=17618/out=10395);交叉对账(F2 前 6 行 out=7240==记账,F1 56+8192=8248==记账);F2 6/6 budget_turns_cap、gate=null;F1 coder 2 调用/changeset 全空/baseSha==candidateSha、机判 1/4(C4 过)、Reviewer BLOCK 原文一致;权威日志行 93-99=F2、100-105=F1 逐字段一致,**窗口外零 pi 调用⇒"一次正式尝试×2、零重跑"独立证实**;check.mjs 确用 playwright chromium;归档件与 test-evidence 原件字节一致。
2. **8192 根因指认 PASS**:sandbox.ts:131 硬编码(全仓唯一);模型 max_output=128000 实测;pi model-runtime.js:508-509 以 route.model.maxTokens 做 Math.min 钳制、openai-completions 映射为 max_tokens 且 thinking 预算以其为天花板——消费链闭合;边界旁证(F2 主回合 5995<8192 未触顶)。Reviewer 注记:网关日志不记录出站 max_tokens,"请求级截断"为 out==上限精确值+代码路径+模型上限三点的强推断,非日志直证——推断成立,性质如实知悉。
3. **边界合规 PASS**:adb713b..HEAD 仅触及 CURRENT.md/docs/CONTINUATION.md/p0-mvp/r2-contrast/**;test/、src/ 零修改;soak 两文件 skip-worktree 完好;提交切分与描述一致。
4. **泄密扫描 PASS**:全包唯一命中为夹具 HTML "task-list" 误报;RELAY_PI_API_KEY 仅占位词;路由 order[] 仅套餐名等非敏感字段。
5. **裁决正确性 PASS**:ADR-0010 定案矩阵下双败⇒PARTIAL+归因为唯一诚实裁决;记账差异主动披露非掩盖;无任何 VERIFIED 升级表述。
6. **预算边界 PASS**:F2=6/4/10/420、F1=6/12/4/30/600 实测代码与授权逐项一致,测试文件零修改。

### 发现与消化(全部在修复提交中闭环)

- **Minor-1**(F2 stub 证据未入归档包)→ 已补入 `p0-mvp/r2-contrast/f2-run1/`(stub-final-check.json + stub-tick-summary.json),报告 §三.5 注记;
- **Minor-2**(wall 数值未随 evidence 落盘)→ 报告 §三.4 披露来源与网关时间窗旁证,改进项(耗时行落盘)已记录;
- **Minor-3**(candidateCommitError 未披露)→ f1-run1/attribution.md 补披露(空 diff 所致,与零编辑自洽,非 git 故障)。

### Reviewer 结论原文(节选)

> 六项核验全部 PASS——报告所有关键数字经独立重算逐位吻合,权威路由日志证明窗口真实、model_ref 真实承接且零重跑;8192 根因指认具备完整代码+运行时+网关三重证据链;git 取证证明边界(test/src/soak 零触及、skip-worktree 完好)全程遵守;泄密扫描干净;PARTIAL(双败+归因)是 ADR-0010 定案矩阵下唯一诚实裁决,且记账口径差异主动披露。三条发现均为证据归档完整性/披露粒度层面的 Minor,不动摇任何结论。

## 复核后状态

- R-2 = **PARTIAL(双败+归因)** 维持;报告 `p0-mvp/r2-contrast/REPORT-r2-contrast.md` 为权威;
- 潜在修复路径(sandbox maxTokens 8192 上调)**保持未实施**,待用户授权决策;
- Minor 修复提交:本 REVIEW 所在提交(证据补充+两处披露增补),Reviewer 无需复验(零 Major;Minor 修复为归档/披露粒度,不触及任何结论性证据)。
