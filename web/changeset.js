// 验收结果页(WEB-UX-02 §11 重做):第一屏=结果摘要(做了什么/修改内容/验证/复核/GitHub),
// 技术证据(Diff/三 SHA/运行)折叠。状态语义严格按 UI_UX §2D;任务 ACCEPTED ≠ 变更集 DELIVERED。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;

  // ---------- 第一屏:结果摘要 ----------
  function summaryBlock(d) {
    const c = d.changeset;
    const files = c.changedFiles.added.length + c.changedFiles.modified.length + c.changedFiles.removed.length;
    const allPassed = d.evidence.length > 0 && d.evidence.every(function (e) { return e.passed; });
    const anyFailed = d.evidence.some(function (e) { return !e.passed; });
    const gatePass = d.gates.some(function (x) { return x.verdict === "PASS"; });
    const gateBlock = d.gates.some(function (x) { return x.verdict === "BLOCK" || x.verdict === "REWORK"; });

    const deliveryLabel = { DELIVERED: "已提交到仓库", DELIVERING: "正在提交", SUBMITTED: "待提交", VERIFIED: "已核实", NOT_VERIFIED: "未核实", NONE: "尚未交付", CONFLICT: "有冲突,需要处理", FAILED: "提交失败", BLOCKED: "已阻止", REWORK: "正在返工", UNKNOWN: "状态未知" };
    const deliveryText = deliveryLabel[c.deliveryState] || A.zh(c.deliveryState);

    const items = [];
    items.push({ label: "Relay 做了什么", text: d.goal ? d.goal.rawInput : "任务 " + c.taskId, testid: "result-what" });
    items.push({ label: "修改内容", text: files + " 个文件(新增 " + c.changedFiles.added.length + " · 修改 " + c.changedFiles.modified.length + " · 删除 " + c.changedFiles.removed.length + ")", testid: "result-files" });
    items.push({
      label: "验证结果",
      text: d.evidence.length === 0 ? "暂无测试记录" : allPassed ? "测试全部通过(" + d.evidence.length + " 项)" : anyFailed ? "测试未通过,详情见技术证据" : "证据需要重新验证",
      kind: d.evidence.length === 0 ? "default" : allPassed ? "ok" : "bad",
      testid: "result-tests",
    });
    items.push({
      label: "AI 复核",
      text: d.gates.length === 0 ? "尚未复核" : gatePass ? "独立复核通过" : gateBlock ? "复核发现问题" : "复核进行中",
      kind: d.gates.length === 0 ? "default" : gatePass ? "ok" : gateBlock ? "bad" : "info",
      testid: "result-review",
    });
    items.push({ label: "GitHub", text: deliveryText, kind: c.deliveryState === "DELIVERED" ? "ok" : c.deliveryState === "CONFLICT" || c.deliveryState === "FAILED" ? "bad" : "default", testid: "result-github" });

    const rows = h("dl", { class: "result-list" },
      items.map(function (it) {
        return h("div", { class: "result-item", "data-testid": it.testid },
          h("dt", { text: it.label }),
          h("dd", {}, it.kind ? A.badge(it.text, it.kind) : h("span", { class: "q-text", text: it.text })),
        );
      }),
    );

    // 四个快捷入口(锚点滚动;技术证据默认折叠,点击时展开)
    function jump(anchorId, openTech) {
      return function () {
        if (openTech) {
          const tech = document.getElementById("cs-tech");
          if (tech) tech.open = true;
        }
        const el = document.getElementById(anchorId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      };
    }
    const links = h("div", { class: "row" },
      h("button", { class: "btn btn-sm", type: "button", text: "查看修改详情", onclick: jump("cs-diff") }),
      h("button", { class: "btn btn-sm", type: "button", text: "查看 Diff", onclick: jump("cs-full-diff", true) }),
      h("button", { class: "btn btn-sm", type: "button", text: "查看测试", onclick: jump("cs-evidence", true) }),
      h("button", { class: "btn btn-sm", type: "button", text: "查看技术证据", onclick: jump("cs-header", true) }),
    );

    const title = c.deliveryState === "DELIVERED" ? "已完成" : c.deliveryState === "CONFLICT" || c.deliveryState === "FAILED" ? "有问题" : "进行中";
    document.getElementById("result-title").textContent = title;
    return h("div", { class: "stack" }, rows, links);
  }

  // ---------- 技术证据区块(默认折叠) ----------
  function headerBlock(d) {
    const c = d.changeset;
    const rows = [];
    rows.push(h("dt", { text: "变更集" }), h("dd", { class: "mono-sm", text: c.id }));
    rows.push(h("dt", { text: "关联任务" }), h("dd", {}, h("a", { class: "mono-sm", href: "/goal.html?id=" + encodeURIComponent(d.goal ? d.goal.id : ""), text: c.taskId })));
    rows.push(h("dt", { text: "attempt" }), h("dd", { text: String(c.attempt) }));
    rows.push(h("dt", { text: "candidate sha(清单内容)" }), h("dd", { class: "mono-sm", "data-testid": "sha-candidate", text: c.candidateSha }));
    rows.push(h("dt", { text: "git tree sha(内容承诺)" }), h("dd", { class: "mono-sm", "data-testid": "sha-tree", text: c.gitTreeSha || "未绑定(无候选 commit)" }));
    rows.push(h("dt", { text: "git commit sha(提交对象)" }), h("dd", { class: "mono-sm", "data-testid": "sha-commit", text: c.gitCommitSha || "未绑定(无候选 commit)" }));
    rows.push(h("dt", { text: "git base commit" }), h("dd", { class: "mono-sm", text: c.gitBaseCommitSha || "未绑定" }));
    rows.push(h("dt", { text: "requirement sha(需求版本)" }), h("dd", { class: "mono-sm", text: c.requirementSha }));
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
    rows.push(h("dt", { text: "任务状态" }), h("dd", {}, d.task ? A.badge(A.zh(d.task.state), A.stateKind(d.task.state)) : h("span", { class: "small dim", text: "—" })));
    return h("dl", { class: "kv" }, rows);
  }

  function diffBlock(c) {
    const list = function (title, arr) {
      return h(
        "div",
        { class: "stack" },
        h("h3", { text: title + "(" + arr.length + ")" }),
        arr.length
          ? h("ul", { class: "plain mono-sm" }, arr.map(function (p) {
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
      h("p", { class: "small mono-sm", text: "在作用域内:" + (c.impactScope.inScope || []).join(", ") }),
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
          h("td", {}, A.badge(A.zh(g.verdict), A.stateKind(g.verdict)), h("span", { class: "mono-sm dim", text: " " + g.verdict })),
          h("td", { class: "small", text: g.reviewer }),
          h("td", { class: "mono-sm", text: A.short(g.candidateSha) }),
          h("td", { class: "mono-sm", text: A.short(g.reviewerRunId, 10) }),
          h("td", { class: "mono-sm", text: A.short(g.coderRunId, 10) }),
          h("td", { class: "small", text: g.consumedAt ? "已消费" : "未消费" }),
          h("td", { class: "small dim", text: (g.evidenceIds || []).length + " 条证据" }),
        ),
      );
    });
    const independence = h(
      "p",
      { class: "small dim", "data-testid": "reviewer-independence" },
      "独立复核约束:复核运行与编码运行必须是不同执行(两者 id 在上表分列展示)。",
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
            h("span", { class: "mono-sm", text: e.id }),
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
    rows.push(h("dt", { text: "变更集交付状态" }), h("dd", {}, A.badge(A.zh(c.deliveryState), A.stateKind(c.deliveryState)), h("span", { class: "mono-sm dim", text: " " + c.deliveryState })));
    rows.push(h("dt", { text: "远端头" }), h("dd", { class: "mono-sm", "data-testid": "delivery-remote-head", text: c.deliveredRemoteHead || "—" }));
    if (d.proposal) {
      rows.push(h("dt", { text: "Action Proposal" }), h("dd", { class: "mono-sm", text: d.proposal.id + " · " + d.proposal.state }));
      rows.push(h("dt", { text: "交付目标" }), h("dd", { class: "mono-sm", "data-testid": "delivery-target", text: d.proposal.target + " [" + d.proposal.branch + "]" }));
      rows.push(h("dt", { text: "期望远端头" }), h("dd", { class: "mono-sm", text: d.proposal.expectedRemoteSha || "—" }));
      rows.push(h("dt", { text: "Policy 裁决" }), h("dd", { class: "small", text: JSON.stringify(d.proposal.policyDetail) }));
    } else {
      rows.push(h("dt", { text: "Action Proposal" }), h("dd", { class: "small dim", text: "尚未提出(需 Gate PASS 才可提案)" }));
    }
    if (d.intent) {
      rows.push(h("dt", { text: "Action Intent" }), h("dd", { class: "mono-sm", text: d.intent.id + " · " + d.intent.state }));
    }
    const caveat = h(
      "div",
      { class: "notice", "data-testid": "delivery-caveat" },
      h("strong", { text: "状态口径:" }),
      h(
        "span",
        {
          text:
            "任务通过复核(ACCEPTED)只表示结果被验收;变更集「已交付」才表示已按授权写入目标仓库。" +
            "当前 Console 部署尚未接入 GitHub 推送交付(将在 REAL-PILOT 阶段接入),验收环境交付到本地远端,均如实标注。",
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
          h("td", { class: "mono-sm", text: r.id }),
          h("td", {}, A.badge(A.zh(r.outcome), A.stateKind(r.outcome))),
          h("td", { class: "small", text: r.role || "coder" }),
          h("td", { class: "small dim mono-sm", text: r.modelRef + " · " + r.sandbox }),
          h("td", { class: "small", text: r.reason || "—" }),
          h("td", { class: "small dim", text: A.fmtTime(r.startedAt) }),
        ),
      );
    });
    return h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Run" }), h("th", { text: "结果" }), h("th", { text: "角色" }), h("th", { text: "模型/沙箱" }), h("th", { text: "原因" }), h("th", { text: "开始" }))), tbody);
  }

  function pickerBlock(list) {
    if (!list.length) return h("p", { class: "empty", text: "还没有任何结果。任务完成后会出现在这里。" });
    const tbody = h("tbody", {});
    list.forEach(function (c) {
      tbody.appendChild(
        h(
          "tr",
          {},
          h("td", { class: "mono-sm", text: c.id }),
          h("td", {}, A.badge(A.zh(c.deliveryState), A.stateKind(c.deliveryState))),
          h("td", { class: "small", text: c.taskId }),
          h("td", {}, h("a", { class: "small", href: "/changeset.html?id=" + encodeURIComponent(c.id), text: "查看 →" })),
        ),
      );
    });
    return h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "结果" }), h("th", { text: "状态" }), h("th", { text: "任务" }), h("th", { text: "" }))), tbody);
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
      document.getElementById("result-summary").textContent = "";
      document.getElementById("result-summary").appendChild(summaryBlock(d));
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
