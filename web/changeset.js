// ChangeSet / Evidence 页(P0-02C):Diff、三 SHA、独立 Review、真实测试、Gate、交付状态。
// 状态语义严格按 UI_UX §2D:SUBMITTED / REWORK / VERIFIED / DELIVERED / BLOCKED / UNKNOWN。
// 注意:任务 ACCEPTED ≠ 变更集 DELIVERED;证据随候选 SHA 变化会失效(显示"需重验")。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  function headerBlock(d) {
    const c = d.changeset;
    const rows = [];
    rows.push(h("dt", { text: "变更集" }), h("dd", { class: "mono", text: c.id }));
    rows.push(h("dt", { text: "关联任务" }), h("dd", {}, h("a", { class: "mono", href: "/goal.html?id=" + encodeURIComponent(d.goal ? d.goal.id : ""), text: c.taskId })));
    rows.push(h("dt", { text: "attempt" }), h("dd", { text: String(c.attempt) }));
    rows.push(h("dt", { text: "candidate sha(清单内容)" }), h("dd", { class: "mono", "data-testid": "sha-candidate", text: c.candidateSha }));
    rows.push(h("dt", { text: "git tree sha(内容承诺)" }), h("dd", { class: "mono", "data-testid": "sha-tree", text: c.gitTreeSha || "未绑定(无候选 commit)" }));
    rows.push(h("dt", { text: "git commit sha(提交对象)" }), h("dd", { class: "mono", "data-testid": "sha-commit", text: c.gitCommitSha || "未绑定(无候选 commit)" }));
    rows.push(h("dt", { text: "git base commit" }), h("dd", { class: "mono", text: c.gitBaseCommitSha || "未绑定" }));
    rows.push(h("dt", { text: "requirement sha(需求版本)" }), h("dd", { class: "mono", text: c.requirementSha }));
    rows.push(
      h("dt", { text: "证据时效" }),
      h(
        "dd",
        {},
        d.evidenceFreshness.verdict === "STALE"
          ? A.badge("证据来自旧候选,需要重验", "warn")
          : A.badge("证据与当前候选一致", "ok"),
        h("span", { class: "small dim", text: " 当前候选 " + A.short(d.evidenceFreshness.currentCandidateSha) }),
      ),
    );
    rows.push(h("dt", { text: "任务状态" }), h("dd", {}, d.task ? A.badge(d.task.state, A.stateKind(d.task.state)) : h("span", { class: "small dim", text: "—" })));
    return h("dl", { class: "kv" }, rows);
  }

  function diffBlock(c) {
    const list = function (title, arr, kind) {
      return h(
        "div",
        { class: "stack" },
        h("h3", { text: title + "(" + arr.length + ")" }),
        arr.length
          ? h("ul", { class: "plain mono small" }, arr.map(function (p) {
              return h("li", { text: p });
            }))
          : h("p", { class: "empty", text: "无" }),
      );
    };
    const violations = c.impactScope.violations || [];
    const notice = violations.length
      ? h("div", { class: "notice bad", "data-testid": "impact-violations" }, h("strong", { text: "影响面越界:" + violations.length + " 个路径不在授权作用域内" }))
      : null;
    return h(
      "div",
      { class: "stack" },
      notice,
      h("div", { class: "grid" }, list("新增", c.changedFiles.added), list("修改", c.changedFiles.modified), list("删除", c.changedFiles.removed)),
      h("h3", { text: "作用域核验" }),
      h("p", { class: "small mono", text: "在作用域内:" + (c.impactScope.inScope || []).join(", ") }),
    );
  }

  function gatesBlock(d) {
    if (!d.gates.length) return h("p", { class: "empty", text: "尚无 Gate 裁决" });
    const tbody = h("tbody", {});
    d.gates.forEach(function (g) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "cs-gate-" + g.id },
          h("td", {}, A.badge(g.verdict, A.stateKind(g.verdict))),
          h("td", { class: "small", text: g.reviewer }),
          h("td", { class: "mono small", text: A.short(g.candidateSha) }),
          h("td", { class: "mono small", text: A.short(g.reviewerRunId, 10) }),
          h("td", { class: "mono small", text: A.short(g.coderRunId, 10) }),
          h("td", { class: "small", text: g.consumedAt ? "已消费" : "未消费" }),
          h("td", { class: "small dim", text: (g.evidenceIds || []).length + " 条证据" }),
        ),
      );
    });
    const independence = h(
      "p",
      { class: "small dim", "data-testid": "reviewer-independence" },
      "独立 Reviewer 约束:Reviewer Run 与 Coder Run 必须不同;两者 id 在上表分列展示。",
    );
    return h("div", { class: "stack" }, independence, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "裁决" }), h("th", { text: "裁决者" }), h("th", { text: "绑定候选" }), h("th", { text: "Reviewer Run" }), h("th", { text: "Coder Run" }), h("th", { text: "消费" }), h("th", { text: "证据" }))), tbody));
  }

  function evidenceBlock(d) {
    if (!d.evidence.length) return h("p", { class: "empty", text: "尚无证据" });
    const wrap = h("div", { class: "stack" });
    d.evidence.forEach(function (e) {
      wrap.appendChild(
        h(
          "div",
          { class: "card", "data-testid": "cs-evidence-" + e.id },
          h(
            "div",
            { class: "row" },
            A.badge(e.kind, "default"),
            A.badge(e.passed ? "通过" : "未通过", e.passed ? "ok" : "bad"),
            h("span", { class: "mono small", text: e.id }),
            h("span", { class: "small dim", text: "绑定候选 " + A.short(e.candidateSha) + " · 摘要 " + e.contentSha256.slice(0, 16) }),
          ),
          h("div", { class: "small dim", text: "采集方:" + e.producedBy + " · 环境:" + JSON.stringify(e.env) + " · 时间:" + A.fmtTime(e.createdAt) }),
          h("pre", { class: "out", "data-testid": "evidence-output-" + e.id, text: e.rawOutput }),
        ),
      );
    });
    return wrap;
  }

  function deliveryBlock(d) {
    const c = d.changeset;
    const rows = [];
    rows.push(h("dt", { text: "变更集交付状态" }), h("dd", {}, A.badge(c.deliveryState, A.stateKind(c.deliveryState))));
    rows.push(h("dt", { text: "远端头" }), h("dd", { class: "mono", "data-testid": "delivery-remote-head", text: c.deliveredRemoteHead || "—" }));
    if (d.proposal) {
      rows.push(h("dt", { text: "Action Proposal" }), h("dd", { class: "mono small", text: d.proposal.id + " · " + d.proposal.state }));
      rows.push(h("dt", { text: "交付目标" }), h("dd", { class: "mono small", "data-testid": "delivery-target", text: d.proposal.target + " [" + d.proposal.branch + "]" }));
      rows.push(h("dt", { text: "期望远端头" }), h("dd", { class: "mono small", text: d.proposal.expectedRemoteSha || "—" }));
      rows.push(h("dt", { text: "Policy 裁决" }), h("dd", { class: "small", text: JSON.stringify(d.proposal.policyDetail) }));
    } else {
      rows.push(h("dt", { text: "Action Proposal" }), h("dd", { class: "small dim", text: "尚未提出(需 Gate PASS 才可提案)" }));
    }
    if (d.intent) {
      rows.push(h("dt", { text: "Action Intent" }), h("dd", { class: "mono small", text: d.intent.id + " · " + d.intent.state }));
    }
    const caveat = h(
      "div",
      { class: "notice", "data-testid": "delivery-caveat" },
      h("strong", { text: "状态口径:" }),
      h(
        "span",
        {
          text:
            "任务 ACCEPTED 只表示通过了 Gate;变更集 DELIVERED 才表示已按授权集成到目标仓库。" +
            "本次验收的交付目标是本地 bare 远端;GitHub 真实写入在有效细粒度 PAT 缺失期间为 NOT_VERIFIED。",
        },
      ),
    );
    return h("div", { class: "stack" }, h("dl", { class: "kv" }, rows), caveat);
  }

  function runsBlock(d) {
    if (!d.runs.length) return h("p", { class: "empty", text: "尚无运行记录" });
    const tbody = h("tbody", {});
    d.runs.forEach(function (r) {
      tbody.appendChild(
        h(
          "tr",
          { "data-testid": "cs-run-" + r.id },
          h("td", { class: "mono small", text: r.id }),
          h("td", {}, A.badge(r.outcome, A.stateKind(r.outcome))),
          h("td", { class: "small", text: r.role || "coder" }),
          h("td", { class: "small dim", text: r.modelRef + " · " + r.sandbox }),
          h("td", { class: "small", text: r.reason || "—" }),
          h("td", { class: "small dim", text: A.fmtTime(r.startedAt) }),
        ),
      );
    });
    return h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Run" }), h("th", { text: "结果" }), h("th", { text: "角色" }), h("th", { text: "模型/沙箱" }), h("th", { text: "原因" }), h("th", { text: "开始" }))), tbody);
  }

  function pickerBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "尚无变更集" });
    const tbody = h("tbody", {});
    list.forEach(function (c) {
      tbody.appendChild(
        h(
          "tr",
          {},
          h("td", { class: "mono small", text: c.id }),
          h("td", {}, A.badge(c.deliveryState, A.stateKind(c.deliveryState))),
          h("td", { class: "small", text: c.taskId }),
          h("td", {}, h("a", { class: "small", href: "/changeset.html?id=" + encodeURIComponent(c.id), text: "查看" })),
        ),
      );
    });
    return h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "变更集" }), h("th", { text: "交付状态" }), h("th", { text: "任务" }), h("th", { text: "" }))), tbody);
  }

  // WEB-UX-01 §4.8:只读 Diff Viewer(数据源=本地已注册项目仓库的 git diff;不可用时如实标注原因)
  async function diffViewerBlock(id) {
    const wrap = h("div", { class: "stack", "data-testid": "cs-diff-viewer" });
    try {
      const res = await A.apiGet("/api/changesets/" + encodeURIComponent(id) + "/diff");
      if (res.available) {
        wrap.appendChild(
          h("div", { class: "small dim", text: "来源:本地已注册项目仓库只读 git diff" + (res.source ? "(" + res.source + ")" : "") + (res.truncated ? " · 已截断(仅展示前 200KB)" : "") }),
        );
        wrap.appendChild(h("pre", { class: "diff", "data-testid": "cs-diff-content", text: res.diff || "(空 diff)" }));
      } else {
        wrap.appendChild(h("div", { class: "notice info", "data-testid": "cs-diff-unavailable" }, h("strong", { text: "Diff 暂不可用。" }), h("span", { text: " " + (res.reason || "原因未记录") })));
      }
    } catch (e) {
      wrap.appendChild(h("div", { class: "notice", text: "Diff 读取失败:" + ((e && e.message) || e) }));
    }
    return wrap;
  }

  async function refresh() {
    const id = new URLSearchParams(window.location.search).get("id");
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/changesets");
      });
      const picker = document.getElementById("cs-picker");
      picker.textContent = "";
      picker.appendChild(pickerBlock(res.changesets || []));
    } catch (e) {
      console.error("render-failed", e && e.stack ? e.stack : String(e));
    }
    if (!id) {
      document.getElementById("cs-detail").hidden = true;
      return;
    }
    try {
      const res = await A.guarded(function () {
        return A.apiGet("/api/changesets/" + encodeURIComponent(id));
      });
      const d = res.changeset;
      document.getElementById("cs-detail").hidden = false;
      document.getElementById("cs-header").textContent = "";
      document.getElementById("cs-header").appendChild(headerBlock(d));
      document.getElementById("cs-diff").textContent = "";
      document.getElementById("cs-diff").appendChild(diffBlock(d.changeset));
      document.getElementById("cs-full-diff").textContent = "";
      document.getElementById("cs-full-diff").appendChild(await diffViewerBlock(id));
      document.getElementById("cs-gates").textContent = "";
      document.getElementById("cs-gates").appendChild(gatesBlock(d));
      document.getElementById("cs-evidence").textContent = "";
      document.getElementById("cs-evidence").appendChild(evidenceBlock(d));
      document.getElementById("cs-delivery").textContent = "";
      document.getElementById("cs-delivery").appendChild(deliveryBlock(d));
      document.getElementById("cs-runs").textContent = "";
      document.getElementById("cs-runs").appendChild(runsBlock(d));
    } catch (e) {
      console.error("render-failed", e && e.stack ? e.stack : String(e));
    }
  }

  A.boot("changeset", async function () {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    await refresh();
    A.poll(refresh);
  });
})();
