# RELAY-SAFETY-AUTHORITY-06 最终报告

裁决:**PASS**(独立 Reviewer 隔离上下文:A 项两轮 REWORK[1 Major=Runbook 示例 XDG_RUNTIME_DIR 值错误,全亲测]→修复→**PASS**;整包终裁 **PASS[0 Major,Minor-1~3 登记且已全部消化]**;冷启动挑战通过/注入探针 25 项+12 场景亲测/文档矩阵抽查属实/压缩不丢事实 8 项抽查/硬禁令 9 条全过)

日期:2026-11-14
合同:a142935(CURRENT.md「RELAY-SAFETY-AUTHORITY-06」ACTIVE;开工冷启动 live main=origin=本地 `a14293558a8d6537ad30ccd58b925203fcf370be`,exact-head CI 43542514450@a142935 test/e2e 双 job success 亲测)

## 1. 基线与 Writer

- 开工冷启动:远端在 a12a5a7(05 收口)之上新增用户合同登记提交 a142935(含 docs/EXTERNAL_PATTERN_COMPARISON_20261114.md 四项目研究登记+README 导航更新);本地纯落后 1 提交(ahead 0/behind 1),`git merge --ff-only` 快进同步;受保护未跟踪 `config/`、`p0-mvp/soak-r3b/` 全程零触碰(审计代理以 find -newermt 独立复核零修改);Writer=本窗口唯一,main-only 快进。
- 边界:零生产迁移/零生产 DB·env·口令写入/零服务 restart/stop/reload/零模型调用/零真实 GitHub 远端写入/零网络改造/零 Core 生命周期·Gate·Policy 修改/零外部源码移植。

## 2. A 项:预检误判修复(红→绿,先过独立检查后展开文档改写)

### 2.1 红态(协调方 Major 反例精确复现+真实生产留证)

- 本会话 shell 有 user bus,显式剥离复现:`env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS node deploy/preflight.ts` @a142935(修复前)⇒ `svc_relay-web/worker.service FAIL"未运行"`(虚构:真实进程 3242781/3242782 在跑,ss 可见 10.30.5.80:8787 监听)+ `process_vs_head PASS"新代码已在进程内生效"`(虚构:进程实为 2026-11-13 02:00:08 旧代码)——与协调方反例完全一致。
- 代码根因三处:`units()` 把 systemctl 失败折叠为 `active:false`(deploy/preflight.ts 旧 448-450);空 stale 集合⇒PASS(旧 124-133);`dirty: dirty.ok && …` 探针失败假 clean(旧 432)。

### 2.2 红绿测试(反例先红)

- 新增 10 用例(R1-R10,`test/integration/deploy-preflight.test.ts` 追加 describe,桩级无 PG/Docker):R1 无 bus=无法查询非未运行/R2 sinceIso 缺失/R3 非法/R4 服务不活跃/R5 git status 探针失败假 clean/R6 HEAD 时间缺失(守卫)/R7 真早于 HEAD(守卫)/R8 全条件可读唯一 PASS 路径(守卫)/R9 同秒歧义 fail-closed/R10 CST 缩写剥离跨时区对照。
- 修复前红态:**7 红 3 绿**(R1-R5/R9/R10 红=缺陷逐一暴露;R6/R7/R8 绿=回归守卫)——证据 `evidence/red-phase-before-fix.log`。

### 2.3 修复(deploy/preflight.ts,判定语义)

- 探针接口:`units()` 行增加 `queryable:boolean`+`reason?`(新导出 `UnitStatus` 类型);`gitHead()` 增加 `dirtyReadable?:boolean`。
- svc_*:查询失败⇒NOT_RUN"无法查询 systemd user bus(<真实 stderr 原因>)…不虚构'未运行'";systemd 已作答的 inactive/不存在⇒FAIL 如实(实证:bus 可用时不存在单元 rc=0+ActiveState=inactive,bus 不可达 rc=1——两态自然区分,无需 stderr 关键字解析)。
- process_vs_head fail-closed:HEAD 时间缺失/不可解析⇒NOT_RUN;任一目标服务无法查询/未运行/启动时间缺失或非法⇒UNKNOWN"不可判 PASS(缺读取依据)"并逐单元列原因;`<=` 同秒歧义归旧代码;**唯一 PASS 路径=全部目标服务 queryable+active+sinceIso 可读且真实晚于 HEAD**。
- git_head:`dirtyReadable:false`⇒NOT_RUN"未能读取被跟踪树状态(fail-closed 不假 clean)"。
- 新导出纯函数 `parseSystemdSinceIso()`:剥离星期与时区缩写后按 ECMAScript 本机时区语义解析(无偏移 ISO=TZ 上海/UTC/芝加哥三时区实证),替代 GNU date 子进程;生产对照实证与 05 版 GNU date 结果逐字节一致(since=2026-11-12T18:00:08.000Z)。
- 修复后:**10/10 绿,全文件 16/16 绿,定向 22/22 绿**;`quality:quick` PASS。

### 2.4 VM80 两环境真实只读对照(证据=evidence/preflight-postfix-{nobus,bus}-20261114.txt)

- 无 bus:svc 两项 NOT_RUN"无法查询"(附真实 stderr)+process_vs_head UNKNOWN"不可判 PASS"——零虚构;裁决 NO-GO 由真实迁移缺失 FAIL 主导(诚实)。
- 显式 bus(`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_RUNTIME_DIR=/run/user/1000`):svc PASS(pid/since 可读)+process_vs_head UNKNOWN"旧代码"(如实)。

### 2.5 Runbook 更新

- deploy/README-deploy.md §0 新增 systemd user bus 前提说明+显式总线复检命令+PASS 判据说明。
- **A 项独立检查(合同门)**:Reviewer 隔离上下文亲审——第一轮 **REWORK(1 Major:Runbook 示例命令 XDG_RUNTIME_DIR 多了 /bus 后缀,照抄必失败"Not a directory";亲测 14 组注入探针四判据全过/16/16 绿/边界合规,唯一阻断=该行文档)**;修复(示例改 `/run/user/$UID`)+采纳 Minor-1(preflight 提示语补 XDG_RUNTIME_DIR)后,Reviewer 复核 **PASS(0 Major,0 新增 Minor)**。A 通过独立检查后才展开 B/C/D 文档改写(合同顺序门)。

## 3. B 项:权威文档审计(全仓 31 文档矩阵)

审计方法:三个只读提取代理(根目录 7 文件+12 ADR/docs 组一 9 文件/UX·策略·部署组 14 文件)+实现者对关键事实的代码级抽查核实;链接完整性全检(根目录与 ADR 零失效;全仓唯一"文件引用错误"=WEB_UX_03_ARCHITECTURE L113 迁移编号 0003→实为 0002,已修)。

| 文档 | 归类 | 处置(全部已实施,除非注明) |
| --- | --- | --- |
| README.md | KEEP | 用户在 a142935 已更新状态行;零失效链接,无需再改 |
| AGENTS.md | CORRECT | L8 过期句"本轮授权仅设计文档"→改为"范围以合同文本为准" |
| ARCHITECTURE_BASELINE.md | CORRECT | L3/L39"本地质量门仍需实现/整体未实现"→实现进度分层(质量三级+对话授权已实现;接管/多 Agent/性能数值仍 OPEN) |
| CONTRACTS.md | CORRECT | L3"P0-00 验证后形成"→schema 已落地 migrations/0000..0009;L22"尚待修改验收"→已实现+CI+复核,线上以重启为界 |
| DOMAIN_MODEL.md | KEEP | 纯语义冻结,无时点声明 |
| P0_P1_ROADMAP.md | CORRECT | L7"P0-00 尚未 ACTIVE"→已完成+进度注记;新增「POC 候选池」节(C 项集成) |
| ADR/README.md | CORRECT | 0012 摘要"实现 OPEN"→标注已实现子项 |
| ADR/0001..0011 | KEEP | 与事实一致(0003/0007/0010/0011 裁决均正确) |
| ADR/0012 | CORRECT | L3/L36"不表示功能已实现"→实现进度分层 |
| docs/PRD.md | KEEP | OPEN-A/B/E 已被 ADR 关闭属"研究开放题过期"性质,本文以 FROZEN+指针结构保留;不逐一改写(避免过度改动权威设计文档) |
| docs/CONSTRUCTION_PLAN.md | KEEP | 冻结计划被历史执行证实;过程文档保留 |
| docs/DETAILED_ARCHITECTURE.md | CORRECT | L36"后生成 migrations"/L99 Pi 取舍/L137 apps/ 布局/L141 OPEN 清单五项已裁决⇒实现现状注记+OPEN 清单收敛(真实仍 OPEN=阈值数值/性能基线/接管多 Agent) |
| docs/SECURITY_MODEL.md | KEEP | 威胁模型与已实现控制一一对应 |
| docs/VALIDATION_PLAN.md | REVALIDATE | L3"未来 P0 产生"→证据现状注记;V21-V29 标题加状态(能力已实现,专项验证未全跑,不以实现冒充验证) |
| docs/INTEGRATIONS.md | CORRECT | L13 vs L24 文内自相矛盾/L63 DBOS OPEN(违反 ADR-0007)/L64 沙箱 OPEN(已实现)→统一已裁决表述 |
| docs/OPERATIONS.md | KEEP | 无过期事实 |
| docs/DELIVERY.md | CORRECT | **唯一与实现直接相反的陈述**(L46"三级入口尚未实现")→已实现(QUALITY-LOCAL-01)+实现注记 |
| docs/FINAL_AUDIT.md | RETAIN_EVIDENCE | 2026-11-09 设计审计快照;头部加"历史快照"限定,L43"当前仓库仍是设计资料"加时点标注 |
| docs/UI_UX.md | CORRECT | §2"四个最小页面"被 WEB-UX-03 推翻⇒实现注记(§2=历史设计,/workspace 为准;§1 原则+状态枚举有效) |
| docs/WEB_UX_03_CONTRACT.md | CORRECT | L3"ACTIVE(03A 阶段)"→03A~03D 已完成+唯一剩余门=⑤用户实机验收;§8 阶段表逐行标真实状态 |
| docs/WEB_UX_03_ARCHITECTURE.md | CORRECT | L3 状态;L113 迁移引用错误修正(0003→0002);L114-115 逐字重复行删除;§5 加"实现以 03C.1 workspace.js 为准" |
| docs/WEB_UX_03_GOAL_FEED.md | CORRECT | L3 状态;实现偏离如实登记(消息 id 单游标+快照整体替换,非 (occurred_at,seq) 二元组);api.ts 行号绑定去除 |
| docs/WEB_UX_PI_WEB_REFERENCE.md | REVALIDATE | L3 状态;**§8 五项〔推断〕对照 pi-web 真实源码复核义务未兑现=保持开放登记(不虚构已复核)** |
| docs/MODEL_POLICY.md | KEEP | 状态自洽(设计冻结/实现 OPEN/激活前置未达成) |
| docs/MODEL_POLICY_REVIEW.md | RETAIN_EVIDENCE | 时点复核记录 |
| docs/USAGE_MAC.md / USAGE_MOBILE.md | REVALIDATE | 对当前线上准确;加"重启为界"时点注记(重启后普通发送≠执行,须显式按钮) |
| docs/PI_WEB_REFERENCE.md | KEEP | 登记台账,零移植与事实一致 |
| docs/AGENT_CONTROL_LOCAL_QUALITY.md | CORRECT | L82"入口尚未实现"→已实现;L118 待实施清单勾销"质量脚本" |
| docs/AGENT_AUTOLOOP_REFERENCE.md | KEEP | 结论仍成立(NEEDS_RECONCILE 不自愈实测仍在);两处行号漂移留待 P1 实施包引用时校正(登记) |
| docs/DEPLOYMENT_PLAN.md | CORRECT | L3"候选拓扑不表示已部署"→已于 11-12 落地+实际拓扑以 README-deploy 为准 |
| deploy/README-deploy.md | KEEP | 部署域唯一事实文档;§0 本包新增 bus 前提 |
| CURRENT.md / docs/CONTINUATION.md | CORRECT+压缩 | 见 §5 |

**审计横向发现(登记,未实施单源化改造)**:G0-G7 门定义双权威(DELIVERY↔VALIDATION_PLAN)、D0-D4 四处重述、六阶段三处重述——属后续治理候选,本轮按"只做真正需要的语义更新"不改写。

**实现/设计/CI/未验收/旧代码五分层(核心结论)**:已实现+CI 绿+Reviewer 复核=Core 全部/Worker/Web/Pi RPC/Gate 双门/工作区绑定/直录完整性/对话授权/质量三级/部署预检(本包修复后);仅设计=MODEL_POLICY/接管多 Agent 会话控制/性能阈值/pstack;真实用户未验收=Mac 实机 UX/手机 VPN/REAL-PILOT 门;24h 运维=PARTIAL 定格;线上旧代码=生产进程(重启为界,见 Runbook)。

## 4. C 项:四项目借鉴逐项裁决(零实施)

- 逐项对照 live main 代码核实后,在 `docs/EXTERNAL_PATTERN_COMPARISON_20261114.md` 追加「2026-11-14 逐项裁决」节(用户原文未改写):**NO-CHANGE(已有)=9 项**——含审计代理研究清单漏列的 `src/core/intents.ts` 两阶段意图日志+三分支 Reconcile(与 AgentRun side-effects/fence 机制直接对应)、lease fencing、Pi vendored、自治刹车等价(Gate 保守停机/abort 旗标/at-most-once 消费)、交接回执(sessions.handoff_ref+C3 回执)、审批卡(03C Decision 内联)、简明工作台(03C.1/03D)、UI 轮询降频;**ADOPT_METHOD=2**(崩溃切片测试补强/事件侧去抖并入 Intake);**POC=6**(受控学习 Skill/预算 UNKNOWN/事件 Intake/来源信任[并入 AUTOLOOP P1-2]/ToolSearch/接管 UI 投影/记忆来源);**DEFER=4**(多 Runtime/BM25 手册/MCP 身份/空闲休眠);**REJECT=1**(第二控制面/进程内队列/高权限 Shell,维持)。
- POC 候选池已登记入 `P0_P1_ROADMAP.md`「POC 候选池」节(立包前须 ACTIVE 合同+独立复核);许可证边界如实注明(AGPL-3.0-only UI 署名条款/Apache/MIT/第三方素材与商标禁复制)。
- **本轮零实施、零代码移植、零新依赖**——符合合同"已有就 NO-CHANGE;新功能仅在现有 ADR/Roadmap 留 POC 候选"。

## 5. D 项:文档实质梳理与压缩

- 语义纠偏:见 §3 矩阵(含 MVP 工程/用户 Mac UX/24h 运维三层验收差别在 CURRENT 风险节+VALIDATION_PLAN+ARCH_BASELINE 三处对齐;生产 NO-GO 四事实+D3 决策集中 CURRENT「关键未解决风险」;Runtime≠Model/main-only 单 Writer/权威分层在治理纪律与 AGENTS 维持)。
- **CURRENT.md 76KB→12KB**:结构=ACTIVE 合同(原文保留)→关键未解决风险与决策(生产 NO-GO 四项/验收三层/登记指针)→历史包索引表(22 行,每行=日期+裁决+关键 SHA+报告路径)→治理纪律→基线终账。压缩前依赖审计:代码/脚本/CI 零引用(仅注释级提及);历史证据文档中的 CURRENT 引用属其自身时代记录,不改写。
- **docs/CONTINUATION.md 71KB→6KB**:结构=短导航头→唯一事实源阅读清单→**运行环境事实(累计,接手必读,完整保留——proxy/ssh:443/user bus/safe-rm/门控 env/setsid 等独特事实)→治理流程→历史归档说明(指针到 CURRENT 索引+Git 历史)**;删除全部逐包长叙述与过期"新窗口可复制指令"(其指向 MVP-READINESS-01 已过期)。
- 未创建第二状态文件;无全仓物理改名;受保护目录零触碰。

## 6. 测试与质量证据

- 定向:deploy-preflight 16/16(6 旧+10 新)+worker-evidence-checks 6/6=22/22(--reporter=verbose,`evidence/targeted-tests-final.log`)。
- 红态证据:`evidence/red-phase-before-fix.log`(7 红 3 绿);两环境对照:`evidence/preflight-postfix-nobus-20261114.txt`+`preflight-postfix-bus-20261114.txt`。
- `quality:quick` PASS(`evidence/quality-quick-20261114.log`;quick=lint+format+typecheck+单测,**不含 integration/browser,不触碰生产 egress 共享栈**——teardownEgress 调用面实证全部位于 test/integration/ 5 文件)。
- **quality:full/release 本地 NOT_RUN(合同 E 项硬约束)**:VM80 真实生产 egress 共享栈在位,全量本地测试可能 teardownEgress 拆除共享栈使运行中 worker 降级;按合同"不能保证安全则 NOT_RUN 交由隔离 CI"——exact-head CI(test job=quality:full 除浏览器+e2e job=浏览器)即为隔离全量权威验证,推送后亲核。
- 演练过程适配:R1 断言从"detail 不含'未运行'"收窄为"不含'未运行(active=false'"(新详情含免责说明,属测试断言精度修正非产品问题);无生产/夹具缺陷发现。

## 7. 独立 Reviewer(隔离上下文;记录原文入库=REVIEW-RELAY-SAFETY-AUTHORITY-06.md)

- **A 项独立检查(合同顺序门,两轮)**:第一轮 REWORK(1 Major=Runbook 示例 XDG_RUNTIME_DIR 值错误;Reviewer 亲测=14 组自建注入探针+VM80 两环境对照+16/16 复跑+CST 三时区+边界合规零越界)→修复→**PASS(0 Major)**;Minor-1(提示语补 XDG_RUNTIME_DIR)采纳落地。
- **整包终裁(代码+文档+证据+不变量):PASS(0 Major,Minor-1~3 登记)**——冷启动挑战通过(仅凭 README→AGENTS→CURRENT 定位唯一 ACTIVE 与验收面);自建 /tmp 注入探针 25 项全过(12 场景含 web 可读+worker 无法查询混合反例/HEAD±1s 边界/同秒歧义;8 组解析反例;5 组 computeVerdict 不变量);两环境复测+22/22 定向复跑(服务/egress/PG 状态不变复核);文档矩阵抽查属实(KEEP 9 个零改动/CORRECT 重点四项全验/迁移引用错误修正属实);C 项三项 NO-CHANGE 到代码实证+POC 池零实施;D 项压缩体积声称精确(75946→12220/70837→6053 字节)+8 个历史事实抽查全部可追溯;硬禁令 9 条逐条核对全过(含 find -newermt 保护目录零触碰);--json 脱敏亲测零泄漏。
- **Minor-1~3 全部消化**:①DELIVERY.md 重复句去重;②DEFER 计数 3→4;③CURRENT.md ACTIVE 合同块恢复与 a142935 字节级一致(弯引号回填)。消化后复跑绿。

## 8. 生产影响、回滚与边界

- **生产影响:零**(零 src/ 改动——git diff 全仓无 src/ 文件;零生产写入/零重启/零配置变更;A 项修复对象 deploy/preflight.ts 为只读工具,B/C/D 为文档;测试全部 p01a_ 隔离 schema+临时目录)。
- 回滚:实施提交整体 `git revert` 即还原(无迁移、无 schema 写入);CURRENT/CONTINUATION 历史内容可从 git 历史完整找回(压缩不删除信息,含归档说明)。
- 边界合规:main-only 单 Writer;禁强推/分支/改历史;config/ 与 p0-mvp/soak-r3b/ 零触碰(独立代理 find -newermt 复核);生产凭据零打印;零模型调用;零真实 GitHub 远端写入;不进入 REAL-PILOT/R-3B/MODEL-POLICY-01;不修改 Core 生命周期/Gate/Policy/Reviewer;不新建常驻服务;零外部源码移植。

## 9. 登记(后续候选,均不阻断、均未实施)

- 历史包叙述单源化(G0-G7/D0-D4/六阶段多处重述收敛)——后续治理候选,本轮不做。
- WEB_UX_PI_WEB_REFERENCE §8 五项〔推断〕对照 pi-web 真实源码复核义务——保持开放登记,不虚构闭环。
- AGENT_AUTOLOOP_REFERENCE 两处行号漂移(worker-entry.ts/supervisor.ts)——留待 P1-1/P1-4 实施包引用时校正。
- USAGE_MAC/MOBILE 在生产重启后按对话授权新语义复核更新(重启为界)。
- 四项目 POC 候选池 6 项(未实施,见 §4)。
- 既有登记不变:M-4 handback/STOPPED 恢复/审计结构化/迁移自动化(DEPLOY-03D)/Minor-PF-1~5/R2-1~4/质量 GAP 8 项/AUTOLOOP P1-1~P1-4。

## 10. NOT_RUN/未验证(如实)

- quality:full/release 本地未跑(生产 egress 共享栈保护,合同硬约束;隔离 CI 为权威口径,推送后亲核 exact-head 双 job)。
- 生产迁移补齐/检查配置/服务重启/生产切换:用户 D3 范围,零执行(生产预检 NO-GO 事实保持)。
- pi-web 真实源码对照复核(§9 开放义务);真机 iPhone Safari/VPN 实机;真实模型 Run/真实 GitHub 交付。
- 新 Agent 冷启动挑战(合同 E 项:仅读 README/AGENTS/CURRENT 能否定位唯一任务)——由 Reviewer 以隔离上下文冷启动方式实质覆盖(其不依赖本会话上下文,从仓库文档独立定位合同与交付面)。
