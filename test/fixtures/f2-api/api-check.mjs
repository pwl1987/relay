// F2 确定性检查(机判;候选面外工具 —— 由仓库侧运行,检查目标=argv[2] 工作区)。
// 用法:node api-check.mjs <workspaceDir>
// 判定(改进前必失败/改进后须通过):
//   A1 POST /api/divide {a:1,b:0} → 400 且 {"error":"division_by_zero"}(不 500/不崩);
//   A2 POST /api/divide {a:"x",b:2} → 400 {"error":"invalid_input"}(不 NaN/null);
//   A3 POST /api/divide {a:9,b:3} → 200 {"result":3}(正常路径不回归);
//   A4 GET /api/health → 200 {ok:true}。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = process.argv[2] === "." ? process.cwd() : process.argv[2] ?? process.cwd();
const checks = [];
const add = (id, ok, note) => checks.push({ id, ok, note });
const tmp = mkdtempSync(join(tmpdir(), "f2-check-"));

async function call(port, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    signal: AbortSignal.timeout(5000),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

const proc = spawn(process.execPath, [join(ws, "server.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
let port = null;
proc.stdout.on("data", (d) => {
  const m = String(d).match(/F2API_PORT=(\d+)/);
  if (m) port = Number(m[1]);
});
await new Promise((r) => setTimeout(r, 800));
try {
  if (port === null) throw new Error("server 未输出 F2API_PORT(可能启动即崩)");

  const a1 = await call(port, "POST", "/api/divide", { a: 1, b: 0 });
  add("A1-zero", a1.status === 400 && a1.json?.error === "division_by_zero", `b=0 ⇒ ${a1.status} ${JSON.stringify(a1.json)}(期望 400 division_by_zero;服务器存活=${!proc.killed})`);

  const a2 = await call(port, "POST", "/api/divide", { a: "x", b: 2 });
  add("A2-nan", a2.status === 400 && a2.json?.error === "invalid_input", `非数字 ⇒ ${a2.status} ${JSON.stringify(a2.json)}(期望 400 invalid_input)`);

  const a3 = await call(port, "POST", "/api/divide", { a: 9, b: 3 });
  add("A3-normal", a3.status === 200 && a3.json?.result === 3, `9/3 ⇒ ${a3.status} ${JSON.stringify(a3.json)}`);

  const a4 = await call(port, "GET", "/api/health");
  add("A4-health", a4.status === 200 && a4.json?.ok === true, `health ⇒ ${a4.status} ${JSON.stringify(a4.json)}`);
} catch (e) {
  add("unexpected", false, String(e && e.stack ? e.stack : e).slice(0, 400));
} finally {
  proc.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}
const okAll = checks.every(c => c.ok);
console.log(JSON.stringify({ ok: okAll, checks }));
process.exit(okAll ? 0 : 1);
