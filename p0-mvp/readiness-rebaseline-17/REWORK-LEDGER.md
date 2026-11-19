# RELAY-MVP-READINESS-REBASELINE-17 · 历史 REWORK/缺口逐项消账(2026-11-19)

对象:旧 `p0-mvp/final-coverage-matrix.md`(a8adcab,2026-11-12)未通过项 + REPORT-final §12 遗留表 + CURRENT.md「登记未实施」+ 11R~16R 各包 REWORK。**逐项分类:已解决(提交/测试)/未解决/ADR-0010 重分类/转用户决策或 D3。禁止为变绿改口径。**

## 一、旧矩阵 §5「MVP=REWORK 维持」三条理由

| 历史项 | 当年状态 | 当前归类 | 消账依据 |
| --- | --- | --- | --- |
| ①US-08/G6 真实 GitHub 写入 BLOCKED | ~~BLOCKED~~ → 已解除 | **已解决(2026-11-12)** | R-1 闭环:用户 PAT 补权后 `github-real.test.ts` 全套绿+三重核对+漂移拒绝+历史保全(`p0-mvp/r1-closure.md`;旧矩阵已划账);当前 main 机制面持续由 E2E 本地 bare 全链回归 |
| ②F1/F2 真模型业务交付 PARTIAL | PARTIAL | **→ 层 C BLOCKED(能力结论不可判定;转用户决策;配置修复面=成功)** | 三段真实链条:R-2 对照 2026-11-12 双败如实(`p0-mvp/r2-contrast/`);工程根因已修=ADR-0011(2026-11-13);**复验已获授权并正式执行**——F2-R/F1-R(2026-11-13 01:25/01:50)均 FAILED,归因=上游出口代理 502 硬故障(网关账本零 token 铁证),尝试已消耗不得自动重跑(`p0-mvp/r2-remediation/`);第二轮 F1-R2/F2-R2 已武装(RELAY_MAX_OUTPUT_TOKENS=32768)因上游持续挂起未发起、尝试完整保留(`p0-mvp/readiness-01/R2-ROUND2-NOTE.md` 三结论分开口径);**不再是工程未完成项,亦不得判模型能力不足(模型未被真实调用)**;复验发起=用户决策项(窗口恢复+额度/新授权) |
| ③24h 长稳 PARTIAL | PARTIAL 定格 | **→ ADR-0010 重分类:N/A(MVP)/层 D Pilot** | 原始结论定格不回改;义务移 PILOT-24H(真实使用中 ≥24h);不再阻断 Usable MVP |

## 二、REPORT-final §12 遗留表逐项

| 项 | 当前状态 |
| --- | --- |
| R-1 github-real 闭环 | **已解除**(2026-11-12;见上) |
| R-2 F1/F2 真模型闭环 | 层 C BLOCKED(复验已授权并执行、双败于上游 502 不可判定;第二轮已武装保留待窗口;配置修复 ADR-0011 成功;详见 §一②) |
| R-3 长稳判定 | ADR-0010 重分类 → PILOT-24H(PARTIAL 定格维持) |
| R-4 终审 2 Major | **已修**(e39ed68,当年已划账) |
| R-5a XFF 登录限速信任客户端伪造头 | **已解决**(15 包 `b50ba29`:登录限速/锁定键=socket remoteAddress,无可信反代部署一律不信 XFF;discovery/15 CI 44293665824) |
| R-5b Origin:null 面 | 登记候选非阻断(11/12 包复核口径);非 ADR-0010 必需项,维持登记不升级 |
| R-5c 哨兵伪造面纵深 | 登记候选非阻断(safe-rm sentinel 设计内;D4 VERIFIED 不变) |
| R-5d decision not_found 映射 | 登记候选非阻断;维持登记 |
| R-5e systemd 实装+部署参数 | **→ 层 D**(部署 Runbook 项,随生产切换 D3;模板已在库 relay-*.service.template) |

## 三、11R~16R 各包 REWORK 消账(全部收口或有效)

| 包 | REWORK 内容 | 当前状态 |
| --- | --- | --- |
| 11 | Major-U1 终态执行按钮误导 | **已解决**(11R bb6c6cb:终态显式「新建后续任务」+暂停指引;CI 10/10 真跑) |
| 11R | Major-R2 Goal 创建 ACK 丢失重复创建 | **已解决**(12→12R:幂等键+项目身份冻结;webux12 15/15) |
| 12 | Major-P1 同目录异项目身份误重放 + Minor-K1 UUID 等价 | **已解决**(12R 20dbc07:GOAL_PLANNED 冻结身份精确比对;CI 15/15;协调方 PASS) |
| 13 | Round1 REWORK 2M/3m(p01a 假 0 登记/csrf 前缀入库) | **已消化**(收口更正+脱敏;Round2 PASS;历史如实登记) |
| 14 | Minor-1 harness contract 字段陈旧 | 登记候选非阻断(harness 加固候选;目录+TAG+时间戳三重可消歧) |
| 15 | (独立复核两轮反例)fail-open/.git/index 损坏 | **已解决**(b50ba29 三态 fail-closed;协调方 PASS 0 Major) |
| 16 | Major-1 旧 changeset 验收污染新 changeset | **已解决**(16R 6a2f51f 版本化投影+写入冻结+409;协调方 PASS 0 Major 2026-11-19 + 独立反例复测闭合) |
| 16R | 观察项:created_at 无次级 tiebreaker | 登记候选非阻断(协调方 2026-11-19 明确"不单独制造包") |

## 四、CURRENT.md「登记未实施」清单(维持登记,不自动升级)

M-4 完整 handback / STOPPED 交付工具化恢复 / ControlCommand 审计结构化收敛 / 迁移自动化(DEPLOY-03D)/ Minor-PF-1~5 / R2-1~4 / 质量差距 8 项 / AUTOLOOP P1-1~3 / 四项目 POC 候选池 / 公网 Search-Crawler(P1)/ 多仓-US11(P1)/ Runtime 切换-US12(P1)/ RSI-US13(P1/P2)。
**归类:全部非 ADR-0010 MVP 必需项**(ADR-0010 必需清单=工程七面+R-2 真模型+Operator Console+Mac LAN 八项+手机 VPN 六项+≥1 真实项目 Pilot+无 Critical/Major)。维持登记,不为矩阵变绿而升级或改口径。

## 五、ADR-0010 必需项 → 四层准入映射总表

| ADR-0010 必需项 | 层 | 当前裁决 |
| --- | --- | --- |
| Lifecycle/Lease/Recovery;Pi Runtime;Sandbox;Gate;Reviewer;GitHub Delivery;CLI/API/Web 同 Core | A | VERIFIED(历史机判+当前回归;GitHub 真实写入机制 R-1 VERIFIED,生产级交付走层 D 授权) |
| Operator Console 可实际使用(信息架构) | A(工程面) | VERIFIED(Dashboard/Projects/New Goal/Goal Detail/Decisions/Result/Models·Usage/System 全在库且被 journey/E2E 覆盖;**实际可用感=层 B 用户**) |
| R-2 真实模型 F1+F2 双过 | C | BLOCKED(复验已授权并执行、双败于上游 502 不可判定;第二轮已武装保留,发起待窗口+额度/新授权确认;根因已修) |
| Mac LAN 八项旅程 | B | BLOCKED(用户本人;工程面 LAN_READY) |
| 手机 VPN 六项旅程 | B | BLOCKED(用户本人真机) |
| ≥1 真实项目 自然语言→GitHub Delivery | C/D | NOT_VERIFIED(依赖 C2+真实使用 Pilot) |
| 无 Critical/Major 未解决问题 | A | VERIFIED(16R 协调方 PASS 0 Major 2026-11-19;当前无未解决 Major;非阻断候选全部登记) |
