import { setRole } from "./api.js";
import { initItems } from "./items.js";
import {
  initLocations, loadLocations, getLocations, renderLocationSelectors,
} from "./locations.js";
import { initLabels } from "./labels.js";
import { initStocktake, refreshStocktakeLocations } from "./stocktake.js";

const $ = (s) => document.querySelector(s);

function applyRole(role) {
  document.body.classList.toggle("role-counter", role === "counter");
  document.body.classList.toggle("role-admin", role === "admin");
  localStorage.setItem("inkstock.role", role);
  setRole(role);
}

// 数据变化后同步各页的库位下拉与容量提示
async function refreshAll() {
  const locs = await loadLocations();
  renderLocationSelectors(locs);
  refreshStocktakeLocations(locs);
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

  initItems(refreshAll);
  initLocations(refreshAll);
  await initLabels(getLocations, refreshAll);
  initStocktake(getLocations);
  await refreshAll();
}

boot().catch((e) => {
  const t = document.querySelector("#toast");
  t.textContent = "初始化失败：" + (e.message || e);
  t.classList.remove("hidden");
  t.classList.add("error");
});
