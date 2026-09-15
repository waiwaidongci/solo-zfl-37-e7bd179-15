import { setRole } from "./api.js";
import { initItems } from "./items.js";
import {
  initLocations, loadLocations, getLocations, renderLocationSelectors,
} from "./locations.js";
import { initLabels } from "./labels.js";
import { initStocktake, refreshStocktakeLocations } from "./stocktake.js";

const $ = (s) => document.querySelector(s);
const toastEl = () => $("#toast");
function showError(msg) {
  const t = toastEl();
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  t.classList.add("error");
  setTimeout(() => t.classList.add("hidden"), 6000);
}

function applyRole(role) {
  document.body.classList.toggle("role-counter", role === "counter");
  document.body.classList.toggle("role-admin", role === "admin");
  localStorage.setItem("inkstock.role", role);
  setRole(role);
}

// 数据变化后同步各页的库位下拉与容量提示；失败不影响盘点台自身功能
async function refreshAll() {
  try {
    const locs = await loadLocations();
    renderLocationSelectors(locs);
    refreshStocktakeLocations(locs);
  } catch (e) {
    console.error("库位数据加载失败", e);
  }
}

function switchTab(tab) {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("hidden", v.dataset.view !== tab));
  if (tab === "locations" || tab === "labels" || tab === "stocktake") refreshAll();
  if (tab === "stocktake") setTimeout(() => $("#scanInput")?.focus(), 50);
}

async function boot() {
  const role = localStorage.getItem("inkstock.role") || "counter";
  $("#roleSelect").value = role;
  applyRole(role);
  $("#roleSelect").onchange = (e) => applyRole(e.target.value);
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  // 盘点台优先初始化：它独立加载历史、注册网络/离线队列监听，
  // 任何其他模块的失败都不能阻断它
  try {
    initStocktake(getLocations);
  } catch (e) {
    console.error("盘点台初始化失败", e);
    showError("盘点台初始化失败：" + (e && e.message ? e.message : e));
  }

  // 其余模块逐个隔离，单点失败不拖垮整页
  try { initItems(refreshAll); } catch (e) { console.error("墨锭页初始化失败", e); showError("墨锭页初始化失败"); }
  try { initLocations(refreshAll); } catch (e) { console.error("库位页初始化失败", e); showError("库位页初始化失败"); }
  try { await initLabels(getLocations, refreshAll); } catch (e) { console.error("标签页初始化失败", e); showError("标签页初始化失败"); }
  await refreshAll();
}

boot().catch((e) => {
  console.error("初始化失败", e);
  showError("初始化失败：" + (e && e.message ? e.message : e));
});
