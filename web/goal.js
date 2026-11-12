// 任务页(WEB-UX-02 §9 重做):主视图=时间线(需求已收到→…→完成),技术细节折叠。
// 诚实性约束:『系统理解』与『可验证建议』显式标注来源=确定性规则推导;模型分析失败如实降级,不冒充模型。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  const DONE_OK = ["SUCCEEDED", "ACCEPTED", "COMPLETED"];
  const DONE_BAD = ["FAILED", "CANCELLED"];

  // ---------- 主视图:状态 Hero(做到哪/用了多久/有没有问题/是否需要我) ----------
  function heroBlock(g) {
    const p = g.progress || {};
    const openDec = (p.counts && p.counts.openDecisions) || 0;
    const parts = [];
    parts.push(
      h("div", { class: "row item-row" },
        h("span", { class: "dim small", text: "需求:" }),
        h("span", { "data-testid": "goal-raw-input", text: g.goal.rawInput }),
      ),
    );
    parts.push(
      h("div", { class: "row item-row mt8" },
        A.badge(A.zh(g.goal.state), A.stateKind(g.goal.state)),
        p.elapsedSeconds !== null && p.elapsedSeconds !== undefined
          ? h("span", { class: "small dim", "data-testid": "goal-elapsed", text: "已用时 " + A.fmtDuration(p.elapsedSeconds) })
          : null,
        p.currentModelRef ? h("span", { class: "small dim mono-sm", text: "模型 " + p.currentModelRef }) : null,
      ),
    );
    if (openDec > 0) {
      parts.push(
        h("div", { class: "notice warn mt8", "data-testid": "goal-needs-you" },
          h("strong", { text: "有 " + openDec + " 件事需要你决定。" }),
          h("span", {}, " 在你处理前任务不会继续。"),
          " ",
          h("a", { href: "/decisions.html", text: "去处理 →" }),
        ),
      );
    }
    return h("div", { class: "stack" }, parts);
  }

  // ---------- 时间线(八步,用户语言;状态由 DB 事实确定性推导,零模型判断) ----------
  function timelineBlock(g) {
    const steps = [];
    const push = (name, st, note) => steps.push({ name: name, st: st, note: note });

    // 1 需求已收到
    push("需求已收到", "passed", "创建于 " + A.fmtTime(g.goal.createdAt));
    // 2 正在理解需求(模型 Discovery;失败/未运行如实)
    const disc = g.discovery && g.discovery.latest;
    if (disc && disc.outcome === "SUCCEEDED") push("正在理解需求", "passed", "Relay 已完成需求分析");
    else if (disc && disc.outcome === "FAILED") push("正在理解需求", "failed", "自动分析未成功,已按既定规则继续(详见技术详情)");
    else push("正在理解需求", "waiting", "尚未运行自动分析(可选步骤)");
    // 3 正在分析项目(任务派生即计划事实)
    if (g.tasks.length > 0) push("正在分析项目", "passed", "已制定 " + g.tasks.length + " 个执行步骤");
    else push("正在分析项目", "waiting", "等待制定执行步骤");
    // 4 正在修改
    const coderRuns = (g.runs || []).filter(function (r) {
      return (r.role || "coder") === "coder";
    });
    const anyOk = coderRuns.some(function (r) { return r.outcome === "SUCCEEDED"; });
    const anyBad = coderRuns.some(function (r) { return ["FAILED", "TIMEOUT", "BUDGET_EXHAUSTED", "CANCELLED", "INTERRUPTED"].indexOf(r.outcome) >= 0; });
    const taskInFlight = (g.tasks || []).some(function (t) { return ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"].indexOf(t.state) >= 0; });
    const taskAccepted = (g.tasks || []).some(function (t) { return t.state === "ACCEPTED"; });
    if (taskAccepted || anyOk) push("正在修改", "passed", "代码修改已完成");
    else if (taskInFlight) push("正在修改", "running", "Relay 正在修改代码");
    else if (anyBad) push("正在修改", "failed", "修改遇到问题,系统会按规则重试(详见技术详情)");
    else push("正在修改", "waiting", "还没开始修改代码");
    // 5 正在测试(确定性证据)
    const ev = g.evidence || [];
    const evPassed = ev.filter(function (e) { return e.passed; }).length;
    if (ev.length && evPassed) push("正在测试", "passed", evPassed + " 项测试全部通过");
    else if (ev.length) push("正在测试", "failed", "测试未通过,已如实记录");
    else push("正在测试", "waiting", "等待运行测试");
    // 6 正在复核(独立 Reviewer + Gate)
    const revRuns = (g.runs || []).filter(function (r) { return r.role === "reviewer"; });
    const gates = g.gates || [];
    if (gates.some(function (x) { return x.verdict === "PASS"; })) push("正在复核", "passed", "独立复核已通过");
    else if (gates.some(function (x) { return x.verdict === "BLOCK" || x.verdict === "REWORK"; })) push("正在复核", "failed", "复核发现问题,需要处理(详见技术详情)");
    else if (revRuns.length) push("正在复核", "running", "独立复核进行中");
    else push("正在复核", "waiting", "等待进入独立复核");
    // 7 正在交付
    const cs = g.changesets || [];
    if (cs.some(function (x) { return x.deliveryState === "DELIVERED"; })) push("正在交付", "passed", "修改已交付到仓库");
    else if (cs.some(function (x) { return x.deliveryState === "DELIVERING"; })) push("正在交付", "running", "正在交付");
    else if (cs.some(function (x) { return x.deliveryState === "CONFLICT" || x.deliveryState === "FAILED"; })) push("正在交付", "failed", "交付遇到问题,需要处理");
    else push("正在交付", "waiting", "通过复核后自动交付");
    // 8 完成(m5:注记消除"完成/等待中/进行中"语义矛盾)
    if (cs.some(function (x) { return x.deliveryState === "DELIVERED"; })) push("完成", "passed", "全部完成,可到「验收结果」查看");
    else if (DONE_OK.indexOf(g.goal.state) >= 0) push("完成", "passed", "任务已完成");
    else if (DONE_BAD.indexOf(g.goal.state) >= 0) push("完成", "failed", "任务未能完成");
    else push("完成", "waiting", "前面的步骤完成后,这里会变为已完成");

    const cls = { passed: "tl-passed", running: "tl-running", failed: "tl-failed", rework: "tl-rework", waiting: "" };
    const chip = { passed: ["已完成", "ok"], running: ["进行中", "info"], failed: ["有问题", "bad"], rework: ["正在返工", "warn"], waiting: ["等待中", "default"] };
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

  // ---------- 技术详情区块(以下内容默认折叠) ----------
  function progressBlock(p, budgetRows) {
    const phaseKind = p.delivered ? "ok" : ["失败", "等待人工决策", "已阻塞"].indexOf(p.phase) >= 0 ? "bad" : ["已暂停", "返工中"].indexOf(p.phase) >= 0 ? "warn" : "info";
    const mc = (budgetRows || []).find(function (b) {
      return b.kind === "model_calls";
    });
    const counts = p.counts || {};
    const rows = [];
    rows.push(h("dt", { text: "当前阶段" }), h("dd", { "data-testid": "goal-phase" }, A.badge(A.zh(p.phase), phaseKind), h("span", { class: "small dim", text: " " + (p.phaseBasis || "") })));
    rows.push(h("dt", { text: "当前任务" }), h("dd", { class: "mono-sm", "data-testid": "goal-current-task", text: p.currentTaskId || "—" }));
    rows.push(h("dt", { text: "当前模型" }), h("dd", { class: "mono-sm", "data-testid": "goal-current-model", text: p.currentModelRef || "尚无运行" }));
    rows.push(h("dt", { text: "已运行" }), h("dd", { class: "small", text: p.elapsedSeconds === null || p.elapsedSeconds === undefined ? "—" : A.fmtDuration(p.elapsedSeconds) }));
    rows.push(
      h("dt", { text: "预算(模型调用)" }),
      h("dd", { class: "small", "data-testid": "goal-budget-mc", text: mc ? "已用 " + mc.used + (mc.limit !== null ? " / 上限 " + mc.limit : " / 无上限") + " · 预留 " + mc.reserved : "无账本行" }),
    );
    rows.push(
      h("dt", { text: "质量面" }),
      h(
        "dd",
        { class: "row" },
        A.badge("运行 " + (counts.runs || 0), "default"),
        A.badge("证据 " + (counts.evidence || 0), "info"),
        A.badge("Gate " + (counts.gates || 0), counts.gates ? "ok" : "default"),
        A.badge("待决定 " + (counts.openDecisions || 0), counts.openDecisions ? "warn" : "default"),
        A.badge(p.delivered ? "已交付" : "未交付", p.delivered ? "ok" : "default"),
      ),
    );
    return h("dl", { class: "kv" }, rows);
  }

  function headerBlock(g) {
    const rows = [];
    rows.push(h("dt", { text: "原始需求" }), h("dd", { class: "small", text: g.goal.rawInput }));
    rows.push(h("dt", { text: "Goal 状态" }), h("dd", {}, A.badge(A.zh(g.goal.state), A.stateKind(g.goal.state)), h("span", { class: "mono-sm dim", text: " " + g.goal.state })));
    rows.push(h("dt", { text: "Goal ID" }), h("dd", { class: "mono-sm", text: g.goal.id }));
    rows.push(h("dt", { text: "预算" }), h("dd", { class: "mono-sm small", text: JSON.stringify(g.goal.budget) }));
    rows.push(h("dt", { text: "创建 / 更新" }), h("dd", { class: "small dim", text: A.fmtTime(g.goal.createdAt) + " / " + A.fmtTime(g.goal.updatedAt) }));
    rows.push(h("dt", { text: "验收依据" }), h("dd", { class: "small", text: g.analysis.understanding.acceptanceBasis }));
    return h("dl", { class: "kv" }, rows);
  }

  function analysisBlock(a, discovery) {
    const src = h(
      "div",
      { class: "row" },
      A.badge("分析来源:确定性规则推导", "info"),
      h("span", { class: "small dim", text: "每条建议都标注依据(basis)与验证方式(verifiableBy),非模型结论" }),
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
            h("div", { class: "row" }, h("span", { class: "mono-sm", text: t.taskId }), A.badge("Gate 必需", t.gateRequired ? "ok" : "warn")),
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
        const btn = h("button", { class: "btn btn-sm", type: "button", "data-testid": "task-action-" + a.id + "-" + t.id, text: a.label });
        btn.addEventListener("click", function () {
          runAction(a, t, btn);
        });
        actions.appendChild(btn);
      });
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "task-row-" + t.id },
          h("td", { class: "mono-sm", text: t.id }),
          h("td", {}, A.badge(A.zh(t.state), A.stateKind(t.state)), h("span", { class: "mono-sm dim", text: " " + t.state })),
          h("td", { class: "small", text: t.attempt + "/" + t.maxAttempts }),
          h("td", { class: "small", text: t.allowedScope.join(", ") || "—" }),
          h("td", { class: "small", text: t.allowedCommands.join(", ") || "—" }),
          h("td", { class: "small dim", text: t.blockedReason || (t.openDecision ? "等待决定:" + A.zh(t.openDecision.level) : "") }),
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
          h("td", { class: "mono-sm", text: c.id }),
          h("td", {}, A.badge(A.zh(c.deliveryState), A.stateKind(c.deliveryState))),
          h("td", { class: "small", text: "增 " + c.changedFiles.added.length + " / 改 " + c.changedFiles.modified.length + " / 删 " + c.changedFiles.removed.length }),
          h("td", { class: "mono-sm dim", text: A.short(c.gitCommitSha || c.candidateSha) }),
          h("td", {}, h("a", { class: "small", href: "/changeset.html?id=" + encodeURIComponent(c.id), text: "查看结果 →" })),
        ),
      );
    });
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "变更集" }), h("th", { text: "交付状态" }), h("th", { text: "变更" }), h("th", { text: "提交" }), h("th", { text: "" }))),
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
          h("td", { class: "mono-sm", text: r.id }),
          h("td", {}, A.badge(A.zh(r.outcome), A.stateKind(r.outcome)), h("span", { class: "mono-sm dim", text: " " + r.outcome })),
          h("td", { class: "small", text: r.role || "coder" }),
          h("td", { class: "small", "data-testid": "run-reason-" + r.id, text: r.reason || "—" }),
          h("td", { class: "small dim mono-sm", text: r.modelRef + " · " + r.sandbox }),
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
          h("td", { class: "mono-sm", text: A.short(e.candidateSha) }),
          h("td", { class: "mono-sm", text: e.contentSha256.slice(0, 16) }),
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
          h("td", {}, A.badge(A.zh(g.verdict), A.stateKind(g.verdict)), h("span", { class: "mono-sm dim", text: " " + g.verdict })),
          h("td", { class: "small", text: g.reviewer }),
          h("td", { class: "mono-sm", text: A.short(g.candidateSha) }),
          h("td", { class: "mono-sm", text: A.short(g.reviewerRunId, 10) }),
          h("td", { class: "mono-sm", text: A.short(g.coderRunId, 10) }),
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
            h("span", { class: "mono-sm", text: "#" + e.seq }),
            A.badge(e.action, "default"),
            h("span", { class: "small dim", text: e.authority + " · " + e.actor + " · " + A.fmtTime(e.ts) }),
          ),
        ),
      );
    });
    return ul;
  }

  // ---------- 列表模式(无 id):全部任务 ----------
  function listBlock(goals) {
    if (!goals.length) {
      return h("div", { class: "stack" },
        h("p", { class: "empty", text: "还没有任务。" }),
        h("p", { class: "small dim" }, "回到", h("a", { href: "/", text: "工作台" }), "用一句话创建一个需求即可。"));
    }
    const ul = h("ul", { class: "plain item-list" });
    goals.forEach(function (g) {
      ul.appendChild(
        h(
          "li",
          { "data-testid": "goal-row-" + g.id },
          h("div", { class: "row item-row" },
            h("a", { class: "row-title", href: "/goal.html?id=" + encodeURIComponent(g.id), text: g.rawInput.length > 80 ? g.rawInput.slice(0, 80) + "…" : g.rawInput }),
            A.badge(A.zh(g.state), A.stateKind(g.state)),
          ),
          h("div", { class: "small dim", text: "更新于 " + A.fmtTime(g.updatedAt) }),
        ),
      );
    });
    return ul;
  }

  async function refresh() {
    const id = new URLSearchParams(window.location.search).get("id");
    const detail = document.getElementById("goal-detail");
    const listCard = document.getElementById("list-card");
    if (!id) {
      document.getElementById("page-title").textContent = "任务";
      listCard.hidden = false;
      try {
        const res = await A.guarded(function () {
          return A.apiGet("/api/dashboard");
        });
        const host = document.getElementById("goals-list");
        host.textContent = "";
        host.appendChild(listBlock(res.dashboard.goals || []));
      } catch (e) {
        console.error("render-failed", e && e.stack ? e.stack : String(e));
      }
      return;
    }
    listCard.hidden = true;
    detail.hidden = false;
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/goals/" + encodeURIComponent(id));
      });
      const g = res.goal;
      document.getElementById("page-title").textContent = "任务详情";
      document.getElementById("goal-hero").textContent = "";
      document.getElementById("goal-hero").appendChild(heroBlock(g));
      document.getElementById("goal-timeline").textContent = "";
      document.getElementById("goal-timeline").appendChild(timelineBlock(g));
      document.getElementById("goal-progress").textContent = "";
      document.getElementById("goal-progress").appendChild(progressBlock(g.progress || {}, g.budget || []));
      document.getElementById("goal-header").textContent = "";
      document.getElementById("goal-header").appendChild(headerBlock(g));
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

  A.boot("goals", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
  });
})();
