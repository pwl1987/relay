// Relay 最小 Web 控制台共享前端(P0-02C → WEB-UX-01 §4.4 AppShell / §4.11 polling / §4.5 共享创建流)。
// 约束:
//  - 零构建、无第三方脚本(CSP script-src 'self');所有渲染用 DOM API(textContent),
//    **不使用 innerHTML** ⇒ 用户输入(Goal 原文等)不会变成可执行标记;
//  - 前端不持有业务状态:每次渲染都从 /api 取;连接中断时显示"无法核实"横幅 +
//    最后一次成功读取的时间戳,绝不把陈旧数据伪装成实时(G-7);
//  - 写操作统一带 x-relay-csrf(服务端双提交校验);
//  - AppShell:桌面=左侧可折叠导航 + 中央工作区(右侧抽屉为各页卡片自身的扩展位);
//    手机=顶栏 + 汉堡抽屉(§4.4);轮询 5~10s,后台降频 30s(§4.11,无 WebSocket/第二事件系统)。
(function () {
  "use strict";

  const state = {
    csrf: null,
    role: null,
    lastLoadedAt: null,
    connected: true,
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function h(tag, attrs) {
    const node = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      const v = a[k];
      if (v === null || v === undefined) return;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "html") throw new Error("innerHTML 禁用:请用 text/DOM");
      else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, String(v));
    });
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) {
          if (c === null || c === undefined || c === false) return;
          node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
      } else {
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  function fmtTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  }

  /** 秒 ⇒ 人读时长(OPERATOR-CONSOLE-00;Goal Detail elapsed 用)。 */
  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined || isNaN(Number(seconds))) return "—";
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return s + " 秒";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " 分 " + (s % 60) + " 秒";
    const hr = Math.floor(m / 60);
    return hr + " 小时 " + (m % 60) + " 分";
  }

  function short(sha, n) {
    if (!sha) return "—";
    const len = n || 12;
    return String(sha).slice(0, len);
  }

  function badge(text, kind) {
    return h("span", { class: "badge badge-" + (kind || "default"), text: text });
  }

  function stateKind(state) {
    const s = String(state || "");
    if (["ACCEPTED", "DELIVERED", "COMPLETED", "PASS", "SUCCEEDED", "RESOLVED_MANUAL"].indexOf(s) >= 0) return "ok";
    if (["FAILED", "CONFLICT", "BLOCK", "REWORK", "REJECTED", "TIMEOUT", "INTERRUPTED"].indexOf(s) >= 0) return "bad";
    if (["NEEDS_DECISION", "NEEDS_RECONCILE", "BLOCKED", "PAUSED", "EXPIRED_STILL_BLOCKED", "OPEN"].indexOf(s) >= 0) return "warn";
    return "info";
  }

  async function getSession() {
    const res = await fetch("/api/session", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error("session_http_" + res.status);
    const body = await res.json();
    state.csrf = body.csrfToken;
    state.role = body.role;
    return body;
  }

  async function apiGet(path) {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("unauthenticated");
    }
    let body = {};
    try {
      body = await res.json();
    } catch (e) {
      body = {};
    }
    if (!res.ok) {
      const err = new Error(body.error || "http_" + res.status);
      err.status = res.status;
      err.payload = body;
      throw err;
    }
    return body;
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-relay-csrf": state.csrf || "",
      },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("unauthenticated");
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || "http_" + res.status);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function setConn(message) {
    const el = $("#conn-banner");
    if (!el) return;
    if (message) {
      el.textContent =
        "连接中断:无法核实当前状态。以下内容是最后一次成功读取的快照(" +
        (state.lastLoadedAt ? fmtTime(state.lastLoadedAt) : "时间未知") +
        "),不代表实时状态。";
      el.hidden = false;
      el.setAttribute("data-state", "offline");
    } else {
      el.textContent = "";
      el.hidden = true;
      el.setAttribute("data-state", "online");
    }
    const stamp = $("#data-stamp");
    if (stamp) stamp.textContent = state.lastLoadedAt ? "数据读取时间:" + fmtTime(state.lastLoadedAt) : "尚未读取数据";
  }

  function updateStamp() {
    const stamp = $("#data-stamp");
    if (stamp) stamp.textContent = state.lastLoadedAt ? "数据读取时间:" + fmtTime(state.lastLoadedAt) : "尚未读取数据";
  }

  /** 统一加载包装:成功 ⇒ 记录读取时间并清横幅;失败 ⇒ 显示"无法核实"横幅。 */
  async function guarded(fn) {
    try {
      const data = await fn();
      state.lastLoadedAt = new Date().toISOString();
      state.connected = true;
      setConn(null);
      return data;
    } catch (err) {
      state.connected = false;
      setConn((err && err.message) || String(err));
      throw err;
    }
  }

  // ---------------- §4.4 AppShell(左侧可折叠导航;手机=顶栏 + 抽屉) ----------------

  const NAV_ITEMS = [
    { id: "dashboard", href: "/", label: "Dashboard" },
    { id: "goal", href: "/goal.html", label: "Goals" },
    { id: "decisions", href: "/decisions.html", label: "Decisions" },
    { id: "changeset", href: "/changeset.html", label: "Reviews" },
    { id: "projects", href: "/projects.html", label: "Projects" },
    { id: "models", href: "/models.html", label: "Models" },
    { id: "system", href: "/system.html", label: "System" },
  ];

  function renderShell(active) {
    const oldHeader = $("#app-header");
    if (!oldHeader) return;

    const nav = h(
      "nav",
      { class: "side-nav", "data-testid": "side-nav" },
      NAV_ITEMS.map(function (item) {
        return h("a", { class: "side-link" + (active === item.id ? " active" : ""), href: item.href, text: item.label });
      }),
    );
    const sidebar = h(
      "aside",
      { class: "sidebar", id: "app-sidebar", "data-testid": "sidebar" },
      h("div", { class: "side-brand" }, h("span", { class: "brand", text: "Relay 控制台" })),
      nav,
      h("div", { class: "side-foot" },
        h("a", { class: "btn btn-primary btn-new-goal", href: "/#new-goal", "data-testid": "btn-new-goal", text: "+ New Goal" }),
        h("div", { class: "side-user" },
          h("span", { id: "whoami", class: "whoami", text: state.role ? "身份:" + state.role : "" }),
          h("button", { id: "btn-logout", class: "btn btn-ghost", type: "button", text: "退出登录" }),
        ),
      ),
    );

    // 手机顶栏(品牌 + 汉堡);桌面由 CSS 隐藏。
    const topbar = h(
      "div",
      { class: "mobile-topbar", "data-testid": "mobile-topbar" },
      h("button", { class: "btn btn-ghost burger", id: "btn-burger", type: "button", "aria-label": "打开导航", text: "☰" }),
      h("span", { class: "brand", text: "Relay" }),
      h("a", { class: "btn btn-primary btn-new-goal-sm", href: "/#new-goal", text: "+ Goal" }),
    );

    const parent = oldHeader.parentNode;
    parent.insertBefore(sidebar, oldHeader);
    parent.insertBefore(topbar, oldHeader);
    oldHeader.remove();
    document.body.classList.add("shell-on");

    const burger = $("#btn-burger");
    if (burger) {
      burger.addEventListener("click", function () {
        const sb = $("#app-sidebar");
        if (sb) sb.classList.toggle("open");
      });
    }
    // 手机:点击导航链接后收起抽屉
    $$(".side-link", sidebar).forEach(function (a) {
      a.addEventListener("click", function () {
        sidebar.classList.remove("open");
      });
    });

    const logout = $("#btn-logout");
    if (logout) {
      logout.addEventListener("click", async function () {
        try {
          await fetch("/api/session", {
            method: "DELETE",
            credentials: "same-origin",
            headers: { accept: "application/json", "x-relay-csrf": state.csrf || "" },
          });
        } catch (e) {
          /* 忽略:无论成功与否都跳登录页 */
        }
        window.location.href = "/login.html";
      });
    }
  }

  // ---------------- §4.11 polling(可见 8s;后台 30s;无 WebSocket/第二事件系统) ----------------

  let pollTimer = null;
  let pollFn = null;

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      tickPoll();
    }, ms);
  }

  async function tickPoll() {
    if (!pollFn) return;
    const hidden = document.visibilityState === "hidden";
    try {
      await pollFn();
    } catch (e) {
      /* guarded 已把错误转成连接横幅;轮询不抛出 */
    }
    schedulePoll(hidden ? 30000 : 8000);
  }

  /** 页面注册轮询:关键用户动作仍直接调 refresh()(立即刷新)。 */
  function poll(fn) {
    pollFn = fn;
    schedulePoll(8000);
    document.addEventListener("visibilitychange", function () {
      // 回到前台立即刷一拍,再按可见性调整节奏
      if (document.visibilityState === "visible") schedulePoll(500);
      else schedulePoll(30000);
    });
  }

  // ---------------- §4.5 共享"新建 Goal"表单(选择 Project → 一句话 → Create) ----------------

  /** 在容器内渲染新建表单;返回值供页面接按钮事件。projectPath 由服务端按注册表解析,浏览器零路径输入。 */
  function renderGoalForm(opts) {
    const o = opts || {};
    const sel = h("select", { id: o.selectId || "goal-project", "data-testid": o.selectTestId || "goal-project" });
    const ta = h("textarea", {
      id: o.inputId || "goal-input",
      "data-testid": o.inputTestId || "goal-input",
      placeholder: "例如:给登录页加一个加载中的提示,让用户知道点了之后在做什么",
    });
    const msg = h("span", { class: "small dim", id: o.msgId || "create-msg", "data-testid": o.msgTestId || "create-msg" });
    const btn = h("button", { class: "btn btn-primary", id: o.btnId || "btn-create-goal", type: "button", "data-testid": o.btnTestId || "btn-create-goal", text: "创建 Goal" });
    const note = h(
      "p",
      { class: "small dim mt8" },
      "执行范围由服务端按项目注册表(config/projects.json)解析;浏览器不提交任何服务器路径。创建走 core.planGoal(goal + 任务 + 预算账本行);",
      h("strong", { text: "派生计划为确定性默认计划" }),
      "(非模型规划)。",
    );
    const wrap = h(
      "div",
      {},
      h("label", { for: o.selectId || "goal-project", text: "选择 Project(执行范围绑定)" }),
      sel,
      h("label", { for: o.inputId || "goal-input", text: "一句自然语言描述你要交付什么(可只写一句模糊话)" }),
      ta,
      h("div", { class: "row mt8" }, btn, msg),
      note,
    );

    async function loadProjects() {
      sel.textContent = "";
      let projects = [];
      try {
        const res = await apiGet("/api/projects");
        const v = res.projects || {};
        projects = (v.projects || []).filter(function (p) {
          return p && p.name && p.path;
        });
        if (!v.configured) {
          sel.appendChild(h("option", { value: "", text: "未配置项目注册表(config/projects.json)— 可不绑定创建" }));
        }
      } catch (e) {
        sel.appendChild(h("option", { value: "", text: "项目列表读取失败 — 可不绑定创建" }));
      }
      if (projects.length) {
        sel.appendChild(h("option", { value: "", text: "不绑定项目(默认 /workspace 作用域)" }));
        projects.forEach(function (p) {
          const label = p.name + (p.health === "ok" ? "" : "(目录不可达)");
          sel.appendChild(h("option", { value: p.name, text: label }));
        });
      } else if (!sel.options.length) {
        sel.appendChild(h("option", { value: "", text: "不绑定项目(默认 /workspace 作用域)" }));
      }
    }

    async function submit() {
      const raw = ta.value.trim();
      msg.textContent = "";
      if (!raw) {
        msg.textContent = "请先写一句目标描述";
        return;
      }
      btn.disabled = true;
      try {
        const payload = { rawInput: raw };
        const pid = sel.value;
        if (pid) payload.projectId = pid;
        const res = await apiPost("/api/goals", payload);
        msg.textContent = "已创建:" + res.goalId + (res.project ? "(绑定 " + res.project.projectId + ")" : "");
        window.location.href = "/goal.html?id=" + encodeURIComponent(res.goalId);
      } catch (e) {
        msg.textContent = "创建失败:" + ((e && e.message) || e);
        btn.disabled = false;
      }
    }

    btn.addEventListener("click", submit);
    loadProjects();
    return { wrap: wrap, loadProjects: loadProjects, focus: function () { ta.focus(); } };
  }

  /** 页面骨架:未登录 ⇒ 跳登录页。 */
  async function boot(page, main) {
    try {
      const sess = await getSession();
      if (!sess) {
        window.location.href = "/login.html";
        return;
      }
    } catch (err) {
      setConn("无法读取会话:" + ((err && err.message) || err));
      return;
    }
    renderShell(page);
    setConn(null);
    updateStamp();
    await main();
  }

  window.RelayApp = {
    h: h,
    $: $,
    $$: $$,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    short: short,
    badge: badge,
    stateKind: stateKind,
    apiGet: apiGet,
    apiPost: apiPost,
    guarded: guarded,
    setConn: setConn,
    boot: boot,
    state: state,
    poll: poll,
    renderGoalForm: renderGoalForm,
  };
})();
