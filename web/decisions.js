// 待我决定(WEB-UX-02 §10 重做):每张卡只答四问(发生什么了/推荐怎么办/为什么处理/风险),
// 按钮=采用推荐方案/查看其他方案/稍后决定。展示与授权一律走 core.ops.resolveDecision / core.deferDecision。
// 铁律不变:本页**不提供**任何自动批准入口(无"超时自动通过"、无"批量批准")。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function decisionCard(d) {
    const pending = d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED";
    const g = d.guidance || {};
    const body = [];

    // WEB-UX-02:用户语言四问;内部术语(D 级代码/fallback/state_version)不进入普通视图
    body.push(h("div", { class: "q-block" }, h("div", { class: "q-label", text: "发生什么了?" }), h("div", { class: "q-text", "data-testid": "decision-why-" + d.id, text: g.why || d.question })));
    body.push(
      h("div", { class: "q-block" },
        h("div", { class: "q-label", text: "Relay 推荐怎么办?" }),
        h("div", { class: "q-text", "data-testid": "decision-recommended-" + d.id, text: g.recommended || "系统没有预设推荐,需要你结合情况判断" })),
    );
    body.push(h("div", { class: "q-block" }, h("div", { class: "q-label", text: "风险是什么?" }), h("div", { class: "q-text", "data-testid": "decision-risk-" + d.id, text: g.risk || "—" })));
    body.push(
      h("div", { class: "q-block" },
        h("div", { class: "q-label", text: "不处理会怎样?" }),
        h("div", { class: "q-text", "data-testid": "decision-impact-" + d.id, text: g.impactOfNoAction || d.timeoutBehavior })),
    );

    // 其他方案(展开):备选 + 影响面 + 可逆性 + 拒绝入口
    const alt = h(
      "div",
      { class: "alt-panel", "data-testid": "decision-alternatives-" + d.id },
      h("h3", { text: "其他方案" }),
      g.alternatives && g.alternatives.length
        ? h("ul", { class: "plain" }, g.alternatives.map(function (x) { return h("li", { text: x }); }))
        : h("p", { class: "empty", text: "没有登记备选方案。" }),
      h("h3", { text: "影响范围" }),
      h("p", { class: "small mono-sm", text: d.affectedFiles.length ? d.affectedFiles.join(", ") : "没有记录受影响文件(该决策未绑定变更集)" }),
      h("p", { class: "small dim", text: d.reversible ? "该操作可以回滚,批准后如需撤销可再次处理。" : "该操作不容易回滚,请谨慎决定。" }),
    );

    const actions = h("div", { class: "row decision-actions" });
    if (pending) {
      const approve = h("button", { class: "btn btn-primary", type: "button", "data-testid": "approve-" + d.id, text: "采用推荐方案" });
      approve.addEventListener("click", function () {
        resolve(d, true, approve);
      });
      actions.appendChild(approve);
      const defer = h("button", { class: "btn", type: "button", "data-testid": "defer-" + d.id, text: "稍后决定" });
      defer.addEventListener("click", function () {
        deferDecision(d, defer);
      });
      actions.appendChild(defer);
    } else {
      actions.appendChild(h("span", { class: "small dim", text: "已处理:" + A.zh(d.state) + (d.decidedBy ? "(由 " + d.decidedBy + ")" : "") }));
    }

    const headRow = h(
      "div",
      { class: "row item-row" },
      A.badge(A.zh(d.level), d.level === "D3" ? "warn" : "info"),
      pending ? A.badge("待处理", "warn") : A.badge(A.zh(d.state), A.stateKind(d.state)),
      h("span", { class: "small dim", text: "提出于 " + A.fmtTime(d.createdAt) + (d.deadline ? " · 建议在 " + A.fmtTime(d.deadline) + " 前处理" : "") }),
      h("span", { class: "mono-sm dim spacer-r", text: d.id }),
    );

    return h(
      "div",
      { class: "decision-card stack", "data-testid": "decision-card-" + d.id, "data-level": d.level, "data-state": d.state },
      headRow,
      h("div", { class: "decision-question", text: d.question }),
      h("div", { class: "stack" }, body),
      h("details", { class: "tech-details" },
        h("summary", { class: "dim", text: "查看其他方案与影响范围" }),
        h("div", { class: "mt8" }, alt),
        pending
          ? h("div", { class: "row mt8" },
              h("button", { class: "btn btn-danger", type: "button", "data-testid": "reject-" + d.id, text: "不采纳推荐(按其他方式处理)" }),
              h("span", { class: "small dim", text: "拒绝后任务会停下并记录原因,不会自动重试。" }))
          : null,
      ),
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
      alert("处理失败:" + ((e && e.message) || e) + "(页面信息可能已过期,请刷新后重试)");
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
      alert("延后失败:" + ((e && e.message) || e) + "(页面信息可能已过期,请刷新后重试)");
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
      A.setNavCount("decisions", pending.length);

      const openBox = document.getElementById("decisions-open");
      openBox.textContent = "";
      if (!pending.length) {
        openBox.appendChild(h("p", { class: "empty", text: "没有等你决定的事。有新事项时会出现在这里。" }));
      } else {
        pending.forEach(function (d) {
          openBox.appendChild(h("div", { class: "decision-sep" }, decisionCard(d)));
        });
      }

      const histBox = document.getElementById("decisions-history");
      histBox.textContent = "";
      if (!history.length) {
        histBox.appendChild(h("p", { class: "empty", text: "还没有处理记录" }));
      } else {
        const tbody = h("tbody", {});
        history.forEach(function (d) {
          tbody.appendChild(
            h(
              "tr",
              { "data-testid": "decision-history-" + d.id },
              h("td", {}, A.badge(A.zh(d.level), "info")),
              h("td", {}, A.badge(A.zh(d.state), A.stateKind(d.state))),
              h("td", { class: "small", text: d.question }),
              h("td", { class: "small dim", text: d.decidedBy || "—" }),
              h("td", { class: "small dim", text: A.fmtTime(d.decidedAt) }),
            ),
          );
        });
        histBox.appendChild(
          h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "类型" }), h("th", { text: "结果" }), h("th", { text: "问题" }), h("th", { text: "处理人" }), h("th", { text: "时间" }))), tbody),
        );
      }
    } catch (e) {
      console.error("render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("decisions", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
  });
})();
