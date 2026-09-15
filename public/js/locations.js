import { api } from "./api.js";

let locations = [];

export function getLocations() { return locations; }

export async function loadLocations() {
  locations = await api.get("/api/locations");
  renderLocations();
  return locations;
}

function renderLocations() {
  const el = document.querySelector("#locList");
  if (!el) return;
  el.innerHTML = locations.map((l) => {
    const pct = l.capacity ? Math.min(100, Math.round((l.used / l.capacity) * 100)) : 0;
    return `<div class="loc-item" data-id="${l.id}">
      <div><b>${l.name}</b> <span class="meta">${l.id}</span></div>
      <div class="cap-bar"><i class="${pct >= 100 ? "full" : ""}" style="width:${pct}%"></i></div>
      <div class="meta">${l.used}/${l.capacity}</div>
      <input class="loc-cap-input" type="number" min="1" value="${l.capacity}" style="width:84px" aria-label="改容量">
      <button class="secondary small loc-save">保存</button>
      <button class="danger small loc-del">删除</button>
    </div>`;
  }).join("") || `<div class="meta">暂无库位</div>`;

  el.querySelectorAll(".loc-item").forEach((row) => {
    const id = row.dataset.id;
    const loc = locations.find((l) => l.id === id);
    row.querySelector(".loc-save").onclick = async () => {
      const capacity = Number(row.querySelector(".loc-cap-input").value);
      try {
        await api.patch("/api/admin/locations/" + encodeURIComponent(id), { capacity });
        await loadLocations();
      } catch (e) {
        alert("修改失败：" + hint(e));
      }
    };
    row.querySelector(".loc-del").onclick = async () => {
      if (!confirm(`删除库位「${loc.name}」？`)) return;
      try {
        await api.del("/api/admin/locations/" + encodeURIComponent(id));
        await loadLocations();
      } catch (e) {
        alert("删除失败：" + hint(e));
      }
    };
  });
}

function hint(e) {
  if (e.code === "capacity_below_used")
    return `容量不能低于在用标签数（当前 ${e.data.used}）`;
  if (e.code === "location_not_empty")
    return `库位内还有 ${e.data.used} 枚活跃标签，不能删除`;
  if (e.code === "location_has_open_session")
    return "该库位有进行中的盘点，不能删除";
  return e.message;
}

export function renderLocationSelectors(locations) {
  const opts = locations.map((l) => `<option value="${l.id}">${l.name}（${l.used}/${l.capacity}）</option>`).join("");
  const issue = document.querySelector("#issueLocation");
  const scan = document.querySelector("#scanLocation");
  // 重建选项前先记住用户已选库位；重建后若该库位仍然有效则重新应用，
  // 避免异步刷新把刚选中的值清空（手机上开始盘点竞态的根因）。
  if (issue) {
    const previous = issue.value;
    issue.innerHTML = opts;
    if (previous && locations.some((l) => l.id === previous)) issue.value = previous;
    issue.dispatchEvent(new Event("change"));
  }
  if (scan) {
    const previous = scan.value;
    scan.innerHTML = `<option value="">请选择库位…</option>` + opts;
    if (previous && locations.some((l) => l.id === previous)) scan.value = previous;
  }
}

export function initLocations(refreshHints) {
  document.querySelector("#locForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post("/api/admin/locations", {
        name: fd.get("name"), capacity: Number(fd.get("capacity")),
      });
      e.target.reset();
      await loadLocations();
      refreshHints && refreshHints();
    } catch (err) {
      alert("建立失败：" + (err.code === "location_name_exists" ? "库位名称已存在" : err.message));
    }
  };
  loadLocations();
}
