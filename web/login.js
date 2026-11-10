// 登录页(P0-02C G-2)。口令只在提交瞬间离开浏览器一次(POST /api/session)。
(function () {
  "use strict";
  const btn = document.getElementById("btn-login");
  const input = document.getElementById("password");
  const err = document.getElementById("login-error");

  async function submit() {
    err.textContent = "";
    btn.disabled = true;
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ password: input.value }),
      });
      const body = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        err.textContent = body.error === "locked_out" ? "登录暂时锁定,请稍后再试" : "登录失败:" + (body.error || res.status);
        return;
      }
      window.location.href = "/";
    } catch (e) {
      err.textContent = "无法连接服务器:" + ((e && e.message) || e);
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submit();
  });
})();
