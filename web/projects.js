// Projects 页(OPERATOR-CONSOLE-00 P0-UI-2):最小项目列表(注册文件驱动;零 schema 变更;零网络)。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function projectRow(p) {
    const health = h("td", {}, A.badge(p.health === "ok" ? "健康" : "不可达", p.health === "ok" ? "ok" : "bad"));
    const goals = h("td", { class: "small" }, h("div", { text: p.goalCount ? "共 " + p.goalCount + " 个 Goal" : "—" }));
    (p.recentGoals || []).slice(0, 3).forEach(function (g) {
      goals.appendChild(
        h(
          "div",
          { class: "small dim", "data-testid": "project-goal-" + g.id },
          h("a", { href: "/goal.html?id=" + encodeURIComponent(g.id), text: g.rawInput.length > 40 ? g.rawInput.slice(0, 40) + "…" : g.rawInput }),
          " " + g.state,
        ),
      );
    });
    return h(
      "tr",
      { "data-testid": "project-row-" + p.name },
      h("td", { text: p.name }),
      h("td", { class: "mono small", text: p.path }),
      h("td", { class: "mono small", text: p.repo || "—" }),
      h("td", { class: "small", text: p.gitBranch || p.branch || "—" }),
      health,
      h("td", { class: "mono small", text: p.gitHead ? p.gitHead.slice(0, 10) : p.healthDetail || "—" }),
      goals,
    );
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/projects");
      });
      const v = res.projects;
      const box = document.getElementById("projects-body");
      box.textContent = "";
      box.appendChild(h("p", { class: "small dim", text: v.note }));
      if (!v.projects.length) {
        box.appendChild(h("p", { class: "empty", text: "尚未配置任何项目(本页仅观察;接入项目请编辑注册文件)" }));
        return;
      }
      const tbody = h("tbody", {});
      v.projects.forEach(function (p) {
        tbody.appendChild(projectRow(p));
      });
      box.appendChild(
        h(
          "div",
          { class: "table-scroll" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", { text: "项目" }), h("th", { text: "本地路径" }), h("th", { text: "GitHub" }), h("th", { text: "分支" }), h("th", { text: "健康" }), h("th", { text: "HEAD" }), h("th", { text: "最近 Goal" }))),
            tbody,
          ),
        ),
      );
    } catch (e) {
      console.error("projects render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("projects", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
  });
})();
