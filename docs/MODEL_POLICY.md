# Relay Model Policy v0.1(MODEL-POLICY-00 设计冻结)

状态:**ACCEPTED(v0.1 设计冻结;实现 OPEN)**。本文件是 MVP 后 Relay Model Policy 的正式设计:只冻结边界、数据模型、状态机与路由规则,**不含任何实现代码**。激活前置:MVP 最终 ACCEPTED 后由 MODEL-POLICY-01 实施(见 §10)。

- 依据:用户指令《MODEL-POLICY-00 设计包》(2026-11-12);R-2 调查证据(`p0-mvp/r2-model-investigation.md`、`p0-mvp/r2-failure-analysis.md`);架构基线 §5("Runtime != Model;模型提供商、能力层级及版本均独立配置");ADR-0003/0004。
- 裁决记录:`ADR/0009-model-policy.md`。
- **当前 MVP 链路不变**:R-2 对照实验仍按授权走 Magpie + `zcode/GLM-5.3`;本设计不改变任何现有路由变量、不消耗模型额度、不干扰 R-2/R-3B/soak。

## 1. 目标与非目标

**目标**:把"用哪个模型、为什么用它、还能不能用"从隐式路由组行为升级为 Relay Core 显式拥有、可持久化、可审计、可降级的策略面。R-2 实证的缺陷正是本设计要消除的:运行时调用面上游身份不可见(仅事后经 Magpie 路由日志对账可见)、回退成员因本机代理故障不可用而调用方不可见、失败归因已精确化为"Flash 级单模型×受限回合预算"组合但链路内无显式升级面可修正。

**非目标**:不做 token 级动态换模型;不做模型自我改写策略的 RSI;不在 MVP 内迁移或删除 Magpie;不承诺任何模型的未实测能力(本地 Qwen/MiniMax M3.1/ChatGPT OAuth 通道均在 MODEL-POLICY-01 真实验证)。

## 2. Provider 四层分层

四类主要模型资源,按稀缺度与角色定位:

### 2.1 LOCAL_PRIMARY —— `Qwen3.8-Flash-Next Q5`

| 项 | 定位 |
| --- | --- |
| 角色 | 本地默认 Coder |
| 适用 | Discovery、文件分析、普通 Bug、普通功能开发、测试修复、日志分析、大批量低/中风险任务 |
| 资源面 | 本地 8×4090;用户口径实测约 100 tok/s(来源:用户指令 2026-11-12,**Relay 链路内未实测,MODEL-POLICY-01 须校准**) |
| 额度 | 无云端额度约束 ⇒ 允许长期大量使用 |
| 稀缺度 | UNMETERED |

### 2.2 CLOUD_PRIMARY —— `MiniMax M3.1`

| 项 | 定位 |
| --- | --- |
| 角色 | 云端主力 Coder;中等/复杂任务;**Qwen 失败后的第一升级层**;与其他模型组成异构 Reviewer |
| 额度模型 | **5h 时间窗口型资源**;不按 GLM 周额度方式管理;视为"可恢复高吞吐资源"(窗口耗尽→等待 reset,非永久损失) |
| 稀缺度 | NORMAL(窗口内)/ EXHAUSTED(窗口耗尽,reset 后恢复) |

### 2.3 SCARCE_GLM_POOL —— 共享额度池

**硬约束:`GLM-5.3-Flash` 与 `GLM-5.3` 必须引用同一个 `glm_weekly` QuotaPool;Relay 不得将其误认为两个独立额度池。**(单池记账是本设计的不可违反项;违反即预算对账失效。)

| 模型 | 角色 |
| --- | --- |
| `GLM-5.3-Flash` | 高级 Reviewer;MiniMax 失败后的升级 Coder;较复杂任务 |
| `GLM-5.3` | **战略储备**:高复杂、高风险、连续失败任务;**不用于普通流水线工作** |

稀缺度:SCARCE(池内有余量)/ RESERVE_ONLY(`GLM-5.3` 的默认策略位)/ EXHAUSTED(周额度耗尽,`reset_at` 后恢复)。

### 2.4 SCARCE_SUPERVISOR —— ChatGPT Plus / Codex

| 项 | 定位 |
| --- | --- |
| 角色 | 技术总监:架构质疑、需求合理性判断、连续失败归因、高风险最终 Reviewer、"是否继续消耗稀缺模型"的裁决 |
| 边界 | **ChatGPT 不得成为 Relay 生命周期、状态机或调度系统的必需依赖;ChatGPT 不可用时 Relay 必须继续工作**(与架构基线"不依赖 ChatGPT"、README"ChatGPT 是可选入口"一致) |
| 稀缺度 | SCARCE(人工订阅资源,无 API 化额度观测 ⇒ 状态可为 UNKNOWN) |

## 3. Magpie 重定位

未来架构中:**Magpie = optional provider / compatibility adapter / experiment router**。

- 不得继续作为 Relay 唯一模型控制中心;Relay 自身拥有:Provider Registry、Model Policy、Quota Policy、Health Policy、Escalation Policy(全部落在 Core/PostgreSQL,见 §4)。
- **暂不删除 Magpie,也不在当前 MVP 中迁移现有链路**:R-2 对照实验、A-4 授权实验仍走 Magpie;迁移在 MVP 后按 MODEL-POLICY-01 的评估结论另行授权立项,且迁移完成前 Magpie 是合法 provider 之一(经 Registry 显式登记,而非隐式前提)。
- 经 Magpie 的条目在 Registry 中如实登记:`endpoint_type=openai-completions`、`auth_source=magpie`;**对照实验必须记录具体模型 id(非组名),Magpie 路由日志可双向对账**(R-2 调查已实证该机制)。

## 4. 数据模型(v0.1 草案)

TypeScript 接口草案;持久化载体(MODEL-POLICY-01 落地)为 PostgreSQL 新表,与现有 `budget_ledger` 并列;**命名映射约定:TS camelCase ↔ PG snake_case 列名**(如 `quotaPoolId` ↔ `quota_pool_id`),实施按此机械映射防漂移。**两者口径分开**:`budget_ledger` 是 Goal 级回合账本,QuotaPool 是 Provider 级资源视图——**测试次数 ≠ 模型请求次数**(第四包遗留③对账教训)。

### 4.1 基础类型

```ts
/** 模型引用:永远是具体 provider/model 对,禁止用路由组名冒充模型标识 */
interface ModelRef {
  providerId: string;   // "zcode" | "minimax-code" | "local-qwen" | "openai-codex" | "magpie" ...
  modelId: string;      // "GLM-5.3" | "GLM-5.3-Flash" | "MiniMax-M3.1" | "Qwen3.8-Flash-Next Q5"(草稿标识,以 01 实施时上游注册名为准)
}

type EndpointType =
  | "openai-completions"   // 现役(Magpie 及兼容网关)
  | "local-http"           // 本地 OpenAI 兼容服务(OPEN:待 MODEL-POLICY-01 实测定型)
  | "oauth-codex";         // ChatGPT Plus/Codex OAuth(OPEN:待实测)

/** auth_source 只记来源类别,永不存 Key 明文(占位 key + egress 改写机制不变) */
type AuthSource = "magpie" | "local" | "oauth" | "env-injected";

type Locality = "local" | "cloud";

type HealthState = "healthy" | "degraded" | "unreachable" | "unknown";

type ModelFamily = "qwen" | "minimax" | "glm" | "openai" | "other";
```

### 4.2 ProviderRegistry

```ts
interface ProviderEntry {
  providerId: string;
  modelId: string;
  endpointType: EndpointType;
  authSource: AuthSource;          // 不含任何凭据材料
  capability: {
    reasoning: boolean;            // /v1/models 实测字段对齐(如 group/gm 的 reasoning/tool_call)
    toolCall: boolean;
    contextTokens: number;
  };
  health: HealthState;             // 由 Health Policy 观测写入(§5.3)
  latency: { p50Ms: number | null; p95Ms: number | null }; // 采自真实调用观测,非手填
  locality: Locality;
  modelFamily: ModelFamily;        // 异构约束(§7)的判定依据
  roles: Array<"coder" | "reviewer" | "supervisor">; // 允许承担的角色
  quotaPoolId: string | null;      // GLM 双模型必指同一 pool
  scarcity: Scarcity;              // 冗余自 QuotaPool 的最近观测(决策时快照用)
  enabled: boolean;                // 人工/策略开关;false 时绝不入选
}
```

### 4.3 QuotaPool

```ts
type QuotaLimitType =
  | "unlimited"            // 本地资源
  | "five_hour_window"     // MiniMax M3.1
  | "weekly"               // glm_weekly
  | "dynamic_allowance"    // 上游动态配给(OPEN:观测语义待实测)
  | "metered"              // 按 token/请求计费
  | "manual"               // 人工额度(如 ChatGPT 订阅,无 API 观测)
  | "unknown";

interface QuotaPool {
  poolId: string;                  // "glm_weekly" | "minimax_5h" | "local_unlimited" ...
  limitType: QuotaLimitType;
  remainingState: number | "unknown" | "window_open" | "window_closed";
                                   // 尽力观测;观测不到必须如实记 unknown,禁猜测
  reserved: number;                // 为在途 Run 预留的量(防超卖)
  resetAt: Date | null;            // weekly/window 型的重置时点
  health: HealthState;
  members: ModelRef[];             // 引用本池的全部模型;glm_weekly 必含 GLM-5.3 与 GLM-5.3-Flash
  updatedAt: Date;
}
```

**同池硬约束(校验规则)**:凡 `modelFamily=glm` 的条目(含 `zcode/GLM-5.3`、`zcode/GLM-5.3-Flash`),`quotaPoolId` 必须等于 `glm_weekly`(以家族而非 providerId 为锚,避免同提供方未来引入非 GLM 模型时误伤);Registry 写入时校验,违反即拒绝落库。

### 4.4 Scarcity(正式定义)

| 级别 | 语义 | 典型归属 |
| --- | --- | --- |
| `UNMETERED` | 无额度约束,允许长期大量使用 | LOCAL_PRIMARY |
| `NORMAL` | 有额度但窗口/余量充裕 | CLOUD_PRIMARY(窗口内) |
| `SCARCE` | 周期型稀缺额度,须按需使用并预留 | SCARCE_GLM_POOL(Flash 侧) |
| `RESERVE_ONLY` | 战略储备,默认不用于普通流水线 | `GLM-5.3` |
| `EXHAUSTED` | 已耗尽,等待 `reset_at` | 任何池 |
| `UNKNOWN` | 未观测,决策时按最保守处理 | 新接入 provider |

### 4.5 RunModelDecision(每次 Run 必须持久化的决策留痕)

```ts
interface RunModelDecision {
  runId: string;
  attemptNo: number;               // 同一 Task 内第几次 Attempt(升级链推进的序号)
  candidates: ModelRef[];          // 本边界上参与评选的全部候选
  chosenModel: ModelRef;           // 最终选中(具体 id,禁组名)
  providerId: string;
  quotaPoolId: string | null;
  scarcityAtDecision: Scarcity;    // 决策瞬间的稀缺度快照
  selectionReason: string;         // 结构化:命中的策略规则 id + 关键参数(如 "rule:low-lowrisk→local_primary")
  escalationReason: string | null; // 非首选时的升级原因(前次失败分类,取值同 FailureClass:timeout/budget_exhausted/tool_failure/gate_rejected/model_error/provider_unavailable)
  previousFailures: Array<{        // 升级依据的前序失败记录(可追溯)
    attemptNo: number;
    model: ModelRef;
    failureClass: FailureClass;
    evidenceRef: string;           // 指向日志/事件证据
  }>;
  policyVersion: string;           // 本决策依据的 Model Policy 版本(审计锚点)
  decidedAt: Date;
}

type FailureClass =
  | "timeout" | "budget_exhausted" | "tool_failure"
  | "gate_rejected" | "model_error" | "provider_unavailable";
```

**禁止只记录最终模型而无法解释"为什么选它"**——`selectionReason`/`escalationReason`/`previousFailures` 是每次 Run 的必填留痕;缺任一项即实现缺陷(MODEL-POLICY-01 验收项)。

### 4.6 与现有账本的关系

- `budget_ledger`(现有):Goal 级,记回合/调用预算口径,继续服役,不改。
- QuotaPool(新增):Provider 级资源视图;其 `remainingState` 的上游对账一律走 **ledger + 上游日志(Magpie 路由日志/官方用量页)双对账 1:1** 口径。
- 消耗统计永远区分"测试触发次数"与"真实模型请求次数"。

## 5. 状态机

### 5.1 Run 模型选择状态机(切换只发生在 Run / Attempt 边界)

```text
Task 分级 + Scarcity/Health 快照
        │ (Run 创建 / Attempt 重启边界)
        ▼
DECIDING ──产出 RunModelDecision(持久化)──► ASSIGNED(model_ref 固定)
        ▼
EXECUTING ──► OK(交付/机判/Review 链继续)
        │
        └─► FAILED(failureClass 落证)
                 │ (新 Attempt 边界,严禁 run 中途换模型)
                 ▼
        ESCALATION_RULES(§6.2) ──► 新 Attempt(下一层模型,新 RunModelDecision)
                 │ 连续失败 / 高风险 / 架构类
                 ▼
        SUPERVISOR_WAIT(ChatGPT 可用时) 或 WAIT_STRONG_MODEL(不可用时,记 Candidate 挂起)
```

**硬规则:禁止每轮 token 级动态换模型。** 模型切换只发生在新的 Run / Attempt 边界,且每次切换必须有新的持久化 `RunModelDecision`。

### 5.2 QuotaPool 状态机

```text
UNKNOWN ──首次观测──► NORMAL/SCARCE/RESERVE_ONLY(按池类型)
NORMAL ──余量下降──► SCARCE ──耗尽──► EXHAUSTED ──reset_at──► NORMAL
任一态 ──观测失效──► UNKNOWN(决策按最保守:视为不可用)
UNMETERED(对应 limitType=unlimited 的池):恒定,不参与迁移
```

### 5.3 Provider 健康状态机

```text
unknown ──探测成功──► healthy ⇄ degraded(间歇失败/高时延) ──连续失败──► unreachable
恢复探测:退避重探(非无界);观测源 = 真实调用结果 + 既有路由日志 + /v1/models 探测
```

## 6. 第一版调度原则

### 6.1 任务分级与默认链

| 任务画像 | 默认 Coder | 说明 |
| --- | --- | --- |
| LOW 难度 + LOW_RISK | Qwen(LOCAL_PRIMARY) | 大批量、低风险,充分用本地资源 |
| MEDIUM | Qwen **或** MiniMax | 按 scarcity/health 快照在两者间选;两者健康时优先 Qwen(零成本),MiniMax 供异构 Reviewer 与升级位 |

### 6.2 升级链(失败升级只在新 Attempt 边界发生)

```text
Qwen 首次失败 ──► MiniMax
MiniMax 失败   ──► GLM-5.3-Flash(SCARCE_GLM_POOL,消耗前查池)
GLM Flash 失败 或 HIGH_COMPLEXITY ──► GLM-5.3(RESERVE_ONLY,逐次消耗均须留痕)
连续失败 / 归因不清 ──► ChatGPT Supervisor(可用时)或 WAIT_STRONG_MODEL(不可用时)
```

- 升级层数与预算沿用"止损是特性不是缺陷"原则(沿用 R-2 结论:回合硬顶诚实止损)。
- 每次"是否继续消耗稀缺模型"的裁决优先交 Supervisor(§2.4);Supervisor 不可用时按 Escalation Policy 的静态上限执行并如实落账。

### 6.3 Supervisor 触发条件

`architecture` 类问题 / `unclear requirement`(需求合理性存疑)/ `repeated failure`(连续失败归因)/ `high-risk decision` → ChatGPT Supervisor。Supervisor 输出是**建议与质疑**,进 Relay 决策链的仍须走既有授权与门禁(Supervisor 不是权限授予方)。

### 6.4 切换边界约束(重申)

- 切换只发生在新的 Run / Attempt 边界(§5.1);
- token 级/轮中动态换模型**禁止**;
- 每次决策必须完整留痕(§4.5),否则视为实现缺陷。

## 7. Coder / Reviewer 异构约束

**尽量满足:`Coder model family != Reviewer model family`**;**禁止默认"同一模型写、同一模型审、同一模型最终裁决"**(与 ADR-0004"Reviewer 与 Coder 分离上下文"一脉相承,并升级为家族级约束)。

| Coder | Reviewer(默认) | 备注 |
| --- | --- | --- |
| Qwen | MiniMax | 首选组合;MiniMax 不可用时退 GLM-5.3-Flash(消耗稀缺池,须留痕) |
| MiniMax | Qwen 或 GLM-5.3-Flash | Qwen 优先(零稀缺消耗) |
| GLM(Flash/5.3) | MiniMax | MiniMax 不可用时退 Qwen |
| 高风险任务 | 上述 + ChatGPT Supervisor 终审 | Supervisor 是可选增审,不是必需依赖 |

家族判定依据 `ProviderEntry.modelFamily`(§4.2);实现层在校验点硬编码"家族相同 ⇒ 拒绝组合"。

## 8. 降级模式 DEGRADED_LOCAL

**触发条件(任一)**:MiniMax 不可用 / GLM 额度耗尽 / ChatGPT 不可用 / 外部网络异常。

**Relay 仍必须(不停摆清单)**:

1. 保持 Core 运行(状态机、租约、预算、证据链照常);
2. 使用本地 Qwen 处理低风险 Ready Task;
3. 跑测试(确定性 Gate 全程有效);
4. 诊断(日志分析、失败归因);
5. Discovery;
6. 准备 Candidate:凡需要异构模型 Review 的修改,产出 Candidate **挂起待审,不自动 ACCEPTED**(门禁只严不松;低风险任务按 ADR-0004 风险裁剪门禁照常推进);
7. 记录高风险任务为 `WAIT_STRONG_MODEL` 等待强模型恢复。

**禁止**:整系统停摆;为"凑齐 Reviewer"放宽异构约束;在降级态消耗稀缺池残余额度做普通流水线工作。

## 9. 评价指标与优先级调整

**tok/s 不作为主判据**(仅作容量规划参考)。

Model Policy 必须按模型采集:

| 指标 | 定义 |
| --- | --- |
| `first_pass_rate` | 首个 Attempt 即通过全部机判的 Task / 进入执行的 Task |
| `accepted_rate` | Accepted Task / 进入执行的 Task |
| `rework_rate` | 经 REWORK 才接受的 Task / Accepted Task |
| `mean_model_calls` | 平均每 Task 真实模型请求数(上游 try 级,双对账口径) |
| `mean_wall_time` | 平均每 Task 墙钟时间 |
| `tool_failure_rate` | 工具失败次数 / 工具调用次数 |
| `reviewer_reject_rate` | Reviewer 拒绝轮 / Review 总轮 |
| `escape_defect_rate` | Accepted 后被推翻/返工的缺陷 / Accepted Task |
| `cost_per_accepted_task` | (货币成本 + 稀缺资源折算) / Accepted Task;稀缺折算权重按 Scarcity 级别设定(具体权重值 OPEN,MODEL-POLICY-01 定) |

**调整依据:Accepted Task / 时间 / 成本 / 稀缺资源消耗** 四元组周期评审,结论以 **Model Policy 版本发布**方式生效(带证据 + 独立 Reviewer);禁止运行中静默自我改写策略(防 RSI)。

## 10. MODEL-POLICY-01 实施包草案与验收标准

> 本节是未来实施包的范围冻结;MODEL-POLICY-01 启动时仍须按治理规则落 ACTIVE 合同,再动代码。

### 10.1 范围

- 实现 §4 数据模型(PostgreSQL 新表 + Registry/Quota/Decision 读写面);
- 实现 §5/§6 状态机与路由规则(Run 边界决策点接入现有 Worker);
- 实现 §7 异构校验、§8 DEGRADED_LOCAL、§9 指标采集;
- Provider Registry 初始登记:local-qwen / minimax-code / zcode(Flash+5.3 同池)/ openai-codex / magpie(adapter);
- Magpie 迁移评估(只评估,不删除);**迁移实施视评估结论另行授权立项,不在 MODEL-POLICY-01 默认范围内**(与 §3 对齐:01 只出评估结论与迁移方案,不改现有链路)。

### 10.2 四通道真实验证(全部必须实跑)

| # | 通道 | 必须证明 |
| --- | --- | --- |
| 1 | Pi → 本地 Qwen | 端到端 Run 成功;真实吞吐校准(替换"约 100 tok/s"口径);工具调用正确性 |
| 2 | Pi → MiniMax API | 端到端 Run;**5h 窗口语义实测**(起点/耗尽/reset 观测);失败升级触发正确 |
| 3 | Pi → GLM API | 端到端 Run;**glm_weekly 单池双模型 1:1 对账**(Flash 与满血共享,与上游用量逐条对上) |
| 4 | Pi → ChatGPT OAuth | Supervisor 通道可用;OAuth 生命周期与失效检测;仅 Supervisor 角色生效 |

### 10.3 故障场景矩阵(逐项可回放)

Provider 不可用 / quota exhausted / rate limit / OAuth 失效 / 模型失败升级 / Coder-Reviewer 异构 / DEGRADED_LOCAL / **Relay 重启后策略恢复**(Registry、池状态、在途决策从持久层恢复,不丢不留脏)。

### 10.4 证据要求

全部场景有**可回放 Evidence**:原始日志、路由/上游对账、`RunModelDecision` 全留痕、故障注入前后状态快照;零 Key 明文接触;消耗走 ledger + 上游双对账 1:1。

### 10.5 验收标准(Definition of Done)

1. 四通道全部 VERIFIED(真模型、真故障注入;Stub 不替代);
2. 抽样任意 Run,其 `RunModelDecision` 能完整回答"为什么选它";
3. DEGRADED_LOCAL 演练:云端全损下 Core 持续产出(Candidate 挂起 + 低风险推进),零停摆、零门禁放宽;
4. 重启恢复演练:策略与池状态零丢失;
5. 独立 Reviewer PASS(全新上下文亲测);
6. Magpie 仍可用且已降格为 Registry 内显式条目(迁移未完成不阻塞);
7. 零生产凭据接触、零 Key 入仓。

## 11. 与冻结边界的一致性声明

- 架构基线 §5"Runtime != Model;模型提供商独立配置"——本设计是该开放边界的首次正式化(ADR-0009);
- ADR-0003——模型选择发生在 Core 侧(Pi 之外的 Policy 面),Pi/Runtime 不拥有模型策略;
- ADR-0004——异构 Reviewer 约束是"Reviewer 与 Coder 分离上下文"的家族级强化;降级模式不降门禁;
- 架构基线 §1/README——ChatGPT 可选、非运行依赖;本设计将其固化为 SCARCE_SUPERVISOR 的边界条款;
- 治理规则 §8(扩展克制)——本包零实现代码;新增抽象的落地全部推迟到 MODEL-POLICY-01 并以其验收证据为准。
