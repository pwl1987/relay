# RELAY-MVP-READINESS-01 子包②:R2-REMEDIATION-01 剩余(根因复核/最小收口/门控记录)

- 合同:RELAY-MVP-READINESS-01 §三(用户指令 2026-11-13);前轮=R2-REMEDIATION-01(p0-mvp/r2-remediation/REPORT-r2-remediation.md)
- 执行:2026-11-13 07:35~08:0x CST;A/B/C 段完成;**D 段(真实 F1/F2 对照)=上游窗口不可用,按合同不发起,门控证据如下**
- 代码变更:本子包零产品语义变更(仅重构收口+注释/ADR 澄清);提交=<见 git log READINESS-01 子包②>

## A. 独立根因复核(只读;结论=与历史定位一致)

1. **修复面**:src/runtime/sandbox.ts——`resolveMaxOutputTokens`/`appliedMaxOutputTokens`/常量三件套(默认 8192;界 1024~128000)+`prepareRunDirs` 经 models.json 现成字段 `maxTokens: appliedMaxOutputTokens(model)` 下传。**无新增硬编码**(未做 8192→32768 之类二次硬编码)。
2. **Pi 消费链实测**:node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:75=`maxTokens: override.maxTokens ?? model.maxTokens`(与 6d3eddb 合同登记时核验一致;≤0 Pi 抛 invalid maxTokens;Pi 模型缺省 16384,Relay 显式 8192 兼容默认)。透传链=worker.ts envModel(RELAY_MAX_OUTPUT_TOKENS)→driver→runner/discovery/reviewer→prepareRunDirs。
3. **历史证据分立**(F1 截断 ≠ F2 回合耗尽,p0-mvp/r2-contrast/REPORT-r2-contrast.md):
   - F1:coder 第 2 调用 out=8192 整(144.4s),模型自身 max_output=128000 ⇒ 截断源=沙箱硬编码(已修复);token 口径对账以网关日志为权威。
   - F2:6 回合烧尽(BUDGET_EXHAUSTED@6,7×200 零上游故障)=**turn 预算止损**,非输出钳制;32768 的价值假设=单回合可完成更多编辑从而减少回合消耗,属对照实验假设,不预设通过。
4. **模型支持上限**:128000=models.json contextWindow(本轮已与 `MAX_MAX_OUTPUT_TOKENS` 共享同一常量,见 B 段)。

## B. 最小收口(READINESS-01 子包②;零行为变更)

| 项 | 变更 | 依据 |
| --- | --- | --- |
| D-1 budget 三处同形 hunk | sandbox.ts 新增 `budgetEvidence(model)`(采用值+来源两字段单一来源);runner.ts/reviewer.ts/discovery.ts 三处改为 `...budgetEvidence(model)` spread,import 同步替换 | 上轮 Standards 评审 D-1;ADR-0011 决策 5 语义不变 |
| D-2a 128000 双字面量 | models.json 条目 `contextWindow: MAX_MAX_OUTPUT_TOKENS`(与输出上界共享常量,注释注明 ADR-0011 取值来源) | 上轮 Standards 评审 D-2;ADR-0011 决策 3 |
| D-2b source 判定 null 边界 | `budgetEvidence` 用 `resolveMaxOutputTokens(...) !== undefined` 判定来源:undefined/null/空串一律 "default",仅通过校验的配置值记 "config"(修复旧 `=== undefined` 判定下 null 记 "config" 实取默认的语义偏差) | 上轮 Standards 评审 D-2 边界项 |
| (c)1 fail-closed 表述 | worker.ts envModel 注释+ADR-0011 新增「语义澄清」节:抛错沿 tick 传播=本拍不领取+loop-safety 计连续错误,连续 3 拍(默认阈值)⇒ 整环熔断 circuitOpen——**实现机制=错误累积→环路熔断,非单拍优雅跳过**;fail-closed 性质不变,纯措辞修正,零行为变更 | 上轮 Spec 评审 (c)1;src/core/loop-safety.ts 实测核验 |
| ADR 索引缺口 | ADR/README.md 补 0011 行(此前 0011 未入索引=权威目录不完整) | 冷启动发现 |

## C. 自动测试(零真实模型)

- 单测 test/unit/max-output-tokens.test.ts 扩至 **10/10 PASS**(新增:budgetEvidence default/config 语义含 null/空串敌意输入;budgetEvidence 与 appliedMaxOutputTokens 同源一致性;models.json contextWindow 与 MAX_MAX_OUTPUT_TOKENS 常量共享)。typecheck 绿。
- 全量回归(门控测试自动 skip)=264 过/2 败/50 skip;**2 败与历史签名一致面(pi-e2e 上游/magpie 依赖 + github-real 网络)定向复跑归因中,失败面与本 diff(budget 证据字段重构/常量共享/注释)无交集的判定待复跑定名后落账**。
- 预算不变/凭据隔离/Docker 一致性:由既有 integration 套件覆盖(全量回归内;budget 断言在 f1/f2 夹具证据查询列)。

## D. 真实 F1/F2 对照——**门控未过,未发起(合同 §三D:无法确认⇒不发起,推进他包并报告阻断)**

门控三要素核验记录:

| 要素 | 结论 | 证据 |
| --- | --- | --- |
| 新一轮模型调用授权 | ✅ 本合同 §三D(各最多一次;上限冻结不增) | 用户指令 2026-11-13 |
| 现有额度 | ✅ 预算按 Goal 口径预留(F1 12/4/30·wall600s;F2 6/4/10·wall420s),非终身配额(历史已澄清口径) | CURRENT.md R-2 授权四参数行 |
| 有效凭据 | ✅ RELAY_PI_* env 四变量在位(0600,零打印;占位 key,真实凭据由 Magpie 持有) | /home/ubuntu/.relay/console/env 变量名核验 |
| **上游窗口** | **✗ 未确认:api.z.ai 经出口代理挂起** | 网关账本 /home/ubuntu/.config/magpie/usage.jsonl |

**窗口探针记录(2 次,零 token;授权依据=合同"确认有效凭据"前置门)**:

1. 探针 1(07:4x,max_tokens=8):客户端 30s 中止(http=000,零响应)。
2. 探针 2(07:5x,max_tokens=8):60s 无响应客户端取消 ⇒ 网关账本记 `provider=zcode host=api.z.ai model=GLM-5.3 in=0 out=0 ms=60001 status=499 err="the agent canceled the request"`。
   - 判读:网关受理并转发(凭据面有效;非 401/403),**上游挂起**(区别于前轮 01:50 窗口的快速 502 proxyconnect)。
   - 同期对照:Magpie 自身 hourly probe(codex→chatgpt.com)04:34/05:34/06:34 连续 Forwarding failure——出口代理链路整体处于劣化窗口。

**结论**:在「上游挂起」窗口发起正式尝试=烧尽唯一尝试且零信息(与 2026-11-13 01:25/01:50 两轮 502 同性质)。按合同"额度或新授权无法确认⇒不发起"原则,**F1-R2/F2-R2 各一次正式尝试均未消耗、完整保留**;收口前(以及 Reviewer 窗口)将再探测 1 次,若窗口恢复(探针 200 且真实 token 流动)即按冻结取值执行。**冻结取值=RELAY_MAX_OUTPUT_TOKENS=32768**(依据:与前轮 F2-R/F1-R 同值保持对照链连续;4× 默认值;≤contextWindow 128000;系历史授权推荐对比值)。

**三结论分开口径(合同要求)**:①输出配置修复=**成功**(unit 10/10+透传链实读断言+Pi contract 行号;生产 worker 横幅 maxOutputTokens=8192(默认) 运行中);②F1 通过=**未判定(未发起)**;③F2 通过=**未判定(未发起)**。三者不得合并表述。
