# Relay 当前执行契约

- 状态:**MVP 最后两项阻断收敛·总执行包 ACTIVE**(用户指令 2026-11-12 五包:第一包=现有最终收口轮;第二包=R-3B 连续长稳补验;第三包=R-2 模型路由与编码能力复核;第四包=测试与治理小缺口;第五包=MVP 最终裁决。**允许在治理/安全/预算边界内连续完成独立子包;不得因用户未即时回复而停止其他安全任务**;不得提前等待在聊天会话——期满验收由已运行的独立 Runner 执行)。**另加 MODEL-POLICY-00 设计冻结包(用户指令 2026-11-12):只做设计文档,零模型消耗,不改变 R-2/R-3B 及冻结执行顺序(第一包收口→F2→F1→R-3B→MVP 最终裁决)。**
- 写者:本窗口唯一 Writer(main-only;禁强推;不重跑 R-1;不修改 PAT;不重置采样起点;不删除日志;不生产部署;不 RSI;无模型授权不消耗新预算)。
- 基线:总包启动时 HEAD `b373726` == live origin/main(CI 绿;唯一 Writer 确认 origin/main 未被他人推进);此后各包快进推进(最新见 `git log`;MODEL-POLICY-00 两提交:254ec5b 合同登记 + 设计交付物,推送随 CI 执行);工作区未跟踪仅 soak 产物(`soak-24h/final-runner.log`、`soak-r3b/` 预置六文件——边界:保持未跟踪,不混入任何提交)。
- 运行态:**保留 Worker 810994 / Sampler 811916 / Final Runner 859915**(PPID=systemd --user;setsid 脱离会话);365s 中断缝与 2 次 PG 采样异常**全部保留**。

## 各包状态与边界

| 包 | 状态 | 边界要点 |
| --- | --- | --- |
| 第一包 现有最终收口轮 | **进行中**(合同 b373726 仍为本包安全边界;期满 17:32:52+0800,Runner 17:35 出唯一快照) | 核查 86400s 窗口/原始 CSV/Worker 日志/进程退出/RSS/PG/Tick/领取;**缝在 ⇒ R-3 PARTIAL 不改 PASS**;受控停机后冻结证据、处理 skip-worktree 与 final-runner.log;独立 Reviewer;CI 后快进推送并释放本包 Writer |
| 第二包 R-3B 连续长稳补验 | 待第一包收尾后启动 | 独立目录/schema/实例,不复用原始证据;ACTIVE 合同先行;systemd(Linger=yes 已确认)或等价独立服务管理;真实 24h;每分钟监控含采样器自身故障;中断不重置不覆盖;未满不报 PASS;区分"空闲连续性"与"业务负载连续性" |
| 第三包 R-2 模型路由复核 | **调查阶段进行中**(零模型消耗) | 先读 `r2-failure-analysis.md`;分析 F1/F2 历史 Run/工具审计/预算/机判失败;确认 `group/gm` 真实上游;盘点可用编码模型 Provider/Model/BaseURL(**禁读/展示 Key 明文**);六分法归因(能力/超时/工具/上下文/提示词/回合预算);确定至少一个可实际调用候选。**未获授权(替代模型/预算/超时/凭据)不发起任何真实模型请求,只交付模型选择与失败归因报告**;对照实验须记录实际模型标识(Magpie 是网关层,≠"同一模型") |
| 第四包 测试与治理小缺口 | ✅ **完成**(b30a492 合同→f8e0263 实施→715c35e Reviewer 附审 PASS-WITH-FINDINGS 零 Major+Minor-p4-1 修必;CI 绿) | ①唯一载荷三处(含重跑实证发现的 foreign.txt)真实验证 4+1skip;②证据改 test-evidence/ 未跟踪;③孤儿审计零孤儿;④口径一致+注释修;⑤skip-worktree 仅 2 soak 文件;⑥A-4 +1 如实披露 |
| 第四包遗留(用户指令 2026-11-12 07:32) | **进行中**(独立小包;零模型消耗) | ①第五包前核查最新 REVIEW/CI(现行 REVIEW=第四包附审,CI 715c35e 绿);②**三个基础设施门测试(live-worker-e2e/gate-e2e/egress-proxy)增加显式模型调用 env 门禁**(RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E),杜绝"零模型定向回归"意外触发真模型;③账本对账:第一手证据 `ledger used=5 limit=8`==上游 5×200(1:1)——**测试次数≠模型请求次数**;limit=8 为每 Goal 口径(非终身配额),历史"累计 used"表述作废重述;④本文件阶段状态修订(本次) |
| 第二包 R-3B 补充边界(用户指令 07:32) | 预置文件保持**未跟踪**,不得混入第一包提交;第一包(复核+冻结+CI+推送+释放 Writer)全部完成后才启动 | 独立目录/schema/systemd user 单元(Linger=yes)+不可掩盖故障的采样与看门狗;24h 重新真实计时,未满不报 PASS |
| 第三包 R-2 **已授权定案**(用户指令 2026-11-12 07:50) | 四参数确认:①`zcode/GLM-5.3`(须记录实际 model_ref+Magpie 路由日志证真实上游,不得只记组名)②Coder≤12/Reviewer≤4/Goal≤30(禁绕过;测试次数与模型请求次数分别统计,ledger+Magpie 双重对账)③每实验 wall=600s(超时/耗尽/失败如实结束,禁放宽禁无限重试)④现有 Magpie 凭据(零新增/修改/读取/打印/入库 Key) | **执行顺序硬约束:第一包收口完成 → F2 → F1 → R-3B**;不得为提前跑 R-2 干扰三进程。夹具核对(只读):F1=12/4/1/600/goal30 **与授权逐项一致**;F2=6/4/1/420/goal10 全部 ≤上限,**零测试修改**;F2 一次正式尝试失败先分析不得自动加预算重跑。VERIFIED 仅当:真实修改+机判全过+独立 Reviewer PASS+Gate ACCEPTED+三 SHA 绑定+交付成功+无 Stub+调用数/Token/wall/工具/实际模型 ID 全落证;双过⇒VERIFIED,单过⇒PARTIAL,双败⇒PARTIAL+归因。**不预设通过**;授权不含:加预算/换模型/改 PAT/生产部署/RSI/放宽 Gate·Reviewer·机判 |
| 第五包 MVP 最终裁决 | 待 R-2/R-3 完整证据 | 重生成 US/V/G/F 矩阵;R-1 只读复核(不为绿重复制造远端提交);F1/F2 实际验证;连续运行日志独立审核;D3 无自动批准/预算无突破/无重复副作用;独立 Reviewer 给 ACCEPTED/REWORK/BLOCKED;**全部 P0 必需门通过才 ACCEPTED** |
| MODEL-POLICY-00 设计冻结包(用户指令 2026-11-12) | ✅ **完成**(254ec5b 合同→5fb4766 交付物+独立 Reviewer PASS-WITH-FINDINGS 零 Major·F-1~F-6 全消化+CI 绿;零代码改动零模型消耗,soak 产物零触碰) | 交付:`docs/MODEL_POLICY.md` v0.1 + `ADR/0009-model-policy.md` + `docs/MODEL_POLICY_REVIEW.md`;设计冻结(实现 OPEN),激活前置=MVP 最终 ACCEPTED 后 MODEL-POLICY-01(四通道真实验证+可回放证据);禁止项全程未违反 |

## 治理纪律(总包)

main-only;单 Writer;每包 ACTIVE 合同先于实现提交;每包独立测试/复核/CI/快进推送;Issues 只管任务不作调度器;外部副作用结果不明先 Reconcile;不能借测试或修复清理其他项目目录;一包被阻断则记录原因推进其余。

## 基线终账(不变)

MVP=REWORK 维持(矩阵权威 `p0-mvp/final-coverage-matrix.md`);R-1 已解除 VERIFIED;R-2 PARTIAL(待授权);R-3 PARTIAL(缝在,期满终验进行中)。
