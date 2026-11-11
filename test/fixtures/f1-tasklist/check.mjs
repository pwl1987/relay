// F1 确定性可用性检查(机判;候选面外工具 —— 由仓库侧运行,检查目标=argv[2] 工作区)。
// 用法:node check.mjs <workspaceDir>(在候选工作区内跑:node check.mjs .)
// 判定标准(可判定验收,改进前必失败/改进后须通过):
//   C1 每个 input 都有关联 label(for/id 或包裹);
//   C2 必填项为空提交时,页面出现可见的错误提示(不静默);
//   C3 合法提交后,页面出现可见的成功反馈(文案含"成功"或"已添加");
//   C4 列表页(index.html)在提交后能看到新条目标题。
// 输出 JSON 结果到 stdout;exit 0 = 全过。
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url); // 以本脚本真实位置(仓库内)解析 playwright
const { chromium } = require("playwright");

const ws = process.argv[2] ? new URL(`file://${process.argv[2] === "." ? process.cwd() : process.argv[2]}`).pathname : process.cwd();
const checks = [];
const add = (id, ok, note) => checks.push({ id, ok, note });

function mime(p) {
  return { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[extname(p)] ?? "application/octet-stream";
}
const root = ws;
const server = createServer((req, res) => {
  const p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(join(root, p));
    res.writeHead(200, { "content-type": mime(p) });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = mkdtempSync(join((await import("node:os")).tmpdir(), "f1-check-"));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/new-task.html`);

  // C1:label 关联
  const inputs = await page.locator("form input").all();
  let labeled = 0;
  for (const inp of inputs) {
    const id = await inp.getAttribute("id");
    const name = await inp.getAttribute("name");
    let ok = false;
    if (id) ok = (await page.locator(`label[for="${id}"]`).count()) > 0;
    if (!ok && name) {
      ok = await page.locator(`xpath=//label[.//input[@name="${name}"]]`).count() > 0;
    }
    if (ok) labeled++;
  }
  add("C1-label", inputs.length > 0 && labeled === inputs.length, `${labeled}/${inputs.length} 个 input 有关联 label`);

  // C2:空提交 → 可见错误提示
  await page.locator("form button[type=submit], form button").first().click();
  await sleep(300);
  const errText = await page.evaluate(() => document.body.innerText);
  const errVisible = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".error, [role=alert], .invalid-feedback, [data-error]")];
    return els.some(e => e.offsetParent !== null && e.textContent.trim().length > 0);
  });
  add("C2-empty-feedback", errVisible, errVisible ? "空提交出现可见错误提示" : "空提交无可见错误提示(静默)");

  // C3:合法提交 → 成功反馈
  const fill = async (sel, v) => { const el = page.locator(`form input[name=${JSON.stringify(sel)}]`); if (await el.count()) await el.fill(v); };
  await fill("title", "写阶段 D 报告");
  await fill("owner", "owner");
  await fill("due", "2026-12-01");
  await page.locator("form button[type=submit], form button").first().click();
  await sleep(500);
  const bodyText = await page.evaluate(() => document.body.innerText);
  add("C3-success-feedback", /成功|已添加|添加成功/.test(bodyText), bodyText.includes("成功") || bodyText.includes("已添加") ? "提交后出现成功反馈" : "提交后无成功反馈");

  // C4:列表页可见新条目(localStorage 同源)
  await page.goto(`${base}/index.html`);
  await sleep(300);
  const listText = await page.evaluate(() => document.body.innerText);
  add("C4-list-shows", listText.includes("写阶段 D 报告"), listText.includes("写阶段 D 报告") ? "列表页显示新条目" : "列表页未显示新条目");
} catch (e) {
  add("unexpected", false, String(e && e.stack ? e.stack : e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
const okAll = checks.every(c => c.ok);
console.log(JSON.stringify({ ok: okAll, checks }));
process.exit(okAll ? 0 : 1);
