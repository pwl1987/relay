// Dashboard 页(P0-02C)。只读为主 + 两个写动作(推进一拍 / 创建 Goal)。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function healthBlock(hl, lastProgressAt) {
    const rows = [];
    rows.push(
      h("dt", { text: "数据库" }),
      h("dd", {}, hl.db.ok ? A.badge("可用", "ok") : A.badge("不可用", "bad")),
    );
    rows.push(
      h("dt", { text: "Worker" }),
      h(
        "dd",
        {},
        A.badge(hl.worker.mode === "live" ? "本进程驱动" : hl.worker.mode === "stub" ? "桩执行器" : "独立进程", hl.worker.mode === "live" ? "ok" : "warn"),
        h("span", { class: "small dim", text: " 最近一次:" + (hl.worker.lastTick ? hl.worker.lastTick.status + " @ " + A.fmtTime(hl.worker.lastTick.at) : "本进程未驱动过") }),
      ),
    );
    rows.push(
      h("dt", { text: "模型 Provider" }),
      h(
        "dd",
        {},
        hl.provider.configured ? A.badge("已配置", "info") : A.badge("未配置", "default"),
        h("span", { class: "small dim", text: " " + hl.provider.note }),
      ),
    );
    rows.push(h("dt", { text: "最近真实进展" }), h("dd", { text: lastProgressAt ? A.fmtTime(lastProgressAt) : "尚无记录" }));
    return h("dl", { class: "kv" }, rows);
  }

  function taskCounts(tc) {
    const keys = Object.keys(tc);
    if (!keys.length) return h("p", { class: "empty", text: "当前没有任何任务" });
    const wrap = h("div", { class: "row" });
    keys.sort().forEach(function (k) {
      wrap.appendChild(h("span", { class: "stack" }, A.badge(k + " " + tc[k], A.stateKind(k))));
    });
    return wrap;
  }

  function budgetBlock(b) {
    if (!b.budget.length) return h("p", { class: "empty", text: "尚无预算账本行" });
    const t = b.budgetTotals;
    const head = h(
      "div",
      { class: "row" },
      A.badge("模型调用 已用 " + t.used + (t.limit !== null ? " / 上限 " + t.limit : " / 未设上限"), t.limit !== null && t.used >= t.limit ? "bad" : "ok"),
      A.badge("预留中 " + t.reserved, "info"),
    );
    const table = h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "范围" }), h("th", { text: "种类" }), h("th", { text: "上限" }), h("th", { text: "已用" }), h("th", { text: "预留" }))),
      h(
        "tbody",
        {},
        b.budget.map(function (r) {
          return h(
            "tr",
            {},
            h("td", { class: "mono", text: r.scopeType + ":" + A.short(r.scopeId, 16) }),
            h("td", { text: r.kind }),
            h("td", { text: r.limit === null ? "—" : String(r.limit) }),
            h("td", { text: String(r.used) }),
            h("td", { text: String(r.reserved) }),
          );
        }),
      ),
    );
    return h("div", { class: "stack" }, head, table);
  }

  function blockedBlock(b) {
    if (!b.blocked.length) return h("p", { class: "empty", text: "没有阻塞项" });
    const list = h("ul", { class: "plain" });
    b.blocked.forEach(function (t) {
      const line = h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "row" },
          A.badge(t.state, A.stateKind(t.state)),
          h("span", { class: "mono small", text: t.taskId }),
          t.openDecision ? A.badge("待裁决 " + t.openDecision.level, "warn") : null,
          h("span", { class: "small dim", text: "尝试 " + t.attempt + "/" + t.maxAttempts }),
        ),
        h("div", { class: "small dim", text: t.blockedReason || (t.openDecision ? t.openDecision.question : "无阻塞原因记录") }),
      );
      list.appendChild(h("li", {}, line));
    });
    return list;
  }

  function anomaliesBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "当前无异常" });
    const ul = h("ul", { class: "plain" });
    list.forEach(function (a) {
      ul.appendChild(
        h(
          "li",
          {},
          h(
            "div",
            { class: "row" },
            A.badge(a.kind, "bad"),
            h("span", { class: "mono small", text: a.subject }),
            h("span", { class: "small dim", text: a.ts ? A.fmtTime(a.ts) : "" }),
          ),
          h("div", { class: "small", text: a.detail }),
        ),
      );
    });
    return ul;
  }

  function auditBlock(rows) {
    if (!rows.length) return h("p", { class: "empty", text: "尚无审计记录" });
    const ul = h("ul", { class: "plain" });
    rows.slice(0, 20).forEach(function (e) {
      ul.appendChild(
        h(
          "li",
          {},
          h(
            "div",
            { class: "row" },
            h("span", { class: "mono small", text: "#" + e.seq }),
            A.badge(e.action, e.action.indexOf("REJECTED") >= 0 || e.action.indexOf("FAILED") >= 0 ? "bad" : "default"),
            h("span", { class: "small dim", text: e.authority + " · " + e.actor + " · " + A.fmtTime(e.ts) }),
          ),
          e.taskId ? h("div", { class: "small dim mono", text: e.taskId + (e.beforeState ? " " + e.beforeState + " → " + e.afterState : "") }) : null,
        ),
      );
    });
    return ul;
  }

  function goalsBlock(goals) {
    if (!goals.length) return h("p", { class: "empty", text: "还没有 Goal —— 先用一句话描述你要交付什么" });
    const table = h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "Goal" }), h("th", { text: "状态" }), h("th", { text: "任务" }), h("th", { text: "更新" }), h("th", { text: "" }))),
      h(
        "tbody",
        {},
        goals.map(function (g) {
          const counts = Object.keys(g.taskCounts)
            .map(function (k) {
              return k + ":" + g.taskCounts[k];
            })
            .join(" ");
          return h(
            "tr",
            { "data-testid": "goal-row-" + g.id },
            h("td", { text: g.rawInput.length > 90 ? g.rawInput.slice(0, 90) + "…" : g.rawInput }),
            h("td", {}, A.badge(g.state, A.stateKind(g.state))),
            h("td", { class: "small", text: counts || "—" }),
            h("td", { class: "small dim", text: A.fmtTime(g.updatedAt) }),
            h("td", {}, h("a", { class: "small", href: "/goal.html?id=" + encodeURIComponent(g.id), text: "查看" })),
          );
        }),
      ),
    );
    return table;
  }

  function capabilitiesBlock(reg) {
    const table = h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { text: "能力" }), h("th", { text: "状态" }), h("th", { text: "说明" }))),
      h(
        "tbody",
        {},
        reg.entries.map(function (e) {
          const kind = e.status === "IMPLEMENTED" ? "ok" : e.status === "NOT_IMPLEMENTED" ? "warn" : e.status === "STUB" ? "info" : "bad";
          return h(
            "tr",
            { "data-testid": "cap-" + e.id },
            h("td", { text: e.title }),
            h("td", {}, A.badge(e.status, kind)),
            h("td", { class: "small dim", text: e.note }),
          );
        }),
      ),
    );
    return h("div", { class: "stack" }, h("p", { class: "small dim", text: "worker 执行面:" + reg.workerMode + "(登记于 " + A.fmtTime(reg.generatedAt) + ")" }), table);
  }

  // OPERATOR-CONSOLE-00 P0-UI-1:总览条(状态/当前 Goal/任务分组/Decision 待决/Provider·Model/Delivery/Worker)
  function overviewBlock(d, extras, worker, providerModel) {
    const overall = extras.overall || { status: "normal", basis: "" };
    const statusKind = overall.status === "blocked" ? "bad" : "ok";
    const statusText = overall.status === "blocked" ? "需要关注" : "正常运行";
    const g = extras.taskGroups || {};
    const left = h(
      "div",
      { class: "stack", "data-testid": "overview-status" },
      h("div", { class: "row" }, A.badge("Relay " + statusText, statusKind), h("span", { class: "small dim", text: overall.basis })),
      h(
        "div",
        { class: "row" },
        A.badge("进行中 " + (g.inFlight || 0), "info"),
        A.badge("可排队 " + (g.ready || 0), "default"),
        A.badge("等待·受阻 " + (g.waiting || 0), g.waiting ? "warn" : "default"),
        A.badge("失败 " + (g.failed || 0), g.failed ? "bad" : "default"),
        A.badge("完成 " + (g.done || 0), "ok"),
        A.badge("Decision 待决 " + (d.openDecisionCount || 0), d.openDecisionCount ? "warn" : "default"),
      ),
    );
    const cur = extras.currentGoal;
    const curLine = h(
      "div",
      { class: "small", "data-testid": "overview-current-goal" },
      cur
        ? [
            h("span", { class: "dim", text: "当前 Goal:" }),
            h("a", { href: "/goal.html?id=" + encodeURIComponent(cur.id), text: cur.rawInput.length > 60 ? cur.rawInput.slice(0, 60) + "…" : cur.rawInput }),
            cur.inFlightState ? h("span", { class: "small dim", text: "(任务 " + cur.inFlightState + ")" }) : null,
          ]
        : h("span", { class: "dim", text: "当前无活跃 Goal —— 可在下方一句话创建" }),
    );
    const delivery = extras.deliverySummary || { byState: {}, deliveredTotal: 0 };
    const dsKeys = Object.keys(delivery.byState || {});
    const deliveryLine = h(
      "div",
      { class: "row", "data-testid": "overview-delivery" },
      h("span", { class: "dim small", text: "GitHub Delivery:" }),
      dsKeys.length
        ? dsKeys.map(function (k) {
            return A.badge(k + " " + delivery.byState[k], A.stateKind(k));
          })
        : h("span", { class: "small dim", text: "尚无变更集" }),
    );
    const model = extras.lastModel || {};
    const providerLine = h(
      "div",
      { class: "row", "data-testid": "overview-provider" },
      h("span", { class: "dim small", text: "Provider/Model:" }),
      providerModel.configured
        ? A.badge((providerModel.providerName || "?") + " / " + (providerModel.modelName || "?"), "info")
        : A.badge("未配置", "warn"),
      model.modelRef ? h("span", { class: "small dim mono", text: "最近 " + model.modelRef }) : h("span", { class: "small dim", text: "尚无调用记录" }),
    );
    const workerLine = h(
      "div",
      { class: "row", "data-testid": "overview-worker" },
      h("span", { class: "dim small", text: "Worker:" }),
      A.badge(worker.mode === "live" ? "本进程驱动" : worker.mode === "stub" ? "桩执行器" : "独立进程", worker.mode === "live" ? "ok" : "info"),
      worker.lastTick ? h("span", { class: "small dim", text: "最近 tick " + worker.lastTick.status }) : h("span", { class: "small dim", text: "独立进程推进" }),
      extras.lastWorkerHeartbeat ? h("span", { class: "small dim", text: "· 租约心跳 " + A.fmtTime(extras.lastWorkerHeartbeat) }) : null,
    );
    // 最近完成任务(REVIEW F-1:合同要件;数据来自 extras.recentCompleted,空态如实)
    const recent = extras.recentCompleted || [];
    const recentLine = h(
      "div",
      { class: "row", "data-testid": "overview-recent-completed" },
      h("span", { class: "dim small", text: "最近完成任务:" }),
      recent.length
        ? recent.map(function (r) {
            return h(
              "span",
              { class: "row small", "data-testid": "overview-recent-" + r.taskId },
              A.badge(r.deliveryState, A.stateKind(r.deliveryState)),
              h("span", { class: "mono small", text: r.taskId }),
              r.commitSha ? h("span", { class: "mono small dim", text: A.short(r.commitSha, 10) }) : null,
              h("span", { class: "small dim", text: r.changedFiles + " 文件" + (r.deliveredAt ? " · " + A.fmtTime(r.deliveredAt) : "") }),
            );
          })
        : h("span", { class: "small dim", text: "尚无交付记录" }),
    );
    return h("div", { class: "stack" }, left, curLine, deliveryLine, providerLine, workerLine, recentLine);
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/dashboard");
      });
      const d = res.dashboard;
      const health = await A.apiGet("/api/health");
      document.getElementById("overview-body").textContent = "";
      document.getElementById("overview-body").appendChild(overviewBlock(d, res.extras || {}, res.worker || { mode: "external" }, res.providerModel || { configured: false }));
      document.getElementById("health-body").textContent = "";
      document.getElementById("health-body").appendChild(healthBlock(health, d.lastProgressAt));
      document.getElementById("task-counts").textContent = "";
      document.getElementById("task-counts").appendChild(taskCounts(d.taskCounts));
      document.getElementById("budget-body").textContent = "";
      document.getElementById("budget-body").appendChild(budgetBlock(d));
      document.getElementById("blocked-body").textContent = "";
      document.getElementById("blocked-body").appendChild(blockedBlock(d));
      document.getElementById("anomalies-body").textContent = "";
      document.getElementById("anomalies-body").appendChild(anomaliesBlock(d.anomalies));
      document.getElementById("audit-body").textContent = "";
      document.getElementById("audit-body").appendChild(auditBlock(d.audit));
      document.getElementById("goals-body").textContent = "";
      document.getElementById("goals-body").appendChild(goalsBlock(d.goals));

      const caps = await A.guarded(function () {
        return A.apiGet("/api/capabilities");
      });
      document.getElementById("capabilities-body").textContent = "";
      document.getElementById("capabilities-body").appendChild(capabilitiesBlock(caps.registry));
    } catch (e) {
      // 渲染异常必须可观测:进浏览器控制台(测试捕获),不吞掉、也不覆盖 tick 的结果文本
      console.error("dashboard render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  async function tick() {
    const btn = document.getElementById("btn-tick");
    btn.disabled = true;
    const msg = document.getElementById("create-msg");
    try {
      const res = await A.apiPost("/api/worker/tick", {});
      msg.textContent = "推进结果:" + (res.tick && res.tick.status ? res.tick.status : JSON.stringify(res).slice(0, 120));
    } catch (e) {
      msg.textContent = "推进失败:" + ((e && e.message) || e);
    } finally {
      btn.disabled = false;
      await refresh();
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

  A.boot("dashboard", async function () {
    document.getElementById("btn-tick").addEventListener("click", tick);
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    document.getElementById("btn-create-goal").addEventListener("click", createGoal);
    await refresh();
  });
})();
