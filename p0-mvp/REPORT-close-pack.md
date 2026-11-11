# 收口包终报(MVP 最终收口执行指令;2026-11-12)

- 合同:`f4ccfa7`(CURRENT.md CLOSE-PACK);实现/处置链:`f4ccfa7 → 2800669 → 1b55400 → 968cad0 → f6c6dd7`
- 终态:HEAD == origin/main == `f6c6dd7`;CI `43055756364` 双绿;独立复核 `p0-mvp/REVIEW-close-pack.md` PASS-WITH-FIXES(处置完成)
- **MVP 终判:REWORK 维持**(三项解除项证据未齐:R-1 用户未补权/R-2 用户未授权替代模型/R-3 24h 观察进行中——按收口指令"不能提前 ACCEPTED")

## 三项阻断的收口状态

| 项 | 状态 | 本包动作 | 解除条件(用户侧) |
| --- | --- | --- | --- |
| R-1 GitHub 写入 | **BLOCKED 维持** | 逐项复查(PAT 仍未授权:仓库端点 404/72 可见仓库无沙箱仓;零 token 打印)+ 复查记录入 stage-c 文档 + capabilities 口径更新(NOT_VERIFIED→BLOCKED,单测同步) | Repository access 勾选沙箱仓+Contents RW → 跑 github-real.test.ts |
| R-2 真模型业务交付 | **PARTIAL 维持**(只读诊断完成,零重跑) | 失败归因六分类落证(`r2-failure-analysis.md`:主因=回合预算内未收敛/次因=首轮上下文不足(已修)/超时一次/Gate 正确拒;**magpie=路由组,上游不透明,归因边界如实**;对照实验设计已备) | 用户授权替代模型+预算 → 同项目同机判可比预算对照实验 |
| R-3 24h 长稳 | **观察进行中(本包收官时 ~6.7h/24h;RSS 稳态 ~114MB≪400MB;tick 全 IDLE_PROVIDER_DOWN)** | 独立验证器 `deploy/soak-verify.mjs`(九项核验:重复表头/连续窗/存活/缺口/PG 异常/RSS-CPU/tick 意外推进/异常退出/意外领取)+ 回归 9/9;到期后 `node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log` 出核验结论(soak-final.json 仅初步) | 真实期满 → 验证器核验 → Reviewer 确认(**口径=24h 空闲稳定性,不得称业务负载稳定性**) |

## 治理收口

- origin/main 跟踪引用漂移修复(此前推送走 ssh URL 不更新跟踪引用)+ CURRENT.md 改动态 HEAD 口径(不再写死)。
- capabilities `delivery.github.real`:NOT_VERIFIED→**BLOCKED**(仓库不在 PAT 授权范围;单测同步;CapabilityStatus 加 BLOCKED 态)。
- /tmp 试验残留清理(本会话前缀全清;**soak 目录与进程未动**)。
- Major-M2 修复:soak 观测产物 samples.csv/worker.log 曾三次随提交带入中间态(流程违约)⇒ `git update-index --skip-worktree` 防再入;24h 完成时显式解除后终版入库。
- CI 基建故障处置:GitHub runner apt exit 100 四连败(每次 ~10min,重试日志全录;e2e 代码零改动)⇒ 免 apt 安装策略(runner 预装库优先+with-deps 兜底)→ 双绿。
- 明示事项:**每次全量 vitest 会触发 live-worker-e2e 既定 A-4 授权实验,消耗 1 次真模型调用(magpie 本地,limit=8 未变)**——后续全量验证应向用户预告。

## 独立复核(REVIEW-close-pack.md)

- PASS-WITH-FIXES;Reviewer 亲测:九项注入自构恶意 CSV 全捕获(exit 1)/真实 soak 数据 verdict 如实/RSS 与 /proc 亲对照/R-1 再证成立/magpie 论断亲证/基建故障定性成立;soak 两进程全程未动。
- 全部发现已处置:Major-M2(skip-worktree)+ Minor-m1(措辞精确化+证据映射补全)/m2(动态口径)/m3(登记)/m4(run id 口径)。

## 下一阶段计划

1. 用户完成 R-1(分钟级)/R-2 授权 → 本窗口或新窗口跑闭环 → 矩阵更新。
2. R-3 到期(~17h 后)→ 验证器核验 → Reviewer 确认。
3. 三项齐备 → 重生成终版矩阵 → 终审 → 方可 ACCEPTED。期间 live main 保持 REWORK 终判,CI 持续绿,soak 观察不间断。
