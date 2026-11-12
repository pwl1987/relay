// Decision Inbox(P0-02C)。展示与授权一律走 core.ops.resolveDecision / core.deferDecision。
// 铁律:本页**不提供**任何 D3 自动批准入口(无"超时自动通过"、无"批量批准")。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  const PATH_BY_LEVEL = {
    D0: "作用域内自动执行(不产生决策行)",
    D1: "作用域内自动执行(不产生决策行)",
    D2: "按创建时已声明的 fallback 执行",
    D3: "必须由人裁决;没有任何自动放行路径",
    D4: "禁止(创建即拒绝)",
  };

  function decisionCard(d) {
    const pending = d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED";
    const g = d.guidance || {};
    const rows = [];
    rows.push(h("dt", { text: "处置路径(规则)" }), h("dd", { text: PATH_BY_LEVEL[d.level] || "未登记" }));
    // OPERATOR-CONSOLE-00 P0-UI-4:决策支持五要素(服务端从既有列确定性推导;不伪造模型推荐)
    rows.push(h("dt", { text: "为什么需要用户决定" }), h("dd", { class: "small", "data-testid": "decision-why-" + d.id, text: g.why || d.question }));
    rows.push(
      h("dt", { text: "推荐方案" }),
      h("dd", { class: "small", "data-testid": "decision-recommended-" + d.id, text: g.recommended || "系统未预设推荐方案(需人工结合事实判断)" }),
    );
    rows.push(
      h("dt", { text: "备选方案" }),
      h("dd", { class: "small", "data-testid": "decision-alternatives-" + d.id, text: g.alternatives && g.alternatives.length ? g.alternatives.join(";") : "无登记备选" }),
    );
    rows.push(h("dt", { text: "风险" }), h("dd", { class: "small", "data-testid": "decision-risk-" + d.id, text: g.risk || "未登记" }));
    rows.push(
      h("dt", { text: "不处理会怎样" }),
      h("dd", { class: "small", "data-testid": "decision-impact-" + d.id, text: g.impactOfNoAction || d.timeoutBehavior }),
    );
    rows.push(
      h("dt", { text: "原始问题 / fallback" }),
      h("dd", { class: "small", text: d.question + (d.fallback ? " · fallback:" + JSON.stringify(d.fallback) : " · 无声明 fallback ⇒ 不得自动执行") }),
    );
    rows.push(
      h("dt", { text: "影响文件 / 系统" }),
      h("dd", { class: "small mono", text: d.affectedFiles.length ? d.affectedFiles.join(", ") : "无记录的影响文件(该决策未绑定变更集)" }),
    );
    rows.push(h("dt", { text: "是否可逆" }), h("dd", {}, A.badge(d.reversible ? "可逆" : "不可逆", d.reversible ? "ok" : "warn")));
    rows.push(h("dt", { text: "成本 / 回滚" }), h("dd", { class: "small", text: "批准后任务回到 READY 由 Worker 继续;回滚 = 再次拒绝/重置状态(需 operator 授权 + 状态版本校验)" }));
    rows.push(h("dt", { text: "超时默认行为" }), h("dd", { class: "small", text: d.timeoutBehavior }));
    rows.push(h("dt", { text: "影响范围" }), h("dd", { class: "small mono", text: (d.taskId || "无关联任务") + (d.goalId ? " · " + d.goalId : "") }));
    rows.push(h("dt", { text: "截止时间" }), h("dd", { class: "small", text: d.deadline ? A.fmtTime(d.deadline) : "无(未设)" }));
    rows.push(h("dt", { text: "关联任务状态" }), h("dd", {}, d.taskState ? A.badge(d.taskState, A.stateKind(d.taskState)) : h("span", { class: "small dim", text: "—" })));

    const actions = h("div", { class: "row" });
    if (pending) {
      const approve = h("button", { class: "btn btn-primary", type: "button", "data-testid": "approve-" + d.id, text: "批准" });
      approve.addEventListener("click", function () {
        resolve(d, true, approve);
      });
      actions.appendChild(approve);
      const reject = h("button", { class: "btn btn-danger", type: "button", "data-testid": "reject-" + d.id, text: "拒绝" });
      reject.addEventListener("click", function () {
        resolve(d, false, reject);
      });
      actions.appendChild(reject);
      const defer = h("button", { class: "btn", type: "button", "data-testid": "defer-" + d.id, text: "推迟(仅延后截止时间)" });
      defer.addEventListener("click", function () {
        deferDecision(d, defer);
      });
      actions.appendChild(defer);
      if (d.level === "D3") {
        actions.appendChild(h("span", { class: "small dim", text: "D3 无自动批准入口" }));
      }
    } else {
      actions.appendChild(h("span", { class: "small dim", text: "已裁决:" + d.state + (d.decidedBy ? " by " + d.decidedBy : "") }));
    }

    return h(
      "div",
      { class: "stack", "data-testid": "decision-card-" + d.id, "data-level": d.level, "data-state": d.state },
      h(
        "div",
        { class: "row" },
        A.badge(d.level, d.level === "D3" ? "warn" : "info"),
        A.badge(d.state, A.stateKind(d.state)),
        h("span", { class: "mono small", text: d.id }),
        h("span", { class: "small dim", text: "创建于 " + A.fmtTime(d.createdAt) }),
      ),
      h("div", { text: d.question }),
      h("dl", { class: "kv" }, rows),
      actions,
    );
  }

  async function resolve(d, approve, btn) {
    btn.disabled = true;
    try {
      await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/resolve", {
        taskId: d.taskId,
        approve: approve,
        expectedStateVersion: d.taskStateVersion,
      });
      await refresh();
    } catch (e) {
      alert("裁决失败:" + ((e && e.message) || e) + "(状态版本可能已变化,请刷新后重试)");
      btn.disabled = false;
    }
  }

  async function deferDecision(d, btn) {
    btn.disabled = true;
    try {
      const base = d.deadline ? new Date(d.deadline).getTime() : Date.now();
      const next = new Date(base + 24 * 3600 * 1000).toISOString();
      await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/defer", {
        taskId: d.taskId,
        expectedStateVersion: d.taskStateVersion,
        newDeadline: next,
      });
      await refresh();
    } catch (e) {
      alert("推迟失败:" + ((e && e.message) || e));
      btn.disabled = false;
    }
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/decisions");
      });
      const list = res.decisions || [];
      const pending = list.filter(function (d) {
        return d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED";
      });
      const history = list.filter(function (d) {
        return d.state !== "OPEN" && d.state !== "EXPIRED_STILL_BLOCKED";
      });

      const openBox = document.getElementById("decisions-open");
      openBox.textContent = "";
      if (!pending.length) {
        openBox.appendChild(h("p", { class: "empty", text: "没有待裁决事项" }));
      } else {
        pending.forEach(function (d) {
          openBox.appendChild(h("div", { class: "decision-sep" }, decisionCard(d)));
        });
      }

      const histBox = document.getElementById("decisions-history");
      histBox.textContent = "";
      if (!history.length) {
        histBox.appendChild(h("p", { class: "empty", text: "尚无已裁决决策" }));
      } else {
        const tbody = h("tbody", {});
        history.forEach(function (d) {
          tbody.appendChild(
            h(
              "tr",
              { "data-testid": "decision-history-" + d.id },
              h("td", {}, A.badge(d.level, "info")),
              h("td", {}, A.badge(d.state, A.stateKind(d.state))),
              h("td", { class: "small", text: d.question }),
              h("td", { class: "small dim", text: d.decidedBy || "—" }),
              h("td", { class: "small dim", text: A.fmtTime(d.decidedAt) }),
            ),
          );
        });
        histBox.appendChild(
          h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "级别" }), h("th", { text: "状态" }), h("th", { text: "问题" }), h("th", { text: "裁决者" }), h("th", { text: "时间" }))), tbody),
        );
      }
    } catch (e) {
      console.error("render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("decisions", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
  });
})();
