// AI 资源页(WEB-UX-02 中文化;原 Models/Usage 纯观察面)。
// 铁律:零探测(probed 恒 false)、零凭据;分类不伪造(UNREGISTERED 如实展示)。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function fmtDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return ms + "ms";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m" + (s % 60) + "s";
  }

  function providerBlock(v) {
    const rows = [];
    rows.push(h("dt", { text: "已配置" }), h("dd", {}, v.provider.configured ? A.badge("已配置", "ok") : A.badge("未配置", "warn")));
    rows.push(h("dt", { text: "服务名称" }), h("dd", { class: "mono-sm", text: v.provider.providerName || "—" }));
    rows.push(h("dt", { text: "模型" }), h("dd", { class: "mono-sm", text: v.provider.modelName || "—" }));
    rows.push(h("dt", { text: "网关地址" }), h("dd", { class: "mono-sm small", text: v.provider.baseUrlHost || "—" }));
    rows.push(h("dt", { text: "健康探测" }), h("dd", {}, A.badge("未探测(零模型调用)", "info")));
    rows.push(h("dt", { text: "本地 / 云端" }), h("dd", { class: "small dim", text: "未登记(Provider Registry 属 MODEL-POLICY-01,未实施 ⇒ 不伪造分类)" }));
    rows.push(h("dt", { text: "最近 model_ref" }), h("dd", { class: "mono-sm small", text: v.recentRuns.length ? v.recentRuns[0].modelRef : "无记录" }));
    return h("dl", { class: "kv" }, rows);
  }

  function budgetBlock(v) {
    const t = v.budgetTotals;
    const mc = t.modelCalls;
    const head = h(
      "div",
      { class: "row", "data-testid": "usage-budget-totals" },
      A.badge("模型调用 已用 " + mc.used + (mc.limit !== null ? " / 上限 " + mc.limit : " / 无全局上限"), mc.limit !== null && mc.used >= mc.limit ? "bad" : "ok"),
      A.badge("预留 " + mc.reserved, "info"),
      A.badge("输入 tokens " + t.tokensInUsed + " · 输出 tokens " + t.tokensOutUsed, "default"),
      A.badge("累计耗时 " + fmtDuration(t.wallSecondsUsed * 1000), "default"),
    );
    if (!v.perGoal.length) return h("div", { class: "stack" }, head, h("p", { class: "empty", text: "尚无任务级账本行" }));
    const tbody = h("tbody", {});
    v.perGoal.forEach(function (p) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "usage-budget-goal-" + p.goalId },
          h("td", { class: "mono-sm", text: p.goalId }),
          h("td", { class: "small", text: p.rawInput.length > 40 ? p.rawInput.slice(0, 40) + "…" : p.rawInput }),
          h("td", { text: p.limit === null ? "—" : String(p.limit) }),
          h("td", { text: String(p.used) }),
          h("td", { text: String(p.reserved) }),
        ),
      );
    });
    return h(
      "div",
      { class: "stack" },
      head,
      h(
        "div",
        { class: "table-scroll" },
        h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "任务" }), h("th", { text: "需求" }), h("th", { text: "上限" }), h("th", { text: "已用" }), h("th", { text: "预留" }))), tbody),
      ),
    );
  }

  function outcomesBlock(v) {
    const keys = Object.keys(v.outcomes.byOutcome);
    if (!keys.length) return h("p", { class: "empty", text: "尚无调用记录" });
    const head = h("div", { class: "row" });
    keys.sort().forEach(function (k) {
      head.appendChild(A.badge(A.zh(k) + " " + v.outcomes.byOutcome[k], A.stateKind(k)));
    });
    const ul = h("ul", { class: "plain", "data-testid": "usage-reasons" });
    (v.outcomes.reasons || []).forEach(function (r) {
      ul.appendChild(h("li", {}, h("span", { class: "small", text: r.reason }), h("span", { class: "small dim", text: " × " + r.n })));
    });
    return h("div", { class: "stack" }, head, ul.childNodes.length ? ul : h("span", { class: "small dim", text: "无失败/中止原因记录" }));
  }

  function runsBlock(v) {
    if (!v.recentRuns.length) return h("p", { class: "empty", text: "尚无模型调用记录" });
    const tbody = h("tbody", {});
    v.recentRuns.forEach(function (r) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "usage-run-" + r.id },
          h("td", { class: "mono-sm", text: r.id }),
          h("td", { class: "mono-sm", text: r.taskId }),
          h("td", { class: "small", text: r.role || "coder" }),
          h("td", {}, A.badge(A.zh(r.outcome), A.stateKind(r.outcome))),
          h("td", { class: "mono-sm", text: r.modelRef }),
          h("td", { class: "small dim", text: fmtDuration(r.durationMs) }),
          h("td", { class: "small dim", text: A.fmtTime(r.startedAt) }),
        ),
      );
    });
    return h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { text: "调用" }), h("th", { text: "任务" }), h("th", { text: "角色" }), h("th", { text: "结果" }), h("th", { text: "model_ref" }), h("th", { text: "耗时" }), h("th", { text: "开始" }))),
        tbody,
      ),
    );
  }

  function discoveriesBlock(v) {
    if (!v.recentDiscoveries.length) return h("p", { class: "empty", text: "尚无需求分析记录" });
    const ul = h("ul", { class: "plain" });
    v.recentDiscoveries.forEach(function (d) {
      ul.appendChild(
        h(
          "li",
          { "data-testid": "usage-discovery-" + d.id },
          h(
            "div",
            { class: "row" },
            A.badge(A.zh(d.outcome), A.stateKind(d.outcome)),
            h("span", { class: "mono-sm", text: d.goalId }),
            h("span", { class: "mono-sm dim", text: d.modelRef }),
            h("span", { class: "small dim", text: A.fmtTime(d.createdAt) }),
          ),
          d.reason ? h("div", { class: "small dim", text: "原因:" + d.reason }) : null,
        ),
      );
    });
    return ul;
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/models-usage");
      });
      const v = res.usage;
      document.getElementById("provider-body").textContent = "";
      document.getElementById("provider-body").appendChild(providerBlock(v));
      document.getElementById("budget-body").textContent = "";
      document.getElementById("budget-body").appendChild(budgetBlock(v));
      document.getElementById("outcomes-body").textContent = "";
      document.getElementById("outcomes-body").appendChild(outcomesBlock(v));
      document.getElementById("runs-body").textContent = "";
      document.getElementById("runs-body").appendChild(runsBlock(v));
      document.getElementById("discoveries-body").textContent = "";
      document.getElementById("discoveries-body").appendChild(discoveriesBlock(v));
    } catch (e) {
      console.error("models render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("models", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
  });
})();
