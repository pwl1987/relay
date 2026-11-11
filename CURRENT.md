# Relay 当前执行契约

- 状态:**R-2/R-3 收口轮 ACTIVE**(用户指令 2026-11-12:VM80 当前 checkout 执行 R-2/R-3 收口;单写者;live main;证据优先)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推)。
- 冷启动基线:HEAD `d75ee9d` == live origin/main(ssh:443 核对);工作区 clean(soak 两观测产物 skip-worktree 不显示)。
- **soak 中断事实(本窗口发现并处置)**:两采集进程于 2026-11-12 06:05+0800(观察 12.53h 时点)被会话解体 SIGTERM 波及——worker.log 末行 `SIGTERM received;graceful stop`(非崩溃;无 OOM 内核记录;无 soak-final.json ⇒ 采样器同波及,非 worker 先死)。已按原始口径**续采**(setsid 完全脱离会话进程组;env/schema/workerId 复刻 REVIEW-stage-e §3①;start-epoch 不重置;日志与 CSV 只追加;新表头由验证器①剔除)。**中断缝 365s(45100→45465s)如实落账。**

## 本包范围

1. **R-2(授权参数缺失 ⇒ 只出清单,零真模型运行)**:替代模型/预算/超时/凭据来源四项用户均未授权 ⇒ 生成精确待授权清单(`p0-mvp/r2-pending-authorization.md`;对照实验设计引用 `r2-failure-analysis.md` §3);不伪造结果;R-2 结论维持 **PARTIAL**。
2. **R-3(中断处置+续采+期满待终验)**:中断取证落账;续采后中期核验快照(`p0-mvp/soak-24h/verify-interim-20261112T0613+0800.json`:观察未满+缝 365s+pg 采样失败 2 行为已知历史痕迹+RSS/tick/领取全净);期满点 **2026-11-12 17:32:52+0800**,到期独立验证器终验;**中断缝存在 ⇒ 终验口径 PARTIAL(缺失样本或中断时保持 PARTIAL——收口指令 §3)**。
3. **文档/矩阵/Reviewer**:更新 `r1-closure.md`(本轮 R-2/R-3 处置附记)/`REVIEW-r1-closure.md`(独立 Reviewer 附审)/`CURRENT.md`/`docs/CONTINUATION.md`;`final-coverage-matrix.md` 相应行重生成;独立 Reviewer 复核原始证据/提交链/CI/工作区。
4. **判定纪律**:R-2 待授权 + R-3 有中断缝 ⇒ **MVP 终判 REWORK 维持,不提前 ACCEPTED**;24h 口径仍为"空闲稳定性",不得称业务负载稳定性。

## 安全边界

不修改/扩大 PAT 权限;不强推;不触碰其他仓库;不重置计时起点;观测产物历史不修饰(只追加);替代模型重跑必须用户先授权四项参数;经典宽权限 Token 禁用;github-real 如需重跑先净化代理变量(`env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy`)。

## 基线终账(不变)

MVP=REWORK 维持(`p0-mvp/REPORT-final.md`;R-1 已解除 VERIFIED,`p0-mvp/r1-closure.md`+`REVIEW-r1-closure.md`);矩阵权威 `p0-mvp/final-coverage-matrix.md`;本轮**不跑全量 vitest**(避免消耗 A-4 真模型调用——收口包明示义务),定向回归仅 `test/unit/soak-verify.test.ts` 9 例(合成数据零模型调用,已绿)。
