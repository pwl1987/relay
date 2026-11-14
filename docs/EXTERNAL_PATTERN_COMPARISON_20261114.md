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
