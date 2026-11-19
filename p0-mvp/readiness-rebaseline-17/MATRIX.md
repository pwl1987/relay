# RELAY-MVP-READINESS-REBASELINE-17 · 当前 MVP Readiness Matrix(2026-11-19 重建)

- 审计对象:live main `9db5c56`(治理提交;**产品面 = `6a2f51f`**,9db5c56 仅文档)。历史矩阵 `p0-mvp/final-coverage-matrix.md`(审计对象 a8adcab,2026-11-12)**原文不动**,本文件为按 ADR-0010 必需项清单与四层准入的**重生成版**。
- 证据权威序:live 代码 + exact-head CI + 独立复核 > 历史报告。六态:VERIFIED / PARTIAL / BLOCKED / NOT_VERIFIED / N/A。**禁止混层**(合同 §三)。
- 本包零产品代码改动(未发现可独立复现的当前工程 Major;16R 协调方 PASS 0 Major 2026-11-19)。

## 层 A · Engineering Usable(本地/隔离环境完整主路径;**stub 显式标注**)

**裁决:VERIFIED —— 工程主链(需求→绑定→执行→测试→Gate→changeset→交付→结果→用户验收)全通。**

| # | 项 | 裁决 | 证据(当前 main 可追溯) |
| --- | --- | --- | --- |
| A1 | 需求创建(Web/CLI/API 三入口同 Core)+ Goal 创建幂等(ACK 丢失/并发/项目身份冻结) | VERIFIED | webux12 15/15(12/12R);web-journey J1~J5;exact-head CI `44340057681@6a2f51f` 双 success 含计数 |
| A2 | 项目绑定三目录统一(冻结 binding/clean Git seed fail-closed/交付目标装配) | VERIFIED | 15 包 `b50ba29` CI `44293665824`;three-dirs 4/4 + dirty-project 6/6(本轮冒烟 40/40 内) |
| A3 | Discovery 需求理解(模型面) | VERIFIED(历史真模型实证;机制未回归) | US-01/US-02/V01 真模型绿(`p0-mvp/f1/discovery.json`;`test/integration/discovery.test.ts` 真模型门控在库);规则面兜底显式标注(journey J1);绑定解析安全面=15 包 discovery-binding 4/4 |
| A4 | Worker 执行链(Lease/恢复/预算/熔断) | VERIFIED | 历史矩阵 US-05/09/E1 + 当前全量回归(CI [tests] 620);V04/V06/V11 历史机判 |
| A5 | 独立测试/Gate/Reviewer(机判双向/证据时效/保守停机) | VERIFIED | V08/V09 历史机判 + gate-integrity-04A-R2 + evidence-gate-rehearsal 3/3;当前 CI 全量 |
| A6 | changeset/候选 commit(三 SHA 绑定/影响面核验) | VERIFIED | P0-02B D-1/D-2 起全链;journey J4(本轮冒烟)三 SHA 核对 |
| A7 | 仓库交付(本地 bare 全链 + 真实 GitHub 写入机制) | VERIFIED | 每轮 E2E DELIVERED+远端内容核对(journey J4/three-dirs T4);真实 GitHub=R-1 闭环 2026-11-12(`github-real.test.ts` 全套+漂移拒绝+历史保全,用户 PAT 补权后);**生产级外部交付仍走授权路径(层 D)** |
| A8 | 结果展示真相层(delivery truth/provenance/仓库交付中性标签/修改详情可达) | VERIFIED | 16 `df3ff59` CI `44311004493` + 16R `6a2f51f` CI `44340057681`;result-truth V1/V2 |
| A9 | 用户接受/拒绝结果(版本化投影/旧验收不污染新版本/拒绝零内部副作用) | VERIFIED | 16R `6a2f51f` + 协调方独立 PG 反例复测(`16R/COORDINATOR-REVIEW-20261119.md`:A 保留/B null/Goal null)+ result-truth-16r 2/2 |
| A10 | 安全面(safe-rm 中央守卫/越权拒绝/注入语料化/登录限速不信任 XFF/Discovery 越权封堵) | VERIFIED | D4/F3 历史机判;XFF 修复+Discovery projectDir 封堵=15 包;f3-injection T01 |
| A11 | **当前 main 隔离主路径冒烟(本轮,2026-11-19)** | VERIFIED(stub 显式) | 六套件 40/40 全绿(`evidence/mainpath-smoke.log`;stub 大脑/本地 bare 远端/一次性 schema,零生产零真实模型);**stub 成功只证工程链,不代表真实模型能力(层 C)** |

## 层 B · User UX Acceptance(**只能由用户本人 ACCEPTED/REWORK;Agent 不代判**)

**裁决:BLOCKED —— 等待用户本人实机体验;这是 ADR-0010 MVP 硬门,且是当前唯一零工程前置、随时可进行的未决门。**

| # | 项 | 裁决 | 证据/前置 |
| --- | --- | --- | --- |
| B1 | Mac LAN 旅程(ADR-0010 八项:打开/登录/创建/进度/Decision/结果/暂停恢复/刷新保真) | BLOCKED | 工程面已就绪:14 包 `--lan` LAN_READY(Reviewer PASS)+ MAC 卡 2026-11-18 版(`p0-mvp/web-ux-acceptance-11/MAC-ACCEPTANCE-CARD.md`);**用户本人未反馈**(USER_DECISION 自 13/14 挂起至今) |
| B2 | 手机 VPN 基础旅程(ADR-0010 六项) | BLOCKED | 同上;真机 VPN/刘海/软键盘 NOT_TESTED 如实登记(13 包);模拟视口 390 测试通过=工程响应式面,不代替真机 |
| B3 | WEB-UX-03 UX ACCEPTED 总门 | BLOCKED | 唯一归属用户本人;11R~16R 全部 Engineering PASS 均不构成 UX 验收 |

## 层 C · Model Capability(**R-2 历史结论与工程链路严格分离**)

**裁决:BLOCKED —— 复验已获授权并正式执行、双败于上游 502 不可判定;第二轮已武装保留,发起待上游窗口恢复+额度/新授权确认(用户决策);生产 32768 采值切换待新授权;非工程缺口。**

| # | 项 | 裁决 | 证据 |
| --- | --- | --- | --- |
| C1 | 真模型 Discovery 质量 | VERIFIED(历史) | 同 A3(magpie 本地路由,零成本;Reviewer 自建需求复验非过拟合) |
| C2 | 真模型业务修改交付(F1/F2) | NOT_VERIFIED(能力结论**不可判定**;配置修复面=成功) | 真实链条(逐环有据):①R-2 对照 2026-11-12 双败如实(F2 BUDGET_EXHAUSTED@6 止损正常/F1 沙箱 maxTokens:8192 截断零编辑,`p0-mvp/r2-contrast/`);②工程根因已修=ADR-0011 maxOutputTokens 运行时配置(2026-11-13);③**复验已获授权并正式执行**:F2-R(01:25:57)/F1-R(01:50:38)均 FAILED——归因=**上游出口代理 502 硬故障**(网关账本 12 次请求全 502、in=0/out=0 零 token 铁证),尝试已消耗、合同禁止自动重跑(`p0-mvp/r2-remediation/`);④第二轮 F1-R2/F2-R2 已完整授权武装(RELAY_MAX_OUTPUT_TOKENS=32768 冻结取值)但因上游持续挂起 ≥42 分钟**未发起、尝试完整保留**(`p0-mvp/readiness-01/R2-ROUND2-NOTE.md`;三结论分开口径:输出配置修复=**成功**;F1 通过=未判定(未发起);F2 通过=未判定(未发起),三者不得合并);生产 32768 采值切换待新授权。**故:非工程缺陷(配置修复实证成功),亦不得判"模型能力不足"(零 token,模型未被真实调用)**;复验发起=待上游窗口恢复+额度/新授权确认(用户决策项) |
| C3 | 真实项目任务 自然语言→GitHub Delivery 完整通过(ADR-0010 ≥1,争取 3) | NOT_VERIFIED | 依赖 C2(真实模型)+ 用户真实使用(Pilot);stub 链与真实 GitHub 机制面均 VERIFIED(A7)但不得冒充本项 |

## 层 D · Production Cutover(**只读刷新 2026-11-19;任何写入/迁移/重启须用户 D3**)

**裁决:NO-GO 维持 —— 历史四项阻断事实全部仍成立(本轮只读复测逐项确认)。**

只读证据:`evidence/prod-preflight-readonly.json`(18 探针;独立 Reviewer 程序化比对零差异)。

| # | 项 | 裁决 | 本轮只读实测(`evidence/prod-preflight-readonly.json`,HEAD=9db5c56) |
| --- | --- | --- | --- |
| D1 | migrations 0008/0009 | **FAIL 维持** | 迁移缺失:0008(goal_messages.execution_request)/0009(tasks.abort_requested_at);补齐写生产 schema 须 D3 |
| D2 | RELAY_EVIDENCE_CHECKS_JSON | **UNKNOWN 维持** | 未配置 ⇒ 代码变更候选 Gate 保守停机(fail-closed 安全;自动放行不可用)=D3 决策项 |
| D3 | 线上进程版本 | **UNKNOWN 维持** | relay-web/relay-worker pid 3242781/3242782 自 2026-11-12T18:00:08Z(=11-13 02:00+08)运行,早于其后全部提交 ⇒ 旧代码,新语义以重启为界 |
| D4 | egress 约束栈 | **UNKNOWN 维持** | network 与 proxy 均缺失 ⇒ 运行中 worker 降级;重启后首拍 ensureEgress 自愈,Runbook 须核对 egress ready 横幅 |
| D5 | 部署树清洁 | **FAIL(登记,不属本包)** | git_head=被跟踪树存在未提交修改(=VM80 工作树 75 项保护面脏文件);部署必须来自确切提交;清理属 D3 决策,本包合同禁止清理 |
| D6 | 其余准入面 | PASS | 服务双运行/凭据 600/env 12 键零取值/web_bind 10.30.5.80:8787 LAN 单接口/docker+沙箱镜像/db 可达 16 表/db_inflight 无阻断(BLOCKED=1 PAUSED=1)/归属绑定旧格式行 1 个=登记残留 R2-D3 由双门把关如实 |
| D7 | Operational 24h(PILOT-24H) | N/A(MVP 内) | ADR-0010 §1:连续 24h 移出 MVP 硬门 → Pilot 阶段在真实使用中完成;原 R-3 PARTIAL 定格不回改 |

## 总裁决

**ENGINEERING_READY → USER_ACCEPTANCE**(理由见 REPORT-17.md §裁决):

- 层 A 全 VERIFIED(含本轮 40/40 独立冒烟 + exact-head CI 620/85 双绿含计数)——工程侧无当前 Major,零产品代码改动;
- 层 B 是 ADR-0010 硬门中**唯一零前置、随时可进行**的未决项(MAC 卡 + `--lan` 一条命令);
- 层 C 待用户决策(R-2 复验已授权并执行、双败于上游 502 不可判定;第二轮已武装保留,发起待上游窗口恢复+额度/新授权确认,生产 32768 采值切换待新授权),层 D 待用户 D3——两者都不因再写代码而推进;
- 历史矩阵三条 REWORK 理由的最终归类:①US-08/G6 已解除(2026-11-12);②F1/F2 → 层 C(工程根因 ADR-0011 已修;复验已授权并执行、双败于上游 502 不可判定,第二轮保留待窗口);③24h → N/A/层 D Pilot(ADR-0010 重分类)。
