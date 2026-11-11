// 能力登记表(P0-02C D-5)。
// 目的:**未实现的能力必须显式标记**,禁止用占位文本冒充 AI 分析结果。
// 状态语义:
//   IMPLEMENTED    —— 已实现,且由真实 DB 事实驱动
//   NOT_IMPLEMENTED —— 本包未实现(必须在 UI 上可见,不得以任何形式伪造)
//   STUB           —— 由确定性桩承担(测试/演示);**不是**真实模型能力
//   NOT_VERIFIED   —— 实现存在但真实验收未完成(如 GitHub 真实写入:有效 PAT 缺失)

export type CapabilityStatus =
  | "IMPLEMENTED"
  | "NOT_IMPLEMENTED"
  | "STUB"
  | "NOT_VERIFIED"
  | "BLOCKED"; // 外部阻断(如用户凭据单点);如实状态,不得与 NOT_VERIFIED 混用

export interface CapabilityEntry {
  id: string;
  title: string;
  status: CapabilityStatus;
  /** 给用户看的一句话说明(不夸大) */
  note: string;
  /** 证据来源(文件/接口);便于复核 */
  evidence?: string;
}

export interface CapabilityRegistry {
  generatedAt: string;
  /** Worker 执行面:live = 真实 runtime;stub = 确定性桩;external = 独立进程(本进程不可驱动) */
  workerMode: "live" | "stub" | "external";
  entries: CapabilityEntry[];
}

export function buildCapabilityRegistry(
  workerMode: "live" | "stub" | "external",
  generatedAt: string,
): CapabilityRegistry {
  const entries: CapabilityEntry[] = [
    {
      id: "goal.create",
      title: "一句自然语言创建 Goal",
      status: "IMPLEMENTED",
      note: "经 core.planGoal 落库:goal + 任务 + 预算账本行;派生计划为确定性默认计划(非模型规划)。",
      evidence: "src/server/api.ts:POST /api/goals",
    },
    {
      id: "goal.analysis.deterministic",
      title: "系统理解与可验证建议(规则推导)",
      status: "IMPLEMENTED",
      note: "由真实 DB 事实(任务状态/决策/预算/审计)推导;**非模型分析**,页面已标注来源。",
      evidence: "src/server/views.ts:buildGoalAnalysis",
    },
    {
      id: "goal.discovery.model",
      title: "模型驱动的需求发现与澄清(本地调查)",
      status: "IMPLEMENTED",
      note: "REWORK-1 P0 最小:relay goal analyze / POST /api/goals/:id/discovery —— 只读调查 operator 指定项目目录一次,结构化报告持久化(discoveries+runs 可回放);失败如实降级规则面并标注来源。公网 Search/Crawler 属 P1,仍 NOT_IMPLEMENTED。",
      evidence: "src/core/discovery.ts;src/runtime/discovery.ts;p0-rework1/REPORT.md",
    },
    {
      id: "goal.recommendation.model",
      title: "模型驱动的推荐行动",
      status: "IMPLEMENTED",
      note: "有 Discovery 记录时推荐来自模型报告(report.recommendation,含依据与可判定验收);无记录/失败时显示规则推导并显式标注来源(不冒充模型)。",
      evidence: "src/server/views.ts:GoalDiscoveryView;src/core/discovery.ts",
    },
    {
      id: "decision.inbox",
      title: "Decision Inbox(D0–D4 展示与授权)",
      status: "IMPLEMENTED",
      note: "批准/拒绝经 core.ops.resolveDecision(actor 授权 + 状态版本校验 + 审计)。",
      evidence: "src/server/api.ts:POST /api/decisions/:id/resolve",
    },
    {
      id: "decision.d3.auto_approve",
      title: "D3 超时自动批准",
      status: "NOT_IMPLEMENTED",
      note: "**永不存在**:D3 永不超时自动批准(超时仅标 EXPIRED_STILL_BLOCKED,任务停留 NEEDS_DECISION)。",
      evidence: "src/core/decisions.ts:expireStaleDecisions",
    },
    {
      id: "changeset.diff",
      title: "候选变更 Diff 与三 SHA",
      status: "IMPLEMENTED",
      note: "candidate_sha(清单)/ git_tree_sha / git_commit_sha 分列展示,不做混用。",
      evidence: "src/core/changesets.ts",
    },
    {
      id: "changeset.evidence",
      title: "真实测试证据与 Gate 裁决",
      status: "IMPLEMENTED",
      note: "证据来自 core.gate_evidence(可信执行器采集),Gate 绑定 attempt/candidate/requirement。",
      evidence: "src/core/evidence.ts, src/core/gates.ts",
    },
    {
      id: "gate.review.independent",
      title: "独立 Reviewer 裁决",
      status: "IMPLEMENTED",
      note: "Reviewer Run 与 coder Run 必须不同(runs.detail.role=reviewer);消费时二次校验。",
      evidence: "src/core/gates.ts:recordGateVerdict",
    },
    {
      id: "delivery.local_bare",
      title: "交付到本地 bare 远端(验收用)",
      status: "IMPLEMENTED",
      note: "走完整 Proposal→Policy→Intent→Executor→远端核对链;目标是本地 bare 仓库,不冒充 GitHub。",
      evidence: "src/core/delivery.ts",
    },
    {
      id: "delivery.github.real",
      title: "GitHub 真实写入",
      status: "BLOCKED",
      note: "BLOCKED:细粒度 PAT 有效但 relay-delivery-sandbox 不在其仓库授权范围(2026-11-11 逐项核查;72 可见仓库无此仓)⇒ 真实写入/漂移实验诚实 skip。用户侧解除:Repository access 勾选沙箱仓+Contents RW;机制面(本地 bare 全链)已 VERIFIED。",
      evidence: "p0-mvp/stage-c-github-permission.md;p0-02b/github-api-verification.log",
    },
    {
      id: "worker.tick",
      title: "Worker 推进(Goal Loop 单拍)",
      status: "IMPLEMENTED",
      note: "POST /api/worker/tick 触发 core.goalLoopTick;失败如实进入 REWORK/FAILED 并留证据。",
      evidence: "src/server/api.ts:POST /api/worker/tick",
    },
    {
      id: "cli.entry",
      title: "最小 CLI(relay 命令)",
      status: "IMPLEMENTED",
      note: "src/cli.ts + bin(relay goal/decision/task/pause/worker tick/status/doctor);与 API 同调 Core(零第二状态机;读同 views,写同 ops 口径)。",
      evidence: "src/cli.ts;src/server/api.ts:POST /api/tasks/:id/pause",
    },
    {
      id: "task.pause",
      title: "任务暂停(PAUSED 置入)",
      status: "IMPLEMENTED",
      note: "core.ops.pauseTask:仅 READY→PAUSED(阻断 claimNextReady 领取;租约链不打断,副作用归租约/Intent/Reconcile);CLI relay pause 与 API 同一 Core。",
      evidence: "src/core/ops.ts:pauseTask",
    },
    {
      id: "worker.model",
      title: "Worker 的真实模型执行",
      status: workerMode === "live" ? "IMPLEMENTED" : workerMode === "stub" ? "STUB" : "NOT_IMPLEMENTED",
      note:
        workerMode === "live"
          ? "使用真实 Pi runtime。"
          : workerMode === "stub"
            ? "本包验收使用确定性桩(非真实模型);UI 与 API 已显式标注。"
            : "独立 worker 进程驱动,本进程不直接执行模型调用。",
      evidence: "src/server/worker.ts",
    },
  ];
  return { generatedAt, workerMode, entries };
}
