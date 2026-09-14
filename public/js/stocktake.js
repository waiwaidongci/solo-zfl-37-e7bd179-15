import {
  api, uuid, isOnline, enqueueScan, queueLength,
  flushQueue, on as onQueue, initConnectivity,
} from "./api.js";

const PENDING_FINISH_KEY = "inkstock.pendingFinish.v1";
const CATEGORY_LABEL = { match: "在位", duplicate: "重复", unknown: "未知", misplaced: "错位" };

let current = null; // 进行中的盘点会话
let locations = [];
let detector = null;
let videoStream = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function clientKey() {
  let k = localStorage.getItem("inkstock.clientKey");
  if (!k) { k = uuid(); localStorage.setItem("inkstock.clientKey", k); }
  return k;
}

function feedback(category, html) {
  const box = $("#scanFeedback");
  const div = document.createElement("div");
  div.className = "fb " + category;
  div.innerHTML = html;
  box.prepend(div);
  while (box.children.length > 6) box.lastChild.remove();
}

function renderQueue() {
  const n = queueLength();
  $("#queueBox").classList.toggle("hidden", n === 0);
  $("#queueCount").textContent = n;
}

function renderSummary(summary) {
  const cells = [
    ["扫码总次数", summary.totalEvents],
    ["在位", summary.match],
    ["重复", summary.duplicate],
    ["未知", summary.unknown],
    ["错位", summary.misplaced],
  ];
  $("#progressGrid").innerHTML = cells
    .map(([k, v]) => `<div class="pcell"><b>${v}</b><span class="meta">${k}</span></div>`).join("");
  $("#cntMatch").textContent = summary.match;
  $("#cntDuplicate").textContent = summary.duplicate;
  $("#cntUnknown").textContent = summary.unknown;
  $("#cntMisplaced").textContent = summary.misplaced;
}

function renderEventLists(events) {
  const buckets = { match: [], duplicate: [], unknown: [], misplaced: [] };
  for (const e of events || []) buckets[e.category]?.push(e);
  const li = (e) =>
    `<li><b>${esc(e.code)}</b>${e.itemCode ? " · " + esc(e.itemCode) : ""}${
      e.category === "misplaced" ? ` <span class="meta">应在 ${esc(e.expectedLocationName)}</span>` : ""
    }</li>`;
  $("#listMatch").innerHTML = buckets.match.map(li).join("");
  $("#listDuplicate").innerHTML = buckets.duplicate.map(li).join("");
  $("#listUnknown").innerHTML = buckets.unknown.map(li).join("");
  $("#listMisplaced").innerHTML = buckets.misplaced.map(li).join("");
}

async function refreshSession() {
  if (!current) return;
  const s = await api.get("/api/sessions/" + current.id);
  current = s;
  if (s.status === "finished") {
    showReport(s.report);
    lockSession(s);
    return;
  }
  renderSummary(s.summary);
  renderEventLists(s.events);
}

function lockSession(s) {
  $("#sessionInfo").classList.remove("hidden");
  $("#sessionInfo").innerHTML = `盘点 <b>${esc(s.id)}</b> 已结束，差异清单已冻结，不再接受扫码。`;
  $("#finishSession").disabled = true;
  $("#scanInput").disabled = true;
  current = { ...s, status: "finished" };
}

function showReport(r) {
  const box = $("#reportBox");
  box.classList.remove("hidden");
  box.classList.add("frozen");
  const sec = (title, rows, empty = "无") =>
    `<h3>${title}（${rows.length}）</h3>${rows.length ? rows.join("") : `<div class="meta">${empty}</div>`}`;
  box.innerHTML = `
    <h2>差异清单 · ${esc(r.locationName)} 🔒 ${r.frozen ? "已冻结" : ""}</h2>
    <div class="meta">盘点 ${esc(r.sessionId)} · 完成于 ${new Date(r.finishedAt).toLocaleString()} · 基线应有 ${r.expectedCount}，扫到唯一条码 ${r.counts.uniqueCount}</div>
    <div class="progress-grid" style="margin-top:10px">
      <div class="pcell"><b>${r.counts.match}</b><span class="meta">在位</span></div>
      <div class="pcell"><b>${r.counts.misplaced}</b><span class="meta">错位</span></div>
      <div class="pcell"><b>${r.counts.duplicate}</b><span class="meta">重复</span></div>
      <div class="pcell"><b>${r.counts.unknown}</b><span class="meta">未知</span></div>
      <div class="pcell"><b>${r.missing.length}</b><span class="meta">漏扫</span></div>
    </div>
    ${sec("漏扫（库位应有但没扫到）", r.missing.map((m) =>
      `<div class="diff-line"><span>${esc(m.code)} · ${esc(m.itemCode)}</span><span class="meta">在库</span></div>`))}
    ${sec("错位（扫到的标签属于别的库位）", r.misplaced.map((m) =>
      `<div class="diff-line"><span>${esc(m.code)} · ${esc(m.itemCode)}</span><span class="meta">应在：${esc(m.belongsTo)}</span></div>`))}
    ${sec("未知条码（系统无此标签）", r.unknown.map((c) =>
      `<div class="diff-line"><span>${esc(c)}</span><span class="meta">查无此码</span></div>`))}
    ${sec("重复扫码", r.duplicates.map((d) =>
      `<div class="diff-line"><span>${esc(d.code)}</span><span class="meta">多扫 ${d.extraTimes} 次</span></div>`))}
  `;
}

async function handleScan(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) return;
  $("#scanInput").value = "";
  if (!current || current.status !== "open") {
    feedback("error", "请先选择库位并开始盘点");
    return;
  }
  const eventKey = uuid(); // 一次扫码一个稳定身份：重连重放时服务端只入账一次

  const submit = async () => {
    const out = await api.post(
      `/api/sessions/${current.id}/scans`,
      { code, eventKey },
      { idemKey: "scan-" + eventKey }
    );
    return out;
  };

  try {
    let out;
    if (isOnline()) {
      try {
        out = await submit();
      } catch (e) {
        if (e.network) {
          enqueueScan(current.id, code, eventKey);
          feedback("queued", `📵 离线：<b>${esc(code)}</b> 已本地排队（${queueLength()}）`);
          renderQueue();
          return;
        }
        throw e;
      }
    } else {
      enqueueScan(current.id, code, eventKey);
      feedback("queued", `📵 离线：<b>${esc(code)}</b> 已本地排队（${queueLength()}）`);
      renderQueue();
      return;
    }

    if (out.replayed) feedback("duplicate", `重复提交已忽略：<b>${esc(code)}</b>（${CATEGORY_LABEL[out.scan.category]}）`);
    else feedback(out.scan.category, scanHtml(out.scan));
    await refreshSession();
  } catch (e) {
    if (e.data && e.data.code === "void_code_rejected") {
      feedback("void",
        `⛔ 旧码 <b>${esc(code)}</b> 已作废，拒绝入账。当前库位：<b>${esc(e.data.currentLocationName || "未知")}</b>` +
        (e.data.currentCode ? `，有效码：<b>${esc(e.data.currentCode)}</b>` : ""));
    } else if (e.data && e.data.code === "session_closed") {
      feedback("error", "盘点已结束，扫码被拒绝");
      if (e.data.report) showReport(e.data.report);
      lockSession({ id: current.id, status: "finished" });
    } else {
      feedback("error", "扫码失败：" + esc(e.message));
    }
  }
}

function scanHtml(s) {
  switch (s.category) {
    case "match": return `✅ <b>${esc(s.code)}</b> · ${esc(s.itemCode)} 在位`;
    case "duplicate": return `🔁 <b>${esc(s.code)}</b> 重复扫码`;
    case "unknown": return `❓ <b>${esc(s.code)}</b> 未知条码`;
    case "misplaced": return `⚠️ <b>${esc(s.code)}</b> 错位，应在 ${esc(s.expectedLocationName)}`;
    default: return esc(s.code);
  }
}

async function start() {
  const locationId = $("#scanLocation").value;
  if (!locationId) return alert("请选择库位");
  try {
    const s = await api.post("/api/sessions",
      { locationId, counter: $("#counterName").value, clientKey: clientKey() });
    // 服务端按 clientKey 识别断网重试（复用），按库位互斥拒绝他人并发；幂等键每次点击随机
    current = s;
    $("#sessionInfo").classList.remove("hidden");
    $("#sessionInfo").innerHTML = `盘点中：<b>${esc(s.locationName)}</b> · ${esc(s.id)} · ${esc(s.counter || "未署名")}`;
    $("#finishSession").disabled = false;
    $("#scanInput").disabled = false;
    $("#scanInput").focus();
    renderSummary(s.summary);
    renderEventLists(s.events);
    $("#reportBox").classList.add("hidden");
  } catch (e) {
    if (e.data && e.data.code === "session_already_open") {
      alert("该库位已有进行中的盘点（可能是其他盘点人发起）。同一库位并发盘点只允许一个，请先结束它。");
    } else alert("开始失败：" + e.message);
  }
}

function finishIdemKey(sessionId) {
  const all = JSON.parse(localStorage.getItem(PENDING_FINISH_KEY) || "{}");
  if (!all[sessionId]) {
    all[sessionId] = uuid();
    localStorage.setItem(PENDING_FINISH_KEY, JSON.stringify(all));
  }
  return all[sessionId];
}

async function finish() {
  if (!current || current.status !== "open") return;
  if (!confirm("结束本次盘点？结束后差异清单立即冻结，不能再扫码。")) return;
  const idemKey = finishIdemKey(current.id);

  const doFinish = async () => {
    const report = await api.post(`/api/sessions/${current.id}/finish`,
      { idemKey }, { idemKey: "finish-" + idemKey });
    return report;
  };

  try {
    if (queueLength()) {
      const r = await flushQueue(async () => { await refreshSession(); });
      feedback("queued", `重连后提交了 ${r.flushed} 条离线扫码`);
    }
    const report = await doFinish();
    showReport(report);
    lockSession({ id: current.id, status: "finished" });
    clearPendingFinish(current.id);
    await loadHistory(locations);
  } catch (e) {
    if (e.network) {
      // 离线：登记待结束，联网后自动、只结束一次
      const all = JSON.parse(localStorage.getItem(PENDING_FINISH_KEY) || "{}");
      all[current.id] = idemKey;
      localStorage.setItem(PENDING_FINISH_KEY, JSON.stringify(all));
      feedback("queued", "📵 离线：结束请求已排队，恢复联网后自动提交，只生效一次");
    } else if (e.data && e.data.code === "already_finished") {
      showReport(e.data.report);
      lockSession({ id: current.id, status: "finished" });
    } else alert("结束失败：" + e.message);
  }
}

function clearPendingFinish(sessionId) {
  const all = JSON.parse(localStorage.getItem(PENDING_FINISH_KEY) || "{}");
  delete all[sessionId];
  localStorage.setItem(PENDING_FINISH_KEY, JSON.stringify(all));
}

async function onReconnect() {
  if (!isOnline()) return;
  if (queueLength() && current) {
    const r = await flushQueue(null);
    feedback("queued", `网络恢复：提交 ${r.flushed} 条离线扫码，每条仅入账一次`);
    await refreshSession();
  }
  // 离线期间排队的「结束盘点」
  const pending = JSON.parse(localStorage.getItem(PENDING_FINISH_KEY) || "{}");
  for (const [sessionId, idemKey] of Object.entries(pending)) {
    try {
      const report = await api.post(`/api/sessions/${sessionId}/finish`,
        { idemKey }, { idemKey: "finish-" + idemKey });
      showReport(report);
      if (current && current.id === sessionId) lockSession({ id: sessionId, status: "finished" });
      clearPendingFinish(sessionId);
      await loadHistory(locations);
    } catch (e) {
      if (!e.network && e.data && e.data.code === "already_finished") {
        showReport(e.data.report);
        clearPendingFinish(sessionId);
      }
    }
  }
  renderQueue();
}

async function loadHistory(locs) {
  const sessions = await api.get("/api/sessions");
  $("#sessionHistory").innerHTML = sessions.map((s) => {
    const counts = s.summary || s.report?.counts;
    return `<div class="sess-row">
      <b>${esc(s.locationName || s.locationId)}</b>
      <span>${esc(s.id)}</span>
      <span class="pill ${s.status === "finished" ? "void" : "active"}">${s.status === "finished" ? "已结束" : "进行中"}</span>
      <span class="meta">${new Date(s.startedAt).toLocaleString()}${s.counter ? " · " + esc(s.counter) : ""}</span>
      <span class="meta">${counts ? `在位${counts.match} 重复${counts.duplicate} 未知${counts.unknown} 错位${counts.misplaced}` : ""}</span>
      <button class="secondary small" data-view-report="${s.id}">${s.status === "finished" ? "查看冻结差异" : "继续盘点"}</button>
    </div>`;
  }).join("");
  $("#sessionHistory").querySelectorAll("[data-view-report]").forEach((btn) => {
    btn.onclick = async () => {
      const s = sessions.find((x) => x.id === btn.dataset.viewReport);
      if (s.status === "open") {
        current = s;
        $("#scanLocation").value = s.locationId;
        $("#sessionInfo").classList.remove("hidden");
        $("#sessionInfo").innerHTML = `盘点中：<b>${esc(s.locationName)}</b> · ${esc(s.id)}`;
        $("#finishSession").disabled = false;
        $("#scanInput").disabled = false;
        renderSummary(s.summary);
        renderEventLists(s.events);
        $("#reportBox").classList.add("hidden");
        $("#scanInput").focus();
      } else {
        showReport(s.report);
      }
    };
  });
}

// —— 摄像头扫码（支持 BarcodeDetector 的浏览器，主要是安卓 Chromium）——
async function toggleCamera() {
  const video = $("#camVideo");
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
    video.classList.add("hidden");
    return;
  }
  if (!("BarcodeDetector" in window)) {
    alert("当前浏览器不支持摄像头识别，请使用扫码枪或手动输入短码。");
    return;
  }
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false,
    });
    video.srcObject = videoStream;
    await video.play();
    video.classList.remove("hidden");
    detector = detector || new window.BarcodeDetector({
      formats: ["code_39", "code_128", "qr_code", "ean_13", "ean_8"],
    });
    let last = "";
    const tick = async () => {
      if (!videoStream) return;
      try {
        const codes = await detector.detect(video);
        const value = codes[0]?.rawValue?.trim().toUpperCase();
        if (value && value !== last) { last = value; await handleScan(value); setTimeout(() => (last = ""), 1200); }
      } catch {}
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    alert("摄像头不可用：" + e.message);
  }
}

export function initStocktake(getLocations) {
  locations = getLocations();
  $("#startSession").onclick = start;
  $("#finishSession").onclick = finish;
  $("#camBtn").onclick = toggleCamera;
  $("#queueFlush").onclick = onReconnect;
  $("#scanInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(e.target.value);
    }
  });

  onQueue(renderQueue);
  initConnectivity(onReconnect);
  renderQueue();
  loadHistory(locations);
  // 网络指示
  const dot = $("#netDot");
  const paintDot = (online) => {
    dot.classList.toggle("online", online);
    dot.classList.toggle("offline", !online);
    dot.title = online ? "在线" : "离线（本地排队）";
  };
  window.addEventListener("online", () => paintDot(true));
  window.addEventListener("offline", () => paintDot(false));
  paintDot(isOnline());
}

export function refreshStocktakeLocations(locs) {
  locations = locs;
}
