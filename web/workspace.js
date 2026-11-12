// Relay 会话式工作区(WEB-UX-03C:主交互入口;§2 三层结构)。
// 约束(沿 app.js 铁律):零构建/CSP 'self';DOM API + textContent,**不用 innerHTML**;
//  前端不持有业务状态——Feed=服务端投影(goal_messages 会话事实)+ 明细快照确定性推导(§5 不伪造 AI 对话);
//  轮询 4s 可见 / 30s 后台 / 发送与 Decision 后立即刷新(§14;无 WebSocket)。
//  Composer 始终可用(§6);发送失败显式显示,不假成功。
(function () {
  "use strict";
  const A = window.RelayApp;
  const h = A.h;
  const $ = A.$;

  const state = {
    goalId: null,
    cursor: 0,          // 已消费的最大消息 id(0=从头拉 200)
    messages: [],       // 服务端会话事实(USER_MESSAGE/RELAY_MESSAGE)
    decisions: [],      // 未决决策卡(feed.decisions 整体替换)
    status: null,       // goalStatusView 快照
    detail: null,       // goalDetailView(STATUS/RESULT/FAILURE 确定性推导源)
    sidebar: null,
    projectOf: {},      // goalId → 项目名(侧栏归组)
    firstLoad: true,
    pendingLocal: [],   // 发送中尚未落库确认的本地回显(失败即移除)
    notices: [],        // 本会话内操作回执(批准/拒绝/失败;renderFeed 持久渲染,避免被刷新抹掉)
    lastEventKeys: {},  // STATUS 事件去重
  };

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
      host.appendChild(h("div", { class: "ws-group-name", text: grp.name }));
      grp.goals.forEach(function (g) {
        state.projectOf[g.id] = grp.name === "未分组" ? null : grp.name;
        decisionTotal += Number(g.pendingDecisions) || 0;
        const dot = PHASE_DOT[g.phase] || PHASE_DOT.idle;
        const link = h(
          "a",
          { class: "ws-goal-row" + (g.id === state.goalId ? " active" : ""), href: "/workspace?goal=" + encodeURIComponent(g.id), "data-testid": "ws-goal-row-" + g.id },
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

  // ---------------- Feed:会话事实 + 系统事件 + Decision/Result 卡(§4/§7/§8/§11) ----------------

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
      else if (["LEASED", "RUNNING", "SUBMITTED"].indexOf(s) >= 0) push("task-run-" + t.id + "-" + s, ts, "st-run", "正在修改代码");
      else if (s === "VERIFYING") push("task-ver-" + t.id, ts, "st-run", "正在验证");
      else if (s === "ACCEPTED") push("task-acc-" + t.id, ts, "st-ok", "本轮执行完成,复核通过");
      else if (s === "REWORK") push("task-rw-" + t.id + "-" + t.attempt, ts, "st-warn", "正在返工");
      else if (["FAILED", "CANCELLED", "BLOCKED", "BUDGET_EXHAUSTED", "TIMEOUT"].indexOf(s) >= 0) push("task-fail-" + t.id + "-" + s, ts, "st-bad", "本轮执行未成功" + (t.blockedReason ? ":" + t.blockedReason : ""));
      else if (s === "NEEDS_DECISION") push("task-dec-" + t.id, ts, "st-warn", "等待你的决定");
    });
    const evRows = (g.evidence || []).slice(0, 50);
    const evPass = evRows.filter(function (e) { return e.passed; }).length;
    const evFail = evRows.length - evPass;
    if (evRows.length && evPass) push("ev-pass-" + evRows.map(function (e) { return e.id; }).join(".").slice(0, 60), evRows[0] && evRows[0].createdAt, "st-ok", evPass + " 项验证通过");
    if (evFail) push("ev-fail-" + evRows.map(function (e) { return e.id; }).join(".").slice(0, 60), evRows[0] && evRows[0].createdAt, "st-bad", evFail + " 项验证未通过");
    (g.runs || []).forEach(function (r) {
      const role = r.role || "coder";
      const ts = r.startedAt || null;
      if (role === "coder") {
        if (r.outcome === "SUCCEEDED") push("run-ok-" + r.id, ts, "st-ok", "代码修改完成");
        else if (r.outcome === "RUNNING") push("run-go-" + r.id, ts, "st-run", "正在修改代码");
        else if (["FAILED", "TIMEOUT", "BUDGET_EXHAUSTED", "CANCELLED", "INTERRUPTED"].indexOf(r.outcome) >= 0) push("run-bad-" + r.id + "-" + r.outcome, ts, "st-bad", "修改遇到问题,系统会按规则重试(原因见技术详情)"); // Reviewer F-2:内部错误码不直出
      } else if (role === "reviewer" && r.outcome === "RUNNING") {
        push("rev-go-" + r.id, ts, "st-run", "独立复核进行中");
      }
    });
    (g.gates || []).forEach(function (gt) {
      const cls = gt.verdict === "PASS" ? "st-ok" : gt.verdict === "BLOCK" ? "st-bad" : "st-warn";
      const text = gt.verdict === "PASS" ? "独立复核通过" : gt.verdict === "BLOCK" ? "独立复核发现问题,需要处理" : "独立复核要求返工";
      push("gate-" + gt.id + "-" + gt.verdict, gt.consumedAt || null, cls, text);
    });
    (g.changesets || []).forEach(function (c) {
      const n = (c.changedFiles.added.length + c.changedFiles.modified.length + c.changedFiles.removed.length);
      if (c.deliveryState === "DELIVERED") push("cs-ok-" + c.id + "-" + c.deliveryState, null, "st-ok", "修改已提交仓库(" + n + " 个文件)");
      else if (c.deliveryState === "DELIVERING") push("cs-go-" + c.id + "-" + c.deliveryState, null, "st-run", "正在交付");
      else if (["CONFLICT", "FAILED"].indexOf(c.deliveryState) >= 0) push("cs-bad-" + c.id + "-" + c.deliveryState, null, "st-bad", "交付遇到问题,需要处理");
    });
    const disc = g.discovery && g.discovery.latest;
    if (disc && disc.outcome === "SUCCEEDED") push("disc-ok", null, "st-ok", "项目分析完成");
    else if (disc && disc.outcome === "FAILED") push("disc-bad", null, "st-warn", "自动分析未成功,按既定规则继续");
    return ev;
  }

  function eventLine(e) {
    const mark = e.cls === "st-ok" ? "✓" : e.cls === "st-run" ? "●" : e.cls === "st-bad" ? "✗" : e.cls === "st-warn" ? "⚠" : "…";
    return h(
      "div",
      { class: "ws-event " + e.cls, "data-testid": "ws-event-" + e.key },
      h("span", { class: "ws-event-mark", text: mark }),
      h("span", { class: "ws-event-text", text: e.text }),
      e.ts ? h("span", { class: "ws-event-ts", text: A.fmtTime(e.ts) }) : null,
    );
  }

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
    const card = h(
      "div",
      { class: "ws-card ws-card-decision", "data-testid": "ws-decision-card-" + d.id },
      h("div", { class: "ws-card-title ws-warn-text", text: "⚠ 需要你的决定" }),
      h("div", { class: "ws-card-question", "data-testid": "ws-decision-question", text: (function () { const q = d.question || "(系统未提供问题描述)"; return q.length > 200 ? q.slice(0, 200) + "…(完整内容见技术详情)" : q; })() }), // Reviewer F-2:内部错误细节截断,完整内容走技术详情
      fb.recommended ? h("div", { class: "ws-card-sub", text: "建议:" + String(fb.recommended) }) : null,
      fb.risk ? h("div", { class: "ws-card-sub dim", text: "风险:" + String(fb.risk) }) : null,
      d.deadline ? h("div", { class: "ws-card-sub dim", text: "截止:" + A.fmtTime(d.deadline) }) : null,
    );
    const row = h("div", { class: "row mt8" });
    const mk = function (label, testid, fn) {
      const b = h("button", { class: "btn btn-sm", type: "button", "data-testid": testid, text: label });
      b.addEventListener("click", function () {
        disableRow();
        fn().catch(function (err) {
          feedNotice("操作失败,请稍后重试(详见技术详情)", "st-bad"); // Reviewer F-2:内部异常文案不直出
          disableRow(false);
        });
      });
      return b;
    };
    function disableRow(dis) {
      Array.prototype.forEach.call(row.querySelectorAll("button"), function (b) { b.disabled = dis !== false; });
    }
    row.appendChild(mk("允许 / 批准", "ws-decision-approve-" + d.id, async function () {
      await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/resolve", {
        taskId: d.taskId,
        approve: true,
        expectedStateVersion: await fetchTaskStateVersion(d.taskId),
      });
      feedNotice("✓ 已批准,Relay 继续执行", "st-ok");
      await refreshAll(true);
    }));
    row.appendChild(mk("不允许", "ws-decision-reject-" + d.id, async function () {
      await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/resolve", {
        taskId: d.taskId,
        approve: false,
        expectedStateVersion: await fetchTaskStateVersion(d.taskId),
      });
      feedNotice("已拒绝:该操作不会执行,Relay 会按预案调整", "st-warn");
      await refreshAll(true);
    }));
    row.appendChild(mk("稍后处理", "ws-decision-defer-" + d.id, async function () {
      await A.apiPost("/api/decisions/" + encodeURIComponent(d.id) + "/defer", { taskId: d.taskId });
      feedNotice("已推迟:稍后在「待我决定」处理", "st-wait");
      await refreshAll(true);
    }));
    card.appendChild(row);
    return card;
  }

  async function fetchTaskStateVersion(taskId) {
    const res = await A.apiGet("/api/goals/" + encodeURIComponent(state.goalId));
    const t = (res.goal.tasks || []).find(function (x) { return x.id === taskId; });
    if (!t) throw new Error("task_not_found");
    return t.stateVersion;
  }

  /** Result 卡(§8:完成后内联;数据=明细快照确定性统计)。 */
  function resultCard(g) {
    const cs = (g.changesets || []).find(function (c) { return c.deliveryState === "DELIVERED"; });
    const evRows = g.evidence || [];
    const evPass = evRows.filter(function (e) { return e.passed; }).length;
    const gatePass = (g.gates || []).some(function (x) { return x.verdict === "PASS"; });
    const accepted = (g.tasks || []).some(function (t) { return t.state === "ACCEPTED"; });
    if (!accepted && !cs) return null;
    const nFiles = cs ? cs.changedFiles.added.length + cs.changedFiles.modified.length + cs.changedFiles.removed.length : 0;
    const card = h(
      "div",
      { class: "ws-card ws-card-result", "data-testid": "ws-result-card" },
      h("div", { class: "ws-card-title ws-ok-text", text: "✓ 本轮工作完成" }),
      h("div", { class: "ws-card-question", text: (g.goal.rawInput || "").length > 120 ? g.goal.rawInput.slice(0, 120) + "…" : g.goal.rawInput || "" }),
    );
    const rows = h("div", { class: "ws-result-rows" });
    if (cs) rows.appendChild(h("div", { class: "ws-card-sub" }, h("span", { class: "dim" }, "修改 "), h("span", { "data-testid": "ws-result-files", text: nFiles + " 个文件" })));
    rows.appendChild(h("div", { class: "ws-card-sub" }, h("span", { class: "dim" }, "验证 "), h("span", { "data-testid": "ws-result-tests", text: evRows.length ? "✓ " + evPass + " 项通过" + (evPass < evRows.length ? "(" + (evRows.length - evPass) + " 项未通过)" : "") : "—未运行" })));
    rows.appendChild(h("div", { class: "ws-card-sub" }, h("span", { class: "dim" }, "复核 "), h("span", { "data-testid": "ws-result-review", text: gatePass ? "✓ 独立复核通过" : "—" })));
    rows.appendChild(h("div", { class: "ws-card-sub" }, h("span", { class: "dim" }, "交付 "), h("span", { "data-testid": "ws-result-delivery", text: cs ? "✓ 已提交 GitHub" : "尚未交付" })));
    card.appendChild(rows);
    const row = h("div", { class: "row mt8" });
    if (cs) {
      row.appendChild(h("a", { class: "btn btn-sm", href: "/changeset.html?id=" + encodeURIComponent(cs.id), "data-testid": "ws-result-view", text: "查看修改" }));
    }
    row.appendChild(h("button", { class: "btn btn-sm", type: "button", "data-testid": "ws-result-tech", text: "技术详情", onclick: function () { toggleTech(); } }));
    card.appendChild(row);
    return card;
  }

  function feedNotice(text, cls) {
    // §7:操作结果插入 Feed;保留最近 3 条,刷新重渲染时不丢(客户端会话回执,非服务端事实)。
    state.notices.push({ text: text, cls: cls || "st-warn" });
    if (state.notices.length > 3) state.notices.shift();
    renderFeed();
  }

  /** Feed 整体渲染:消息(按 id 序)∪ 派生事件(按时间)→ Decision 卡 → Result 卡 →(Composer 常驻)。 */
  function renderFeed() {
    const feed = $("#ws-feed");
    if (!feed) return;
    feed.textContent = "";
    if (!state.goalId) {
      feed.appendChild(h("div", { class: "ws-empty-feed" }, "选择左侧任务,或新建一个任务开始对话。"));
      return;
    }
    const items = [];
    state.messages.forEach(function (m) {
      items.push({ sort: Number(m.id), node: m.kind === "USER_MESSAGE" ? userBubble(m) : relayBubble(m) });
    });
    state.pendingLocal.forEach(function (m) {
      items.push({ sort: Number.MAX_SAFE_INTEGER, node: userBubble({ id: "local-" + m.n, content: m.content }) });
    });
    deriveEvents(state.detail).forEach(function (e) {
      const ts = e.ts ? Date.parse(e.ts) : 0;
      items.push({ sort: ts || 0.5, node: eventLine(e), ts: ts || null });
    });
    // 排序:消息按 id 权威;事件按时间戳落在消息间(无时间戳事件贴在现有内容后)。
    items.sort(function (a, b) { return a.sort - b.sort; });
    items.forEach(function (it) { feed.appendChild(it.node); });
    // Decision 卡(未决;内联于 Feed 末尾、Composer 之前)
    (state.decisions || []).forEach(function (d) { feed.appendChild(decisionCard(d)); });
    // 本会话操作回执(批准/拒绝/失败提示;客户端回执,排在决策卡后)
    state.notices.forEach(function (n, i) {
      feed.appendChild(h("div", { class: "ws-event " + n.cls, "data-testid": "ws-notice", text: n.text }));
    });
    // Result 卡(完成后内联;detail 未返回时跳过,下一拍补齐——Reviewer F-1)
    const rc = state.detail ? resultCard(state.detail) : null;
    if (rc) feed.appendChild(rc);
    feed.scrollTop = feed.scrollHeight;
  }

  // ---------------- 右侧详情栏(§9:默认摘要;技术详情折叠) ----------------

  let techOpen = false;
  function toggleTech() {
    techOpen = !techOpen;
    renderDetail();
  }

  function renderDetail() {
    const host = $("#ws-detail");
    if (!host) return;
    host.textContent = "";
    const st = state.status;
    const g = state.detail;
    if (!state.goalId) { host.appendChild(h("div", { class: "empty" }, "未选择任务")); return; }
    const ph = st && st.inFlight ? "正在处理" : st && st.pendingDecisions > 0 ? "等待你决定" : g && (g.progress || {}).phase ? A.zh((g.progress || {}).phase) : "—";
    host.appendChild(h("div", { class: "ws-detail-head", text: "任务信息" }));
    host.appendChild(h("div", { class: "ws-detail-item" }, h("span", { class: "dim" }, "当前项目"), h("span", { "data-testid": "ws-detail-project", text: state.projectOf[state.goalId] || "默认工作区" })));
    host.appendChild(h("div", { class: "ws-detail-item" }, h("span", { class: "dim" }, "当前阶段"), h("span", { "data-testid": "ws-detail-phase", text: ph })));
    host.appendChild(h("div", { class: "ws-detail-item" }, h("span", { class: "dim" }, "已运行时间"), h("span", { "data-testid": "ws-detail-elapsed", text: g && g.progress && g.progress.elapsedSeconds !== null && g.progress.elapsedSeconds !== undefined ? A.fmtDuration(g.progress.elapsedSeconds) : "—" })));
    host.appendChild(h("div", { class: "ws-detail-item" }, h("span", { class: "dim" }, "是否等待用户"), h("span", { "data-testid": "ws-detail-waiting", text: st && st.pendingDecisions > 0 ? "是(需要你决定)" : "否" })));
    host.appendChild(h("button", { class: "btn btn-sm ws-tech-toggle", type: "button", "data-testid": "ws-detail-toggle", text: techOpen ? "收起技术详情" : "技术详情", onclick: toggleTech }));
    if (techOpen && g) {
      const box = h("div", { class: "ws-tech", "data-testid": "ws-detail-tech" });
      const rows = [];
      rows.push(h("dt", { text: "Goal ID" }), h("dd", { class: "mono-sm", text: g.goal.id }));
      rows.push(h("dt", { text: "当前任务" }), h("dd", { class: "mono-sm", text: (g.progress || {}).currentTaskId || "—" }));
      rows.push(h("dt", { text: "模型" }), h("dd", { class: "mono-sm", text: (g.progress || {}).currentModelRef || "尚无运行" }));
      const mc = (g.budget || []).find(function (b) { return b.kind === "model_calls"; });
      rows.push(h("dt", { text: "预算(模型调用)" }), h("dd", { class: "small", text: mc ? "已用 " + mc.used + (mc.limit !== null ? " / 上限 " + mc.limit : " / 无上限") : "无账本行" }));
      const coder = (g.runs || []).filter(function (r) { return (r.role || "coder") === "coder"; }).slice(0, 5);
      rows.push(h("dt", { text: "Run(最近)" }), h("dd", { class: "small" }, coder.length ? coder.map(function (r) { return h("div", { class: "mono-sm", text: r.id.slice(0, 14) + " · " + r.outcome + (r.reason ? " · " + r.reason : "") }); }) : "—"));
      const gates = (g.gates || []).slice(0, 5);
      rows.push(h("dt", { text: "Gate / Reviewer" }), h("dd", { class: "small" }, gates.length ? gates.map(function (x) { return h("div", { class: "small", text: x.verdict + " · " + x.reviewer }); }) : "—"));
      const cs = (g.changesets || [])[0];
      rows.push(h("dt", { text: "交付 / SHA" }), h("dd", { class: "mono-sm", text: cs ? (cs.deliveryState + " · " + A.short(cs.gitCommitSha || cs.candidateSha)) : "—" }));
      rows.push(h("dt", { text: "作用域" }), h("dd", { class: "small", text: (g.tasks[0] && g.tasks[0].allowedScope.join(", ")) || "—" }));
      box.appendChild(h("dl", { class: "kv" }, rows));
      host.appendChild(box);
    }
  }

  // ---------------- Composer(§6:始终可见;Enter 发送;失败显式) ----------------

  async function sendMessage() {
    const input = $("#ws-input");
    const btn = $("#ws-send");
    if (!input || !state.goalId) return;
    const content = input.value.trim();
    if (!content) return;
    if (content.length > 2000) { feedNotice("内容过长(上限 2000 字)", "st-bad"); return; }
    input.value = "";
    const localN = state.pendingLocal.length;
    state.pendingLocal.push({ n: localN, content: content });
    renderFeed(); // §6:发送后立即在 Feed 显示 USER_MESSAGE(本地回显)
    btn.disabled = true;
    try {
      await A.apiPost("/api/goals/" + encodeURIComponent(state.goalId) + "/messages", { content: content });
      state.pendingLocal = []; // 单发送在途(btn 已禁用);服务端事实将经刷新落 Feed
      await refreshAll(true); // §14:发送后立即刷新
    } catch (err) {
      state.pendingLocal = state.pendingLocal.filter(function (m) { return m.content !== content; });
      input.value = content; // 失败还原文稿;显式报错,不假成功
      feedNotice("发送失败:" + ((err && err.message) || err), "st-bad");
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  function wireComposer() {
    const input = $("#ws-input");
    const btn = $("#ws-send");
    if (btn) btn.addEventListener("click", sendMessage);
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }
  }

  // ---------------- 新建任务面板(C1:选项目 → 一句话 → 开始) ----------------

  function wireNewTask() {
    const btn = $("#ws-new-task");
    const panel = $("#ws-newtask-panel");
    const close = function () { panel.hidden = true; };
    if (btn) btn.addEventListener("click", function () { panel.hidden = false; $("#ws-goal-input").focus(); });
    window.addEventListener("hashchange", function () {
      if (window.location.hash === "#new-task") { panel.hidden = false; }
    });
    if (window.location.hash === "#new-task") panel.hidden = false;
    const sel = $("#ws-project");
    const ta = $("#ws-goal-input");
    const create = $("#ws-create");
    const msg = $("#ws-create-msg");
    A.apiGet("/api/projects").then(function (res) {
      const v = res.projects || {};
      const list = (v.projects || []).filter(function (p) { return p && p.name && p.path; });
      sel.textContent = "";
      if (!list.length) {
        sel.appendChild(h("option", { value: "", text: v.configured ? "暂无项目 — 直接开始(默认工作区)" : "尚未配置项目 — 直接开始(默认工作区)" }));
      } else {
        sel.appendChild(h("option", { value: "", text: "请选择一个项目" }));
        list.forEach(function (p) { sel.appendChild(h("option", { value: p.name, text: p.name })); });
      }
    }).catch(function () { sel.appendChild(h("option", { value: "", text: "项目列表读取失败,可直接开始" })); });
    create.addEventListener("click", async function () {
      const raw = ta.value.trim();
      msg.textContent = "";
      if (!raw) { msg.textContent = "先写一句你想让 Relay 做的事"; return; }
      create.disabled = true;
      try {
        const payload = { rawInput: raw };
        if (sel.value) payload.projectId = sel.value;
        const res = await A.apiPost("/api/goals", payload);
        window.location.href = "/workspace?goal=" + encodeURIComponent(res.goalId);
      } catch (e) {
        msg.textContent = "创建失败:" + ((e && e.message) || e);
        create.disabled = false;
      }
    });
    void close;
  }

  // ---------------- 数据刷新(§14:Feed 增量 + 明细/侧栏整体替换;4s 可见 / 30s 后台) ----------------

  async function refreshFeed(immediate) {
    if (!state.goalId) return;
    const after = state.cursor > 0 ? state.cursor : "";
    const res = await A.apiGet("/api/goals/" + encodeURIComponent(state.goalId) + "/feed" + (after ? "?after=" + after : ""));
    const f = res.feed;
    if (state.firstLoad || after === "") {
      state.messages = f.items.slice();
      state.cursor = f.nextCursor || 0;
      state.firstLoad = false;
    } else if (f.items.length) {
      f.items.forEach(function (m) { state.messages.push(m); });
      state.cursor = f.nextCursor || state.cursor;
    }
    state.decisions = f.decisions || [];
    state.status = f.status || state.status;
    if (immediate) renderFeed();
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

  function renderHeader() {
    const title = $("#ws-title");
    const g = state.detail;
    if (!state.goalId) { title.textContent = "工作区"; return; }
    const proj = state.projectOf[state.goalId];
    title.textContent = (proj ? proj + " · " : "") + goalTitle(g && g.goal ? g.goal.rawInput : "");
    const stamp = $("#ws-stamp");
    if (stamp) stamp.textContent = "数据读取时间:" + A.fmtTime(new Date().toISOString());
  }

  async function refreshAll(immediate) {
    try {
      if (state.goalId) {
        await Promise.all([refreshFeed(immediate), refreshDetail()]);
        renderFeed();
        renderDetail();
        renderHeader();
      }
      await refreshSidebar();
      setConn(null);
    } catch (err) {
      setConn("无法核实当前状态(连接或服务异常);显示最后一次成功读取的内容。"); // Reviewer F-1:不直出原始异常文本
    }
  }

  function setConn(message) {
    const el = $("#ws-conn");
    if (!el) return;
    if (message) { el.textContent = message; el.hidden = false; el.setAttribute("data-state", "offline"); }
    else { el.textContent = ""; el.hidden = true; el.setAttribute("data-state", "online"); }
  }

  function scheduleLoop() {
    let timer = null;
    const tick = async function () {
      const hidden = document.visibilityState === "hidden";
      await refreshAll(false);
      timer = setTimeout(tick, hidden ? 30000 : 4000);
    };
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { clearTimeout(timer); timer = setTimeout(tick, 300); }
    });
    timer = setTimeout(tick, 400);
  }

  // ---------------- 启动 ----------------

  A.boot("workspace", async function () {
    const params = new URLSearchParams(window.location.search);
    state.goalId = params.get("goal");
    const logout = $("#ws-logout");
    if (logout) {
      logout.addEventListener("click", async function () {
        try {
          await fetch("/api/session", { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json", "x-relay-csrf": A.state.csrf || "" } });
        } catch (e) { /* 无论成功与否都跳登录页 */ }
        window.location.href = "/login.html";
      });
    }
    wireComposer();
    wireNewTask();
    if (!state.goalId) {
      const panel = $("#ws-newtask-panel");
      if (panel && window.location.hash !== "#new-task") panel.hidden = false; // 无选中任务时默认引导新建
      $("#ws-feed").textContent = "";
      $("#ws-feed").appendChild(h("div", { class: "ws-empty-feed" }, "在下方选择项目并说出需求,Relay 会在这里持续汇报进展。"));
    }
    await refreshAll(true);
    scheduleLoop();
  }, { bare: true });
})();
