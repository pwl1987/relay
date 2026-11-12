// RELAY-MVP-READINESS-01 子包①:VM80 生产实例 Chromium 双端冒烟(1440×900 + 390×844)。
// 只读冒烟:登录→工作台→打开验收演练 Goal→Feed/详情/抽屉/sheet;Composer 仅键入不发送(零模型消耗)。
// 口令从 0600 文件读取,零打印。输出:本目录 shots/*.png + smoke-results.json。
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.SMOKE_BASE || "http://10.30.5.80:8787";
const PW_FILE = process.env.SMOKE_PW_FILE || "/home/ubuntu/.relay/credentials/web-password";
const GOAL = process.env.SMOKE_GOAL || "goal-73d01da0-7a59-41b3-8c6d-62c7f252377c";
const BLOCKED_GOAL = process.env.SMOKE_GOAL2 || "goal-1332f8d7-9521-4b53-b192-d3030dfc4ee8";
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

const password = readFileSync(PW_FILE, "utf8").trim();
const results = { base: BASE, steps: [], pageErrors: [], shots: [] };
const step = (name, ok, detail = "") => {
  results.steps.push({ name, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const shot = async (page, name) => {
  const f = join(SHOTS, name + ".png");
  await page.screenshot({ path: f, fullPage: false });
  results.shots.push(name + ".png");
};

async function login(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 15000 });
  if (!page.url().includes("login")) return; // 已有会话
  await page.fill("#password", password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL(/workspace/, { timeout: 10000 });
}

async function assertWorkspace(page, tag) {
  await page.waitForSelector("#ws-layout", { timeout: 10000 });
  const title = await page.title();
  step(tag + " workspace 标题=Relay · 工作区(03D)", title.includes("工作区"), title);
}

async function openGoal(page, goalId) {
  await page.click('[data-testid="ws-goal-row-' + goalId + '"]');
  await page.waitForSelector("#ws-composer textarea, textarea", { timeout: 10000 });
  await page.waitForTimeout(400);
}

const desktop = await chromium.launch();
try {
  // ---------- 桌面 1440×900 ----------
  const dctx = await desktop.newContext({ viewport: { width: 1440, height: 900 } });
  dctx.on("pageerror", (e) => results.pageErrors.push("desktop:" + String(e).slice(0, 200)));
  const d = await dctx.newPage();
  await login(d);
  step("desktop 登录→/workspace", d.url().includes("/workspace"), d.url());
  await assertWorkspace(d, "desktop");
  // 侧栏有验收演练 Goal
  await d.waitForSelector('[data-testid="ws-goal-row-' + GOAL + '"]', { timeout: 10000 });
  step("desktop 侧栏含验收演练 Goal", true);
  await shot(d, "d-01-workspace-blank");
  // 打开会话
  await openGoal(d, GOAL);
  const feedText = await d.textContent("body");
  step("desktop 会话含需求原文", feedText.includes("项目简介"), "");
  await shot(d, "d-02-conversation");
  // BLOCKED Goal 的失败工作块(Result/失败 UX 真证据)+ 桌面 pane 技术详情
  await openGoal(d, BLOCKED_GOAL);
  const failBtn = await d.$('[data-testid="ws-fail-reason"]');
  step("desktop BLOCKED Goal 失败工作块含「查看原因」", !!failBtn);
  await shot(d, "d-03-result-blocked");
  const paneToggle = await d.$("#ws-pane-toggle");
  if (paneToggle) { await paneToggle.click(); await d.waitForTimeout(300); }
  await shot(d, "d-04-tech-pane");
  await dctx.close();

  // ---------- 移动 390×844 ----------
  const mctx = await desktop.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
  });
  mctx.on("pageerror", (e) => results.pageErrors.push("mobile:" + String(e).slice(0, 200)));
  const m = await mctx.newPage();
  await login(m);
  step("mobile 登录→/workspace", m.url().includes("/workspace"), m.url());
  await assertWorkspace(m, "mobile");
  // 顶栏:menu 可见;工程 stamp 隐藏(≤900px)
  const menuVisible = await m.isVisible("#ws-menu-btn");
  step("mobile 顶栏菜单键可见", menuVisible);
  const stampHidden = await m.isHidden("#ws-stamp");
  step("mobile 工程 stamp 隐藏", stampHidden);
  await shot(m, "m-01-topbar");
  // 抽屉开→截图→关闭回原上下文
  await m.click("#ws-menu-btn");
  await m.waitForTimeout(350);
  const cls1 = await m.getAttribute("#ws-layout", "class");
  step("mobile 抽屉打开", String(cls1).includes("ws-drawer-open"));
  await shot(m, "m-02-drawer");
  await m.click("#ws-backdrop", { position: { x: 370, y: 400 }, force: true });
  await m.waitForTimeout(350);
  const cls2 = await m.getAttribute("#ws-layout", "class");
  step("mobile 抽屉关闭(回原上下文)", !String(cls2).includes("ws-drawer-open"));
  // 打开验收演练会话
  await m.click("#ws-menu-btn");
  await m.waitForTimeout(350);
  await m.click('[data-testid="ws-goal-row-' + GOAL + '"]');
  await m.waitForTimeout(400);
  await m.keyboard.press("Escape");
  await m.waitForTimeout(350);
  const cls3 = await m.getAttribute("#ws-layout", "class");
  step("mobile 选中 Goal 后抽屉已关", !String(cls3).includes("ws-drawer-open"));
  const feedTextM = await m.textContent("body");
  step("mobile 会话含需求原文", feedTextM.includes("项目简介"));
  await shot(m, "m-03-conversation");
  // 技术详情 sheet:经 BLOCKED Goal 失败块「查看原因」触发(mobile toggleTech→openSheet)
  await m.click("#ws-menu-btn");
  await m.waitForTimeout(350);
  await m.click('[data-testid="ws-goal-row-' + BLOCKED_GOAL + '"]');
  await m.waitForTimeout(400);
  await m.keyboard.press("Escape");
  await m.waitForTimeout(350);
  const failBtnM = await m.$('[data-testid="ws-fail-reason"]');
  if (failBtnM && await failBtnM.isVisible()) {
    await failBtnM.click();
    await m.waitForTimeout(350);
    step("mobile 失败块「查看原因」→技术详情 sheet", await m.isVisible("#ws-sheet"));
    await shot(m, "m-04-tech-sheet");
    const closeBtn = await m.$("#ws-sheet-close");
    if (closeBtn) { await closeBtn.click(); await m.waitForTimeout(250); }
    step("mobile sheet 关闭", !(await m.isVisible("#ws-sheet")));
  } else {
    step("mobile 失败块「查看原因」存在", false, "未找到,如实记录");
  }
  // Composer 可键入(不发送=零模型消耗)
  const composer = await m.$("#ws-composer textarea, textarea");
  if (composer) {
    await composer.fill("移动端冒烟键入验证(未发送)");
    const v = await composer.inputValue();
    step("mobile Composer 可键入(未发送)", v.includes("未发送"));
  } else {
    step("mobile Composer 存在", false);
  }
  // 回到最新浮层标记存在
  step("mobile 回到最新浮层元素在 DOM", !!(await m.$("#ws-jump-latest")));
  await shot(m, "m-05-composer-typed");
  await mctx.close();
} finally {
  await desktop.close();
}

results.pass = results.steps.filter((s) => s.ok).length;
results.fail = results.steps.filter((s) => !s.ok).length;
writeFileSync(join(HERE, "smoke-results.json"), JSON.stringify(results, null, 2));
console.log(`----\nPASS=${results.pass} FAIL=${results.fail} shots=${results.shots.length} pageErrors=${results.pageErrors.length}`);
process.exit(results.fail === 0 && results.pageErrors.length === 0 ? 0 : 2);
