// 工作台(首页,WEB-UX-02 §5/§6):一句话开始 + 四区(正在处理/等待我决定/最近完成/有问题)。
// 只读为主 + 两个写动作(开始处理 / 推进一拍);技术细节(Worker/PG/预算/审计)已移入「系统状态」页。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  const IN_FLIGHT = ["PLANNED", "READY", "LEASED", "RUNNING", "SUBMITTED", "VERIFYING", "WAITING", "NEEDS_DECISION", "REWORK", "PAUSED", "NEEDS_RECONCILE", "BLOCKED"];
  const DONE_OK = ["SUCCEEDED", "ACCEPTED", "COMPLETED"];
  const DONE_BAD = ["FAILED", "CANCELLED"];

  function goalLink(g, maxLen) {
    const t = g.rawInput.length > maxLen ? g.rawInput.slice(0, maxLen) + "…" : g.rawInput;
    return h("a", { class: "row-title", href: "/goal.html?id=" + encodeURIComponent(g.id), text: t });
  }

  // 正在处理:尚在推进的 Goal(用户语言:需求 + 当前状态 + 更新时间)
  function activeBlock(goals) {
    const list = goals.filter(function (g) {
      return IN_FLIGHT.indexOf(g.state) >= 0;
    });
    if (!list.length) {
      return h("p", { class: "empty", "data-testid": "active-empty", text: "现在没有正在处理的任务。在上方写下需求,点「开始处理」即可。" });
    }
    const ul = h("ul", { class: "plain item-list", "data-testid": "active-list" });
    list.forEach(function (g) {
      ul.appendChild(
        h(
          "li",
          { "data-testid": "active-" + g.id },
          h("div", { class: "row item-row" }, goalLink(g, 70), A.badge(A.zh(g.state), A.stateKind(g.state))),
          h("div", { class: "small dim", text: "更新于 " + A.fmtTime(g.updatedAt) }),
        ),
      );
    });
    return ul;
  }

  // 等待我决定:OPEN 决策摘要(用户语言四要素精简:问题 + 级别中文 + 推荐)
  function decisionsBlock(list) {
    const open = list.filter(function (d) {
      return d.state === "OPEN" || d.state === "EXPIRED_STILL_BLOCKED";
    });
    A.setNavCount("decisions", open.length);
    const chip = document.getElementById("home-decision-count");
    if (chip) {
      chip.textContent = String(open.length);
      chip.hidden = open.length === 0;
    }
    const more = document.getElementById("decisions-more");
    if (more) more.hidden = open.length <= 2;
    if (!open.length) {
      return h("p", { class: "empty", "data-testid": "decisions-empty", text: "没有需要你决定的事情,一切顺利。" });
    }
    const ul = h("ul", { class: "plain item-list", "data-testid": "decisions-list" });
    open.slice(0, 3).forEach(function (d) {
      const g = d.guidance || {};
      ul.appendChild(
        h(
          "li",
          { "data-testid": "home-decision-" + d.id },
          h("div", { class: "row item-row" },
            h("span", { class: "row-title", text: d.question.length > 50 ? d.question.slice(0, 50) + "…" : d.question }),
            A.badge(A.zh(d.level), d.level === "D3" ? "warn" : "info"),
          ),
          g.recommended ? h("div", { class: "small dim", text: "推荐:" + g.recommended }) : null,
          h("div", { class: "small", text: "" }, h("a", { href: "/decisions.html", text: "去处理 →" })),
        ),
      );
    });
    return ul;
  }

  // 最近完成:交付记录优先,其次已完成的 Goal
  function recentBlock(extras, goals) {
    const delivered = (extras.recentCompleted || []).map(function (r) {
      return {
        title: "任务 " + A.short(r.taskId, 14) + " 已交付",
        sub: (r.changedFiles || 0) + " 个文件" + (r.commitSha ? " · 提交 " + A.short(r.commitSha, 10) : "") + (r.deliveredAt ? " · " + A.fmtTime(r.deliveredAt) : ""),
        kind: "ok",
        label: "已交付",
        goalId: null,
      };
    });
    const doneGoals = goals
      .filter(function (g) {
        return DONE_OK.indexOf(g.state) >= 0;
      })
      .slice(0, 5)
      .map(function (g) {
        return {
          title: g.rawInput.length > 60 ? g.rawInput.slice(0, 60) + "…" : g.rawInput,
          sub: "完成于 " + A.fmtTime(g.updatedAt),
          kind: "ok",
          label: A.zh(g.state),
          goalId: g.id,
        };
      });
    const items = delivered.concat(doneGoals).slice(0, 6);
    if (!items.length) {
      return h("p", { class: "empty", "data-testid": "recent-empty", text: "还没有完成记录。完成后会在这里看到结果。" });
    }
    const ul = h("ul", { class: "plain item-list", "data-testid": "recent-list" });
    items.forEach(function (r) {
      ul.appendChild(
        h(
          "li",
          { "data-testid": "recent-" + (r.goalId || r.title) },
          h("div", { class: "row item-row" },
            r.goalId
              ? h("a", { class: "row-title", href: "/goal.html?id=" + encodeURIComponent(r.goalId), text: r.title })
              : h("span", { class: "row-title", text: r.title }),
            A.badge(r.label, r.kind),
          ),
          h("div", { class: "small dim", text: r.sub }),
        ),
      );
    });
    return ul;
  }

  // 有问题:被阻塞/失败的任务 + 系统异常(种类转中文,细节保留)
  function issuesBlock(d) {
    const ul = h("ul", { class: "plain item-list" });
    (d.blocked || []).forEach(function (t) {
      ul.appendChild(
        h(
          "li",
          { "data-testid": "issue-task-" + t.taskId },
          h("div", { class: "row item-row" },
            h("span", { class: "row-title mono-sm", text: t.taskId }),
            A.badge(A.zh(t.state), A.stateKind(t.state)),
            t.openDecision ? h("a", { class: "small", href: "/decisions.html", text: "需要你决定 →" }) : null,
          ),
          h("div", { class: "small dim", text: t.blockedReason || (t.openDecision ? t.openDecision.question : "") }),
        ),
      );
    });
    (d.goals || [])
      .filter(function (g) {
        return DONE_BAD.indexOf(g.state) >= 0;
      })
      .forEach(function (g) {
        ul.appendChild(
          h(
            "li",
            { "data-testid": "issue-goal-" + g.id },
            h("div", { class: "row item-row" }, goalLink(g, 60), A.badge(A.zh(g.state), "bad")),
          ),
        );
      });
    const issuesBody = document.getElementById("issues-body");
    issuesBody.textContent = "";
    issuesBody.appendChild(
      ul.childNodes.length ? ul : h("p", { class: "empty", "data-testid": "issues-empty", text: "没有需要处理的问题。" }),
    );

    const anomalies = d.anomalies || [];
    const aw = document.getElementById("anomalies-wrap");
    aw.textContent = "";
    if (anomalies.length) {
      const head = h("h3", { class: "mt8", text: "系统异常" });
      const al = h("ul", { class: "plain item-list" });
      anomalies.forEach(function (a) {
        al.appendChild(
          h(
            "li",
            {},
            h("div", { class: "row item-row" }, A.badge(A.zh(a.kind), "bad"), h("span", { class: "mono-sm dim", text: a.subject }), h("span", { class: "small dim", text: a.ts ? A.fmtTime(a.ts) : "" })),
            a.detail ? h("div", { class: "small dim", text: a.detail }) : null,
          ),
        );
      });
      aw.appendChild(h("div", { class: "stack" }, head, al));
    }
  }

  async function refresh() {
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/dashboard");
      });
      const d = res.dashboard;
      const extras = res.extras || {};
      let decisions = { decisions: [] };
      try {
        decisions = await A.apiGet("/api/decisions");
      } catch (e) {
        /* 决策列表失败不阻塞首页其余区域(横幅会如实提示) */
      }
      document.getElementById("active-body").textContent = "";
      document.getElementById("active-body").appendChild(activeBlock(d.goals || []));
      document.getElementById("decisions-summary").textContent = "";
      document.getElementById("decisions-summary").appendChild(decisionsBlock(decisions.decisions || []));
      document.getElementById("recent-body").textContent = "";
      document.getElementById("recent-body").appendChild(recentBlock(extras, d.goals || []));
      issuesBlock(d);
    } catch (e) {
      console.error("dashboard render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  async function tick() {
    const btn = document.getElementById("btn-tick");
    btn.disabled = true;
    const msg = document.getElementById("create-msg");
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

  A.boot("dashboard", async function () {
    const form = A.renderGoalForm({});
    const host = document.getElementById("new-goal-form");
    host.textContent = "";
    host.appendChild(form.wrap);
    document.getElementById("btn-tick").addEventListener("click", tick);
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
    // 侧栏「＋新建需求」落到首页表单:聚焦输入框
    if (window.location.hash === "#new-goal") form.focus();
  });
})();
