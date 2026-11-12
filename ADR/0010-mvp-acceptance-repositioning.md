# ADR-0010:MVP 验收口径调整——连续 24h 重定位为 Operational/Pilot Readiness Gate

状态:**ACCEPTED(用户指令 2026-11-12;口径裁决,不改历史结论,不静默变更)**。合同登记见 `CURRENT.md`【可用 MVP 最终收口大包】行(d3543c2);本 ADR 为该口径调整唯一裁决记录。

## 背景

- 原 R-3 为 24h 连续运行采集,口径=**空闲 FAIL-CLOSED 稳定性观察**(Worker 空转、零任务领取;中期快照实证 3017 拍全 `IDLE_PROVIDER_DOWN`、RSS 峰值 312936<400000)。12.53h 时点(2026-11-12 06:05+0800)两采集进程被会话解体 SIGTERM 波及,365s 中断缝如实落账,06:10 按原始口径 setsid detached 续采(起点不重置)。
- 按既有收口合同:存在中断缝 ⇒ 终验口径 **PARTIAL,不得称 PASS**;期满 2026-11-12 17:32:52+0800 由独立 Final Runner 出唯一终验快照。
- `docs/VALIDATION_PLAN.md` 原始原则本就规定:"24h/72h 的门槛只在环境和资源可复现时设定,**不可倒填'已通过'**"。
- 项目目标升级:从"技术机制基本齐全"推进到"用户可通过 Mac/手机真正使用、能完成真实软件开发任务的可用 MVP"。

## 决定

1. **连续 24h(及 72h、真实业务负载长稳)不再作为 Usable MVP ACCEPTED 的硬阻断条件**,重定位为 **Operational / Pilot Readiness Gate**。
2. **MVP 阶段验收要求(必需项清单,替代原 24h 门)**:
   - Lifecycle / Lease / Recovery VERIFIED;
   - Pi Runtime VERIFIED;
   - Sandbox VERIFIED;
   - Gate VERIFIED;
   - Reviewer VERIFIED;
   - GitHub Delivery VERIFIED;
   - CLI/API/Web 共用 Core VERIFIED;
   - R-2 至少达到本大包确定的真实模型验收要求(zcode/GLM-5.3,授权四参数不变;F1+F2 双过=VERIFIED,单过或双败=PARTIAL+归因,禁止加预算或降机判换 VERIFIED);
   - Operator Console 可实际使用(信息架构:Dashboard/Projects/New Goal/Goal Detail/Decisions/Review·Result/Models·Usage/System);
   - Mac LAN 用户旅程通过(真实浏览器;8 项:页面正常打开、登录/访问控制符合设计、创建 Goal、查看进度、查看 Decision、查看最终结果、暂停/恢复、页面刷新后状态不丢);
   - 手机 VPN 基础旅程通过(定位=查看+决策+控制,响应式;6 项:Dashboard、Goal 状态、Decision、Result、暂停/恢复);
   - 至少 1 个真实项目任务从自然语言需求到 GitHub Delivery 完整通过(争取 3 个;**项目约束:独立、低风险、非 Relay 自身、有测试、GitHub 可回滚**;用户只能通过正常使用方式提出需求,禁止为验收人为构造理想 Prompt);
   - 无 Critical / Major 未解决问题。
3. **不再作为 MVP 硬阻断的项**(后置或移出 MVP 范围):连续 24h、72h、真实业务负载长稳、MODEL-POLICY-01、ChatGPT Supervisor、动态多模型路由、公网 Search/Crawler、多仓并发。
4. **Pilot 阶段要求(原 24h 门的新位置)**:在真实使用过程中连续运行 ≥24h,包含真实任务、空闲、模型调用、GitHub、DB、Web 操作;无未解释退出、无重复副作用、无状态丢失。
5. **原 R-3 结论保持 PARTIAL(历史事实)**:原始起点、CSV、日志、365s 中断缝、verify 输出全部冻结保留;不修改历史为 PASS;不重启旧 R-3。必须明确写明原因:**"原 R-3 是以空闲 FAIL-CLOSED 为主的稳定性观察,不能充分代表真实业务负载;连续运行验收后移至 Pilot,在真实使用过程中完成。"** PARTIAL 不再阻断 Usable MVP 判定。
6. **原第二包 R-3B(独立空闲 24h 补验)暂缓**:预置产物 `p0-mvp/soak-r3b/` 保持未跟踪、不启动;其目标由 PILOT-24H 吸收。
7. **MVP ACCEPTED 后 Relay 持续运行进入 PILOT-24H**,尽可能包含:用户真实提交 Goal、Worker 空闲、模型调用、GitHub Delivery、PostgreSQL、Web 操作、Mac 访问、手机 VPN 访问、Decision、自然发生的 Restart/Recover。通过后判定 **Operational Readiness = VERIFIED**。
8. **最终裁决报告必须区分三类结论,不得合并为单一 PASS**:**Engineering Verified**(机判/门禁/Reviewer 链路)/ **User Experience Verified**(真实设备真实旅程)/ **Operational 24h Pending | Verified**(PILOT-24H 状态)。
9. 本 ADR 为口径调整唯一裁决记录;`p0-mvp/final-coverage-matrix.md` 在 MVP 最终裁决包按新必需项清单**重生成**并标注口径来源,历史行不回改;`docs/VALIDATION_PLAN.md` 原则(不可倒填已通过)不变且被本 ADR 继承。

## 理由

- **口径错位是调整根因**:R-3 实证的是"空闲空转下不崩、FAIL-CLOSED 正确",不能证明真实业务负载连续性;用它阻断"用户可用性"是把稳定性指标误用为可用性判据。
- **诚实结论与新目标解耦**:365s 中断缝是环境事实(会话解体 SIGTERM 连坐),如实落账后 PARTIAL 是唯一诚实结论;该 PARTIAL 反映采集中断,不反映产品不可用。两者不应捆绑。
- **空闲 24h 重复采集边际价值低**:R-3B 与 R-3 同为空闲口径,再跑一次得到的仍是同类证据;带真实任务、Decision、Web 操作的 PILOT-24H 才具有真正业务价值。
- **MVP 硬门不降反实**:真实模型(F2/F1)、真实用户旅程(Mac LAN+手机 VPN)、真实项目 Pilot 全部保留且新增;可用性由真实使用证明,而非空转时长证明。
- **与 VALIDATION_PLAN 一致**:该计划早已警示 24h/72h 门槛不可硬设、不可倒填;本次调整是正式化而非推翻。

## 备选方案

- (a) 维持 24h 为 MVP 硬阻断并立即启动 R-3B 补跑——仍是空闲观察、仍不代表业务负载,延迟用户可用且边际信息量低,**否决**;
- (b) 将中断缝重解释为 PASS 或回改历史结论——伪造验收事实,直接违反"不可倒填已通过",**否决**;
- (c) 口径静默调整不落合同与 ADR——违反治理规则(不能静默改变历史标准),**否决**;
- (d) 本 ADR 方案:R-3 定格 PARTIAL、口径后移 Pilot、MVP 用真实使用验收——**采纳**。

## 后果

- `CURRENT.md` 大包执行顺序:阶段A 旧 R-3 收口(PARTIAL 定格)→ 阶段B R-2 F2→失败归因→F1 → 阶段C Operator Console 可用性收敛 → 阶段D Mac LAN+手机 VPN 验收 → 阶段E 真实项目 Pilot → MVP 最终裁决(新必需项清单)→ PILOT-24H。
- 阶段C/D 安全边界:Web 第一阶段**仅 LAN+VPN**;禁止公网裸露端口、自动开放公网入口、自动创建公网域名、Cloudflare Tunnel 等外网暴露;禁止浏览器保存 Provider API Key、Web 返回模型凭据明文;Relay Server 与模型凭据仍在服务器侧。
- 真实 Pilot 采集指标:first_pass_rate、accepted_rate、rework_rate、model_calls、wall_time、tool_failure_rate、reviewer_reject_rate、用户人工介入次数、Decision 数量、GitHub Delivery 成功率;并记录用户能否"不懂 Relay 内部细节,只提出业务想法就完成开发"。
- PILOT-24H 数据同时回喂 MODEL-POLICY-01 激活决策(模型优先级以真实 Pilot 数据调整,不允许仅凭理论判断)。
- OPERATOR-CONSOLE 实施包(MODEL-POLICY-01 同级约束)不得提前实施 MODEL-POLICY-01;Models/Usage 页仅做可观察性。

## 残余风险

- PILOT-24H 尚未运行:连续性风险(内存/句柄/PG 连接泄漏、夜间无人处理 Decision 等)在 MVP ACCEPTED 时点仍属未验证,最终报告必须如实标注 "Operational 24h Pending"。
- 真实业务负载可能暴露空闲观察覆盖不到的失败模式(任务领取/恢复/并发副作用等),Pilot 指标是首道真实数据;不得以 MVP ACCEPTED 替代或跳过 Pilot 结论。
- 口径放宽存在被误读为"标准降低"的风险:本 ADR 同时新增真实模型/真实旅程/真实项目三项硬门,总验收强度不减,仅在稳定性维度上把证据位置从"空闲空转"移到"真实使用"。
