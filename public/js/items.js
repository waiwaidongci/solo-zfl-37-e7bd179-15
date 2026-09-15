import { api } from "./api.js";

const fields = [
  ["code", "墨锭编号", "text"],
  ["smokeSource", "烟料来源", "text"],
  ["glueRatio", "胶料比例", "text"],
  ["ageYears", "存放年限", "number"],
];
const stages = ["待试磨", "已试磨", "重点观察"];
const extraFields = [
  ["paper", "试磨纸张"], ["water", "加水量"], ["speed", "出墨速度"],
  ["colorLayer", "墨色层次"], ["sediment", "沉淀情况"], ["score", "评分"],
];

let items = [];

function cardHtml(item) {
  const main = fields.map(([key, label]) =>
    `<div><b>${label}</b> ${item[key] ?? ""}</div>`).join("");
  const logs = (item.logs || []).slice(-4)
    .map((l) => `<div>${l.step}：${l.note}</div>`).join("");
  return `<article class="card">
    <h3 style="margin:0">${item.code || item.id}</h3>
    <span class="pill">${item.status || ""}</span>
    ${main}
    <label>状态</label>
    <select data-status="${item.code || item.id}">
      ${stages.map((s) => `<option ${s === item.status ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <button class="secondary small" data-note="${item.code || item.id}">追加备注</button>
    <div class="logs meta">${logs || "暂无记录"}</div>
  </article>`;
}

function render() {
  document.querySelector("#itemSelect").innerHTML = items
    .map((item) => `<option value="${item.code || item.id}">${item.code || item.id} · ${item.smokeSource || ""}</option>`)
    .join("");
  const stats = Object.fromEntries(stages.map((s) => [s, 0]));
  items.forEach((i) => { if (stats[i.status] !== undefined) stats[i.status]++; });
  document.querySelector("#stats").innerHTML = Object.entries(stats)
    .map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");
  const status = document.querySelector("#statusFilter").value;
  const q = document.querySelector("#search").value.trim();
  const visible = items.filter(
    (item) => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q))
  );
  document.querySelector("#cards").innerHTML = visible.map(cardHtml).join("");

  document.querySelectorAll("[data-status]").forEach((sel) => {
    sel.onchange = async () => {
      await api.patch("/api/items/" + encodeURIComponent(sel.dataset.status), { status: sel.value });
      load();
    };
  });
  document.querySelectorAll("[data-note]").forEach((btn) => {
    btn.onclick = async () => {
      const note = prompt("记录备注");
      if (note) {
        await api.post("/api/items/" + encodeURIComponent(btn.dataset.note) + "/logs", { step: "备注", note });
        load();
      }
    };
  });
}

async function load() {
  items = await api.get("/api/items");
  render();
}

export function initItems(refreshHints) {
  document.querySelector("#itemFields").innerHTML = fields
    .map(([key, label, type]) =>
      `<label>${label}</label><input name="${key}" type="${type}" ${key === "code" ? "required" : ""}>`).join("");
  document.querySelector("#itemStatus").innerHTML = stages.map((s) => `<option>${s}</option>`).join("");
  document.querySelector("#extraFields").innerHTML = extraFields
    .map(([key, label]) => `<label>${label}</label><input name="${key}">`).join("");
  document.querySelector("#statusFilter").innerHTML =
    `<option value="">全部状态</option>` + stages.map((s) => `<option>${s}</option>`).join("");

  const createForm = document.querySelector("#createForm");
  const actionForm = document.querySelector("#actionForm");
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(createForm).entries());
    try {
      await api.post("/api/items", data);
      createForm.reset();
      await load();
      refreshHints && refreshHints();
    } catch (err) {
      alert("保存失败：" + err.message + (err.code === "item_code_exists" ? "（编号已存在）" : ""));
    }
  };
  actionForm.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(actionForm).entries());
    await api.post("/api/items/" + encodeURIComponent(data.id) + "/action", data);
    actionForm.reset();
    load();
  };
  document.querySelector("#statusFilter").onchange = render;
  document.querySelector("#search").oninput = render;
  document.querySelector("#reloadItems").onclick = load;
  load();
}
