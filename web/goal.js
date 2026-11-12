// Goal 页(P0-02C):创建 + 详情(理解 / 可验证建议 / 任务 / 证据 / Gate / 审计)。
// 诚实性约束:『系统理解』与『可验证建议』必须显式标注来源=确定性规则推导;模型分析标记为未实现。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  // OPERATOR-CONSOLE-00 P0-UI-3:执行进度(阶段/当前任务/模型/耗时/计数;全部服务端确定性推导)
  function progressBlock(p, budgetRows) {
    const phaseKind = p.delivered ? "ok" : ["失败", "等待人工决策", "已阻塞"].indexOf(p.phase) >= 0 ? "bad" : ["已暂停", "返工中"].indexOf(p.phase) >= 0 ? "warn" : "info";
    const mc = (budgetRows || []).find(function (b) {
      return b.kind === "model_calls";
    });
    const counts = p.counts || {};
    const rows = [];
    rows.push(h("dt", { text: "当前阶段" }), h("dd", { "data-testid": "goal-phase" }, A.badge(p.phase, phaseKind), h("span", { class: "small dim", text: " " + p.phaseBasis })));
    rows.push(h("dt", { text: "当前任务" }), h("dd", { class: "mono small", "data-testid": "goal-current-task", text: p.currentTaskId || "—" }));
    rows.push(h("dt", { text: "当前模型" }), h("dd", { class: "mono small", "data-testid": "goal-current-model", text: p.currentModelRef || "尚无运行" }));
    rows.push(h("dt", { text: "已运行" }), h("dd", { class: "small", "data-testid": "goal-elapsed", text: p.elapsedSeconds === null || p.elapsedSeconds === undefined ? "—" : A.fmtDuration(p.elapsedSeconds) }));
    rows.push(
      h("dt", { text: "预算(模型调用)" }),
      h("dd", { class: "small", "data-testid": "goal-budget-mc", text: mc ? "已用 " + mc.used + (mc.limit !== null ? " / 上限 " + mc.limit : " / 无上限") + " · 预留 " + mc.reserved : "无账本行" }),
    );
    rows.push(
      h("dt", { text: "质量面" }),
      h(
        "dd",
        { class: "row" },
        A.badge("Run " + (counts.runs || 0), "default"),
        A.badge("证据 " + (counts.evidence || 0), "info"),
        A.badge("Gate " + (counts.gates || 0), counts.gates ? "ok" : "default"),
        A.badge("待决 " + (counts.openDecisions || 0), counts.openDecisions ? "warn" : "default"),
        A.badge(p.delivered ? "已交付" : "未交付", p.delivered ? "ok" : "default"),
      ),
    );
    return h("dl", { class: "kv" }, rows);
  }

  function headerBlock(g) {
    const rows = [];
    rows.push(h("dt", { text: "原始需求" }), h("dd", { "data-testid": "goal-raw-input", text: g.goal.rawInput }));
    rows.push(h("dt", { text: "Goal 状态" }), h("dd", {}, A.badge(g.goal.state, A.stateKind(g.goal.state))));
    rows.push(h("dt", { text: "Goal ID" }), h("dd", { class: "mono", text: g.goal.id }));
    rows.push(h("dt", { text: "预算" }), h("dd", { class: "mono small", text: JSON.stringify(g.goal.budget) }));
    rows.push(h("dt", { text: "创建/更新" }), h("dd", { class: "small dim", text: A.fmtTime(g.goal.createdAt) + " / " + A.fmtTime(g.goal.updatedAt) }));
    rows.push(h("dt", { text: "验收依据" }), h("dd", { class: "small", text: g.analysis.understanding.acceptanceBasis }));
    return h("dl", { class: "kv" }, rows);
  }

  function analysisBlock(a, discovery) {
    const src = h(
      "div",
      { class: "row" },
      A.badge("分析来源:" + a.sourceLabel, "info"),
      h("span", { class: "small dim", text: "每条建议都标注依据(basis)与验证方式(verifiableBy)" }),
    );
    // REWORK-1:Discovery 区块(来源徽章三态;失败/未运行如实降级规则面,不冒充模型)
    const discoveryParts = [h("h3", { text: "模型发现(Discovery)" })];
    if (discovery && discovery.source === "model" && discovery.latest && discovery.latest.report) {
      const r = discovery.latest.report;
      discoveryParts.push(h("div", { class: "row" }, A.badge("来源:模型", "ok"), h("span", { class: "small dim", text: discovery.note })));
      discoveryParts.push(h("p", { text: "问题陈述:" + String(r.problemStatement ?? "") }));
      if (Array.isArray(r.assumptions) && r.assumptions.length) {
        discoveryParts.push(
          h("ul", { class: "plain", "data-testid": "discovery-assumptions" }, r.assumptions.map(function (x) {
            return h("li", { text: "假设:" + String(x.text ?? "") + "(置信度:" + String(x.confidence ?? "?") + ")" });
          })),
        );
      }
      if (r.recommendation) {
        discoveryParts.push(h("p", { "data-testid": "discovery-recommendation", text: "推荐:" + String(r.recommendation.action ?? "") }));
        discoveryParts.push(h("p", { class: "small dim", text: "依据:" + String(r.recommendation.rationale ?? "") }));
      }
      if (Array.isArray(r.acceptanceCriteria) && r.acceptanceCriteria.length) {
        discoveryParts.push(h("p", { text: "可判定验收:" + r.acceptanceCriteria.join(";") }));
      }
      if (Array.isArray(r.openQuestions) && r.openQuestions.length) {
        discoveryParts.push(h("p", { class: "small", text: "仍需人决:" + r.openQuestions.join(";") }));
      }
      if (Array.isArray(r.sources) && r.sources.length) {
        const latest = discovery.latest;
      discoveryParts.push(h("p", { class: "small dim", text: "来源文件:" + r.sources.join(", ") + " · 回放:run " + String(latest.runId).slice(0, 18) + " · SHA " + String(latest.contentSha256 ?? "").slice(0, 12) }));
      }
    } else {
      const note = discovery && discovery.latest && discovery.latest.reason
        ? "模型分析失败(" + discovery.latest.reason + "),已如实落记;以下为规则推导,非模型结论。"
        : "尚未运行模型分析;以下为规则推导,非模型结论。可用 relay goal analyze <goalId> --project-dir <dir> 发起(预算经账本)。";
      discoveryParts.push(h("div", { class: "notice", "data-testid": "discovery-notice" }, h("strong", { text: "来源:规则面兜底。" }), h("span", { text: " " + note })));
    }
    const discoveryBlock = h("div", {}, discoveryParts);
    const modelNotice = h(
      "div",
      { class: "notice", "data-testid": "model-analysis-notice" },
      h("strong", { text: "规则面理解/建议为确定性推导;" }),
      h("span", { text: " 模型结论仅在上方 Discovery 区块展示(带来源徽章),两者不混用。" }),
    );
    const understanding = h(
      "div",
      {},
      h("h3", { text: "系统理解(规则推导)" }),
      h(
        "ul",
        { class: "plain" },
        a.understanding.derivedTasks.map(function (t) {
          return h(
            "li",
            {},
            h("div", { class: "row" }, h("span", { class: "mono small", text: t.taskId }), A.badge("Gate 必需", t.gateRequired ? "ok" : "warn")),
            h("div", { class: "small dim", text: "作用域:" + (t.allowedScope.join(", ") || "无(默认拒绝)") + " · 授权命令:" + (t.allowedCommands.join(", ") || "无(禁 exec)") }),
          );
        }),
      ),
    );
    const suggestions = h(
      "div",
      {},
      h("h3", { text: "可验证建议" }),
      h(
        "ul",
        { class: "plain", "data-testid": "suggestion-list" },
        a.suggestions.map(function (s) {
          return h(
            "li",
            { "data-testid": "suggestion-" + s.id },
            h("div", { text: s.text }),
            h("div", { class: "small dim", text: "依据:" + s.basis }),
            h("div", { class: "small dim", text: "验证方式:" + s.verifiableBy }),
          );
        }),
      ),
    );
    return h("div", { class: "stack" }, src, discoveryBlock, modelNotice, understanding, suggestions);
  }

  function tasksBlock(tasks) {
    if (!tasks.length) return h("p", { class: "empty", text: "该 Goal 下暂无任务" });
    const tbody = h("tbody", {});
    tasks.forEach(function (t) {
      const actions = h("td", { class: "row" });
      t.availableActions.forEach(function (a) {
        const btn = h("button", { class: "btn", type: "button", "data-testid": "task-action-" + a.id + "-" + t.id, text: a.label });
        btn.addEventListener("click", function () {
          runAction(a, t, btn);
        });
        actions.appendChild(btn);
      });
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "task-row-" + t.id },
          h("td", { class: "mono small", text: t.id }),
          h("td", {}, A.badge(t.state, A.stateKind(t.state))),
          h("td", { class: "small", text: t.attempt + "/" + t.maxAttempts }),
          h("td", { class: "small", text: t.allowedScope.join(", ") || "—" }),
          h("td", { class: "small", text: t.allowedCommands.join(", ") || "—" }),
          h("td", { class: "small dim", text: t.blockedReason || (t.openDecision ? "待裁决:" + t.openDecision.level : "") }),
          actions,
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "任务" }), h("th", { text: "状态" }), h("th", { text: "尝试" }), h("th", { text: "作用域" }), h("th", { text: "命令" }), h("th", { text: "说明" }), h("th", { text: "操作" }))),
      tbody,
    );
  }

  async function runAction(action, task, btn) {
    btn.disabled = true;
    try {
      if (action.id === "decision_approve" || action.id === "decision_reject") {
        const decisionId = task.openDecision.id;
        await A.apiPost("/api/decisions/" + encodeURIComponent(decisionId) + "/resolve", {
          taskId: task.id,
          approve: action.id === "decision_approve",
          expectedStateVersion: task.stateVersion,
        });
      } else if (action.id === "resume") {
        await A.apiPost("/api/tasks/" + encodeURIComponent(task.id) + "/resume", {
          expectedStateVersion: task.stateVersion,
        });
      }
      await refresh();
    } catch (e) {
      alert("操作失败:" + ((e && e.message) || e));
      btn.disabled = false;
    }
  }

  function changesetsBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "尚无候选变更" });
    const tbody = h("tbody", {});
    list.forEach(function (c) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "changeset-row-" + c.id },
          h("td", { class: "mono small", text: c.id }),
          h("td", {}, A.badge(c.deliveryState, A.stateKind(c.deliveryState))),
          h("td", { class: "mono small", text: "候选 " + A.short(c.candidateSha) }),
          h("td", { class: "mono small", text: "树 " + A.short(c.gitTreeSha) }),
          h("td", { class: "mono small", text: "提交 " + A.short(c.gitCommitSha) }),
          h("td", { class: "small", text: "增 " + c.changedFiles.added.length + " / 改 " + c.changedFiles.modified.length + " / 删 " + c.changedFiles.removed.length }),
          h("td", {}, h("a", { class: "small", href: "/changeset.html?id=" + encodeURIComponent(c.id), text: "查看" })),
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "变更集" }), h("th", { text: "交付状态" }), h("th", { text: "candidate sha" }), h("th", { text: "tree sha" }), h("th", { text: "commit sha" }), h("th", { text: "变更" }), h("th", { text: "" }))),
      tbody,
    );
  }

  function runsBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "尚无运行记录" });
    const tbody = h("tbody", {});
    list.forEach(function (r) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "goal-run-" + r.id },
          h("td", { class: "mono small", text: r.id }),
          h("td", {}, A.badge(r.outcome, A.stateKind(r.outcome))),
          h("td", { class: "small", text: r.role || "coder" }),
          h("td", { class: "small", "data-testid": "run-reason-" + r.id, text: r.reason || "—" }),
          h("td", { class: "small dim", text: r.modelRef + " · " + r.sandbox }),
          h("td", { class: "small dim", text: A.fmtTime(r.startedAt) }),
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "Run" }), h("th", { text: "结果" }), h("th", { text: "角色" }), h("th", { text: "失败/停止原因" }), h("th", { text: "模型/沙箱" }), h("th", { text: "开始" }))),
      tbody,
    );
  }

  function evidenceBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "尚无证据" });
    const tbody = h("tbody", {});
    list.slice(0, 20).forEach(function (e) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "evidence-row-" + e.id },
          h("td", { text: e.kind }),
          h("td", {}, A.badge(e.passed ? "通过" : "未通过", e.passed ? "ok" : "bad")),
          h("td", { class: "mono small", text: A.short(e.candidateSha) }),
          h("td", { class: "mono small", text: e.contentSha256.slice(0, 16) }),
          h("td", { class: "small dim", text: A.fmtTime(e.createdAt) }),
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "种类" }), h("th", { text: "结果" }), h("th", { text: "绑定候选" }), h("th", { text: "内容摘要" }), h("th", { text: "时间" }))),
      tbody,
    );
  }

  function gatesBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "尚无 Gate 裁决" });
    const tbody = h("tbody", {});
    list.forEach(function (g) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "gate-row-" + g.id },
          h("td", {}, A.badge(g.verdict, A.stateKind(g.verdict))),
          h("td", { class: "small", text: g.reviewer }),
          h("td", { class: "mono small", text: A.short(g.candidateSha) }),
          h("td", { class: "mono small", text: A.short(g.reviewerRunId, 10) }),
          h("td", { class: "mono small", text: A.short(g.coderRunId, 10) }),
          h("td", { class: "small", text: g.consumedAt ? "已消费 " + A.fmtTime(g.consumedAt) : "未消费" }),
          h("td", {}, g.staleEvidence ? A.badge("证据来自旧候选,需重验", "warn") : null),
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "裁决" }), h("th", { text: "裁决者" }), h("th", { text: "绑定候选" }), h("th", { text: "Reviewer Run" }), h("th", { text: "Coder Run" }), h("th", { text: "消费" }), h("th", { text: "时效" }))),
      tbody,
    );
  }

  function auditBlock(rows) {
    if (!rows.length) return h("p", { class: "empty", text: "尚无审计记录" });
    const ul = h("ul", { class: "plain" });
    rows.slice(0, 25).forEach(function (e) {
      ul.appendChild(
        h(
          "li",
          {},
          h(
            "div",
            { class: "row" },
            h("span", { class: "mono small", text: "#" + e.seq }),
            A.badge(e.action, "default"),
            h("span", { class: "small dim", text: e.authority + " · " + e.actor + " · " + A.fmtTime(e.ts) }),
          ),
        ),
      );
    });
    return ul;
  }

  // WEB-UX-01 §4.6:Goal 执行 Timeline(七阶段;状态全部由 DB 事实确定性推导,零模型判断)
  function timelineBlock(g) {
    const steps = [];
    // Discovery:模型调查记录(规则面兜底不影响"是否运行过"的事实)
    const disc = g.discovery && g.discovery.latest;
    if (disc && disc.outcome === "SUCCEEDED") {
      steps.push({ name: "Discovery 调查", st: "passed", note: "模型结构化报告已持久化(可回放 run " + A.short(disc.runId, 12) + ")" });
    } else if (disc && disc.outcome === "FAILED") {
      steps.push({ name: "Discovery 调查", st: "failed", note: "失败已如实落记:" + (disc.reason || "无原因") + ";规则面继续可用" });
    } else {
      steps.push({ name: "Discovery 调查", st: "waiting", note: "尚未显式发起模型调查(规则面始终可用)" });
    }
    // Planning:planGoal 派生任务即计划事实
    steps.push(
      g.tasks.length > 0
        ? { name: "Planning 计划", st: "passed", note: g.tasks.length + " 个任务已派生(确定性默认计划)" }
        : { name: "Planning 计划", st: "waiting", note: "尚未派生任务" },
    );
    // Coding:coder 运行面
    const coderRuns = (g.runs || []).filter(function (r) {
      return (r.role || "coder") === "coder";
    });
    const anyOk = coderRuns.some(function (r) { return r.outcome === "SUCCEEDED"; });
    const anyBad = coderRuns.some(function (r) { return ["FAILED", "TIMEOUT", "BUDGET_EXHAUSTED", "CANCELLED", "INTERRUPTED"].indexOf(r.outcome) >= 0; });
    const taskInFlight = (g.tasks || []).some(function (t) { return ["LEASED", "RUNNING", "SUBMITTED"].indexOf(t.state) >= 0; });
    const taskAccepted = (g.tasks || []).some(function (t) { return t.state === "ACCEPTED"; });
    if (taskAccepted || anyOk) steps.push({ name: "Coding 编码", st: "passed", note: "coder 运行 " + coderRuns.length + " 次(含成功)" });
    else if (taskInFlight) steps.push({ name: "Coding 编码", st: "running", note: "任务执行中" });
    else if (anyBad) steps.push({ name: "Coding 编码", st: "failed", note: "存在失败/预算耗尽的 coder 运行(详见运行记录)" });
    else steps.push({ name: "Coding 编码", st: "waiting", note: "尚未开始" });
    // Testing:确定性证据
    const ev = g.evidence || [];
    const evPassed = ev.some(function (e) { return e.passed; });
    if (ev.length && evPassed) steps.push({ name: "Testing 测试", st: "passed", note: ev.filter(function (e) { return e.passed; }).length + " 条证据通过" });
    else if (ev.length) steps.push({ name: "Testing 测试", st: "failed", note: "证据全部未通过(机判如实拒绝)" });
    else steps.push({ name: "Testing 测试", st: "waiting", note: "尚无确定性证据" });
    // Reviewing:独立 Reviewer 运行
    const revRuns = (g.runs || []).filter(function (r) { return r.role === "reviewer"; });
    if (revRuns.some(function (r) { return r.outcome === "SUCCEEDED"; })) steps.push({ name: "Reviewing 审查", st: "passed", note: "独立 Reviewer 已完成" });
    else if (revRuns.length) steps.push({ name: "Reviewing 审查", st: "failed", note: "Reviewer 运行存在失败" });
    else steps.push({ name: "Reviewing 审查", st: "waiting", note: "尚未进入独立审查" });
    // Gate:裁决
    const gates = g.gates || [];
    if (gates.some(function (x) { return x.verdict === "PASS"; })) steps.push({ name: "Gate 裁决", st: "passed", note: "PASS(独立 Reviewer + 确定性检查)" });
    else if (gates.some(function (x) { return x.verdict === "BLOCK" || x.verdict === "REWORK"; })) steps.push({ name: "Gate 裁决", st: "failed", note: "存在 BLOCK/REWORK 裁决(见 Gate 详情)" });
    else steps.push({ name: "Gate 裁决", st: "waiting", note: "尚无裁决" });
    // Delivery:变更集
    const cs = g.changesets || [];
    if (cs.some(function (x) { return x.deliveryState === "DELIVERED"; })) steps.push({ name: "Delivery 交付", st: "passed", note: "已交付并核对远端" });
    else if (cs.some(function (x) { return x.deliveryState === "DELIVERING"; })) steps.push({ name: "Delivery 交付", st: "running", note: "交付进行中" });
    else if (cs.some(function (x) { return x.deliveryState === "CONFLICT" || x.deliveryState === "FAILED"; })) steps.push({ name: "Delivery 交付", st: "failed", note: "交付异常(见候选变更与交付)" });
    else steps.push({ name: "Delivery 交付", st: "waiting", note: "尚无候选变更" });

    const cls = { passed: "tl-passed", running: "tl-running", failed: "tl-failed", rework: "tl-rework", waiting: "" };
    const chip = { passed: ["passed", "ok"], running: ["running", "info"], failed: ["failed", "bad"], rework: ["rework", "warn"], waiting: ["waiting", "default"] };
    return h(
      "div",
      { class: "timeline", "data-testid": "goal-timeline-steps" },
      steps.map(function (s) {
        return h(
          "div",
          { class: "tl-step " + (cls[s.st] || "") },
          h("span", { class: "tl-dot" }),
          h(
            "div",
            { class: "tl-body" },
            h("div", { class: "tl-title" }, h("span", { class: "tl-name", text: s.name }), A.badge(chip[s.st][0], chip[s.st][1])),
            h("div", { class: "tl-note", text: s.note }),
          ),
        );
      }),
    );
  }

  async function refresh() {
    const id = new URLSearchParams(window.location.search).get("id");
    const detail = document.getElementById("goal-detail");
    if (!id) {
      document.getElementById("create-card").hidden = false;
      return;
    }
    detail.hidden = false;
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/goals/" + encodeURIComponent(id));
      });
      const g = res.goal;
      document.getElementById("page-title").textContent = "Goal · " + A.short(g.goal.id, 12);
      document.getElementById("goal-header").textContent = "";
      document.getElementById("goal-header").appendChild(headerBlock(g));
      document.getElementById("goal-progress").textContent = "";
      document.getElementById("goal-progress").appendChild(progressBlock(g.progress || {}, g.budget || []));
      document.getElementById("goal-timeline").textContent = "";
      document.getElementById("goal-timeline").appendChild(timelineBlock(g));
      document.getElementById("goal-analysis").textContent = "";
      document.getElementById("goal-analysis").appendChild(analysisBlock(g.analysis, g.discovery));
      document.getElementById("goal-tasks").textContent = "";
      document.getElementById("goal-tasks").appendChild(tasksBlock(g.tasks));
      document.getElementById("goal-changesets").textContent = "";
      document.getElementById("goal-changesets").appendChild(changesetsBlock(g.changesets));
      document.getElementById("goal-runs").textContent = "";
      document.getElementById("goal-runs").appendChild(runsBlock(g.runs));
      document.getElementById("goal-evidence").textContent = "";
      document.getElementById("goal-evidence").appendChild(evidenceBlock(g.evidence));
      document.getElementById("goal-gates").textContent = "";
      document.getElementById("goal-gates").appendChild(gatesBlock(g.gates));
      document.getElementById("goal-audit").textContent = "";
      document.getElementById("goal-audit").appendChild(auditBlock(g.audit));
    } catch (e) {
      console.error("render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("goal", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      document.getElementById("create-card").hidden = false;
      const form = A.renderGoalForm({});
      const host = document.getElementById("new-goal-form");
      host.textContent = "";
      host.appendChild(form.wrap);
    }
    await refresh();
    A.poll(refresh);
  });
})();
