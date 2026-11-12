// System 页(OPERATOR-CONSOLE-00 P0-UI-6):Relay HEAD / Core / Worker / PostgreSQL / GitHub / Provider / uptime / 最近异常。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function relayBlock(s) {
    const rows = [];
    rows.push(h("dt", { text: "HEAD" }), h("dd", { class: "mono", "data-testid": "system-head", text: s.relay.headShort || "不可得" }));
    rows.push(h("dt", { text: "版本" }), h("dd", { text: s.relay.version + " · Node " + s.relay.node }));
    rows.push(h("dt", { text: "uptime" }), h("dd", { text: Math.floor(s.relay.uptimeSeconds / 60) + " 分 " + (s.relay.uptimeSeconds % 60) + " 秒" }));
    rows.push(h("dt", { text: "进程启动" }), h("dd", { class: "small dim", text: A.fmtTime(s.relay.startedAt) }));
    return h("dl", { class: "kv" }, rows);
  }

  function dbWorkerBlock(s) {
    const rows = [];
    rows.push(
      h("dt", { text: "PostgreSQL" }),
      h("dd", {}, s.db.ok ? A.badge("可用", "ok") : A.badge("不可用", "bad"), s.db.schema ? h("span", { class: "small dim mono", text: " schema:" + s.db.schema }) : null),
    );
    rows.push(h("dt", { text: "DB 版本" }), h("dd", { class: "small dim", text: (s.db.serverVersion || "—").split(",")[0] }));
    rows.push(
      h("dt", { text: "Worker" }),
      h(
        "dd",
        { "data-testid": "system-worker" },
        A.badge(s.worker.mode === "live" ? "本进程驱动" : s.worker.mode === "stub" ? "桩执行器" : "独立进程", s.worker.mode === "live" ? "ok" : "info"),
        s.worker.lastTick ? h("span", { class: "small dim", text: " 最近 tick:" + s.worker.lastTick.status + " @ " + A.fmtTime(s.worker.lastTick.at) }) : h("span", { class: "small dim", text: " 本进程未驱动(独立 worker 进程)" }),
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
      badges.appendChild(A.badge(k + " " + s.github.deliveryByState[k], A.stateKind(k)));
    });
    rows.push(h("dt", { text: "GitHub 交付" }), badges);
    rows.push(h("dt", { text: "最近交付" }), h("dd", { class: "small dim", text: s.github.lastDeliveredAt ? A.fmtTime(s.github.lastDeliveredAt) : "—" }));
    rows.push(
      h("dt", { text: "Provider" }),
      h(
        "dd",
        { "data-testid": "system-provider" },
        s.provider.configured ? A.badge("已配置", "info") : A.badge("未配置", "warn"),
        h("span", { class: "mono small", text: " " + (s.provider.modelName || "—") }),
        h("span", { class: "small dim", text: " 最近 model_ref:" + (s.provider.lastModelRef || "无记录") }),
      ),
    );
    const ul = h("ul", { class: "plain" });
    (s.github.recentIntents || []).slice(0, 5).forEach(function (i) {
      ul.appendChild(
        h("li", {}, h("div", { class: "row" }, A.badge(i.state, A.stateKind(i.state)), h("span", { class: "mono small", text: i.capability }), h("span", { class: "small dim", text: i.target + " · " + A.fmtTime(i.updatedAt) }))),
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
            A.badge(e.kind, "bad"),
            h("span", { class: "mono small", text: e.subject }),
            h("span", { class: "small dim", text: e.ts ? A.fmtTime(e.ts) : "" }),
          ),
          e.detail ? h("div", { class: "small dim", text: e.detail }) : null,
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
    } catch (e) {
      console.error("system render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("system", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
  });
})();
