#!/usr/bin node
// 端到端验证：换签 / 错位 / 离线队列只提交一次 / 并发盘点与重复结束 / 写盘失败回滚 / 重启。
// 运行：node test/verify.mjs
import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push(["PASS", name]); console.log("  ✓ " + name); },
    (e) => { results.push(["FAIL", name, e]); console.error("  ✗ " + name, "\n   ", e.message); }
  );
}

const admin = { "Content-Type": "application/json", "X-Role": "admin" };
const jsonC = { "Content-Type": "application/json" };
const BASE = process.env.BASE || "http://127.0.0.1:" + (process.env.PORT || 4099);

async function req(method, p, body, headers = jsonC) {
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}
const idem = (key) => ({ ...jsonC, "Idem-Key": key });
const adminIdem = (key) => ({ ...admin, "Idem-Key": key });

let server;
async function startServer(dbFile, { fault = false } = {}) {
  const env = {
    ...process.env,
    PORT: process.env.PORT || 4099,
    DB_PATH: dbFile,
    ALLOW_FAULT_INJECTION: fault ? "1" : "",
  };
  server = spawn(process.execPath, [path.resolve("server.js")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/api/locations");
      if (r.ok) return { logs, stop: () => new Promise((res) => {
        server.kill("SIGTERM"); server.on("exit", res);
      }) };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("服务器启动超时\n" + logs);
}

async function readDb(dbFile) {
  return JSON.parse(await readFile(dbFile, "utf8"));
}

// ————————————————————————————————————————————————
console.log("\n[准备] 启动服务器（临时数据文件）");
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "inkstock-"));
const dbFile = path.join(tmpDir, "test-db.json");
const svc = await startServer(dbFile, { fault: true });

// 0. 角色与基础数据
await test("非管理员不能建库位（403 admin_only）", async () => {
  const r = await req("POST", "/api/admin/locations", { name: "黑客柜", capacity: 5 });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "admin_only");
});

let locA, locB;
await test("管理员建库位 A/B，含容量上限", async () => {
  let r = await req("POST", "/api/admin/locations", { name: "恒湿柜A", capacity: 2 }, admin);
  assert.equal(r.status, 201); locA = r.data;
  r = await req("POST", "/api/admin/locations", { name: "恒湿柜B", capacity: 50 }, admin);
  assert.equal(r.status, 201); locB = r.data;
});

await test("容量必须≥1，重名被拒", async () => {
  let r = await req("POST", "/api/admin/locations", { name: "X", capacity: 0 }, admin);
  assert.equal(r.status, 400);
  r = await req("POST", "/api/admin/locations", { name: "恒湿柜A", capacity: 3 }, admin);
  assert.equal(r.status, 409);
});

for (const code of ["IS-T1", "IS-T2", "IS-T3"]) {
  await req("POST", "/api/items", { code, smokeSource: "松烟", status: "待试磨" });
}

// 1. 分批发标签 + 短码唯一 + 容量
let batch;
await test("分批发放标签：自动码/指定码混合，全部成功", async () => {
  const r = await req("POST", "/api/admin/labels/issue", {
    locationId: locA.id,
    entries: [{ itemCode: "IS-T1", code: "MQ00101" }, { itemCode: "IS-T2" }],
  }, admin);
  assert.equal(r.status, 201);
  assert.equal(r.data.labels.length, 2);
  batch = r.data;
  assert.ok(/^MQ\d{5}$/.test(r.data.labels[1].code));
});

await test("短码不得重复：复用历史码整批失败；库位容量超限整批失败", async () => {
  let r = await req("POST", "/api/admin/labels/issue", {
    locationId: locB.id, entries: [{ itemCode: "IS-T3", code: "MQ00101" }],
  }, admin);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "code_already_exists");
  // 容量 A=2，已放 2 枚，再发必拒
  r = await req("POST", "/api/admin/labels/issue", {
    locationId: locA.id, entries: [{ itemCode: "IS-T3" }],
  }, admin);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "location_capacity_exceeded");
});

await test("一个墨锭只能有一枚活跃标签", async () => {
  const r = await req("POST", "/api/admin/labels/issue", {
    locationId: locB.id, entries: [{ itemCode: "IS-T1" }],
  }, admin);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "item_already_labeled");
});

// 给 T3 在 B 发一枚（用于错位测试）
await req("POST", "/api/admin/labels/issue", {
  locationId: locB.id, entries: [{ itemCode: "IS-T3", code: "MQ00103" }],
}, admin);

// 2. 换签：旧码作废
const oldCode = "MQ00101";
let newCode;
await test("换签后旧码立即作废，新码活跃且同库位", async () => {
  newCode = "MQ00201";
  const r = await req("POST", `/api/admin/labels/${oldCode}/replace`, { newCode }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.data.voided.status, "void");
  assert.equal(r.data.voided.replacedBy, newCode);
  assert.equal(r.data.active.code, newCode);
  assert.equal(r.data.active.locationId, locA.id);
});

await test("新码重复被拒；对已作废码再换签被拒", async () => {
  let r = await req("POST", `/api/admin/labels/MQ00201/replace`, { newCode: "MQ00103" }, admin);
  assert.equal(r.status, 409);
  r = await req("POST", `/api/admin/labels/${oldCode}/replace`, { newCode: "MQ00999" }, admin);
  assert.equal(r.status, 409, "void 再换签应 409");
});

// 3. 盘点：开始、扫码分类
let session;
await test("开始盘点（库位A）", async () => {
  const r = await req("POST", "/api/sessions", { locationId: locA.id, counter: "张三", clientKey: "dev-1" });
  assert.equal(r.status, 201);
  session = r.data;
});

await test("同一库位并发开始盘点只有一个成功（同 clientKey 幂等复用，不同 clientKey 409）", async () => {
  const [a, b, c] = await Promise.all([
    req("POST", "/api/sessions", { locationId: locA.id, counter: "张三", clientKey: "dev-1" }),
    req("POST", "/api/sessions", { locationId: locA.id, counter: "李四", clientKey: "dev-2" }),
    req("POST", "/api/sessions", { locationId: locA.id, counter: "王五", clientKey: "dev-3" }),
  ]);
  assert.equal(a.status, 200, "同 key 重试幂等 200");
  assert.equal(a.data.id, session.id);
  assert.equal(b.status, 409);
  assert.equal(b.data.error, "session_already_open");
  assert.equal(c.status, 409);
});

const k1 = "evt-1", k1b = "evt-1";
await test("扫新码=在位；扫旧码被拒并指出当前库位", async () => {
  let r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: newCode, eventKey: k1 });
  assert.equal(r.status, 201);
  assert.equal(r.data.scan.category, "match");

  r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: oldCode, eventKey: "evt-old" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "void_code_rejected");
  assert.equal(r.data.currentCode, newCode);
  assert.equal(r.data.currentLocationName, "恒湿柜A");
});

await test("重复扫同一码=重复条目", async () => {
  const r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: newCode, eventKey: "evt-2" });
  assert.equal(r.status, 201);
  assert.equal(r.data.scan.category, "duplicate");
  assert.equal(r.data.summary.duplicate, 1);
});

await test("未知码单独分类", async () => {
  const r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: "ZZZZZZ", eventKey: "evt-3" });
  assert.equal(r.status, 201);
  assert.equal(r.data.scan.category, "unknown");
});

await test("错位：扫到库位B的标签，提示应在位置", async () => {
  const r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: "MQ00103", eventKey: "evt-4" });
  assert.equal(r.status, 201);
  assert.equal(r.data.scan.category, "misplaced");
  assert.equal(r.data.scan.expectedLocationName, "恒湿柜B");
});

// 4. 离线重放：同一 eventKey 多次提交只入账一次
await test("断网恢复后重放：相同 eventKey 只提交一次（幂等，不计重复）", async () => {
  const before = (await req("GET", `/api/sessions/${session.id}`)).data.summary;
  // 模拟队列重传同一扫码 3 次（还带通用 HTTP 幂等键）
  const rs = await Promise.all([1, 2, 3].map(() =>
    req("POST", `/api/sessions/${session.id}/scans`,
      { code: "MQ00103", eventKey: "evt-4" }, idem("http-evt-4"))));
  assert.ok(rs.every((r) => r.status === 200));
  assert.ok(rs.every((r) => r.data.replayed === true));
  const after = (await req("GET", `/api/sessions/${session.id}`)).data.summary;
  assert.deepEqual(after, before, "重放不得改变任何计数");
});

// 5. 结束盘点：并发/重复只成功一次，差异冻结
let reportAtFinish;
await test("并发结束盘点：只有一个成功", async () => {
  const rs = await Promise.all(["f1", "f2", "f3"].map((k) =>
    req("POST", `/api/sessions/${session.id}/finish`, { idemKey: k }, idem(k))));
  const ok = rs.filter((r) => r.status === 200 && r.data.frozen);
  assert.equal(ok.length, 1);
  const rejected = rs.filter((r) => r !== ok[0]);
  assert.ok(rejected.every((r) => r.status === 409 && r.data.error === "already_finished"));
  reportAtFinish = ok[0].data;
});

await test("重复结束（同一 idemKey）返回同一份冻结报告；不同 key 被拒", async () => {
  const same = await req("POST", `/api/sessions/${session.id}/finish`,
    { idemKey: "f1" }, idem("f1"));
  assert.equal(same.status, 200);
  assert.equal(same.data.finishedAt, reportAtFinish.finishedAt);
  const other = await req("POST", `/api/sessions/${session.id}/finish`,
    { idemKey: "other" });
  assert.equal(other.status, 409);
  assert.equal(other.data.error, "already_finished");
});

await test("差异清单内容：漏扫/错位/未知/重复分类正确", async () => {
  const r = reportAtFinish;
  assert.equal(r.frozen, true);
  // 库位 A 基线应有 T2 自动码一枚（T1 换签后仍在 A）；扫到了 newCode(T1)，漏 T2
  const codes = [newCode, batch.labels[1].code];
  assert.ok(r.missing.some((m) => m.code === batch.labels[1].code), "T2 漏扫");
  assert.deepEqual(r.misplaced.map((m) => m.code), ["MQ00103"]);
  assert.deepEqual(r.unknown, ["ZZZZZZ"]);
  assert.deepEqual(r.duplicates.map((d) => d.code), [newCode]);
  assert.equal(r.duplicates[0].extraTimes, 1, "多扫 1 次");
  assert.equal(r.counts.match, 1);
});

await test("结束后再扫码被拒（409 session_closed），差异不变", async () => {
  const r = await req("POST", `/api/sessions/${session.id}/scans`,
    { code: batch.labels[1].code, eventKey: "evt-late" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "session_closed");
  const again = await req("GET", `/api/sessions/${session.id}`);
  assert.equal(again.data.report.finishedAt, reportAtFinish.finishedAt);
});

// 7. 容量/删除约束（此时库位 A 在用 2 枚）
await test("容量不能下调到在用数以下；非空库位不能删", async () => {
  let r = await req("PATCH", `/api/admin/locations/${locA.id}`, { capacity: 1 }, admin);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "capacity_below_used");
  r = await req("DELETE", `/api/admin/locations/${locA.id}`, undefined, admin);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "location_not_empty");
});

// 8. 结束后换签/移库，冻结报告不得改变
await test("结束后移库/换签，冻结的差异清单不变", async () => {
  await req("POST", `/api/admin/labels/${newCode}/move`,
    { locationId: locB.id, newCode: "MQ00301" }, admin);
  const r = await req("GET", `/api/sessions/${session.id}`);
  assert.equal(r.data.report.locationName, "恒湿柜A");
  assert.deepEqual(r.data.report.misplaced.map((m) => m.code), ["MQ00103"]);
  assert.equal(r.data.report.scannedUnique.includes(newCode), true);
  assert.equal(r.data.report.finishedAt, reportAtFinish.finishedAt);
  // 旧新码都已作废，扫旧码要指出当前库位=B
  const look = await req("GET", `/api/lookup?code=${newCode}`);
  assert.equal(look.data.status, "void");
  assert.equal(look.data.currentLocationName, "恒湿柜B");
  assert.equal(look.data.currentCode, "MQ00301");
});

// 9. 写盘失败回滚：不留半条数据
await test("写盘失败时整笔回滚：标签/库位/扫描/差异不留半条", async () => {
  await req("POST", "/api/items", { code: "IS-T4", smokeSource: "油烟", status: "待试磨" });
  const before = await readDb(dbFile);
  // 8a 发标签：校验全部通过后在写盘阶段失败
  await req("POST", "/api/test/arm-write-failure", {}, admin);
  let r = await req("POST", "/api/admin/labels/issue", {
    locationId: locB.id, entries: [{ itemCode: "IS-T4", code: "MQ07777" }],
  }, admin);
  assert.equal(r.status, 500);
  assert.match(r.data.detail || r.data.error || "", /INJECTED_WRITE_FAILURE/);
  // 8b 建库位失败
  await req("POST", "/api/test/arm-write-failure", {}, admin);
  r = await req("POST", "/api/admin/locations", { name: "幻影柜", capacity: 9 }, admin);
  assert.equal(r.status, 500);
  // 8c 扫码失败：先在 B 开个盘点
  const open = await req("POST", "/api/sessions", { locationId: locB.id, clientKey: "dev-b" });
  const sid = open.data.id;
  await req("POST", "/api/test/arm-write-failure", {}, admin);
  r = await req("POST", `/api/sessions/${sid}/scans`, { code: "MQ00103", eventKey: "rollback-1" });
  assert.equal(r.status, 500);
  // 8d 结束盘点失败
  await req("POST", "/api/test/arm-write-failure", {}, admin);
  r = await req("POST", `/api/sessions/${sid}/finish`, { idemKey: "rb-finish" });
  assert.equal(r.status, 500);

  const after = await readDb(dbFile);
  // 磁盘上的文件必须与故障前逐字节级一致（JSON 结构一致、无幻影数据、无半截事件）
  assert.equal(after.locations.length, before.locations.length);
  assert.ok(!after.locations.some((l) => l.name === "幻影柜"));
  assert.equal(after.labels.length, before.labels.length);
  assert.ok(!after.labels.some((l) => l.code === "MQ07777"));
  const s = after.sessions.find((x) => x.id === sid);
  assert.equal(s.events.length, 0, "失败的扫码不得留下事件");
  assert.equal(s.status, "open", "失败的结束不得改状态");
  assert.equal(s.report, null, "失败的结束不得留差异记录");
  // 盘点 B 仍然可用（服务存活、锁已释放）
  const ok = await req("POST", `/api/sessions/${sid}/scans`, { code: "MQ00103", eventKey: "after-rb-1" });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.scan.category, "match");
});

// 10. 重启持久化
await test("重启服务：标签/库位/盘点/冻结差异全部保留", async () => {
  await svc.stop();
  await startServer(dbFile);
  const locs = await req("GET", "/api/locations");
  assert.ok(locs.data.some((l) => l.name === "恒湿柜A"));
  const labels = await req("GET", "/api/labels?status=void");
  assert.ok(labels.data.some((l) => l.code === oldCode));
  const s = await req("GET", `/api/sessions/${session.id}`);
  assert.equal(s.data.status, "finished");
  assert.equal(s.data.report.frozen, true);
  assert.deepEqual(s.data.report.misplaced.map((m) => m.code), ["MQ00103"]);
  assert.equal(s.data.report.finishedAt, reportAtFinish.finishedAt);
  // 重启后旧库位 A 仍不能并发开新盘点以外……A 的盘点是 finished，可以开新的一轮
  const reopen = await req("POST", "/api/sessions", { locationId: locA.id, clientKey: "dev-x" });
  assert.equal(reopen.status, 201);
});

// 11. 页面与静态资源
await test("首页与前端模块可访问（手机视口标签页存在）", async () => {
  const home = await fetch(BASE + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /viewport-fit/);
  assert.match(html, /盘点台/);
  for (const f of ["/js/app.js", "/js/stocktake.js", "/js/barcode.js", "/styles.css"]) {
    const r = await fetch(BASE + f);
    assert.equal(r.status, 200, f);
  }
});

await svc.stop();
await rm(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error("\n失败项：");
  for (const [, name, e] of failed) console.error(" -", name, "\n   ", e.stack);
  process.exit(1);
}
console.log("全部验证通过：换签 / 错位 / 离线只提交一次 / 并发与重复结束 / 写盘回滚 / 重启 ✔");
