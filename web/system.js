// 系统状态页(WEB-UX-02 §6:首页技术面板迁入此处;原 OPERATOR-CONSOLE-00 P0-UI-6)。
// Relay HEAD / Core / Worker / PostgreSQL / GitHub / Provider / uptime / 最近异常 + 预算账本 / 能力登记 / 审计。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function relayBlock(s) {
    const rows = [];
    rows.push(h("dt", { text: "HEAD" }), h("dd", { class: "mono-sm", "data-testid": "system-head", text: s.relay.headShort || "不可得" }));
    rows.push(h("dt", { text: "版本" }), h("dd", { text: s.relay.version + " · Node " + s.relay.node }));
    rows.push(h("dt", { text: "运行时长" }), h("dd", { text: Math.floor(s.relay.uptimeSeconds / 60) + " 分 " + (s.relay.uptimeSeconds % 60) + " 秒" }));
    rows.push(h("dt", { text: "进程启动" }), h("dd", { class: "small dim", text: A.fmtTime(s.relay.startedAt) }));
    return h("dl", { class: "kv" }, rows);
  }

  function dbWorkerBlock(s) {
    const rows = [];
    rows.push(
      h("dt", { text: "PostgreSQL" }),
      h("dd", {}, s.db.ok ? A.badge("可用", "ok") : A.badge("不可用", "bad"), s.db.schema ? h("span", { class: "small dim mono-sm", text: " schema:" + s.db.schema }) : null),
    );
    rows.push(h("dt", { text: "DB 版本" }), h("dd", { class: "small dim", text: (s.db.serverVersion || "—").split(",")[0] }));
    rows.push(
      h("dt", { text: "Worker" }),
      h(
        "dd",
        { "data-testid": "system-worker" },
        A.badge(s.worker.mode === "live" ? "本进程驱动" : s.worker.mode === "stub" ? "演示执行器" : "独立进程", s.worker.mode === "live" ? "ok" : "info"),
        s.worker.lastTick ? h("span", { class: "small dim", text: " 最近一拍:" + A.zh(s.worker.lastTick.status) + " @ " + A.fmtTime(s.worker.lastTick.at) }) : h("span", { class: "small dim", text: " 本进程未驱动(独立 worker 进程)" }),
      ),
    );
    rows.push(
      h("dt", { text: "活跃租约" }),
      h("dd", { class: "small", text: s.worker.activeLeases + " 个" + (s.worker.lastLeaseHeartbeat ? " · 最近心跳 " + A.fmtTime(s.worker.lastLeaseHeartbeat) : "") }),
    );
    return h("dl", { class: "kv" }, rows);
  }

  function githubProviderBlock(s) {
    const rows = [];
    const states = Object.keys(s.github.deliveryByState);
    const badges = h("dd", { class: "row", "data-testid": "system-delivery" });
    if (!states.length) badges.appendChild(h("span", { class: "small dim", text: "尚无交付记录" }));
    states.sort().forEach(function (k) {
      badges.appendChild(A.badge(A.zh(k) + " " + s.github.deliveryByState[k], A.stateKind(k)));
    });
    rows.push(h("dt", { text: "GitHub 交付" }), badges);
    rows.push(h("dt", { text: "最近交付" }), h("dd", { class: "small dim", text: s.github.lastDeliveredAt ? A.fmtTime(s.github.lastDeliveredAt) : "—" }));
    rows.push(
      h("dt", { text: "模型服务" }),
      h(
        "dd",
        { "data-testid": "system-provider" },
        s.provider.configured ? A.badge("已配置", "info") : A.badge("未配置", "warn"),
        h("span", { class: "mono-sm small", text: " " + (s.provider.modelName || "—") }),
        h("span", { class: "small dim mono-sm", text: " 最近 model_ref:" + (s.provider.lastModelRef || "无记录") }),
      ),
    );
    const ul = h("ul", { class: "plain" });
    (s.github.recentIntents || []).slice(0, 5).forEach(function (i) {
      ul.appendChild(
        h("li", {}, h("div", { class: "row" }, A.badge(A.zh(i.state), A.stateKind(i.state)), h("span", { class: "mono-sm", text: i.capability }), h("span", { class: "small dim", text: i.target + " · " + A.fmtTime(i.updatedAt) }))),
      );
    });
    if (ul.childNodes.length) rows.push(h("dt", { text: "最近副作用 Intent" }), h("dd", {}, ul));
    return h("dl", { class: "kv" }, rows);
  }

  function errorsBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "当前无异常记录" });
    const ul = h("ul", { class: "plain", "data-testid": "system-errors" });
    list.forEach(function (e) {
      ul.appendChild(
        h(
          "li",
          {},
          h(
            "div",
            { class: "row" },
            A.badge(A.zh(e.kind), "bad"),
            h("span", { class: "mono-sm", text: e.subject }),
            h("span", { class: "small dim", text: e.ts ? A.fmtTime(e.ts) : "" }),
          ),
          e.detail ? h("div", { class: "small dim", text: e.detail }) : null,
        ),
      );
    });
    return ul;
  }

  // WEB-UX-02:从首页迁入的三个技术面板(预算/能力/审计;只读)
  function budgetBlock(d) {
    const b = d.budget || [];
    if (!b.length) return h("p", { class: "empty", text: "尚无预算账本行" });
    const t = d.budgetTotals || { used: 0, limit: null, reserved: 0 };
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
        b.map(function (r) {
          return h(
            "tr",
            {},
            h("td", { class: "mono-sm", text: r.scopeType + ":" + A.short(r.scopeId, 16) }),
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
            h("td", {}, A.badge(A.zh(e.status), kind)),
            h("td", { class: "small dim", text: e.note }),
          );
        }),
      ),
    );
    return h("div", { class: "stack" }, h("p", { class: "small dim", text: "执行面:" + reg.workerMode + "(登记于 " + A.fmtTime(reg.generatedAt) + ")" }), table);
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
            h("span", { class: "mono-sm", text: "#" + e.seq }),
            A.badge(e.action, e.action.indexOf("REJECTED") >= 0 || e.action.indexOf("FAILED") >= 0 ? "bad" : "default"),
            h("span", { class: "small dim", text: e.authority + " · " + e.actor + " · " + A.fmtTime(e.ts) }),
          ),
          e.taskId ? h("div", { class: "small dim mono-sm", text: e.taskId + (e.beforeState ? " " + e.beforeState + " → " + e.afterState : "") }) : null,
        ),
      );
    });
    return ul;
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/system");
      });
      const s = res.system;
      document.getElementById("relay-body").textContent = "";
      document.getElementById("relay-body").appendChild(relayBlock(s));
      document.getElementById("db-worker-body").textContent = "";
      document.getElementById("db-worker-body").appendChild(dbWorkerBlock(s));
      document.getElementById("github-provider-body").textContent = "";
      document.getElementById("github-provider-body").appendChild(githubProviderBlock(s));
      document.getElementById("errors-body").textContent = "";
      document.getElementById("errors-body").appendChild(errorsBlock(s.recentErrors));
      // 预算/能力/审计(WEB-UX-02 迁入;失败不阻塞其他面板)
      try {
        const dash = await A.apiGet("/api/dashboard");
        document.getElementById("system-budget").textContent = "";
        document.getElementById("system-budget").appendChild(budgetBlock(dash.dashboard || {}));
        document.getElementById("system-audit").textContent = "";
        document.getElementById("system-audit").appendChild(auditBlock((dash.dashboard || {}).audit || []));
      } catch (e2) {
        console.error("system dashboard-panel render-failed", e2 && e2.stack ? e2.stack : String(e2));
      }
      try {
        const caps = await A.apiGet("/api/capabilities");
        document.getElementById("capabilities-body").textContent = "";
        document.getElementById("capabilities-body").appendChild(capabilitiesBlock(caps.registry));
      } catch (e3) {
        console.error("system capabilities render-failed", e3 && e3.stack ? e3.stack : String(e3));
      }
    } catch (e) {
      console.error("system render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  // 运维动作:推进一拍(Reviewer m4:从工作台迁入系统状态页;零模型门禁语义不变)
  async function tick() {
    const btn = document.getElementById("btn-tick");
    const msg = document.getElementById("tick-msg");
    btn.disabled = true;
    try {
      const res = await A.apiPost("/api/worker/tick", {});
      msg.textContent = "推进结果:" + (res.tick && res.tick.status ? A.zh(res.tick.status) : JSON.stringify(res).slice(0, 120));
    } catch (e) {
      msg.textContent = "推进失败:" + ((e && e.message) || e);
    } finally {
      btn.disabled = false;
      await refresh();
    }
  }

  A.boot("system", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    document.getElementById("btn-tick").addEventListener("click", tick);
    await refresh();
    A.poll(refresh);
  });
})();
