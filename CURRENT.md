# Relay 当前执行契约

- 状态:**P0-ACCEPT ACTIVE**(2026-11-11 激活;VM80 唯一 Writer)。基点:`f4c1248`(P0-02C 终态,上包已推送核验)。
- 冷启动事实:工作区 clean、HEAD == f4c1248;**VM80 出口代理故障**(git ls-remote 超时 / curl api.github.com 000,http_proxy 8118 + ALL_PROXY 1080 不可用)——离线冷启动已登记;magpie 模型路由(127.0.0.1:3425⇒200)与 PG 容器(relay-p000-pg:55433)正常。**任何推送前必须先恢复网络并核对远端 HEAD == 本地 HEAD 无漂移**;缺口 B(GitHub 真实远端)若网络持续故障则如实标 BLOCKED,不影响其他缺口独立验收。
- 本包性质:**验收与差距裁决包**。以验证、审计、裁决为主,不以验收名义重构业务内核;除验收必需的最小安全收口(逐项登记)外零源码改动。

## 一、第二阶段:六项 MVP 缺口核查(验收口径)

| 缺口 | 验收口径 |
| --- | --- |
| **A. Live Worker 安全与权限** | ① host-fallback 沙箱必须要求 OS 级隔离保证:**不得静默降级**——不能提供 Docker/等价 OS 隔离 ⇒ FAIL-CLOSED(拒绝执行,不得以提示词规则顶替);② `allowedScope`/`allowedCommands` 从 task/RunSpec 到执行器的**完整传递链**自证(漏传 ⇒ 全拒,与 P0-02B 执行语义一致);③ **允许与越权双向实证**:白名单内动作真实成功、白名单外动作真实被拒(非仅单测断言,须有真实进程/容器证据);④ **真实模型 Run 联合验证**:至少 1 次真实模型 Run 走通 Web/API→core→worker→Run→Gate→交付语义全链,预算经 budget_ledger 真实计数——**Stub 不能代替**(Stub 只能佐证机械面,不能佐证模型行为面)。未通过 ⇒ 列发布阻断,不修业务内核(安全收口除外) |
| **B. GitHub 真实远端** | ① 只针对沙箱仓库 `pwl1987/relay-delivery-sandbox`;② PAT 预检:凭据文件存在性/形态区分(有效 github_pat_ 前缀/无效/缺失),**零密钥内容输出**;网络故障须与 401/403/404 区分(超时/DNS 不得报"凭据无效");③ 跑既有 `test/integration/github-real.test.ts`(真实写入 + 漂移拒绝实验);④ 禁退回宽权限 gh token、禁强推、禁触碰其他仓库;⑤ 凭据/网络问题 ⇒ 该项 BLOCKED/NOT_VERIFIED,**不得影响其他独立验收继续** |
| **C. Discovery 与模糊需求** | 对照 PRD US-01/US-02:一句模糊目标 → 可验证建议。**三分类强制**:确定性规则推导/真实模型分析/未实现——逐项标注,不得用规则化分析冒充模型自主发现;模型分析未实现 ⇒ 如实 NOT_IMPLEMENTED 并判缺口(BLOCKED/REWORK 形成独立补建任务) |
| **D. CLI/API/Web 对等** | ① 核实是否存在正式 CLI 入口(package.json bin / scripts / src/cli*);② 三入口(CLI/API/Web)是否同调唯一 Core 权威(零第二状态机);③ 未实现入口**不计入 MVP 能力**,如实登记(不得宣称对等) |
| **E. 连续自治与故障恢复** | ① 真实 `relay-server`/`relay-worker` 进程启停/周期 Tick/重启后断线恢复(非仅单测内嵌驱动);② 故障注入:SIGKILL worker、PG 断连、Provider 离线、超预算、循环失败——逐项真实注入并核对状态机终态与审计;③ D3 长期未决 ⇒ 其他安全 Task 继续(P0-02C J2 已证,复核证据链);④ 未授权动作/不确定副作用 ⇒ 停止走 Reconcile(NEEDS_RECONCILE 语义,不重推);⑤ **长稳**:先冻结环境指标阈值(CPU/RAM/PG 连接/账本漂移),再起长稳观测;**24h/72h 未跑满不得宣称通过**——本包只交付"阈值冻结 + 起跑基线 + 截至包收尾的真实观测段",不足 24h 如实标注 |
| **F. 备份与恢复** | ① 实际执行备份:PostgreSQL(pg_dump)/Evidence/Artifact/配置,产物落受控路径;② **隔离实例恢复**(新起 PG 实例/独立 schema,不是简单重启);③ 恢复后核对全实体:Goal/Task/Run/Gate 证据/Decision/Intent/Audit + 外部 Git 状态核对;④ 不允许用简单重启代替恢复演练 |

## 二、第三阶段:PRD 全覆盖审计矩阵

- 覆盖:US-01~US-10(及 US-11~13 如有)、V01~V15/V19/V20、G0~G7、F1/F2/F3、安全权限/预算/状态恢复/独立 Reviewer/GitHub 交付/真实浏览器交互。
- **六态唯一**:VERIFIED / PARTIAL / NOT_IMPLEMENTED / NOT_VERIFIED / BLOCKED / NOT_APPLICABLE——每项注明证据(文件 + 产出 HEAD SHA);**不得用测试数量代替覆盖率;不得用 Mock/Stub 冒充真实能力**。
- NFR 逐项过(性能/安全/可靠性如实;未测即 NOT_VERIFIED)。

## 三、第四阶段:独立复核与缺口裁决

- 独立 Reviewer(全新上下文)**不依赖实现者自述**:亲测复跑、证据 SHA 核对、结论独立落盘 `p0-accept/REVIEW.md`。
- **安全或 P0 必需未满足 ⇒ MVP 判 BLOCKED/REWORK**;其余项允许继续独立验收。
- 按影响依赖输出**有界 REWORK 工作包**(目标/范围/验收标准/顺序),不得并入一个无限扩大包。

## 四、第五阶段:交付物

`p0-accept/` 下:REPORT.md(总报告)、REVIEW.md(独立复核)、PRD 覆盖证据矩阵、安全故障注入报告、GitHub 交付验收记录、长稳资源预算报告、备份恢复验收报告、缺口与下一工作包清单。全部证据绑 exact SHA;所有阻断关闭才可裁 MVP **ACCEPTED**,否则如实保留未通过结论 + 明确下一唯一工作包。收尾:独立复核通过、CI 成功、main 快进推送、更新 CURRENT.md 与 docs/CONTINUATION.md。

## 五、不可逾越边界(全程)

1. **零生产部署**、零公网暴露;2. **零 RSI 自我修改**(验收包不得修改 Relay 用于自改自身的能力面);3. **零 GitHub 权限扩大**(不新增凭据面、不用宽权限 gh token、不碰 relay-delivery-sandbox 之外的仓库);4. **零模型预算扩大**(真实模型调用仅限缺口 A/C/E 联验必需的最小次数,分阶段经 budget_ledger 预留,先声明后消费);5. 只用 main、禁强推、禁其他分支;6. 不触碰其他业务仓库/宿主其他项目;7. 推送前置 = 网络恢复 + 远端无漂移核对。
