// Goal 页(P0-02C):创建 + 详情(理解 / 可验证建议 / 任务 / 证据 / Gate / 审计)。
// 诚实性约束:『系统理解』与『可验证建议』必须显式标注来源=确定性规则推导;模型分析标记为未实现。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

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

  function analysisBlock(a) {
    const src = h(
      "div",
      { class: "row" },
      A.badge("分析来源:" + a.sourceLabel, "info"),
      h("span", { class: "small dim", text: "每条建议都标注依据(basis)与验证方式(verifiableBy)" }),
    );
    const modelNotice = h(
      "div",
      { class: "notice", "data-testid": "model-analysis-notice" },
      h("strong", { text: "模型驱动的分析/推荐:未实现。" }),
      h("span", { text: " " + a.modelAnalysis.note }),
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
    return h("div", { class: "stack" }, src, modelNotice, understanding, suggestions);
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
      document.getElementById("goal-analysis").textContent = "";
      document.getElementById("goal-analysis").appendChild(analysisBlock(g.analysis));
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

  async function createGoal() {
    const input = document.getElementById("goal-input");
    const msg = document.getElementById("create-msg");
    const raw = input.value.trim();
    if (!raw) {
      msg.textContent = "请先写一句目标描述";
      return;
    }
    try {
      const res = await A.apiPost("/api/goals", { rawInput: raw });
      msg.textContent = "已创建:" + res.goalId;
      window.location.href = "/goal.html?id=" + encodeURIComponent(res.goalId);
    } catch (e) {
      msg.textContent = "创建失败:" + ((e && e.message) || e);
    }
  }

  A.boot("goal", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    document.getElementById("btn-create-goal").addEventListener("click", createGoal);
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) document.getElementById("create-card").hidden = false;
    await refresh();
  });
})();
