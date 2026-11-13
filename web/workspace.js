// Relay 会话式工作区(WEB-UX-03C;03C.1 桌面 UX 收口 P0-1~P0-6/P1-1)。
// 约束(沿 app.js 铁律):零构建/CSP 'self';DOM API + textContent,**不用 innerHTML**;
//  前端不持有业务状态——Feed=服务端投影(goal_messages 会话事实)+ 明细快照确定性推导(§5 不伪造 AI 对话);
//  轮询 4s 可见 / 30s 后台 / 发送与 Decision 后立即刷新(§14;无 WebSocket)。
//  03C.1:单 Composer 模型(P0-1:空白态=项目+开始,任务态=继续对话;整页唯一主要文本输入)/
//  项目上下文唯一来源(P0-2:status.projectName=侧栏同规则;未绑定如实显示,禁"默认工作区"兜底)/
//  执行事件聚合为工作状态块(P0-3/P0-4:每轮一个块,阶段确定性去重,完成原位更新;原始事件入技术详情)/
//  会话布局收敛(P0-5:定宽阅读列,短会话贴 Composer)/ 右栏降噪可折叠(P0-6)/ 用户文案不直出内部错误(P1-1)。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;
  const $ = A.$;

  const UNBOUND = "项目未绑定"; // P0-2:无法识别项目时的唯一如实文案(禁"默认工作区")
  // 与服务端 src/server/views/shared.ts IN_FLIGHT_STATES 对齐(展示层投影只读快照;Core 状态集变更需同步此处)
  const IN_FLIGHT = ["LEASED", "RUNNING", "SUBMITTED", "VERIFYING"];
  const TERMINAL_BAD = ["FAILED", "CANCELLED", "BLOCKED", "BUDGET_EXHAUSTED", "TIMEOUT"];

  // ---------------- WEB-UX-03D 移动端(390×844;iPhone Safari/VPN;同一 API/Feed,零新状态模型) ----------------
  // 布局断点与 style.css @media (max-width: 900px) 对齐;指针粗细判定 Enter 语义(§9:移动端 Enter=换行)。
  const MOBILE_MQ = "(max-width: 900px)";
  const COARSE_MQ = "(pointer: coarse)";
  function mqMatches(query) {
    return !!(window.matchMedia && window.matchMedia(query).matches);
  }
  function isMobileView() {
    return mqMatches(MOBILE_MQ);
  }
  /** §13:iOS 键盘/工具栏不占 100vh ⇒ 高度经 --ws-app-height 注入(桌面 CSS 不消费该变量,零回退)。 */
  function watchViewport() {
    const vv = window.visualViewport;
    const set = function () {
      const px = vv ? Math.round(vv.height) : window.innerHeight;
      document.documentElement.style.setProperty("--ws-app-height", px + "px");
    };
    if (vv) {
      vv.addEventListener("resize", set);
      vv.addEventListener("scroll", set);
    }
    window.addEventListener("resize", set);
    set();
  }

  const state = {
    goalId: null,
    cursor: 0, // 已消费的最大消息 id(0=从头拉 200)
    messages: [], // 服务端会话事实(USER_MESSAGE/RELAY_MESSAGE)
    decisions: [], // 未决决策卡(feed.decisions 整体替换)
    status: null, // goalStatusView 快照(projectName=项目上下文唯一来源)
    detail: null, // goalDetailView(工作状态块/技术详情确定性推导源)
    sidebar: null,
    firstLoad: true,
    pendingLocal: [], // 发送中尚未落库确认的本地回显(失败即移除)
    notices: [], // 本会话内操作回执(批准/拒绝/失败;renderFeed 持久渲染,避免被刷新抹掉)
    lastEventKeys: {}, // 原始事件去重(技术详情层)
    paneOpen: true, // P0-6:右栏整栏折叠
  };

  // ---------------- 项目上下文(P0-2:唯一来源 = feed.status.projectName,服务端与侧栏同规则) ----------------

  function projectDisplay() {
    const p = state.status && state.status.projectName;
    return p ? String(p) : UNBOUND;
  }

  // ---------------- 侧栏(§3:项目分组;行=标题+状态点+待决;不显示 UUID/Run/model/SHA) ----------------

  const PHASE_DOT = {
    executing: ["ws-dot-blue", "正在处理"],
    waiting_user: ["ws-dot-yellow", "等待你"],
    problem: ["ws-dot-red", "有问题"],
    done: ["ws-dot-green", "已完成"],
    idle: ["ws-dot-gray", "空闲"],
  };

  function goalTitle(t) {
    const s = String(t || "");
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
  }

  function renderSidebar() {
    const host = $("#ws-sidebar-body");
    if (!host) return;
    const sb = state.sidebar;
    host.textContent = "";
    if (!sb) return;
    const groups = (sb.projects || []).concat([{ name: "未分组", goals: sb.ungrouped || [] }]).filter(function (g) {
      return (g.goals || []).length > 0;
    });
    if (!groups.length) {
      host.appendChild(h("div", { class: "ws-side-empty" }, "还没有任务。点上方「＋ 新建任务」开始。"));
      return;
    }
    let decisionTotal = 0;
    groups.forEach(function (grp) {
      // P0-2:未绑定注册表项目的 Goal 如实显示"项目未绑定"(与右栏/Header 同文案)
      host.appendChild(h("div", { class: "ws-group-name", text: grp.name === "未分组" ? UNBOUND : grp.name }));
      grp.goals.forEach(function (g) {
        decisionTotal += Number(g.pendingDecisions) || 0;
        const dot = PHASE_DOT[g.phase] || PHASE_DOT.idle;
        const link = h(
          "a",
          {
            class: "ws-goal-row" + (g.id === state.goalId ? " active" : ""),
            href: "/workspace?goal=" + encodeURIComponent(g.id),
            "data-testid": "ws-goal-row-" + g.id,
          },
          h("span", { class: "ws-dot " + dot[0], title: dot[1] }),
          h("span", { class: "ws-goal-title", text: goalTitle(g.title) }),
          Number(g.pendingDecisions) > 0 ? h("span", { class: "nav-badge", text: String(g.pendingDecisions) }) : null,
        );
        host.appendChild(link);
      });
    });
    const badge = $("#ws-decision-badge");
    if (badge) {
      badge.textContent = decisionTotal > 99 ? "99+" : String(decisionTotal);
      badge.hidden = decisionTotal === 0;
    }
  }

  // ---------------- 导航抽屉(§4:☰ 开关;遮罩/ Esc 关闭;关闭后回到原会话,上下文不变) ----------------

  function setDrawer(open) {
    const layout = $("#ws-layout");
    if (layout) layout.classList.toggle("ws-drawer-open", !!open);
  }
  function drawerOpen() {
    const layout = $("#ws-layout");
    return !!(layout && layout.classList.contains("ws-drawer-open"));
  }

  // ---------------- 工作状态块(P0-3/P0-4:执行事件聚合;每 Goal 一个块,原位更新) ----------------

  const STAGE_MARK = { ok: "✓", run: "●", idle: "○", bad: "✗", warn: "⚠" };
  const MODE_TITLE = {
    running: "Relay 正在处理",
    queued: "已纳入执行队列,即将开始",
    waiting: "等待你的决定",
    done: "Relay 已完成本轮工作",
    failed: "本轮工作未完成,需要处理",
  };

  /**
   * 明细快照 → 单一工作状态块(确定性推导,不伪造;Core 事实源不变,仅 UI 投影)。
   * 主 Feed 不再逐条渲染执行事件(P0-3:同阶段只出现一次);原始事件见技术详情(P0-4/P1-1)。
   */
  function deriveWork(g) {
    if (!g) return null;
    const tasks = (g.tasks || []).slice().sort(function (a, b) {
      return (
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id))
      );
    });
    const latest = tasks[tasks.length - 1];
    if (!latest) return null;
    const pending = state.status ? Number(state.status.pendingDecisions) || 0 : 0;
    const csList = g.changesets || [];
    // 交付判定以「最新变更集」为准(ORDER BY created_at DESC ⇒ csList[0] 最新;旧轮 DELIVERED 不代表本轮交付成功——Reviewer Minor-2)
    const newestCs = csList[0] || null;
    const delivering = newestCs !== null && newestCs.deliveryState === "DELIVERING";
    const delivered = newestCs !== null && newestCs.deliveryState === "DELIVERED" ? newestCs : null;
    const undelivered = newestCs !== null && newestCs.deliveryState === "NONE"; // 候选已建但交付未完成(如 propose 失败挂 D3)
    const failedCs = newestCs !== null && ["FAILED", "CONFLICT"].indexOf(newestCs.deliveryState) >= 0 ? newestCs : null;
    const coderRuns = (g.runs || []).filter(function (r) {
      return (r.role || "coder") === "coder";
    });
    const coderRunning = coderRuns.some(function (r) {
      return r.outcome === "RUNNING";
    });
    // role=null ⇒ coder run(runs 表无 role 列;仅 reviewer 在 detail.role 锚定)——禁止 fallback 到 reviewer
    const reviewerRunning = (g.runs || []).some(function (r) {
      return r.role === "reviewer" && r.outcome === "RUNNING";
    });
    const inFlight =
      tasks.some(function (t) {
        return IN_FLIGHT.indexOf(t.state) >= 0;
      }) ||
      coderRunning ||
      reviewerRunning ||
      delivering;
    const latestBad = TERMINAL_BAD.indexOf(latest.state) >= 0;

    let mode;
    if (pending > 0 || latest.state === "NEEDS_DECISION") mode = "waiting";
    else if (inFlight) mode = "running";
    else if (latestBad) mode = "failed";
    else if (["READY", "PLANNED", "REWORK", "WAITING"].indexOf(latest.state) >= 0) mode = "queued";
    else if (
      tasks.some(function (t) {
        return t.state === "ACCEPTED";
      }) ||
      delivered
    )
      mode = "done";
    else return null;

    const evRows = g.evidence || [];
    const evPass = evRows.filter(function (e) {
      return e.passed;
    }).length;
    const evFail = evRows.length - evPass;
    const gate = (g.gates || [])[0] || null; // gates 新在前(ORDER BY created_at DESC,与 buildGoalProgress 口径一致)
    const disc = g.discovery && g.discovery.latest;
    const active = mode === "running" || mode === "queued" || mode === "waiting"; // 未完成轮次:未到阶段显示 ○

    const stages = [];
    if (disc) {
      stages.push(
        disc.outcome === "SUCCEEDED"
          ? { key: "analyze", cls: "ok", label: active ? "已分析项目" : "项目分析" }
          : { key: "analyze", cls: "warn", label: "自动分析未成功,按规则继续" },
      );
    } else if (active) {
      stages.push({ key: "analyze", cls: "idle", label: "项目分析" });
    }
    const newestCoder = coderRuns[0] || null;
    if (coderRunning) stages.push({ key: "code", cls: "run", label: "正在修改代码" });
    else if (newestCoder && newestCoder.outcome === "SUCCEEDED")
      stages.push({ key: "code", cls: "ok", label: "代码修改" });
    else if (
      newestCoder &&
      ["FAILED", "TIMEOUT", "BUDGET_EXHAUSTED", "CANCELLED", "INTERRUPTED"].indexOf(newestCoder.outcome) >= 0
    )
      stages.push({ key: "code", cls: "bad", label: "代码修改未完成" });
    else if (mode === "done") stages.push({ key: "code", cls: "ok", label: "代码修改" });
    else stages.push({ key: "code", cls: "idle", label: "代码修改" });
    if (inFlight && latest.state === "VERIFYING") stages.push({ key: "test", cls: "run", label: "正在测试" });
    else if (evRows.length)
      stages.push({
        key: "test",
        cls: evFail ? (evPass ? "warn" : "bad") : "ok",
        label: evPass + " 项测试" + (evFail ? "(" + evFail + " 项未通过)" : ""),
        testid: "ws-result-tests",
      });
    else if (active) stages.push({ key: "test", cls: "idle", label: "自动测试" });
    if (reviewerRunning) stages.push({ key: "review", cls: "run", label: "正在复核" });
    else if (gate && gate.verdict === "PASS")
      stages.push({ key: "review", cls: "ok", label: "独立复核通过", testid: "ws-result-review" });
    else if (gate && gate.verdict === "BLOCK")
      stages.push({ key: "review", cls: "bad", label: "复核发现问题,需要处理" });
    else if (gate && gate.verdict === "REWORK") stages.push({ key: "review", cls: "warn", label: "复核要求返工" });
    else if (active) stages.push({ key: "review", cls: "idle", label: "独立复核" });
    if (delivering) stages.push({ key: "deliver", cls: "run", label: "正在交付" });
    else if (delivered) {
      const n =
        delivered.changedFiles.added.length +
        delivered.changedFiles.modified.length +
        delivered.changedFiles.removed.length;
      stages.push({
        key: "deliver",
        cls: "ok",
        label: "已提交 GitHub",
        testid: "ws-result-delivery",
        extra: h("span", { class: "dim", "data-testid": "ws-result-files", text: n + " 个文件" }),
      });
    } else if (failedCs)
      stages.push({ key: "deliver", cls: "bad", label: "GitHub 交付未成功,需要处理。" }); // P1-1:用户文案,内部原因见技术详情
    else if (undelivered && !active)
      stages.push({ key: "deliver", cls: "warn", label: "交付未完成,需要处理" }); // 本轮候选未交付(如实;不冒充旧轮已提交)
    else if (active) stages.push({ key: "deliver", cls: "idle", label: "交付" });

    return {
      mode: mode,
      stages: stages,
      rawInput: (g.goal && g.goal.rawInput) || "",
      changesetId: delivered ? delivered.id : csList[0] ? csList[0].id : null,
    };
  }

  function stageRow(s) {
    return h(
      "div",
      { class: "ws-stage st-" + s.cls, "data-testid": s.testid || "ws-stage-" + s.key },
      h("span", { class: "ws-stage-mark", text: STAGE_MARK[s.cls] || "○" }),
      h("span", { class: "ws-stage-text", text: s.label }),
      s.extra || null,
    );
  }

  function workBlock(w) {
    const isDone = w.mode === "done";
    const cls = isDone
      ? "ws-block-done"
      : w.mode === "failed"
        ? "ws-block-bad"
        : w.mode === "waiting"
          ? "ws-block-wait"
          : "ws-block-run";
    const titleCls = isDone
      ? "ws-ok-text"
      : w.mode === "failed"
        ? "ws-bad-text"
        : w.mode === "waiting"
          ? "ws-warn-text"
          : "ws-run-text";
    const block = h(
      "div",
      { class: "ws-block " + cls, "data-testid": isDone ? "ws-result-card" : "ws-work-block" },
      h("div", {
        class: "ws-block-title " + titleCls,
        text: (isDone ? "✓ " : w.mode === "failed" ? "✗ " : "") + MODE_TITLE[w.mode],
      }),
    );
    if (isDone && w.rawInput) {
      block.appendChild(
        h("div", {
          class: "ws-card-question",
          text: w.rawInput.length > 120 ? w.rawInput.slice(0, 120) + "…" : w.rawInput,
        }),
      );
    }
    const rows = h("div", { class: "ws-stage-rows" });
    w.stages.forEach(function (s) {
      rows.appendChild(stageRow(s));
    });
    block.appendChild(rows);
    if (w.mode === "failed") {
      // P1-1:失败只给用户文案 + 「查看原因」;内部错误码/路径/堆栈只在技术详情
      block.appendChild(
        h(
          "div",
          { class: "row mt8" },
          h("button", {
            class: "btn btn-sm",
            type: "button",
            "data-testid": "ws-fail-reason",
            text: "查看原因",
            onclick: function () {
              toggleTech(true);
            },
          }),
        ),
      );
    }
    if (isDone) {
      const row = h("div", { class: "row mt8" });
      if (w.changesetId) {
        row.appendChild(
          h("a", {
            class: "btn btn-sm",
            href: "/changeset.html?id=" + encodeURIComponent(w.changesetId),
            "data-testid": "ws-result-view",
            text: "查看修改",
          }),
        );
      }
      row.appendChild(
        h("button", {
          class: "btn btn-sm",
          type: "button",
          "data-testid": "ws-result-tech",
          text: "技术详情",
          onclick: function () {
            toggleTech();
          },
        }),
      );
      block.appendChild(row);
    }
    return block;
  }

  // ---------------- 原始执行事件(仅技术详情层展示;审计事实不删,只换层 P0-4/P1-1) ----------------

  /** STATUS/RESULT/FAILURE 事件 = goalDetail 确定性推导(与 goal.js 时间线同规则;键去重,带时间戳)。 */
  function deriveEvents(g) {
    if (!g) return [];
    const ev = [];
    const push = function (key, ts, cls, text) {
      if (state.lastEventKeys[key]) return;
      state.lastEventKeys[key] = true;
      ev.push({ key: key, ts: ts, cls: cls, text: text });
    };
    (g.tasks || []).forEach(function (t) {
      const s = t.state;
      const ts = t.updatedAt || t.createdAt || null;
      if (["READY", "PLANNED"].indexOf(s) >= 0) push("task-ready-" + t.id + "-" + s, ts, "st-wait", "已纳入执行队列");
      else if (["LEASED", "RUNNING", "SUBMITTED"].indexOf(s) >= 0)
        push("task-run-" + t.id + "-" + s, ts, "st-run", "正在修改代码");
      else if (s === "VERIFYING") push("task-ver-" + t.id, ts, "st-run", "正在验证");
      else if (s === "ACCEPTED") push("task-acc-" + t.id, ts, "st-ok", "本轮执行完成,复核通过");
      else if (s === "REWORK") push("task-rw-" + t.id + "-" + t.attempt, ts, "st-warn", "正在返工");
      else if (TERMINAL_BAD.indexOf(s) >= 0)
        push(
          "task-fail-" + t.id + "-" + s,
          ts,
          "st-bad",
          "本轮执行未成功" + (t.blockedReason ? ":" + t.blockedReason : ""),
        );
      else if (s === "NEEDS_DECISION") push("task-dec-" + t.id, ts, "st-warn", "等待你的决定");
    });
    const evRows = (g.evidence || []).slice(0, 50);
    const evPass = evRows.filter(function (e) {
      return e.passed;
    }).length;
    const evFail = evRows.length - evPass;
    if (evRows.length && evPass)
      push(
        "ev-pass-" +
          evRows
            .map(function (e) {
              return e.id;
            })
            .join(".")
            .slice(0, 60),
        evRows[0] && evRows[0].createdAt,
        "st-ok",
        evPass + " 项验证通过",
      );
    if (evFail)
      push(
        "ev-fail-" +
          evRows
            .map(function (e) {
              return e.id;
            })
            .join(".")
            .slice(0, 60),
        evRows[0] && evRows[0].createdAt,
        "st-bad",
        evFail + " 项验证未通过",
      );
    (g.runs || []).forEach(function (r) {
      const role = r.role || "coder";
      const ts = r.startedAt || null;
      if (role === "coder") {
        if (r.outcome === "SUCCEEDED") push("run-ok-" + r.id, ts, "st-ok", "代码修改完成");
        else if (r.outcome === "RUNNING") push("run-go-" + r.id, ts, "st-run", "正在修改代码");
        else if (["FAILED", "TIMEOUT", "BUDGET_EXHAUSTED", "CANCELLED", "INTERRUPTED"].indexOf(r.outcome) >= 0)
          push("run-bad-" + r.id + "-" + r.outcome, ts, "st-bad", "修改未成功" + (r.reason ? ":" + r.reason : ""));
      } else if (role === "reviewer" && r.outcome === "RUNNING") {
        push("rev-go-" + r.id, ts, "st-run", "独立复核进行中");
      }
    });
    (g.gates || []).forEach(function (gt) {
      const cls = gt.verdict === "PASS" ? "st-ok" : gt.verdict === "BLOCK" ? "st-bad" : "st-warn";
      const text =
        gt.verdict === "PASS"
          ? "独立复核通过"
          : gt.verdict === "BLOCK"
            ? "独立复核发现问题,需要处理"
            : "独立复核要求返工";
      push("gate-" + gt.id + "-" + gt.verdict, gt.consumedAt || null, cls, text);
    });
    (g.changesets || []).forEach(function (c) {
      const n = c.changedFiles.added.length + c.changedFiles.modified.length + c.changedFiles.removed.length;
      if (c.deliveryState === "DELIVERED")
        push("cs-ok-" + c.id + "-" + c.deliveryState, null, "st-ok", "修改已提交仓库(" + n + " 个文件)");
      else if (c.deliveryState === "DELIVERING")
        push("cs-go-" + c.id + "-" + c.deliveryState, null, "st-run", "正在交付");
      else if (["CONFLICT", "FAILED"].indexOf(c.deliveryState) >= 0)
        push(
          "cs-bad-" + c.id + "-" + c.deliveryState,
          null,
          "st-bad",
          "交付未成功" + (c.failReason ? ":" + c.failReason : ""),
        );
    });
    const disc = g.discovery && g.discovery.latest;
    if (disc && disc.outcome === "SUCCEEDED") push("disc-ok", null, "st-ok", "项目分析完成");
    else if (disc && disc.outcome === "FAILED") push("disc-bad", null, "st-warn", "自动分析未成功,按既定规则继续");
    return ev;
  }

  function eventLine(e) {
    const mark =
      e.cls === "st-ok" ? "✓" : e.cls === "st-run" ? "●" : e.cls === "st-bad" ? "✗" : e.cls === "st-warn" ? "⚠" : "…";
    return h(
      "div",
      { class: "ws-event " + e.cls, "data-testid": "ws-event-" + e.key },
      h("span", { class: "ws-event-mark", text: mark }),
      h("span", { class: "ws-event-text", text: e.text }),
      e.ts ? h("span", { class: "ws-event-ts", text: A.fmtTime(e.ts) }) : null,
    );
  }

  // ---------------- 会话消息与卡(§4/§7/§8;UX6:Decision/Result/Follow-up 不回归) ----------------

  function userBubble(m) {
    return h(
      "div",
      { class: "ws-msg ws-msg-user", "data-testid": "ws-msg-user-" + m.id },
      h("div", { class: "ws-msg-who", text: "你" }),
      h("div", { class: "ws-msg-body", text: m.content }),
    );
  }

  function relayBubble(m) {
    return h(
      "div",
      { class: "ws-msg ws-msg-relay", "data-testid": "ws-msg-relay-" + m.id },
      h("div", { class: "ws-msg-who", text: "Relay" }),
      h("div", { class: "ws-msg-body", text: m.content }),
    );
  }

  /** Decision 卡(§7:内联;三按钮映射现有 resolve/defer 语义;不向用户暴露版本号)。 */
  function decisionCard(d) {
    const fb = d.fallback || {};
    // P1-1(Reviewer Major-1):交付装配失败的 D3 question 直含 propose_failed/git 原始报错——
    // 主 Feed 一律换用户文案;完整原始 question 保留于「待我决定」页(decisions.html 直出全文)与 API。
    const q = String(d.question || "");
    const isDeliveryFail = q.indexOf("delivery_propose_failed") === 0;
    const qShown = isDeliveryFail
      ? "GitHub 交付未成功,需要处理。"
      : q.length > 200
        ? q.slice(0, 200) + "…(完整内容见「待我决定」页)"
        : q || "(系统未提供问题描述)";
    const card = h(
      "div",
      { class: "ws-card ws-card-decision", "data-testid": "ws-decision-card-" + d.id },
      h("div", { class: "ws-card-title ws-warn-text", text: "⚠ 需要你的决定" }),
      h("div", { class: "ws-card-question", "data-testid": "ws-decision-question", text: qShown }),
      fb.recommended ? h("div", { class: "ws-card-sub", text: "建议:" + String(fb.recommended) }) : null,
      fb.risk ? h("div", { class: "ws-card-sub dim", text: "风险:" + String(fb.risk) }) : null,
      d.deadline ? h("div", { class: "ws-card-sub dim", text: "截止:" + A.fmtTime(d.deadline) }) : null,
    );
    const row = h("div", { class: "row mt8" });
    const mk = function (label, testid, fn) {
      const b = h("button", { class: "btn btn-sm", type: "button", "data-testid": testid, text: label });
      b.addEventListener("click", function () {
        disableRow();
        fn().catch(function () {
          feedNotice("操作失败,请稍后重试(详见技术详情)", "st-bad"); // P1-1:内部异常文案不直出
          disableRow(false);
        });
      });
      return b;
    };
    function disableRow(dis) {
      Array.prototype.forEach.call(row.querySelectorAll("button"), function (b) {
        b.disabled = dis !== false;
      });
    }
    row.appendChild(
      mk("允许 / 批准", "ws-decision-approve-" + d.id, async function () {
        await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/resolve", {
          taskId: d.taskId,
          approve: true,
          expectedStateVersion: await fetchTaskStateVersion(d.taskId),
        });
        feedNotice("✓ 已批准,Relay 继续执行", "st-ok");
        await refreshAll(true);
      }),
    );
    row.appendChild(
      mk("不允许", "ws-decision-reject-" + d.id, async function () {
        await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/resolve", {
          taskId: d.taskId,
          approve: false,
          expectedStateVersion: await fetchTaskStateVersion(d.taskId),
        });
        feedNotice("已拒绝:该操作不会执行,Relay 会按预案调整", "st-warn");
        await refreshAll(true);
      }),
    );
    row.appendChild(
      mk("稍后处理", "ws-decision-defer-" + d.id, async function () {
        await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/defer", { taskId: d.taskId });
        feedNotice("已推迟:稍后在「待我决定」处理", "st-wait");
        await refreshAll(true);
      }),
    );
    card.appendChild(row);
    return card;
  }

  async function fetchTaskStateVersion(taskId) {
    const res = await A.apiGet("/api/goals/" + encodeURIComponent(state.goalId));
    const t = (res.goal.tasks || []).find(function (x) {
      return x.id === taskId;
    });
    if (!t) throw new Error("task_not_found");
    return t.stateVersion;
  }

  function feedNotice(text, cls) {
    // §7:操作结果插入 Feed;保留最近 3 条,刷新重渲染时不丢(客户端会话回执,非服务端事实)。
    state.notices.push({ text: text, cls: cls || "st-warn" });
    if (state.notices.length > 3) state.notices.shift();
    renderFeed(true);
  }

  /** Feed 整体渲染(P0-5:定宽阅读列;短会话贴 Composer;长会话正常滚动):
   *  消息(按 id 序)→ 工作状态块(单块原位更新 P0-3/P0-4)→ Decision 卡 → 操作回执。 */
  function renderFeed(immediate) {
    const feed = $("#ws-feed");
    if (!feed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    feed.textContent = "";
    const col = h("div", { class: "ws-feed-col" + (state.goalId ? "" : " ws-feed-empty") });
    feed.appendChild(col);
    if (!state.goalId) {
      // 空白态(P0-1/P0-5):引导语居中;唯一输入 = 下方 Composer(项目选择+开始)
      col.appendChild(
        h(
          "div",
          { class: "ws-empty-hero" },
          h("h1", { class: "ws-hero-title", text: "今天想让 Relay 做什么?" }),
          h("p", {
            class: "ws-hero-sub",
            text: "在下方选择项目,用一句话说出需求。Relay 会自动理解、修改、测试、复核并交付。",
          }),
        ),
      );
      return;
    }
    const items = [];
    state.messages.forEach(function (m) {
      items.push({ sort: Number(m.id), node: m.kind === "USER_MESSAGE" ? userBubble(m) : relayBubble(m) });
    });
    state.pendingLocal.forEach(function (m) {
      items.push({ sort: Number.MAX_SAFE_INTEGER, node: userBubble({ id: "local-" + m.n, content: m.content }) });
    });
    items.sort(function (a, b) {
      return a.sort - b.sort;
    });
    items.forEach(function (it) {
      col.appendChild(it.node);
    });
    // 工作状态块(每 Goal 一个;随明细快照原位更新,不逐条追加日志)
    const w = deriveWork(state.detail);
    if (w) col.appendChild(workBlock(w));
    // Decision 卡(未决;内联于 Feed 末尾、Composer 之前)
    (state.decisions || []).forEach(function (d) {
      col.appendChild(decisionCard(d));
    });
    // 本会话操作回执(批准/拒绝/失败提示;客户端回执,排在决策卡后)
    state.notices.forEach(function (n) {
      col.appendChild(h("div", { class: "ws-event " + n.cls, "data-testid": "ws-notice", text: n.text }));
    });
    if (immediate || nearBottom) feed.scrollTop = feed.scrollHeight;
    // §10:用户向上翻历史(未贴底)⇒ 出现「回到最新」;贴底/动作渲染后隐藏
    updateJumpButton(!nearBottom && !!state.goalId);
  }

  /** §10:回到最新——平滑滚到底部(移动端浮层按钮;桌面由 CSS 隐藏)。旧 Safari 无 scrollTo options ⇒ 直接赋值回退。 */
  function jumpToLatest() {
    const feed = $("#ws-feed");
    if (!feed) return;
    try {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    } catch (e) {
      feed.scrollTop = feed.scrollHeight;
    }
    updateJumpButton(false);
  }

  function updateJumpButton(show) {
    const btn = $("#ws-jump-latest");
    const feed = $("#ws-feed");
    if (!btn) return;
    const overflow = !!(feed && feed.scrollHeight > feed.clientHeight + 40);
    btn.hidden = !(show && overflow);
  }

  // ---------------- 右侧详情栏(§9 + P0-6:默认四项;elapsed 按需;技术详情折叠;整栏可收起) ----------------

  let techOpen = false;
  let sheetOpen = false;

  /** 技术详情入口:桌面=右栏折叠(03C.1 不回退);移动端(§11)=打开详情 sheet(secondary view)。 */
  function toggleTech(force) {
    if (isMobileView()) {
      openSheet();
      return;
    }
    techOpen = force === undefined ? !techOpen : !!force;
    if (techOpen && !state.paneOpen) {
      state.paneOpen = true;
      applyPane();
    }
    renderDetail();
  }

  function openSheet() {
    sheetOpen = true;
    const sheet = $("#ws-sheet");
    if (sheet) sheet.hidden = false;
    renderSheet();
  }
  function closeSheet() {
    sheetOpen = false;
    const sheet = $("#ws-sheet");
    if (sheet) sheet.hidden = true;
  }
  function renderSheet() {
    if (!sheetOpen) return;
    const body = $("#ws-sheet-body");
    if (body) renderDetailInto(body, { techOpen: true, sheetMode: true });
  }

  function renderDetail() {
    renderDetailInto($("#ws-detail"), { techOpen: techOpen });
    renderSheet();
  }

  /** 详情渲染(单一实现,两处消费:桌面右栏 / 移动 sheet;sheet 恒展开技术详情且不带开关按钮)。 */
  function renderDetailInto(host, opts) {
    if (!host) return;
    const o = opts || {};
    const techShown = !!o.techOpen;
    const sheetMode = !!o.sheetMode;
    host.textContent = "";
    const st = state.status;
    const g = state.detail;
    if (!state.goalId) {
      host.appendChild(h("div", { class: "empty" }, "未选择任务"));
      return;
    }
    const ph =
      st && st.inFlight
        ? "正在处理"
        : st && st.pendingDecisions > 0
          ? "等待你决定"
          : g && (g.progress || {}).phase
            ? A.zh((g.progress || {}).phase)
            : "—";
    host.appendChild(h("div", { class: "ws-detail-head", text: "任务信息" }));
    host.appendChild(
      h(
        "div",
        { class: "ws-detail-item" },
        h("span", { class: "dim" }, "项目"),
        h("span", { "data-testid": "ws-detail-project", text: projectDisplay() }),
      ),
    );
    host.appendChild(
      h(
        "div",
        { class: "ws-detail-item" },
        h("span", { class: "dim" }, "状态"),
        h("span", { "data-testid": "ws-detail-state", text: st ? A.zh(st.goalState) : "—" }),
      ),
    );
    host.appendChild(
      h(
        "div",
        { class: "ws-detail-item" },
        h("span", { class: "dim" }, "当前阶段"),
        h("span", { "data-testid": "ws-detail-phase", text: ph }),
      ),
    );
    host.appendChild(
      h(
        "div",
        { class: "ws-detail-item" },
        h("span", { class: "dim" }, "是否等待用户"),
        h("span", {
          "data-testid": "ws-detail-waiting",
          text: st && st.pendingDecisions > 0 ? "是(需要你决定)" : "否",
        }),
      ),
    );
    const elapsed = g && g.progress && g.progress.elapsedSeconds;
    if (elapsed !== null && elapsed !== undefined && Number(elapsed) > 0) {
      // P0-6:已运行时间只在有意义时显示(有实际运行时长)
      host.appendChild(
        h(
          "div",
          { class: "ws-detail-item" },
          h("span", { class: "dim" }, "已运行时间"),
          h("span", { "data-testid": "ws-detail-elapsed", text: A.fmtDuration(elapsed) }),
        ),
      );
    }
    if (!sheetMode) {
      host.appendChild(
        h("button", {
          class: "btn btn-sm ws-tech-toggle",
          type: "button",
          "data-testid": "ws-detail-toggle",
          text: techShown ? "收起技术详情" : "技术详情",
          onclick: function () {
            toggleTech();
          },
        }),
      );
    }
    if (techShown && g) {
      // §11:工程术语(Model/Run/Budget/Gate/Reviewer/SHA/Scope)只在此层;移动端 testid 独立避免桌面断言串扰
      const box = h("div", { class: "ws-tech", "data-testid": sheetMode ? "ws-sheet-tech" : "ws-detail-tech" });
      const rows = [];
      rows.push(h("dt", { text: "Goal ID" }), h("dd", { class: "mono-sm", text: g.goal.id }));
      rows.push(
        h("dt", { text: "当前任务" }),
        h("dd", { class: "mono-sm", text: (g.progress || {}).currentTaskId || "—" }),
      );
      rows.push(
        h("dt", { text: "模型" }),
        h("dd", { class: "mono-sm", text: (g.progress || {}).currentModelRef || "尚无运行" }),
      );
      const mc = (g.budget || []).find(function (b) {
        return b.kind === "model_calls";
      });
      rows.push(
        h("dt", { text: "预算(模型调用)" }),
        h("dd", {
          class: "small",
          text: mc ? "已用 " + mc.used + (mc.limit !== null ? " / 上限 " + mc.limit : " / 无上限") : "无账本行",
        }),
      );
      const coder = (g.runs || [])
        .filter(function (r) {
          return (r.role || "coder") === "coder";
        })
        .slice(0, 5);
      rows.push(
        h("dt", { text: "Run(最近)" }),
        h(
          "dd",
          { class: "small" },
          coder.length
            ? coder.map(function (r) {
                return h("div", {
                  class: "mono-sm",
                  text: r.id.slice(0, 14) + " · " + r.outcome + (r.reason ? " · " + r.reason : ""),
                });
              })
            : "—",
        ),
      );
      const gates = (g.gates || []).slice(0, 5);
      rows.push(
        h("dt", { text: "Gate / Reviewer" }),
        h(
          "dd",
          { class: "small" },
          gates.length
            ? gates.map(function (x) {
                return h("div", { class: "small", text: x.verdict + " · " + x.reviewer });
              })
            : "—",
        ),
      );
      const cs = (g.changesets || [])[0];
      rows.push(
        h("dt", { text: "交付 / SHA" }),
        h("dd", {
          class: "mono-sm",
          text: cs ? cs.deliveryState + " · " + A.short(cs.gitCommitSha || cs.candidateSha) : "—",
        }),
      );
      rows.push(
        h("dt", { text: "作用域" }),
        h("dd", { class: "small", text: (g.tasks[0] && g.tasks[0].allowedScope.join(", ")) || "—" }),
      );
      box.appendChild(h("dl", { class: "kv" }, rows));
      // P0-4:完整原始执行事件保留在技术详情(审计事实不删;P1-1:内部码/路径只在此层)
      box.appendChild(
        h(
          "div",
          { class: "ws-tech-events", "data-testid": sheetMode ? "ws-sheet-events" : "ws-tech-events" },
          h("div", { class: "ws-detail-head", text: "执行事件(原始)" }),
          deriveEvents(g)
            .map(eventLine)
            .concat([h("div", { class: "ws-event dim", text: "更早事件与完整审计见系统状态/技术证据。" })]),
        ),
      );
      host.appendChild(box);
    }
  }

  // ---------------- 右栏整栏折叠(P0-6) ----------------

  function applyPane() {
    const layout = $("#ws-layout");
    if (layout) layout.classList.toggle("ws-pane-closed", !state.paneOpen);
    const btn = $("#ws-pane-toggle");
    if (btn) btn.textContent = state.paneOpen ? "收起详情" : "查看详情";
  }

  // ---------------- Composer(P0-1:唯一输入;空白态=项目+开始 / 任务态=继续对话;Enter 发送;失败显式) ----------------

  function renderComposer() {
    const input = $("#ws-input");
    const btn = $("#ws-send");
    const execBtn = $("#ws-execute");
    const projRow = $("#ws-composer-project");
    if (!input || !btn) return;
    if (!state.goalId) {
      input.placeholder = "告诉 Relay 你想做什么……";
      btn.textContent = "开始";
      if (projRow) projRow.hidden = false;
      if (execBtn) execBtn.hidden = true; // 空白态=显式创建入口(开始);无"执行"语义
    } else {
      input.placeholder = "继续告诉 Relay……";
      btn.textContent = "发送";
      if (projRow) projRow.hidden = true;
      // 方案 A:任务态=双操作(发送=只交流/记录;交给 Relay 执行=显式创建受控任务)
      if (execBtn) execBtn.hidden = false;
    }
  }

  async function sendMessage(executionRequest) {
    const input = $("#ws-input");
    const btn = executionRequest ? $("#ws-execute") : $("#ws-send");
    if (!input || !state.goalId) return;
    const content = input.value.trim();
    if (!content) return;
    if (content.length > 2000) {
      feedNotice("内容过长(上限 2000 字)", "st-bad");
      return;
    }
    input.value = "";
    growInput(); // 发送后输入框收回单行(§9)
    const localN = state.pendingLocal.length;
    state.pendingLocal.push({ n: localN, content: content });
    renderFeed(true); // §6:发送后立即在 Feed 显示 USER_MESSAGE(本地回显)
    if (btn) btn.disabled = true;
    const sendBtn = $("#ws-send");
    const execBtn = $("#ws-execute");
    if (sendBtn) sendBtn.disabled = true;
    if (execBtn) execBtn.disabled = true;
    try {
      // 方案 A:普通发送不携带执行字段(旧客户端兼容路径);显式执行带 executionRequest=true
      const payload = { content: content };
      if (executionRequest) payload.executionRequest = true;
      await A.apiPost("/api/goals/" + encodeURIComponent(state.goalId) + "/messages", payload);
      state.pendingLocal = []; // 单发送在途(按钮已禁用);服务端事实将经刷新落 Feed
      await refreshAll(true); // §14:发送后立即刷新
    } catch (err) {
      state.pendingLocal = state.pendingLocal.filter(function (m) {
        return m.content !== content;
      });
      input.value = content; // 失败还原文稿;显式报错,不假成功(§13 写操作)
      growInput();
      feedNotice("发送失败,请稍后重试", "st-bad"); // P1-1:内部异常文案不直出
    } finally {
      if (btn) btn.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (execBtn) execBtn.disabled = false;
      input.focus();
    }
  }

  async function createFromComposer() {
    const input = $("#ws-input");
    const btn = $("#ws-send");
    const msg = $("#ws-composer-msg");
    const sel = $("#ws-project");
    if (!input || !btn) return;
    const raw = input.value.trim();
    if (msg) msg.textContent = "";
    if (!raw) {
      if (msg) msg.textContent = "先写一句你想让 Relay 做的事";
      return;
    }
    if (raw.length > 2000) {
      if (msg) msg.textContent = "内容过长(上限 2000 字)";
      return;
    }
    btn.disabled = true;
    try {
      const payload = { rawInput: raw };
      if (sel && sel.value) payload.projectId = sel.value;
      const res = await A.apiPost("/api/goals", payload);
      window.location.href = "/workspace?goal=" + encodeURIComponent(res.goalId);
    } catch (e) {
      if (msg) msg.textContent = "创建失败,请稍后重试"; // P1-1:内部错误不直出
      btn.disabled = false;
    }
  }

  function composerSubmit(executionRequest) {
    if (state.goalId) return sendMessage(executionRequest === true);
    if (executionRequest) return; // 空白态无"执行"语义(创建走 POST /api/goals)
    return createFromComposer();
  }

  /** §9:输入框自然增高(上限 140px 与 CSS max-height 一致;下限由 CSS 按端 min-height 控制)。 */
  function growInput() {
    const input = $("#ws-input");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  function wireComposer() {
    const input = $("#ws-input");
    const btn = $("#ws-send");
    const execBtn = $("#ws-execute");
    if (btn)
      btn.addEventListener("click", function () {
        return composerSubmit(false);
      });
    if (execBtn)
      execBtn.addEventListener("click", function () {
        return composerSubmit(true);
      }); // 方案 A:显式执行
    if (input) {
      input.addEventListener("input", growInput);
      // §9:移动端(coarse pointer)Enter=换行,发送走「发送」按钮;桌面保持 03C.1 语义(Enter 发送/Shift+Enter 换行)
      if (mqMatches(COARSE_MQ)) return;
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          composerSubmit(false); // Enter=普通发送(只交流/记录;方案 A)
        }
      });
    }
  }

  function populateProjectSelect() {
    const sel = $("#ws-project");
    if (!sel) return;
    A.apiGet("/api/projects")
      .then(function (res) {
        const v = res.projects || {};
        const list = (v.projects || []).filter(function (p) {
          return p && p.name && p.path;
        });
        sel.textContent = "";
        if (!list.length) {
          sel.appendChild(
            h("option", { value: "", text: v.configured ? "暂无项目 — 直接开始" : "尚未配置项目 — 直接开始" }),
          );
        } else {
          sel.appendChild(h("option", { value: "", text: "请选择一个项目" }));
          list.forEach(function (p) {
            sel.appendChild(h("option", { value: p.name, text: p.name }));
          });
        }
      })
      .catch(function () {
        sel.appendChild(h("option", { value: "", text: "项目列表读取失败,可直接开始" }));
      });
  }

  // ---------------- 顶栏 / 数据刷新(§14:Feed 增量 + 明细/侧栏整体替换;4s 可见 / 30s 后台) ----------------

  /** §3:顶栏状态点(必要状态点;与工作块模式同源确定性推导;桌面 CSS 隐藏不回退 03C.1)。 */
  const HEADER_DOT = {
    running: ["ws-dot-blue", "正在处理"],
    queued: ["ws-dot-blue", "已纳入执行队列"],
    waiting: ["ws-dot-yellow", "等待你的决定"],
    done: ["ws-dot-green", "已完成"],
    failed: ["ws-dot-red", "需要处理"],
  };

  function renderHeader() {
    const title = $("#ws-title");
    const g = state.detail;
    const dot = $("#ws-title-dot");
    if (!state.goalId) {
      title.textContent = "工作区";
      if (dot) dot.hidden = true;
      return;
    }
    // P0-2:Header 项目 = status.projectName(与侧栏/右栏同源);未绑定如实显示
    title.textContent = projectDisplay() + " · " + goalTitle(g && g.goal ? g.goal.rawInput : "");
    const w = deriveWork(g);
    if (dot) {
      const d = w ? HEADER_DOT[w.mode] : null;
      if (d) {
        dot.className = "ws-dot ws-title-dot " + d[0];
        dot.setAttribute("title", d[1]);
        dot.hidden = false;
      } else {
        dot.hidden = true;
      }
    }
    const stamp = $("#ws-stamp");
    if (stamp) stamp.textContent = "数据读取时间:" + A.fmtTime(new Date().toISOString());
  }

  async function refreshFeed(immediate) {
    if (!state.goalId) return;
    const after = state.cursor > 0 ? state.cursor : "";
    const res = await A.apiGet(
      "/api/goals/" + encodeURIComponent(state.goalId) + "/feed" + (after ? "?after=" + after : ""),
    );
    const f = res.feed;
    if (state.firstLoad || after === "") {
      state.messages = f.items.slice();
      state.cursor = f.nextCursor || 0;
      state.firstLoad = false;
    } else if (f.items.length) {
      f.items.forEach(function (m) {
        state.messages.push(m);
      });
      state.cursor = f.nextCursor || state.cursor;
    }
    state.decisions = f.decisions || [];
    state.status = f.status || state.status;
    if (immediate) renderFeed(true);
  }

  async function refreshDetail() {
    if (!state.goalId) return;
    const res = await A.apiGet("/api/goals/" + encodeURIComponent(state.goalId));
    state.detail = res.goal;
  }

  async function refreshSidebar() {
    const res = await A.apiGet("/api/workspace/sidebar");
    state.sidebar = res.sidebar;
    renderSidebar();
  }

  async function refreshAll(immediate) {
    try {
      if (state.goalId) {
        await Promise.all([refreshFeed(immediate), refreshDetail()]);
      }
      renderFeed(immediate); // 空白态=引导语;任务态=消息+工作块
      renderComposer(); // P0-1:模式随 goal 选择切换(占位/按钮/项目选择)
      renderDetail(); // 空白态右栏=「未选择任务」(不留整列空白——Reviewer Minor-6)
      if (state.goalId) {
        renderHeader();
      }
      await refreshSidebar();
      setConn(null);
    } catch (err) {
      // §13:临时断网——统一用户文案(不直出原始异常);会话不清空,轮询自动恢复
      setConn("与 Relay 的连接暂时中断,正在重新连接。"); // Reviewer F-1:不直出原始异常文本
    }
  }

  function setConn(message) {
    const el = $("#ws-conn");
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
      el.setAttribute("data-state", "offline");
    } else {
      el.textContent = "";
      el.hidden = true;
      el.setAttribute("data-state", "online");
    }
  }

  function scheduleLoop() {
    let timer = null;
    const tick = async function () {
      const hidden = document.visibilityState === "hidden";
      await refreshAll(false);
      timer = setTimeout(tick, hidden ? 30000 : 4000);
    };
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        timer = setTimeout(tick, 300);
      }
    });
    timer = setTimeout(tick, 400);
  }

  // ---------------- 启动 ----------------

  A.boot(
    "workspace",
    async function () {
      const params = new URLSearchParams(window.location.search);
      state.goalId = params.get("goal");
      const logout = $("#ws-logout");
      if (logout) {
        logout.addEventListener("click", async function () {
          try {
            await fetch("/api/session", {
              method: "DELETE",
              credentials: "same-origin",
              headers: { accept: "application/json", "x-relay-csrf": A.state.csrf || "" },
            });
          } catch (e) {
            /* 无论成功与否都跳登录页 */
          }
          window.location.href = "/login.html";
        });
      }
      const newTask = $("#ws-new-task");
      if (newTask) {
        newTask.addEventListener("click", function () {
          // P0-1:新建任务 = 回空白工作区(唯一 Composer 承载创建;§5 手机同样进入该 sheet 式空白页),不再有第二表单
          if (state.goalId || window.location.search) window.location.href = "/workspace";
          else {
            setDrawer(false);
            const input = $("#ws-input");
            if (input) input.focus();
          }
        });
      }
      // WEB-UX-03D §4:导航抽屉(移动端;桌面 CSS 隐藏菜单键,行为不存在)
      const menuBtn = $("#ws-menu-btn");
      if (menuBtn)
        menuBtn.addEventListener("click", function () {
          setDrawer(!drawerOpen());
        });
      const backdrop = $("#ws-backdrop");
      if (backdrop)
        backdrop.addEventListener("click", function () {
          setDrawer(false);
        });
      // WEB-UX-03D §11:详情 sheet 关闭(按钮 + 遮罩 + Esc)
      const sheetClose = $("#ws-sheet-close");
      if (sheetClose) sheetClose.addEventListener("click", closeSheet);
      const sheetBackdrop = $("#ws-sheet-backdrop");
      if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        if (sheetOpen) closeSheet();
        else if (drawerOpen()) setDrawer(false);
      });
      // WEB-UX-03D §10:回到最新
      const jump = $("#ws-jump-latest");
      if (jump) jump.addEventListener("click", jumpToLatest);
      const paneToggle = $("#ws-pane-toggle");
      if (paneToggle)
        paneToggle.addEventListener("click", function () {
          state.paneOpen = !state.paneOpen;
          applyPane();
        });
      applyPane();
      wireComposer();
      watchViewport();
      if (window.location.hash === "#new-task") {
        const input = $("#ws-input");
        if (input) input.focus();
      } // 旧锚点兼容:聚焦唯一 Composer
      if (!state.goalId) populateProjectSelect();
      await refreshAll(true);
      // 移动端(coarse pointer)不自动弹键盘(页面加载即开键盘体验差);桌面保持 03C.1 聚焦行为
      if (!state.goalId && !mqMatches(COARSE_MQ)) {
        const input = $("#ws-input");
        if (input) input.focus();
      }
      scheduleLoop();
    },
    { bare: true },
  );
})();
