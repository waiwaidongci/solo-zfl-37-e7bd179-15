#!/usr/bin node
// 浏览器端到端：真实加载并执行页面脚本，桌面与手机（iPhone 视口）各跑一遍，覆盖
// 初始化不报错 / 盘点历史直接显示 / 网络指示 / 断网本地排队→恢复自动重放且同一条只入账一次，
// 以及页面上的换签旧码拒绝、错位分类、结束冻结、批量打印。
// 运行：npm run verify:ui
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = Number(process.env.PORT || 0);
// PORT=0 时由内核分配空闲端口，spawn 后从监听日志/探测中拿不到，故这里预占一个空闲口
import net from "node:net";
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
const actualPort = PORT || (await pickFreePort());
const BASE = "http://127.0.0.1:" + actualPort;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push(["PASS", name]); console.log("  ✓ " + name); },
    (e) => { results.push(["FAIL", name, e]); console.error("  ✗ " + name + "\n    " + e.message); }
  );
}

let server;
async function startServer(dbFile) {
  server = spawn(process.execPath, [path.resolve("server.js")], {
    env: { ...process.env, PORT: String(actualPort), DB_PATH: dbFile, ALLOW_FAULT_INJECTION: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stderr.on("data", (d) => (logs += d));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + "/api/locations")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("服务器启动超时\n" + logs);
}

const admin = { "Content-Type": "application/json", "X-Role": "admin" };
async function api(method, p, body, role = "admin") {
  const res = await fetch(BASE + p, {
    method,
    headers: role === "admin" ? admin : { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { tries = 50, every = 150 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (e) { err = e; }
    await sleep(every);
  }
  throw err || new Error("poll timeout");
}
const dispatchOnline = (page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

async function currentSessionId(locationId) {
  const sessions = await (await fetch(BASE + "/api/sessions")).json();
  const s = sessions.find((x) => x.locationId === locationId);
  return s ? s.id : null;
}

// —— 起服务；造一条打开页面就应直接显示的「已结束」历史盘点 ——
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ink-ui-"));
const dbFile = path.join(tmpDir, "ui-db.json");
await startServer(dbFile);

const histLoc = (await api("POST", "/api/admin/locations", { name: "历史样盒", capacity: 10 })).data;
{
  const s = await api("POST", "/api/sessions", { locationId: histLoc.id, counter: "预置盘点", clientKey: "pre" }, "counter");
  await api("POST", `/api/sessions/${s.data.id}/finish`, { idemKey: "pre-fin" }, "counter");
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

async function runScenario(label, context, tag) {
  await context.addInitScript(() => localStorage.setItem("inkstock.role", "admin"));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // 业务 4xx（如旧码 409）浏览器会自动打一条资源加载错误，属预期，不计为脚本缺陷
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text())) {
      pageErrors.push("console: " + m.text());
    }
  });

  // 每个场景独立的库位与编码前缀，避免两个场景相互干扰
  const locA = (await api("POST", "/api/admin/locations", { name: "盘点柜" + tag, capacity: 10 })).data;
  const locB = (await api("POST", "/api/admin/locations", { name: "错位柜" + tag, capacity: 10 })).data;
  const c1 = tag + "A001", c2 = tag + "A002", cb = tag + "B001", cnew = tag + "A020", cprint = tag + "PRT1";
  for (const code of [c1, c2, cb, cprint]) await api("POST", "/api/items", { code, status: "待试磨" });
  await api("POST", "/api/admin/labels/issue", {
    locationId: locA.id,
    entries: [{ itemCode: c1, code: c1 }, { itemCode: c2, code: c2 }],
  });

  await test(`[${label}] 页面初始化正常完成（无失败提示、无脚本错误）`, async () => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await sleep(400);
    const toast = await page.$eval("#toast", (el) => el.textContent.trim());
    assert.ok(!/初始化失败/.test(toast), "不应出现初始化失败，实际：" + toast);
    assert.equal(pageErrors.length, 0, "页面脚本错误：" + pageErrors.join(" | "));
  });

  await test(`[${label}] 盘点历史打开页面即直接显示（预置的已结束盘点）`, async () => {
    await page.click('.tabs button[data-tab="stocktake"]');
    const hist = await poll(() => page.$eval("#sessionHistory", (el) =>
      el.textContent.includes("历史样盒") ? el.textContent.replace(/\s+/g, " ") : null));
    assert.match(hist, /已结束/);
    assert.match(hist, /预置盘点/);
  });

  await test(`[${label}] 网络状态指示初始在线`, async () => {
    assert.match(await page.$eval("#netDot", (el) => el.className), /online/);
  });

  // —— 页面上开始盘点（切换标签会异步刷新下拉，先等目标库位选项就位）——
  await poll(() => page.$eval("#scanLocation", (el, id) =>
    [...el.options].some((o) => o.value === id), locA.id));
  await page.selectOption("#scanLocation", locA.id);
  await page.fill("#counterName", label + "盘点员");
  await page.click("#startSession");
  await page.waitForSelector("#sessionInfo:not(.hidden)");

  await test(`[${label}] 扫码四分类：在位 / 重复 / 未知 / 错位`, async () => {
    await page.fill("#scanInput", c1); await page.press("#scanInput", "Enter");
    await poll(() => page.$eval("#cntMatch", (el) => el.textContent === "1"));

    await page.fill("#scanInput", c1); await page.press("#scanInput", "Enter");
    await poll(() => page.$eval("#cntDuplicate", (el) => el.textContent === "1"));

    await page.fill("#scanInput", tag + "UNKNOWN"); await page.press("#scanInput", "Enter");
    await poll(() => page.$eval("#cntUnknown", (el) => el.textContent === "1"));

    await api("POST", "/api/admin/labels/issue", { locationId: locB.id, entries: [{ itemCode: cb, code: cb }] });
    await page.fill("#scanInput", cb); await page.press("#scanInput", "Enter");
    await poll(() => page.$eval("#cntMisplaced", (el) => el.textContent === "1"));
    const fb = await page.$eval("#scanFeedback", (el) => el.textContent.replace(/\s+/g, " "));
    assert.match(fb, new RegExp("应在\\s*错位柜" + tag));
  });

  await test(`[${label}] 换签后扫旧码被拒，指出当前库位与有效码`, async () => {
    const rep = await api("POST", `/api/admin/labels/${c2}/replace`, { newCode: cnew });
    assert.equal(rep.status, 200);
    await page.fill("#scanInput", c2); await page.press("#scanInput", "Enter");
    const fb = await poll(() => page.$eval("#scanFeedback", (el) =>
      el.textContent.includes("已作废") ? el.textContent.replace(/\s+/g, " ") : null));
    assert.match(fb, new RegExp("当前库位：\\s*盘点柜" + tag));
    assert.match(fb, new RegExp(cnew));
    assert.equal(await page.$eval("#cntMatch", (el) => el.textContent), "1"); // 拒绝入账
  });

  await test(`[${label}] 断网扫码本地排队；恢复后自动重放，同一条只入账一次`, async () => {
    await context.setOffline(true);
    await poll(() => page.$eval("#netDot", (el) => el.className.includes("offline")));

    await page.fill("#scanInput", cnew); await page.press("#scanInput", "Enter");
    await poll(() => page.$eval("#queueCount", (el) => el.textContent === "1"));

    // 离线时服务端绝不可能收到这条
    await sleep(300);

    await context.setOffline(false);
    // 不点击「立即重传」：仅派发浏览器 online 事件，必须自动提交
    await dispatchOnline(page);
    await poll(() => page.$eval("#queueBox", (el) => el.classList.contains("hidden")));
    await poll(() => page.$eval("#cntMatch", (el) => el.textContent === "2"));

    // 浏览器重复派发 online（含 15s 兜底之外的抖动）不得重复入账
    await dispatchOnline(page); await dispatchOnline(page);
    await sleep(500);
    assert.equal(await page.$eval("#cntMatch", (el) => el.textContent), "2");
    assert.equal(await page.$eval("#cntDuplicate", (el) => el.textContent), "1");

    // 服务端核对：离线码恰有一条 match 事件
    const sessions = await (await fetch(BASE + "/api/sessions")).json();
    const open = sessions.find((s) => s.status === "open" && s.locationId === locA.id);
    const detail = await (await fetch(BASE + "/api/sessions/" + open.id)).json();
    const evts = detail.events.filter((e) => e.code === cnew);
    assert.equal(evts.length, 1, "离线扫码只入账一次");
    assert.equal(evts[0].category, "match");
  });

  await test(`[${label}] 结束盘点→差异冻结；结束后扫码被拒；刷新后历史可回看同一份`, async () => {
    page.once("dialog", (d) => d.accept());
    await page.click("#finishSession");
    await poll(() => page.$eval("#reportBox", (el) => el.textContent.includes("已冻结")));
    const reportText = () => page.$eval("#reportBox", (el) => el.textContent.replace(/\s+/g, " "));
    assert.match(await reportText(), /错位（扫到的标签属于别的库位）（1）/);
    assert.match(await reportText(), /未知条码（系统无此标签）（1）/);

    // 结束后：页面把扫码框锁死（禁用），结束按钮也禁用
    assert.equal(await page.$eval("#scanInput", (el) => el.disabled), true);
    assert.equal(await page.$eval("#finishSession", (el) => el.disabled), true);

    // 服务端兜底：直接向已结束盘点 POST 扫码必须 409 session_closed
    const late = await api("POST", "/api/sessions/" + (await currentSessionId(locA.id)) + "/scans",
      { code: c1, eventKey: "late-1" }, "counter");
    assert.equal(late.status, 409);
    assert.equal(late.data.error, "session_closed");
    assert.ok(late.data.report && late.data.report.frozen);

    // 刷新后历史里能打开同一份冻结报告
    const finAt = late.data.report.finishedAt;

    await page.reload({ waitUntil: "networkidle" });
    await sleep(300);
    await page.click('.tabs button[data-tab="stocktake"]');
    await poll(() => page.$eval("#sessionHistory", (el, name) =>
      el.textContent.includes(name) ? true : null, "盘点柜" + tag));
    await page.click(`.sess-row:has-text("盘点柜${tag}") [data-view-report]`);
    const again = await poll(() => page.$eval("#reportBox", (el) =>
      el.textContent.includes("已冻结") ? el.textContent.replace(/\s+/g, " ") : null));
    assert.match(again, /错位（扫到的标签属于别的库位）（1）/);
    // 报告仍是同一份冻结快照（结束时间不变）
    const detailAfter = await api("GET", "/api/sessions/" + (await currentSessionId(locA.id)), null, "counter");
    assert.equal(detailAfter.data.report.finishedAt, finAt);
  });

  await test(`[${label}] 发放并批量打印：打印区生成 Code39 条码标签`, async () => {
    await page.evaluate(() => { window.print = () => {}; });
    await page.click('.tabs button[data-tab="labels"]');
    // 等目标库位选项出现后再选择、填写
    await poll(() => page.$eval("#issueLocation", (el, id) =>
      [...el.options].some((o) => o.value === id), locB.id));
    await page.selectOption("#issueLocation", locB.id);
    const ta = page.locator('textarea[name="entries"]');
    await ta.waitFor({ state: "visible" });
    await ta.fill(cprint + " " + cprint);
    await page.click("#issueAndPrint");
    const hasSvg = await poll(() => page.$eval("#printArea", (el, code) =>
      el.textContent.includes(code) && !!el.querySelector("svg"), cprint));
    assert.ok(hasSvg);
    // 打印区里应有可渲染的 Code39 条码（<rect>）
    const rects = await page.$$eval("#printArea svg rect", (els) => els.length);
    assert.ok(rects > 10);
  });

  assert.equal(pageErrors.length, 0, "全程页面脚本错误：" + pageErrors.join(" | "));
  await page.close();
}

console.log("\n[桌面 Chromium 1280x900]");
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await runScenario("桌面", context, "D");
}
console.log("\n[手机 iPhone 视口]");
{
  const context = await browser.newContext(devices["iPhone 13"]);
  await runScenario("手机", context, "M");
}

await browser.close();
server.kill("SIGTERM");
await rm(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const [, name, e] of failed) console.error("FAIL -", name, "\n", e.stack);
  process.exit(1);
}
console.log("浏览器验证通过：初始化 / 历史显示 / 断网恢复自动重放且一次 / 换签 / 错位 / 冻结 / 打印（桌面+手机）✔");
