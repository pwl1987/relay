# RELAY-MVP-READINESS-01 子包②(R2-REMEDIATION-01 剩余)独立复核

- 复核人:全新上下文独立 Reviewer agent(只读+亲测;未修改/未提交/未推送;未发起任何上游请求)
- 复核对象:代码提交 `aa19c9d`(②B+C 最小收口)+ 证据提交 `8b2d83c` ②D 部分(R2-ROUND2-NOTE.md/REPORT §6)
- 裁决:**PASS-WITH-FINDINGS**(九个验证点全部亲测通过;仅 1 条证据叙述 Minor,零 REWORK 项)

## 亲测记录

- `npx tsc --noEmit` 绿;`npx vitest run test/unit/max-output-tokens.test.ts` = **10/10**;
- `test/integration/f1-ux-journey.test.ts`+`f2-bug-fix.test.ts` = 4 skip(门=RELAY_F1/F2_E2E+envModel,预期 skip);
- `github-real.test.ts` 隔离复跑 4 过 1 skip(网络依赖面印证);
- Pi contract 行号实测:`provider-composer.js:75` = `maxTokens: override.maxTokens ?? model.maxTokens`。

## 验证点(9/9 ✅)

1. budgetEvidence 与 appliedMaxOutputTokens 同源(sandbox.ts:81-88 均经 resolve 单点);三处 spread 对象仅 role/reserveCalls/wallSeconds 无键冲突;三文件无 appliedMaxOutputTokens 残留 import。
2. contextWindow=MAX_MAX_OUTPUT_TOKENS(sandbox.ts:171;单测常量共享断言过)。
3. source 判定:sandbox.ts:61 undefined/null/空串→undefined⇒default,仅通过校验值→config,旧 null→"config" 偏差已修。
4. worker.ts:129 envModel 在 tick 体内、先于领取,抛错沿 tick 传播=本拍不领取;loop-safety.ts:29/49 默认阈值 3、累计≥3⇒circuitOpen——与注释及 ADR-0011 语义澄清一致。
5. ADR/README.md:15 已含 0011 行。
6. ADR-0011「语义澄清」节与代码一致,决策 1-6 原文未改,标注仅措辞。
7. 零新硬编码:8192 仅 DEFAULT 常量/历史注释/文档;models.json 写入点=appliedMaxOutputTokens(model);src 无 32768。
8. 门控证据:账本实测三探针全有行(07:50:52 ms=30001/07:51:43 ms=60001/08:06:27 ms=45001,均 status=499 in=0 out=0 agent_canceled),非 401/403 ⇒ 上游挂起+凭据面有效成立;三结论分立表述无合并;冻结 32768 及依据在案。
9. 无真实 F1/F2 尝试被发起:生产库 07:00 后 0 runs、0 budget_ledger 动账(今日仅 01:45 冒烟 1 run);窗口内 agent=pi 200 条目为 GLM-5.3-Flash≠合同模型 zcode/GLM-5.3;git log 无 RELAY_F*_E2E 执行证据。

## Findings

- **Minor-1**(R2-ROUND2-NOTE.md:45-46):称探针 1/3「客户端中止可能无账本行」,实测三探针在 usage.jsonl 均有 499 行——证据强于叙述,叙述与账本未完全对齐。**已消化**:NOTE 探针节改写为 4 次全账本行口径(REPORT §6 与 CONTINUATION 同步对齐)。
- 观察:NOTE:50「Reviewer 窗口再探针 1 次」为未执行的前瞻承诺,属收口动作非缺陷(收口前第 4 次探针已执行:08:32:35 status=499 零 token,窗口仍未恢复)。
- 264/2 归因核验:pi-e2e.test.ts:100/245 实读均为 outcome=SUCCEEDED 断言,TIMEOUT 暴露点吻合,与本 diff 零交集;github-real 复跑 4/4 印证网络面。
