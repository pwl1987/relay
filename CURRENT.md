# Relay 当前执行契约

- 状态:**最终收口轮 ACTIVE**(用户指令 2026-11-12:VM80 当前 checkout 执行最终收口;**不得重跑 R-1;不得修改代码;不得扩大 PAT 权限;不强推**;单写者;live main;证据优先)。
- 写者:本窗口唯一 Writer(main-only)。
- 冷启动基线:HEAD `247afca` == live origin/main(ssh:443 ls-remote 核对;2026-11-12 06:33+0800);工作区 clean(soak 两观测产物 samples.csv/worker.log skip-worktree)。无 `d75ee9d`/`247afca` 不一致,无需基线纠偏提交。
- 上一轮(R-2/R-3 收口轮)已履行完毕:R-2 待授权清单已发出(`r2-pending-authorization.md`);R-3 中断已续采(setsid detached;起点不重置;缝 365s 落账);Reviewer 附审 PASS-WITH-FINDINGS(247afca)。
- 期满前只读监测(2026-11-12 06:33+0800):两进程存活(worker 810994/sampler 811916;PGID=SID=自身);start-epoch=1794389572 未动;最新样本 elapsed=46849s alive=yes;tick 全 `IDLE_PROVIDER_DOWN` 零领取;无 soak-final.json(窗口未满)。

## 本包范围(用户指令五节)

1. **基线纠偏**:核对 HEAD/origin/main/工作区/log;三者一致才继续(已核一致)。
2. **R-3 期满前**:保持 setsid 两采集进程运行;只读监测;不重启、不重置 start-epoch、不删 CSV 或日志;若提前退出,保存退出原因/末行日志/末 elapsed/是否生成 soak-final.json,**不得把窗口重新包装成连续 24h**。
3. **期满终验(2026-11-12 17:32:52+0800 后)**:`node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log`;保存完整输出与独立快照;核对 86400s/365s 缝保留/RSS<400000/tick 全 FAIL-CLOSED/零领取零异常零 OOM 零 SIGKILL 零未解释退出/两进程连续性。**存在 365s 中断缝 ⇒ R-3 终验结论 PARTIAL,不得改 PASS。**
4. **R-2 继续保持待授权**:用户未提供替代模型标识/预算/超时/凭据来源任一项 ⇒ **不运行任何真模型**;授权到位后同项目/同机/可比预算跑 F1/F2 对照并落原始日志/消耗/交付物/独立复核。
5. **最终治理收口**:更新 `r1-closure.md`/`REVIEW-r1-closure.md`/`CURRENT.md`/`CONTINUATION.md`/`final-coverage-matrix.md`;记录中断缝与终验结果,保持 R-2/R-3 真实状态;独立 Reviewer 复核提交链/终验快照/CI/远端 HEAD/工作区;**仅 R-2 与 R-3 均有充分证据才可改判 ACCEPTED,否则提交最终收口证据并列明剩余门槛**。

## 安全边界

不重跑 R-1;不修改产品代码;不修改/扩大 PAT 权限;不强推;不触碰其他仓库;不重置计时起点;观测产物只追加不修饰;零真模型调用(R-2 未授权);不跑全量 vitest(避免 A-4 真模型消耗)。

## 基线终账(不变)

MVP=REWORK 维持(`p0-mvp/REPORT-final.md`;R-1 已解除 VERIFIED);矩阵权威 `p0-mvp/final-coverage-matrix.md`。
