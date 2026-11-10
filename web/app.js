// Relay 最小 Web 控制台共享前端(P0-02C)。
// 约束:
//  - 零构建、无第三方脚本(CSP script-src 'self');所有渲染用 DOM API(textContent),
//    **不使用 innerHTML** ⇒ 用户输入(Goal 原文等)不会变成可执行标记;
//  - 前端不持有业务状态:每次渲染都从 /api 取;连接中断时显示"无法核实"横幅 +
//    最后一次成功读取的时间戳,绝不把陈旧数据伪装成实时(G-7);
//  - 写操作统一带 x-relay-csrf(服务端双提交校验)。
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

  function renderHeader(active) {
    const host = $("#app-header");
    if (!host) return;
    host.textContent = "";
    const nav = h(
      "nav",
      { class: "nav" },
      h("a", { class: "nav-link" + (active === "dashboard" ? " active" : ""), href: "/", text: "Dashboard" }),
      h("a", { class: "nav-link" + (active === "goal" ? " active" : ""), href: "/goal.html", text: "Goal" }),
      h("a", { class: "nav-link" + (active === "decisions" ? " active" : ""), href: "/decisions.html", text: "Decision Inbox" }),
      h("a", { class: "nav-link" + (active === "changeset" ? " active" : ""), href: "/changeset.html", text: "ChangeSet / Evidence" }),
    );
    const right = h(
      "div",
      { class: "header-right" },
      h("span", { id: "whoami", class: "whoami", text: state.role ? "身份:" + state.role : "" }),
      h("button", { id: "btn-logout", class: "btn btn-ghost", type: "button", text: "退出登录" }),
    );
    host.appendChild(h("div", { class: "header-left" }, h("span", { class: "brand", text: "Relay 控制台" }), nav));
    host.appendChild(right);
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
    renderHeader(page);
    setConn(null);
    updateStamp();
    await main();
  }

  window.RelayApp = {
    h: h,
    $: $,
    $$: $$,
    fmtTime: fmtTime,
    short: short,
    badge: badge,
    stateKind: stateKind,
    apiGet: apiGet,
    apiPost: apiPost,
    guarded: guarded,
    setConn: setConn,
    boot: boot,
    state: state,
  };
})();
