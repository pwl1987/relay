# R-2 对照实验正式报告:GLM-5.3-Flash(历史)vs GLM-5.3(当前)

- 日期:2026-11-12;依据:用户主路径纠偏指令(CURRENT.md 大包行,HEAD adb713b 起)+ R-2 已授权定案四参数(`zcode/GLM-5.3`;Coder≤12/Reviewer≤4/Goal≤30;wall≤600s;现有 Magpie 凭据)。
- 单变量对照:**历史经 `group/gm` 路由组(11-11 实测 ~95% 成功 try 由 `zcode/GLM-5.3-Flash` 承接,r2-model-investigation.md §1)vs 本次直连 model_ref `zcode/GLM-5.3`(路由日志逐行实证)**——同家族、同提供方、同夹具、同机判、可比预算(夹具 F1=12/4/1/600/goal30、F2=6/4/1/420/goal10,与授权逐项一致,零修改)。
- 尝试纪律:**F2、F1 各一次正式尝试,失败即停,零自动重跑、零预算追加、零模型更换、零变量调整。**

## 一、裁决总表

| 实验 | GLM-5.3-Flash(历史,group/gm) | GLM-5.3(本次,zcode/GLM-5.3) |
| --- | --- | --- |
| **F1 accepted** | ❌(首轮 SUCCEEDED 零编辑@2 turns;次轮×2 BUDGET_EXHAUSTED@12;一次 TIMEOUT——从未产出候选过 Gate) | ❌ run SUCCEEDED 但零编辑空提交,Playwright 机判 1/4 拒,Reviewer BLOCK |
| **F2 accepted** | ❌(轮 1 机判 4 项未全过;轮 2 BUDGET_EXHAUSTED@6) | ❌ BUDGET_EXHAUSTED@6 turns(135s),候选未成形,gate/delivery 未到达 |
| **first pass(候选过机判)** | F2 轮 1 到达机判但 4 项未全过;F1 零候选 | F1 到达机判但 1/4;F2 零候选 |
| **model calls(网关权威)** | 11-11 窗口路由日志 486×200(全部实验合计,Flash 承接) | **F1=6(discovery 3+coder 2+reviewer 1);F2=7(6 计账+1 止损边界在途);共 13,全部 200/tries=1** |
| **turns** | F1:2→12(耗尽);F2:6(耗尽) | F1:discovery 3 + coder 2 + reviewer 1;F2:6/6 耗尽 |
| **wall** | F1 数百秒(含 1 次 TIMEOUT);F2 — | F1 总 247.3s / F2 135.2s(均远低于上限,零超时) |
| **Reviewer REWORK/BLOCK** | 历史 F1/F2 无一到达 Reviewer(gate 前已死) | F1:Reviewer **BLOCK**(精准识别空提交,论证"为何非 REWORK");F2:未到达 |
| **tool failures** | 无 denied(历史排查);本轮 discovery 4 工具 0 拒绝、F1/F2 无 denied 记录 | 同左(零工具拒绝) |
| **Delivery** | 均未到达 | 均未到达(DELIVERED=0) |
| **token usage(网关口径)** | 11-11 in ~未逐轮归档(路由日志在档可回溯) | F1 in 17618/out 10395;F2 in 20475/out 7984 |

**R-2 裁决:PARTIAL(双败 + 归因)**——按定案矩阵,双过⇒VERIFIED / 单过⇒PARTIAL / 双败⇒PARTIAL+归因;本次双败,归因如下。

## 二、归因(两实验失败模式不同,均已实证定位)

### F2:回合预算 × 收敛速度(BUDGET_EXHAUSTED@6)

- 7×200 零上游故障、135s≪420s 零超时;6 回合硬顶止损时候选未成形;
- 与 Flash 轮 2 同模式:**回合预算内未收敛**——预算止损机制正常工作,非缺陷;
- 在 6 回合硬顶内无法区分"能力不足"与"需要更多回合"(诚实边界,与 r2-failure-analysis.md §2 一致)。

### F1:Relay 侧输出钳制截断(maxTokens=8192)

- **决定性实证:coder 第 2 调用 out=8192 整**(144.4s),而 `zcode/GLM-5.3` 自身 max_output=128000 ⇒ 截断来自 **`src/runtime/sandbox.ts:131` 硬编码 `maxTokens: 8192`**;
- GLM-5.3(medium effort)重推理输出风格吃满 8192 输出预算,截断先于文件编辑工具落实 ⇒ 零编辑;
- 机判 3/4 拒 + Reviewer BLOCK 属**治理链正确 FAIL-CLOSED**(正面实证:失败被诚实拦截而非掩盖);
- 排除提示词问题:coder 上下文 9514 tokens 含采纳装配后的全部显式可判定验收标准。

### 与历史 Flash 的结构性对照

| | Flash(历史) | GLM-5.3(本次) | 共性 |
| --- | --- | --- | --- |
| Discovery | 高质量(VERIFIED 前科) | 高质量(3 turns 真实调查) | Discovery 能力两档模型均可靠 |
| 编码失败模式 | 12 回合烧尽/超时(有编辑但不收敛) | F2 6 回合烧尽;F1 8192 截断零编辑 | **多步编辑收敛是共同短板** |
| 治理链 | 止损正常 | 止损+机判+Reviewer 全链正确 | FAIL-CLOSED 双重实证 |

## 三、记账口径披露(不掩盖)

1. **调用数**:F2 网关 7 行 vs run 记账 6 turns——止损边界在途调用未计入 run;"测试次数≠模型请求次数"再实证;
2. **token 口径**:run 侧 tokensIn 与网关全量 prompt token 显著不一致(F2:3265 vs 20475;F1 coder:1386 vs 10530),tokensOut 精确一致(F1 8248=56+8192);**对账以 Magpie 路由日志为权威**(本报告全部 token 数取网关口径);
3. effort=medium 为网关侧缺省,不在授权四参数内,未调整;
4. **wall 数值来源披露(Reviewer Minor-2 消化)**:F2 135.2s/135196ms、F1 247.3s 取自执行会话 vitest 控制台输出,执行时证据面无该字段、未落盘;可由网关时间窗旁证(F2 窗 147.4s ≥ 135.2s;F1 窗 239.8s + 调度开销 ≈ 247.3s);改进项已记:后续实验将耗时行随 evidence() 一并落盘;
5. F2 stub 机制对照件(stub-final-check.json 4/4 ok、stub-tick-summary.json gate ACCEPTED+DELIVERED)原仅存未跟踪运行时面,已按 Reviewer Minor-1 补入 `p0-mvp/r2-contrast/f2-run1/`(与 F1 stub 四件对称)。

## 四、边界遵守声明

- 一次正式尝试×2,失败即停,零重跑/零加预算/零换模型/零变量调整;✅
- 独立 schema×2(d-f2-bug / d-f1-ux)、独立临时 workspace(safeRm 哨兵)、共享清理目录零复用;✅
- soak 三进程(810994/811916/859915)零触碰,soak 文件零修改,R-3 旁路并行(纠偏指令);✅
- 无关真实模型门(RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E)全程关闭,仅 F1/F2 定向单文件;✅
- 零 Key 明文读取/打印/入库;凭据链 = Magpie 持上游凭据 + Relay 占位 key(零新增凭据)。✅

## 五、证据索引

- `p0-mvp/r2-contrast/f2-run1/`:attribution.md、routing-window.jsonl(7 行)、tick-summary/tick-full/runs-detail/gate-evidence.json;
- `p0-mvp/r2-contrast/f1-run1/`:attribution.md、routing-window.jsonl(6 行)、discovery/tick-summary/tick-full/runs-detail/gate-evidence.json + stub 对照四件;
- 运行时原始未跟踪面:`test-evidence/f1|f2/`(与本目录内容同源);
- 历史对照基线:`p0-mvp/f1|f2/`(跟踪证据,原样保留)+ `p0-mvp/r2-failure-analysis.md` §2 + `p0-mvp/r2-model-investigation.md` §1;
- 路由日志权威源:`~/.config/magpie/routing/2026-11-12.jsonl`(行 93-105 为本轮窗口)。

## 六、后续建议(待用户授权,本包不执行)

1. **候选修复实验**:上调 `src/runtime/sandbox.ts` maxTokens(8192→建议 65536,与 128000 上限对齐留余量)后,F1/F2 各再一次正式尝试——F1 截断根因已定位,修复后过 Gate 概率显著改善;是否授权交用户;
2. 回合预算维持现值不建议加(F2 的 6 回合止损是合同口径,加预算掩盖收敛性问题);
3. MODEL-POLICY-00 冻结维持;本报告不构成任何模型路由切换依据。
