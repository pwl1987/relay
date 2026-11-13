# RELAY-MVP-READINESS-01 最终报告(合同 §六 九项)

- 执行窗口:2026-11-13 07:24~08:5x CST;冷启动核验=live main 重 fetch(不沿用历史 SHA)+AGENTS/CURRENT/CONTINUATION/ADR 索引/最新 Reviewer 全读
- 收口提交=<本提交>;全链=`9b05cfb`(合同登记)→`02c19f2`(子包①证据)→`3dea3fa`(**用户本人并行推送的子包①独立复核 PASS-WITH-FINDINGS**)→`aa19c9d`(子包②B+C)→`8b2d83c`(子包②D 证据+③+④)→`83b9318`(①复核五发现消化)→<本提交>(②③复核消化+REVIEW 记录+收口)
- 硬停止遵从:零 MODEL-POLICY-01 实施/零 REAL-PILOT 进入/零 R-3B 启动/零公网暴露/零 Core 生命周期·Gate·Policy·Reviewer 权限变更/零 Agent 代用户宣布 UX ACCEPTED

## 1. live main 完整 SHA

- 开工冷启动 live main=`8fe0f7f029c16c2a8bdd7b772feb8251437dc70c`(fresh fetch,非沿用 2a37a41 历史参考值);收口前 live main 推进序列=9b05cfb→02c19f2→3dea3fa(用户)→aa19c9d→8b2d83c→83b9318→<本提交>。

## 2. 本地与远端一致性、工作区和 Writer 状态

- 本地=origin/main(0/0 分叉)后快进推进;单 Writer 全程(用户并行推送复核提交一次,快进整合 rebase 零冲突,无覆盖无强推);工作区未跟踪仅受保护两项=`config/`(运行时 Project Registry)与 `p0-mvp/soak-r3b/`(R-3B 冻结预置)——分类记录、零触碰、未混入任何提交。

## 3. 代码修改范围和实际测试

- **产品代码(子包②B,零语义变更)**:sandbox.ts(+budgetEvidence 单源/contextWindow 常量共享)、worker.ts(envModel 注释语义澄清)、runner.ts/reviewer.ts/discovery.ts(三处 budget 证据字段 spread 单源化+import);测试 test/unit/max-output-tokens.test.ts 7→10 例。
- **实际测试**:typecheck 绿;单测 **10/10**;全量回归 **264 过/2 败/50 skip**(2 败=pi-e2e 上游挂起 TIMEOUT 签名,`pi-e2e.test.ts:100/245` outcome=TIMEOUT,与 diff 零交集;github-real 网络瞬断面隔离复跑 4/4 印证);f1/f2 夹具门控 skip 符合预期(零真实模型);CI 为权威口径(见 §4)。
- **证据/文档(非代码)**:DEPLOY-VERIFY-01.md+9 截图+冒烟脚本+smoke-results.json(子包①);R2-ROUND2-NOTE.md+REPORT §6(②D 门控);AGENT_AUTOLOOP_REFERENCE.md(③重核注记+逐项裁决表);CURRENT.md/CONTINUATION.md(④);REVIEW-readiness-01-r2.md+REVIEW-readiness-01-al-gov.md(复核记录)。

## 4. exact-head CI 链接及未覆盖测试

| 提交 | CI run | 结果 |
| --- | --- | --- |
| 8fe0f7f(开工基线) | 43280551759 | success |
| 02c19f2(子包①) | 43330123942 | success(用户复核 F-3 消化时实证) |
| aa19c9d+8b2d83c+83b9318+<本提交> | <推送后核验,结果见本报告收口注记> | <状态> |

- 未覆盖测试(如实):RELAY_F1/F2/A4/GATE/EGRESS 等模型与基础设施门控测试本地自动 skip(无门禁变量);pi-e2e 上游依赖 2 例本地 TIMEOUT(上游挂起窗口;CI 无凭据自动 skip 同面);真机 iPhone/Android PWA 实装无法自动覆盖(见 §5/§8)。

## 5. VM80 实际部署和运行验证(子包①,p0-mvp/readiness-01/DEPLOY-VERIFY-01.md)

- 服务:relay-web(3242781)/relay-worker(3242782)02:00:08 起 active,Linger=yes,WorkingDirectory=/home/ubuntu/dev/relay(部署 checkout=工作树),LAN 10.30.5.80:8787 单接口(ss 实证非 0.0.0.0),schema=relay_console 16 表全在位,worker 横幅 maxOutputTokens=8192(默认),web 12h 零 error。
- 资源指纹三方一致(本地 HEAD=served=GitHub raw@8fe0f7f;raw 抽查 2/2);HTTP 行为 32/32;Chromium 真实双端冒烟 **17/17 零页面错误**(9 截图;桌面 1440×900+移动 390×844;含 BLOCKED Goal 失败块→移动技术详情 sheet 真实预算事实;Composer 键入未发送=零模型消耗)。
- PWA 分端判定:**Android 当前不可安装**(唯一硬阻断=非安全上下文,manifest 字面全达标)/ **iOS A2HS 基础可用体验降级**(apple meta HTTP 生效);HTTPS 最小方案三选已交(**方案 A 推荐**=同机 TLS 仅 10.30.5.80:8443+内部 CA 设备信任,零公网/防火墙/DNS 变更)——**仅方案,涉网络/安全配置,待用户裁决后实施**。
- 回滚方法:detached checkout+restart(已知点 8fe0f7f/67c89f2/2a37a41);relay_console 迁移为增量,回退代码无需回滚 schema。

## 6. F1/F2 对照结果或明确未执行原因(子包②D)

- **未执行原因(合同 §三D 门控未过)**:上游 api.z.ai 经出口代理**挂起持续 ≥42 分钟**(4 次窗口探针 07:50:52/07:51:43/08:06:27/08:32:35,账本四行全落 status=499 in=0 out=0 零 token;凭据面有效=网关受理转发非 401/403;同期 Magpie hourly probe codex→chatgpt.com 连续 Forwarding failure=出口链路整体劣化)。按合同「额度或新授权无法确认⇒不发起」:**F2-R2/F1-R2 均未发起、未消耗,完整保留**。
- **三结论分立**:①输出配置修复=**成功**(单测 10/10+透传链实读+Pi contract:75;生产横幅 8192 默认运行中);②F1 通过=**未判定(未发起)**;③F2 通过=**未判定(未发起)**。取值冻结 32768(前轮同值保对照链连续/4×默认/≤128000)。若后续窗口恢复,新授权下按同条件执行。

## 7. AUTOLOOP 最小借鉴结论(子包③)

- 重核:HEAD 439be64→**1bd9aa2**(单提交 #278,MIT 不变;不触 A–F/REJECT×5 机制语义;protocol.md ≥100 行号 +2 偏移注记)。
- 逐项裁决(表见 docs/AGENT_AUTOLOOP_REFERENCE.md READINESS-01 节):挂起零消耗恢复=NO-CHANGE;why 因果=**ADOPT P1-1**(只读投影);外部数据隔离+Source 边界=**ADOPT P1-2**(invariant 先行);hop/TTL=**DEFER**(无 Agent 自派发链,禁为假设加机制);Channel=**ADOPT P1-3**(轻量投递,Decision 权威唯一);pause/resume/replay=①NEEDS_RECONCILE 自愈**ADOPT P1-4**(Relay 自身修复候选)②until/replay **DEFER** 待 Source;REJECT×5 维持(事件溯源/SQLite/第二 Rules Engine/第二 Delivery Pipeline/双控制平面);**本包零实施**。

## 8. 独立 Reviewer 的 PASS / REWORK / BLOCKED

| 子包 | Reviewer | 裁决 | 记录 |
| --- | --- | --- | --- |
| ① 部署一致性 | **用户本人**(并行推送 3dea3fa) | **PASS-WITH-FINDINGS**(零 REWORK;5 发现全消化于 83b9318:17→16 表更正/结果 SHA/CI 43330123942 实证/未验证项维持/d-04 注记) | p0-mvp/REVIEW-readiness-01.md(用户提交) |
| ② R2 剩余 | 独立 agent(全新上下文亲测:9 验证点全过) | **PASS-WITH-FINDINGS**(Minor-1=探针叙述与账本对齐,已消化) | p0-mvp/REVIEW-readiness-01-r2.md |
| ③+④ | 独立 agent(全新上下文亲测:含 GitHub API 亲测) | **PASS-WITH-FINDINGS**(Minor-1~4,已消化) | p0-mvp/REVIEW-readiness-01-al-gov.md |

## 9. 遗留问题、风险及回滚方式

- **遗留**:①F1/F2 真实对照(2 次尝试完整保留,待上游稳定窗口+新授权);②生产 maxOutputTokens 维持默认 8192(32768 切换待对照结论,届时改 /home/ubuntu/.relay/console/env+重启 worker,零打印);③HTTPS/PWA:方案 A 待用户裁决;④真机 iPhone A2HS/键盘/safe-area、Android HTTPS 后安装、生产 Follow-up 发送、真实 Decision 动作=**用户实机验收项**;⑤候选包:P1-0 迁移自动化/NEEDS_RECONCILE 自愈(P1-4)/P1-1 Explain/P1-2 Source invariant/P1-3 Channel。
- **风险**:上游(出口代理链路)劣化窗口持续,影响一切真实模型路径;网络窗口期间歇影响 GitHub 推送(本次 SSH-443 重试一次成功);登录会话内存态重启需重登(已知非缺陷)。
- **回滚**:代码=git detached checkout 已知点+systemctl --user restart 双服务(8fe0f7f/67c89f2/2a37a41 全部可用);schema=relay_console 增量迁移无需回滚;本包零生产配置变更(零 restart/零 env 改动),生产自 02:00:08 起未被本包触碰。
- **下一步=用户产品体验裁决入口**:Mac LAN(docs/USAGE_MAC.md)+手机 VPN(docs/USAGE_MOBILE.md),演练场=PAUSED Goal goal-73d01da0;**REAL-PILOT 门保持未激活,Pilot 仓库与任务由您/ChatGPT 决定**。
