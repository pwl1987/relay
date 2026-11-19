# RELAY-MVP-READINESS-REBASELINE-17 · 实施报告(MVP 重新基线/准入审计)

日期:2026-11-19。基线:`9db5c56476143f2e6f9ef01ef19570b0ddd2edeb`(ff-only 自 6a2f51f;产品面 = `6a2f51f`)。合同:`CONTRACT.md`(ACTIVE)。Writer=本地开发 Agent。

## 一、本包做了什么(审计包,零产品代码改动)

1. **权威资料交叉核对**:PRD(P0 十三 US/NFR/MVP 出口)、DETAILED_ARCHITECTURE、VALIDATION_PLAN(V01~V29/G0~G7/三 Fixture)、ADR-0010(MVP 必需项清单+四层结论分离)、ADR-0011(maxOutputTokens 根因修复)、旧 final-coverage-matrix(a8adcab)、REPORT-final、11R~16R 全部实施/复核记录、live code 与 exact-head CI(`44293665824@b50ba29`/`44311004493@df3ff59`/`44340057681@6a2f51f` 含计数)。
2. **重建四层 readiness matrix**(`MATRIX.md`;历史矩阵原文零改动)。
3. **历史 REWORK 逐项消账**(`REWORK-LEDGER.md`;三类处置:已解决/重分类/转用户或 D3,零口径篡改)。
4. **当前 main 隔离主路径独立冒烟**(§二)。
5. **只读生产 readiness 刷新**(§三)。
6. **唯一下一阶段裁决**(§四)。
7. **零产品代码改动**:未发现可独立复现的当前工程 Major(16R 协调方 PASS 0 Major + 六套件冒烟 40/40 + exact-head CI 双绿),按合同 §五 仅 4 号选项可开修复包,本包不触发。

## 二、当前 main 隔离主路径冒烟(2026-11-19;stub 显式)

- 方式:RELAY_E2E=1 真实 PG(一次性 schema)+真实 Web/HTTP+真实 chromium,六套件一次运行(`evidence/mainpath-smoke.log`):**40 passed / 40,EXIT=0**。
  - web-journey 7(J1 模糊需求→J2 决策→J3 崩溃恢复→J4 候选/独立验证/Gate/本地 bare 交付→J5 刷新断线保真)
  - three-dirs 4(clean Git 注册项目+冻结绑定+allowed_scope=/workspace+内建 seed+真实交付远端 HEAD==commit)
  - dirty-project 6(dirty/不可验证 Git 状态 fail-closed 零交付)
  - webux12 15(创建幂等:ACK 丢失/并发/项目身份/409 面)
  - result-truth 6(delivery truth/provenance/dead-control/接受+刷新保持/拒绝不改 Gate)
  - result-truth-16r 2(**A 验收后新 B 不继承旧验收**+仓库交付中性标签)
- 合同 §四-3 九项全被覆盖:clean 注册项目✓/冻结绑定✓/执行链✓/Gate·changeset✓/本地 bare 交付✓/结果页 provenance·delivery truth✓/用户接受✓/新版本不污染旧验收✓/拒绝不改内部 Gate✓。
- **诚实边界:大脑=确定性 stub(provider stub,baseUrl 不可达层),交付=本地 bare 远端,零真实模型零外部 GitHub**——stub 成功只证工程链路(层 A),不代表真实模型能力(层 C);该标注同时写入 MATRIX.md A11。

## 三、只读生产 readiness 刷新(2026-11-19;零写入零重启)

`node deploy/preflight.ts --env-file ~/.relay/console/env --pg-container relay-p000-pg`(`evidence/prod-preflight-readonly.json`,18 探针;独立 Reviewer 对该 JSON 程序化比对零差异;裁决=**NO-GO**):

| 历史阻断项 | 本轮实测 | 结论 |
| --- | --- | --- |
| migrations 0008/0009 | **仍缺失**(FAIL) | 维持;补齐须用户 D3 |
| RELAY_EVIDENCE_CHECKS_JSON | **仍未配置**(UNKNOWN;Gate 保守停机 fail-closed) | 维持;配置或接受保守停机=用户 D3 |
| 线上进程版本 | relay-web/worker pid 3242781/3242782 自 2026-11-13 02:00+08 运行,**早于当前 HEAD**(UNKNOWN) | 维持;旧代码,新语义以重启为界 |
| egress 约束栈 | **仍不在**(network+proxy 均缺;worker 降级;重启首拍自愈) | 维持;切换 Runbook 核对 egress ready 横幅 |
| 部署树清洁 | 被跟踪树存在未提交修改(=VM80 75 项保护面脏文件)(FAIL) | 登记;清理=D3 决策,本包禁止 |

PASS 面:服务双运行/凭据 600/env 12 键(取值零输出)/web_bind 10.30.5.80:8787 LAN 单接口/docker+沙箱镜像/db 可达 16 表/db_inflight 无阻断(BLOCKED=1 PAUSED=1)/归属绑定旧格式行 1 个(登记残留 R2-D3,双门把关如实)。

## 四、唯一下一阶段裁决

## **ENGINEERING_READY → USER_ACCEPTANCE**

理由(对照合同 §五四选项):

1. **层 A 全 VERIFIED**:ADR-0010 工程七面(Lifecycle/Pi/Sandbox/Gate/Reviewer/GitHub Delivery/CLI-API-Web 同 Core)+Operator Console 信息架构+结果真相层,全部有当前代码/测试/CI/独立实证;本轮 40/40 冒烟与 exact-head CI 620/85 双绿含计数;16R 协调方 PASS 0 Major——**无当前工程 Major,无最小 REWORK 包的事由**(4 号选项不触发)。
2. **层 B(User UX)是 ADR-0010 MVP 硬门中唯一零前置、零成本、随时可进行的未决项**:Mac/手机实机体验路径已就绪(`node scripts/webux11-preview.mjs --lan` → `http://10.30.5.80:8790/workspace`,MAC 卡 2026-11-18 版),USER_DECISION 自 13/14 挂起至今;B 层只能由用户本人裁决,Agent 不代判。
3. **层 C(Model Capability)BLOCKED 于真实模型复验窗口与用户决策,非工程缺口**:真实链条=①R-2 对照 2026-11-12 双败;②工程根因已修(ADR-0011,配置面实证成功);③复验**已授权并正式执行**——F2-R/F1-R(2026-11-13)均 FAILED,归因上游出口代理 502 硬故障(零 token),尝试已消耗不得自动重跑;④第二轮 F1-R2/F2-R2 已完整武装(32768 冻结取值)因上游持续挂起未发起、尝试完整保留——**不是再写代码能推进的项**:复验发起只差上游窗口恢复+额度/新授权确认(用户决策);生产 32768 采值切换亦待新授权。按"唯一裁决"纪律,下一阶段包=USER_ACCEPTANCE;模型复验在用户批准窗口后随时可发起(零新增工程)。
4. **层 D(Production Cutover)BLOCKED 于用户 D3**:NO-GO 维持(§三);PRE-D3 材料已定稿(D3-DECISION-PACK 2026-11-15)但生产切换在 UX 验收与真实模型确认之前启动违背 ADR-0010 阶段序(阶段 D→E→最终裁决),不选。
5. **停止编码符合合同本意**:「不得为了还有东西可以优化而继续创建泛化重构包」——登记候选(ledger §四)全部维持登记不升级。

**用户动作(不受本包阻塞,随时可开始)**:①按 MAC-ACCEPTANCE-CARD(2026-11-18 版)实机体验并回复「可用/卡在何处+截图」;②(模型路线,可选并行)确认上游窗口恢复+额度后批准发起已武装保留的第二轮 F1-R2/F2-R2 各一次正式尝试,并单独批复生产 RELAY_MAX_OUTPUT_TOKENS=32768 采值切换。

## 五、边界

零生产写入/迁移/重启(生产仅只读 preflight 采样);零真实 GitHub 外部交付;零 migration/schema;零产品代码改动(本包提交面=纯文档+证据);75/76 项历史脏文件零触碰;生产 PID 前后一致。

## 六、验证与复核

- 本包质量面:纯文档包,`quality:quick`(lint/format/typecheck/unit 191/191)提交前复跑,日志留证 `evidence/quality-quick.log`;exact-head CI 推送后核验。
- 独立 Reviewer(全新上下文):**Round1 = REWORK(2 Major/2 Minor,全部文档面;零产品代码问题;边界零违反)**——Major-1=本报告/MATRIX/LEDGER 曾把 R-2 复验误写为「从未执行待首次授权」,与在库证据(ADR-0011 授权原文/r2-remediation 两次正式尝试 502 归因/R2-ROUND2-NOTE 保留口径)相悖,已按真实链条重写;Major-2=§六曾预断 Reviewer 裁决并引用不存在的 REVIEW 文件,已删除改为如实登记;Minor-1=quality:quick 留证缺失,已补 `evidence/quality-quick.log`;Minor-2=空 prod-preflight .log 已删除、引用收敛至 JSON。Reviewer 同时独立证实:冒烟 40/40(cloned HEAD 重跑逐点一致)、preflight 18 探针零差异、三个 CI run gh API 独立核验、消账无口径篡改、四层结构与裁决方向可维持。
- **Round2 = REWORK(1 Major 残留/无新增 Minor/无回归)**:Major-2/Minor-1/Minor-2 消化合格;Major-1 主单元格(C2/②/§四.3/用户动作)重写合格,但 5 处汇总单元格(层 C 标题行/总裁决理由 3、4/LEDGER §二 R-2/§五 R-2)残留「待授权/四参数」旧口径——本轮已逐行机械对齐为真实链条(复验已授权并执行、双败于上游 502 不可判定;第二轮已武装保留,发起待上游窗口恢复+额度/新授权确认;生产 32768 采值切换待新授权)。Round3 复审结论见 `REVIEW-17.md`(由 Reviewer 复审后落盘,不预断)。
