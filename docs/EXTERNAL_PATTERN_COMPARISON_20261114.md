# Relay 外部四项目源码借鉴对照（2026-11-14）

> 本文是设计候选研究与引用资料，**不是第二事实源、当前工作合同或已验收的功能**。先从 Relay live main 检查既有实现再讨论增量；不引入第三方控制面，不能把项目方 README 和 Benchmark 宣称当本机实测。

## 代码与许可证基线

| 仓库 @ main SHA | 读取到的实际实现（研究，不等于本轮独立跑通） | 许可/风险 |
| --- | --- | --- |
| [nickvasilescu/grokbot-clone](https://github.com/nickvasilescu/grokbot-clone) `7ee6a7ed8464311dbb467bb9ee7c76d9286e56be` | `server/src/agent/loop.ts` Promise 进程内队列；`memory.ts` 历史压缩；`web/src/components/ComputerViewer.tsx` 观看/接管；`ActivityLine.tsx` 简洁进度；`idle.ts` 空闲休眠。README 明言未经安全审计，未查到 Actions 运行。 | MIT；第三方 Grok/xAI/Cursor 素材/商标不属 MIT；高权限 Shell 和进程内队列不可照搬 |
| [Parcha-ai/agentrun](https://github.com/Parcha-ai/agentrun) `b1d717f704599464962aecbf7b026ccfd0421e07`（主体源码检查 `92702dc`） | `packages/serve/src/runner/side-effects.ts` 意图 flush 再副作用；`store/fence.ts` claim epoch 栅栏；`learn/SPEC.md` 与 check/grade 受控学习；`packages/dsl/src/recovery/store.ts` 结果未知不盲重发；`test/durable-crash-sweep` 崩溃注入、`spec/receipts` TLA+/Lean 形式化模型。旧 HEAD `92702dc` 包 CI 绿，较新 HEAD 未核终态（只见 Mac UI conformance 脚本变更）。 | Apache-2.0；证明只涵盖声明的恢复范围，不代表真实 SSH/GitHub exactly-once |
| [agentes-chat/agentes-chat](https://github.com/agentes-chat/agentes-chat) `46e93aede28372d1607836b740fefbc4b94de9b9` | `packages/engine/src/continuation.ts` 有界续接、`brakes.ts` 自治刹车、`works.ts` 后台状态、`tools/directory.ts` 工具按需搜索、`outbox.ts` 受控重试；`test/autonomy/invariants.ts` 状态不变量；ADR 0043/0095/0131/0167/0181 对交接、记忆、MCP 身份有决策记录。exact-head CI 绿。 | AGPL-3.0-only，NOTICE 有额外 UI 署名条款；直接复制代码要另审许可证 |
| [pmndrs/pine](https://github.com/pmndrs/pine) `a341d233f148c8273a1d222f7bb213f69ca997b7` | `src/sources.ts` 订阅启停事件源、`router.ts` debounce/throttle、`store.ts` SQLite 日志+进程内回调、`goals.ts` 有界自主目标、`manual.ts` BM25 手册发现、`security.ts` 来源信任/沙箱；`baseline/RESULTS.md` 上游 Pi 59 项模拟检查，非本轮实测；Release workflow 含 typecheck，不代表完整 E2E。 | MIT；主 Agent 默认高权限 auto 与 Relay 强沙箱不同 |

## Relay 已有能力（必须逐项核实，已有则 NO-CHANGE）

`src/core/goal-loop.ts`（有界重试/熔断）、`lease.ts`（fencing）、`supervisor.ts`（Reconcile）、`budget.ts`（预算）、`decisions.ts`（人工门）、`gates.ts` 与 `gate-orchestrator.ts`（验收证据）、`src/runtime/runner.ts`（Pi 执行与恢复）、`web/`（用户工作台）。Relay 是交付控制系统，状态/预算/Policy/Writer/交付由 Relay Core 唯一拥有，项目 Authority 为 GitHub main + 既有 Architecture/ADR/CURRENT。

| 借鉴机制 | 取舍建议 | 未来证据门/禁止照搬的部分 |
| --- | --- | --- |
| AgentRun 先持久意图再外部调用、未知结果 Reconcile、崩溃和坏实现变异测试 | **ADOPT_METHOD** | 优先对照既有 Intent/Lease/Supervisor/故障测试，先找真实缺口，不声称 exactly-once |
| AgentRun 短笔记→Skill→可验证流程，安全扫描/独立评分/回退 | **POC** | 经验先提议后验收；不能自动改 AGENTS/Policy/Gate/CURRENT，允许零学习结果 |
| AgentRun 未知费用不能算零、多 Runtime 一致性 | **POC** | 对照已有 Budget 与 Adapter，实际测量 Token/返工/质量，不建第二预算控制面 |
| PINE 事件源按需订阅、去抖节流、来源信任、轮次判断与按需手册 | **POC / ADOPT_METHOD** | Event Intake 仅转现有 PostgreSQL Goal/Task/Lease；进程内 Bus 不具可靠持久领取语义；信任不能升级权限 |
| agentes.chat 自治刹车、交接回执、人工决策等待、按需 ToolSearch、MCP Caller 身份/证据记忆 | **ADOPT_METHOD / POC** | 延续唯一 Core；补无效唤醒/漏回执/审批绕行反例；工具目录不得绕过 Policy，签名身份≠授权 |
| grokbot-clone 活动行、工作区、观看/接管、空闲休眠 | **POC** | UI 只投影现有事实；接管必须同时取消旧 Writer/Lease，不是仅开关 VNC；不复制受限素材 |
| 四个项目完整执行服务、进程内队列或默认高权限自动 Shell | **REJECT** | 第二调度器/状态机、弱沙箱与 P0 最小必要设计冲突 |

## 下一轮执行顺序建议

**当前任务仅修复安全预检并整理权威文档**。未来若验证有收益再分别立包：①副作用/崩溃恢复差距审计→②最小事件 Intake→③真实 UI/UX 决策与进度可视化→④受控经验学习→⑤多 Runtime/工具目录的成本质量试验。需对已有代码逐项交叉核对后才可改 Roadmap，避免“为了借鉴而开发”。

### 2026-11-14 Relay 更紧急的独立事实

Relay 05 工程 CI 成功，但 VM80 无 systemd user bus 环境下预检会误把两个实际运行服务报 FAIL，且 process_vs_head 误判 PASS；显式连接 user bus 后表现正常。源码存在“缺读取依据时空集合⇒PASS”逻辑漏洞。生产迁移缺 0008/0009、检查未配置、旧进程与 egress 栈问题仍为 **NO-GO**，任何修复与文档更新均不授权生产迁移/重启。

## 2026-11-14 逐项裁决（RELAY-SAFETY-AUTHORITY-06 C 项；逐条对照 live main 代码后定稿）

上表为研究建议；本节为对照 `src/` 真实代码后的最终裁决。**代码核实补充**：上文"Relay 已有能力"清单漏列 **`src/core/intents.ts` 外部副作用两阶段意图日志**（RESERVED→EXECUTING→COMPLETED/CONFLICT/FAILED；idempotency_key 幂等预留；执行前核对目标真实状态，漂移⇒CONFLICT 绝不强推；"副作用已发生、回执未写"窗口由 Reconcile 三分支兜底：CONFIRMED/ABSENT_REEXECUTE_SAFE/REMOTE_MOVED_NEEDS_HUMAN）——AgentRun"先持久意图再外部调用+未知结果 Reconcile"机制 Relay **已有完整实现**。

| 借鉴机制（来源） | 最终裁决 | 代码核实依据 |
| --- | --- | --- |
| AgentRun 先持久意图再外部调用、未知结果 Reconcile | **NO-CHANGE（已有）** | `src/core/intents.ts` 两阶段意图日志+三分支 Reconcile；架构 §4 正式化 |
| AgentRun claim epoch 栅栏 | **NO-CHANGE（已有）** | `src/core/lease.ts` fencing_token 单调递增+单事务行锁/校验/审计 |
| AgentRun 崩溃切片/坏实现变异测试 | **ADOPT_METHOD（方法登记）** | 已有故障注入面（heartbeatFn 注入、租约回收、abort 竞争 10 用例）；系统性"崩溃切片"测试矩阵无 ⇒ 以现有 Supervisor/租约/意图恢复测试为基，补缺口用例即可，不建新框架 |
| AgentRun 受控学习/Skill（短笔记→可验证流程） | **POC（登记不实施）** | 无对应机制（discoveries 表=发现记录，非 Skill）；经验提升必须先提议后验收，禁自动改 AGENTS/Policy/Gate |
| AgentRun 预算 UNKNOWN 不算零 | **POC** | `src/core/budget.ts` reserve→settle 已有记账；外部调用"结果未知"时的费用记账语义未定义 |
| AgentRun 多 Runtime 一致性合同 | **DEFER** | 当前单 runtime（pi-rpc）；先做深单 Runtime，不预设多 Runtime 抽象 |
| PINE 事件源按需订阅 | **POC（登记不实施）** | 无事件总线；Intake 只能转现有 PostgreSQL Goal/Task/Lease 队列，禁进程内 Bus（无可靠持久领取语义） |
| PINE 去抖节流 | **NO-CHANGE（UI 侧已有）/ POC（后端事件侧）** | web 轮询 8s/30s 后台降频已实现；后端事件去抖随事件 Intake POC 一并评估 |
| PINE 来源信任/沙箱分级 | **POC（并入既有登记）** | 信任边界已有（project registry+allowed_scope+docker 沙箱）；外部 Source 信任分级与 `docs/AGENT_AUTOLOOP_REFERENCE.md` P1-2 同主题，合并登记不重复 |
| PINE 按需手册（BM25 发现） | **DEFER** | 无对应；优先级低于 P1-1/P1-2 |
| PINE Pi SDK 基线 | **NO-CHANGE（已有）** | vendored Pi（`resolveVendoredPi`）+Runtime≠Model 既定原则 |
| agentes.chat 自治刹车 | **NO-CHANGE（已有等价）** | Gate 保守停机/NEEDS_DECISION/budget 止损/abort 旗标+at-most-once 消费（UNIQUE 约束） |
| agentes.chat 交接回执 | **NO-CHANGE（已有）** | sessions.handoff_ref/resume_mode=context_rebuild；CONTROL-SAFETY-04 C3 命令回执审计 |
| agentes.chat 审批卡 | **NO-CHANGE（已有）** | Decision 内联卡（WEB-UX-03C C3）+待我决定 Inbox |
| agentes.chat 按需 ToolSearch | **POC（登记不实施）** | 无工具目录；现有受控命令面（allowedCommands）不得被目录绕过；签名身份≠授权 |
| agentes.chat MCP 调用身份/证据记忆 | **DEFER** | 无 MCP 面；待真实多工具场景出现再评估 |
| agentes.chat 记忆来源分级 | **POC（与受控学习合并评估）** | discoveries+context_rebuild 已有底座；来源分级语义未定义 |
| grokbot-clone 活动流（活动行粒度） | **NO-CHANGE（主体已有）/ POC（增量粒度）** | Goal Feed deriveEvents+工作状态块（P0-4 原位更新）已覆盖；更细活动行属投影粒度调整 |
| grokbot-clone 查看/接管 | **POC（UI 投影）** | API 已实现（CONTROL-READY-03 P1-3：`/abort`、`/takeover` 回执三分）；web 端接管视图无；接管 UI 必须同时取消旧 Writer/Lease 并如实呈现回执，非仅"看屏幕" |
| grokbot-clone 简明工作台 | **NO-CHANGE（方向已交付）** | WEB-UX-03C.1/03D 会话式工作台即此方向；空闲休眠（idle.ts）=DEFER（worker tick 模型已足够） |
| 四项目完整执行服务/进程内队列/默认高权限 Shell | **REJECT（维持）** | 第二控制面/弱沙箱与 P0 最小必要设计冲突 |

**裁决汇总**：NO-CHANGE（已有）=9 项；ADOPT_METHOD=2 项（崩溃切片测试补强、事件侧去抖并入 Intake 评估）；POC=6 项（受控学习/Skill、预算 UNKNOWN、事件 Intake、来源信任[并入 AUTOLOOP P1-2]、ToolSearch、接管 UI 投影、记忆来源[与学习合并]——均为候选登记，**本轮零实施**）；DEFER=4 项（多 Runtime、按需手册、MCP 身份、空闲休眠）；REJECT=1 项（第二控制面/高权限 Shell）。**许可证边界维持**：AGPL-3.0-only（agentes.chat）仅借鉴方法不移植代码，其 NOTICE 附加 UI 署名条款使代码级借鉴需另行法务评估；Apache-2.0（AgentRun）/MIT（PINE、grokbot-clone 本仓库部分）方法借鉴不受限；grokbot-clone 的第三方 Grok/xAI/Cursor 素材与商标不在 MIT 范围，禁止复制。

**Roadmap 集成**：上述 POC 候选统一登记于 `P0_P1_ROADMAP.md`（POC 候选池节），每项未来立包前须按治理规则落 ACTIVE 合同+独立复核；`AGENT_AUTOLOOP_REFERENCE.md` 既有 P1-1/P1-2/P1-3 候选继续有效（C 项来源信任并入其 P1-2）。本轮（RELAY-SAFETY-AUTHORITY-06）不实施其中任何一项。
