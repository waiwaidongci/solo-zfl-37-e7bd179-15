import { api } from "./api.js";
import { code39Svg } from "./barcode.js";

let lastPrinted = [];

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function printLabels(labels, title = "标签批量打印") {
  if (!labels.length) return alert("没有可打印的标签");
  lastPrinted = labels;
  const area = document.querySelector("#printArea");
  area.innerHTML = `<div class="label-sheet">${labels.map((l) => `
    <div class="label-card">
      <div class="sub">${esc(l.locationName || "")} · ${esc(l.itemCode || "")}</div>
      ${code39Svg(l.code)}
      <div class="code">${esc(l.code)}</div>
    </div>`).join("")}</div>`;
  window.print();
}

async function loadLabels() {
  const locationId = document.querySelector("#labelLocationFilter").value;
  const status = document.querySelector("#labelStatusFilter").value;
  const q = document.querySelector("#labelSearch").value.trim().toUpperCase();
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", locationId);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const labels = await api.get("/api/labels?" + params.toString());
  const tbody = document.querySelector("#labelTable tbody");
  tbody.innerHTML = labels.map((l) => `
    <tr>
      <td><b>${esc(l.code)}</b></td>
      <td>${esc(l.itemCode)}</td>
      <td>${esc(l.locationName || "—")}</td>
      <td><span class="pill ${l.status}">${l.status === "active" ? "活跃" : "作废"}</span></td>
      <td class="admin-only">
        ${l.status === "active"
          ? `<button class="secondary small act-replace" data-code="${esc(l.code)}">换签</button>
             <button class="secondary small act-move" data-code="${esc(l.code)}">移库</button>
             <button class="small act-print" data-code="${esc(l.code)}">补打</button>`
          : (l.replacedBy ? `旧码 → <b>${esc(l.replacedBy)}</b>` : "—")}
      </td>
    </tr>`).join("") || `<tr><td colspan="5" class="meta">暂无标签</td></tr>`;

  tbody.querySelectorAll(".act-replace").forEach((btn) => {
    btn.onclick = () => replaceOrMove(btn.dataset.code, "replace");
  });
  tbody.querySelectorAll(".act-move").forEach((btn) => {
    btn.onclick = () => replaceOrMove(btn.dataset.code, "move");
  });
  tbody.querySelectorAll(".act-print").forEach((btn) => {
    btn.onclick = () => printLabels(labels.filter((l) => l.code === btn.dataset.code));
  });
  window.__currentLabels = labels;
}

async function replaceOrMove(oldCode, kind) {
  const newCode = prompt(
    kind === "replace"
      ? `为 ${oldCode} 换签，输入新短码（大写字母数字，留空取消）：`
      : `将 ${oldCode} 移库并换发新短码，输入新短码：`,
    ""
  );
  if (newCode === null) return;
  if (!newCode.trim()) return;
  try {
    if (kind === "replace") {
      await api.post(`/api/admin/labels/${encodeURIComponent(oldCode)}/replace`, { newCode });
    } else {
      const locations = await api.get("/api/locations");
      const targetName = prompt(
        "移入目标库位（输入名称）：\n" + locations.map((l) => l.name).join("、"), ""
      );
      if (!targetName) return;
      const target = locations.find((l) => l.name === targetName.trim());
      if (!target) return alert("没有该库位");
      await api.post(`/api/admin/labels/${encodeURIComponent(oldCode)}/move`,
        { locationId: target.id, newCode });
    }
    await loadLabels();
    alert("操作成功，旧码已立即作废。");
  } catch (e) {
    alert("操作失败：" + (e.code === "code_already_exists" ? "新短码已存在" : e.message));
  }
}

export async function initLabels(getLocations, refreshHints) {
  const issueForm = document.querySelector("#issueForm");

  function syncCapHint() {
    const locId = document.querySelector("#issueLocation").value;
    const loc = getLocations().find((l) => l.id === locId);
    const hint = document.querySelector("#issueCapHint");
    if (loc) hint.textContent = `剩余容量 ${loc.capacity - loc.used} / ${loc.capacity}`;
  }
  document.querySelector("#issueLocation").onchange = syncCapHint;

  issueForm.onsubmit = async (e) => {
    e.preventDefault();
    await doIssue(false, getLocations, refreshHints);
  };
  document.querySelector("#issueAndPrint").onclick = () => doIssue(true, getLocations, refreshHints);
  document.querySelector("#labelLocationFilter").onchange = loadLabels;
  document.querySelector("#labelStatusFilter").onchange = loadLabels;
  document.querySelector("#labelSearch").oninput = debounce(loadLabels, 250);
  document.querySelector("#printAll").onclick = () => printLabels(window.__currentLabels || []);
  await loadLabels();
  syncCapHint();
}

async function doIssue(withPrint, getLocations, refreshHints) {
  const locationId = document.querySelector("#issueLocation").value;
  const raw = document.querySelector('textarea[name="entries"]').value;
  const entries = raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [itemCode, code] = line.split(/\s+/);
    return code ? { itemCode, code } : { itemCode };
  });
  if (!entries.length) return alert("请填写至少一个墨锭编号");
  try {
    const out = await api.post("/api/admin/labels/issue", { locationId, entries });
    document.querySelector('textarea[name="entries"]').value = "";
    await refreshHints();
    await loadLabels();
    if (withPrint) {
      const locName = getLocations().find((l) => l.id === locationId)?.name;
      printLabels(out.labels.map((l) => ({ ...l, locationName: locName })), "本批标签");
    } else {
      alert(`批次 ${out.batchId} 发放成功，共 ${out.labels.length} 枚。`);
    }
  } catch (e) {
    const map = {
      location_capacity_exceeded: "超过库位容量，整批未发放",
      duplicate_code_in_batch: "本批内短码重复，整批未发放",
      code_already_exists: "短码已存在（含历史作废码不可复用），整批未发放",
      item_already_labeled: "墨锭已有活跃标签，整批未发放",
      item_not_found: "墨锭编号不存在，整批未发放",
      bad_code_format: "短码格式应为 2-16 位大写字母/数字/连字符",
    };
    alert("发放失败：" + (map[e.code] || e.message));
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
