// Relay 工作台共享前端(P0-02C → WEB-UX-01 AppShell → WEB-UX-02 中文化与产品体验返工)。
// 约束:
//  - 零构建、无第三方脚本(CSP script-src 'self');所有渲染用 DOM API(textContent),
//    **不使用 innerHTML** ⇒ 用户输入(Goal 原文等)不会变成可执行标记;
//  - 前端不持有业务状态:每次渲染都从 /api 取;连接中断时显示"无法核实"横幅 +
//    最后一次成功读取的时间戳,绝不把陈旧数据伪装成实时(G-7);
//  - 写操作统一带 x-relay-csrf(服务端双提交校验);
//  - WEB-UX-02:界面全中文;DB/API 内部枚举不改协议,仅在 UI 层经 zh() 转换为中文展示;
//    AppShell=左侧导航(主:工作台/项目/任务/待我决定/验收结果;次:AI 资源/系统状态)+ 底部"＋新建需求";
//    待我决定/进行中用数量 Badge;轮询 8s 可见 / 30s 后台(§4.11,无 WebSocket/第二事件系统)。
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
    // WEB-UX-02 m8:本地时区 + 中文格式,不再直出 UTC "Z" 后缀(技术详情区如需原始值见 API)
    return d.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  /** 秒 ⇒ 人读时长(Goal elapsed 用)。 */
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

  // ---------------- WEB-UX-02:内部枚举 → 中文展示(UI 层转换;协议/DB 不改) ----------------

  const ZH_STATUS = {
    // 任务 / Goal 生命周期
    PLANNED: "已规划",
    READY: "等待执行",
    LEASED: "正在处理",
    RUNNING: "正在处理",
    SUBMITTED: "正在处理",
    VERIFYING: "正在验证",
    WAITING: "等待中",
    NEEDS_DECISION: "等待你的决定",
    NEEDS_RECONCILE: "待核对",
    REWORK: "正在返工",
    BLOCKED: "已阻止",
    PAUSED: "已暂停",
    FAILED: "需要处理",
    SUCCEEDED: "已完成",
    ACCEPTED: "已通过",
    COMPLETED: "已完成",
    CANCELLED: "已取消",
    TIMEOUT: "已超时",
    BUDGET_EXHAUSTED: "预算用尽",
    INTERRUPTED: "已中断",
    CONFLICT: "有冲突",
    EXPIRED_STILL_BLOCKED: "超时待处理",
    // 决策
    OPEN: "待处理",
    RESOLVED_APPROVED: "已批准",
    RESOLVED_REJECTED: "已拒绝",
    // 变更集交付
    DELIVERED: "已交付",
    DELIVERING: "交付中",
    VERIFIED: "已核实",
    NOT_VERIFIED: "未核实",
    NONE: "尚未交付",
    UNKNOWN: "未知",
    // Gate 裁决
    PASS: "已通过",
    BLOCK: "已阻止",
    // 决策级别(用户语言,不直显 D 代码)
    D0: "自动执行",
    D1: "自动执行",
    D2: "按预案执行",
    D3: "需要你决定",
    D4: "已禁止",
    // Worker 一拍状态
    IDLE: "空闲",
    CLAIMED: "已领取任务",
    // Goal 补充(状态机别名)
    ACTIVE: "进行中",
    PENDING: "等待中",
    // 能力登记
    IMPLEMENTED: "已实现",
    NOT_IMPLEMENTED: "未实现",
    STUB: "演示版",
    // 常见异常种类
    run_failed: "任务运行失败",
    tick_error: "调度异常",
    lease_recovered: "执行租约已回收",
    reconcile_needed: "需要核对",
    web_login_failed: "登录失败",
  };

  /** 内部枚举 → 用户语言;未登记的值如实原样(不伪造翻译)。 */
  function zh(s) {
    if (s === null || s === undefined || s === "") return "—";
    const v = ZH_STATUS[String(s)];
    return v || String(s);
  }

  function stateKind(state) {
    const s = String(state || "");
    if (["ACCEPTED", "DELIVERED", "COMPLETED", "PASS", "SUCCEEDED", "RESOLVED_APPROVED", "IMPLEMENTED", "VERIFIED"].indexOf(s) >= 0) return "ok";
    if (["FAILED", "CONFLICT", "BLOCK", "REWORK", "REJECTED", "TIMEOUT", "INTERRUPTED", "BUDGET_EXHAUSTED", "CANCELLED", "run_failed", "tick_error"].indexOf(s) >= 0) return "bad";
    if (["NEEDS_DECISION", "NEEDS_RECONCILE", "BLOCKED", "PAUSED", "EXPIRED_STILL_BLOCKED", "OPEN", "RESOLVED_REJECTED", "D3", "NOT_IMPLEMENTED"].indexOf(s) >= 0) return "warn";
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
    updateStamp();
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

  // ---------------- AppShell(WEB-UX-02 §7:左侧导航 + 分组 + Badge + 底部新建需求) ----------------

  const NAV_MAIN = [
    { id: "workspace", href: "/workspace", label: "工作区" },
    { id: "projects", href: "/projects.html", label: "项目" },
    { id: "goals", href: "/goal.html", label: "任务", badge: "running" },
    { id: "decisions", href: "/decisions.html", label: "待我决定", badge: "decisions" },
    { id: "changeset", href: "/changeset.html", label: "验收结果" },
  ];
  // WEB-UX-03C §10:旧后台降级重定位(不删除);总览不再是默认首页(/ 302 → /workspace)。
  const NAV_SUB = [
    { id: "legacy", href: "/index.html", label: "总览(旧)" },
    { id: "models", href: "/models.html", label: "AI 资源" },
    { id: "system", href: "/system.html", label: "系统状态" },
  ];
  const NAV_BADGES = {};

  function navLink(item) {
    const kids = [h("span", { class: "side-label", text: item.label })];
    if (item.badge) {
      NAV_BADGES[item.badge] = { el: null };
      kids.push(h("span", { class: "nav-badge", id: "nav-badge-" + item.badge, hidden: "", "data-testid": "nav-badge-" + item.badge, text: "0" }));
    }
    return h("a", { class: "side-link", href: item.href, "data-nav": item.id }, kids);
  }

  function renderShell(active) {
    const oldHeader = $("#app-header");
    if (!oldHeader) return;

    const nav = h(
      "nav",
      { class: "side-nav", "data-testid": "side-nav" },
      NAV_MAIN.map(navLink),
      h("div", { class: "side-divider" }),
      NAV_SUB.map(navLink),
    );
    const sidebar = h(
      "aside",
      { class: "sidebar", id: "app-sidebar", "data-testid": "sidebar" },
      h("div", { class: "side-brand" },
        h("span", { class: "brand", text: "Relay" }),
        h("span", { class: "brand-sub", text: "AI 软件开发工作台" })),
      nav,
      h("div", { class: "side-foot" },
        h("a", { class: "btn btn-primary btn-new-goal", href: "/workspace#new-task", "data-testid": "btn-new-goal", text: "＋ 新建任务" }),
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
      h("a", { class: "btn btn-primary btn-new-goal-sm", href: "/#new-goal", text: "＋ 新建" }),
    );

    const parent = oldHeader.parentNode;
    parent.insertBefore(sidebar, oldHeader);
    parent.insertBefore(topbar, oldHeader);
    oldHeader.remove();
    document.body.classList.add("shell-on");

    // 高亮当前页
    $$(".side-link", sidebar).forEach(function (a) {
      if (a.getAttribute("data-nav") === active) a.classList.add("active");
      a.addEventListener("click", function () {
        sidebar.classList.remove("open");
      });
    });

    const burger = $("#btn-burger");
    if (burger) {
      burger.addEventListener("click", function () {
        const sb = $("#app-sidebar");
        if (sb) sb.classList.toggle("open");
      });
    }

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

  /** 导航 Badge:各页 refresh 后调用(>0 显示数量,=0 隐藏)。 */
  function setNavCount(kind, n) {
    const el = $("#nav-badge-" + kind);
    if (!el) return;
    const v = Number(n) || 0;
    el.textContent = v > 99 ? "99+" : String(v);
    if (v > 0) el.hidden = false;
    else el.hidden = true;
  }

  // ---------------- 轮询(可见 8s;后台 30s;回前台立即刷) ----------------

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

  // ---------------- 新建需求表单(选项目 → 一句话 → 开始处理) ----------------

  /** 在容器内渲染新建表单;projectPath 由服务端按注册表解析,浏览器零路径输入。
   *  opts.presetProject:渲染后自动选中该项目(项目页内嵌场景)。 */
  function renderGoalForm(opts) {
    const o = opts || {};
    const sel = h("select", { id: o.selectId || "goal-project", "data-testid": o.selectTestId || "goal-project" });
    const ta = h("textarea", {
      id: o.inputId || "goal-input",
      "data-testid": o.inputTestId || "goal-input",
      placeholder: "例如:这个登录页面不太好用,你自己检查一下并改好。",
    });
    const msg = h("span", { class: "small dim", id: o.msgId || "create-msg", "data-testid": o.msgTestId || "create-msg" });
    const btn = h("button", { class: "btn btn-primary btn-lg", id: o.btnId || "btn-create-goal", type: "button", "data-testid": o.btnTestId || "btn-create-goal", text: "开始处理" });
    const note = h(
      "p",
      { class: "small dim mt8" },
      "Relay 会自动理解需求、修改代码、运行测试并交由独立复核;执行范围严格限定在所选项目内。完成后在",
      h("a", { href: "/changeset.html", text: "验收结果" }),
      "查看。",
    );
    const wrap = h(
      "div",
      { class: "goal-form" },
      h("label", { for: o.selectId || "goal-project", text: "选择项目" }),
      sel,
      h("label", { for: o.inputId || "goal-input", text: "用一句话描述你想让 Relay 做的事(说得不完整也没关系)" }),
      ta,
      h("div", { class: "row mt8" }, btn, msg),
      note,
    );

    async function loadProjects() {
      sel.textContent = "";
      let projects = [];
      let configured = true;
      try {
        const res = await apiGet("/api/projects");
        const v = res.projects || {};
        configured = !!v.configured;
        projects = (v.projects || []).filter(function (p) {
          return p && p.name && p.path;
        });
      } catch (e) {
        configured = false;
      }
      if (!projects.length) {
        sel.appendChild(h("option", { value: "", text: configured ? "暂无项目 — 可直接开始(默认工作区)" : "尚未配置项目 — 可直接开始(默认工作区)" }));
      } else {
        sel.appendChild(h("option", { value: "", text: "请选择一个项目" }));
        projects.forEach(function (p) {
          const label = p.name + (p.health === "ok" ? "" : "(目录暂不可用)");
          sel.appendChild(h("option", { value: p.name, text: label }));
        });
        if (o.presetProject) sel.value = o.presetProject;
      }
    }

    async function submit() {
      const raw = ta.value.trim();
      msg.textContent = "";
      if (!raw) {
        msg.textContent = "先写一句你想让 Relay 做的事";
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
    return { wrap: wrap, loadProjects: loadProjects, focus: function () { ta.focus(); }, select: sel };
  }

  /** 页面骨架:未登录 ⇒ 跳登录页。opts.bare = 不注入通用侧栏(工作区页自带三层骨架;WEB-UX-03C)。 */
  async function boot(page, main, opts) {
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
    if (!(opts && opts.bare)) renderShell(page);
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
    zh: zh,
    stateKind: stateKind,
    apiGet: apiGet,
    apiPost: apiPost,
    guarded: guarded,
    setConn: setConn,
    boot: boot,
    state: state,
    poll: poll,
    setNavCount: setNavCount,
    renderGoalForm: renderGoalForm,
  };
})();
