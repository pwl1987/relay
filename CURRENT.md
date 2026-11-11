# Relay 当前执行契约

- 状态:**总包收口包(CLOSE-PACK)ACTIVE**——目标:治理收口+R-1/R-2 只读诊断+R-3 验证器(不改变 REWORK 终判;三项解除项按证据推进)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推)。
- 冷启动基线:HEAD == origin/main(动态核对,勿写死;本轮已修跟踪引用漂移——此前推送走 ssh URL 不更新跟踪引用);工作区仅 soak 观测产物脏(`p0-mvp/soak-24h/samples.csv`+`worker.log`,**不 reset 不提交中间态**);soak 两进程存活(4.6h/24h;RSS ~118MB)。
- 基线事实:R-1 PAT **仍未授权**(仓库端点 404+72 可见仓库无沙箱仓——保持 BLOCKED);R-2 只读诊断完成(见下);R-3 到期前不判。

## 本包范围

1. **R-1(保持 BLOCKED)**:PAT 复查记录入 `p0-mvp/stage-c-github-permission.md`(复查时间/结果);用户补权前零 Git 远端实验。
2. **R-2(只读诊断落证)**:`p0-mvp/r2-failure-analysis.md`——F1/F2 失败归因六分类(证据:runs-detail/gate-evidence/tick-full)+ magpie 路由组核对(`group/gm`=GMD routing group,reasoning+tool_call;上游不透明,归因边界如实)。**替代模型未经用户授权前零重跑**。
3. **R-3(独立验证器+回归)**:`deploy/soak-verify.mjs`——按收口指令 §4 实现独立核验(剔除重复表头/连续时间窗/存活采样/缺口检测/PG 异常/RSS-CPU 阈值/tick 状态/异常退出/重复副作用);`soak-final.json` 仅初步报告;**24h 标记"空闲稳定性",不得称"业务负载稳定性"**;回归测试 `test/unit/soak-verify.test.ts`(合成 CSV:正常/重复表头/缺口/进程死亡/RSS 超阈值)。
4. **治理收口**:CURRENT.md HEAD 口径修正(自指 e39ed68 → 动态口径);capabilities `delivery.github.real` 陈旧措辞更新(PAT 有效/仓库不在范围);试验残留清理(/tmp/e3-backup、review 残留——**不动 soak 目录**)。
5. **收尾**:独立 Reviewer → CI 绿 → 快进推送;终判维持 REWORK(除非用户动作解除 R 项)。

## 安全边界

不动 soak 两进程与观测产物;不扩大模型预算/GitHub 权限/生产部署授权;替代模型重跑必须用户先授权;经典宽权限 Token 禁用。

## 基线终账(不变)

MVP=REWORK 维持(`p0-mvp/REPORT-final.md`);全量 240=223+15skip+2fail(2=github-real 凭据面);tsc 0;CI 链全绿。