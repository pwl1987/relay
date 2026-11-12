// 项目页(WEB-UX-02 §8 重做):卡片=名称/简介/状态/正在处理/最近完成/最后更新;
// 技术字段(路径/HEAD/分支)收进「项目详情」;项目内突出"让 Relay 在这个项目里做什么?"。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  let sharedForm = null;
  let formHost = null;

  function ensureForm() {
    if (!sharedForm) {
      sharedForm = A.renderGoalForm({});
      formHost = document.getElementById("project-form-host");
      formHost.textContent = "";
      formHost.appendChild(sharedForm.wrap);
    }
    return sharedForm;
  }

  /** 把共享表单移进项目卡片并预选该项目(m10:显式等列表加载完成后再选中)。 */
  async function startInProject(p, slot) {
    const form = ensureForm();
    await form.loadProjects();
    slot.textContent = "";
    slot.appendChild(form.wrap);
    formHost.hidden = false;
    if (form.select) {
      const opt = Array.prototype.find.call(form.select.options || [], function (o) {
        return o.value === p.name;
      });
      if (opt) {
        form.select.value = p.name;
      }
      form.focus();
    }
  }

  function projectCard(p) {
    const stat = h("div", { class: "row stat-row" },
      h("span", { class: "small", text: "正在处理 " + (p.runningCount || 0) }),
      h("span", { class: "small", text: "已完成 " + (p.doneCount || 0) }),
      h("span", { class: "small dim", text: "最后更新 " + (p.lastUpdatedAt ? A.fmtTime(p.lastUpdatedAt) : "—") }),
    );

    const recent = h("div", { class: "stack mt8" });
    (p.recentGoals || []).forEach(function (g) {
      recent.appendChild(
        h("div", { class: "row item-row", "data-testid": "project-goal-" + g.id },
          h("a", { class: "row-title", href: "/goal.html?id=" + encodeURIComponent(g.id), text: g.rawInput.length > 44 ? g.rawInput.slice(0, 44) + "…" : g.rawInput }),
          A.badge(A.zh(g.state), A.stateKind(g.state)),
        ),
      );
    });

    const formSlot = h("div", { class: "project-form-slot mt8" });
    const askBtn = h("button", { class: "btn btn-primary btn-sm", type: "button", "data-testid": "project-ask-" + p.name, text: "让 Relay 在这个项目里做什么?" });
    askBtn.addEventListener("click", function () {
      askBtn.disabled = true;
      startInProject(p, formSlot).then(function () {
        askBtn.hidden = true;
        askBtn.disabled = false;
      });
    });

    const detail = h(
      "details",
      { class: "tech-details mt8", "data-testid": "project-detail-" + p.name },
      h("summary", { class: "dim small", text: "项目详情" }),
      h("dl", { class: "kv mt8" },
        h("dt", { text: "本地路径" }), h("dd", { class: "mono-sm", text: p.path }),
        h("dt", { text: "GitHub" }), h("dd", { class: "mono-sm", text: p.repo || "—" }),
        h("dt", { text: "分支" }), h("dd", { class: "mono-sm", text: p.gitBranch || p.branch || "—" }),
        h("dt", { text: "HEAD" }), h("dd", { class: "mono-sm", text: p.gitHead ? p.gitHead.slice(0, 10) : p.healthDetail || "—" }),
        h("dt", { text: "状态明细" }), h("dd", { class: "small dim", text: p.healthDetail || "目录与 git 均可读" }),
      ),
    );

    return h(
      "div",
      { class: "card project-card", "data-testid": "project-row-" + p.name },
      h("div", { class: "row item-row" },
        h("h3", { class: "project-name", text: p.name }),
        A.badge(p.health === "ok" ? "可用" : "无法访问", p.health === "ok" ? "ok" : "bad"),
      ),
      h("p", { class: "small dim", text: p.repo ? "仓库 " + p.repo : "本地项目" }),
      stat,
      recent.childNodes.length ? h("div", { class: "mt8" }, h("h3", { class: "mt0", text: "最近任务" }), recent) : null,
      h("div", { class: "mt8" }, askBtn),
      formSlot,
      detail,
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
      if (!v.projects.length) {
        box.appendChild(h("p", { class: "empty", text: "还没有接入项目。" }));
        box.appendChild(h("p", { class: "small dim" }, "接入方法:编辑注册文件 config/projects.json,加入 {\"projects\":[{\"name\":\"…\",\"path\":\"/绝对路径\",\"repo\":\"https://github.com/…\",\"branch\":\"main\"}]},然后刷新本页。"));
        return;
      }
      const grid = h("div", { class: "grid wide project-grid" });
      v.projects.forEach(function (p) {
        grid.appendChild(projectCard(p));
      });
      box.appendChild(grid);
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
