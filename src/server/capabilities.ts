// 能力登记表(P0-02C D-5)。
// 目的:**未实现的能力必须显式标记**,禁止用占位文本冒充 AI 分析结果。
// 状态语义:
//   IMPLEMENTED    —— 已实现,且由真实 DB 事实驱动
//   NOT_IMPLEMENTED —— 本包未实现(必须在 UI 上可见,不得以任何形式伪造)
//   STUB           —— 由确定性桩承担(测试/演示);**不是**真实模型能力
//   NOT_VERIFIED   —— 实现存在但真实验收未完成(如 GitHub 真实写入:有效 PAT 缺失)

export type CapabilityStatus = "IMPLEMENTED" | "NOT_IMPLEMENTED" | "STUB" | "NOT_VERIFIED";

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
      title: "模型驱动的需求发现与澄清(自动调查/提问)",
      status: "NOT_IMPLEMENTED",
      note: "本包未实现:页面不展示任何模型生成的『问题分析』,只展示规则推导结果。",
      evidence: "p0-02c/REPORT.md §未实现能力",
    },
    {
      id: "goal.recommendation.model",
      title: "模型驱动的推荐行动",
      status: "NOT_IMPLEMENTED",
      note: "本包未实现:推荐内容一律来自确定性规则,不做模型结论。",
      evidence: "p0-02c/REPORT.md §未实现能力",
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
      status: "NOT_VERIFIED",
      note: "状态 NOT_VERIFIED:有效细粒度 PAT 缺失 ⇒ 真实写入/漂移实验诚实 skip;本包验收不覆盖,不得声称已通过。",
      evidence: "p0-02b/github-api-verification.log",
    },
    {
      id: "worker.tick",
      title: "Worker 推进(Goal Loop 单拍)",
      status: "IMPLEMENTED",
      note: "POST /api/worker/tick 触发 core.goalLoopTick;失败如实进入 REWORK/FAILED 并留证据。",
      evidence: "src/server/api.ts:POST /api/worker/tick",
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
