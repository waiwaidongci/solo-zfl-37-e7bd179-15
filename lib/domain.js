// 领域规则：库位容量、标签短码唯一性/作废、盘点分类、并发与幂等。
// 所有函数都在 store.transaction 内调用，直接修改传入的 db 对象。

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function nextSeq(db) {
  db.seq = (db.seq || 0) + 1;
  return db.seq;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}
export function assertCodeFormat(code) {
  if (!CODE_RE.test(code)) {
    throw new HttpError(400, "bad_code_format", {
      hint: "短码需为 2-16 位大写字母、数字或连字符",
    });
  }
}

export function listLocations(db) {
  return db.locations.map((l) => ({
    ...l,
    used: activeLabelCount(db, l.id),
  }));
}

export function activeLabelCount(db, locationId) {
  return db.labels.filter(
    (l) => l.status === "active" && l.locationId === locationId
  ).length;
}

export function createLocation(db, { name, capacity }) {
  name = String(name || "").trim();
  capacity = Math.floor(Number(capacity));
  if (!name) throw new HttpError(400, "location_name_required");
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new HttpError(400, "bad_capacity");
  if (db.locations.some((l) => l.name === name))
    throw new HttpError(409, "location_name_exists");
  const loc = {
    id: "LOC" + String(nextSeq(db)).padStart(5, "0"),
    name,
    capacity,
    createdAt: nowIso(),
  };
  db.locations.push(loc);
  return { ...loc, used: 0 };
}

export function updateLocation(db, id, patch) {
  const loc = db.locations.find((l) => l.id === id);
  if (!loc) throw new HttpError(404, "location_not_found");
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new HttpError(400, "location_name_required");
    if (db.locations.some((l) => l.name === name && l.id !== id))
      throw new HttpError(409, "location_name_exists");
    loc.name = name;
  }
  if (patch.capacity !== undefined) {
    const capacity = Math.floor(Number(patch.capacity));
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new HttpError(400, "bad_capacity");
    const used = activeLabelCount(db, id);
    if (capacity < used)
      throw new HttpError(409, "capacity_below_used", { used, capacity });
    loc.capacity = capacity;
  }
  return { ...loc, used: activeLabelCount(db, id) };
}

export function deleteLocation(db, id) {
  const loc = db.locations.find((l) => l.id === id);
  if (!loc) throw new HttpError(404, "location_not_found");
  const used = activeLabelCount(db, id);
  if (used > 0) throw new HttpError(409, "location_not_empty", { used });
  if (db.sessions.some((s) => s.locationId === id && s.status === "open"))
    throw new HttpError(409, "location_has_open_session");
  db.locations = db.locations.filter((l) => l.id !== id);
  return { ok: true };
}

function findLabelByCode(db, code) {
  return db.labels.find((l) => l.code === code) || null;
}

function codeTaken(db, code, exceptId) {
  return db.labels.some((l) => l.code === code && l.id !== exceptId);
}

function genLabelCode(db) {
  // MQ + 5 位流水；容量耗尽时继续加长，绝不与历史（含作废）短码重复
  let code;
  do {
    const seq = nextSeq(db);
    code = "MQ" + String(seq).padStart(5, "0");
  } while (findLabelByCode(db, code));
  return code;
}

// 分批发标签：一次调用要么全部成功，要么（含写盘失败）整体不留数据
export function issueLabels(db, { locationId, entries }) {
  const loc = db.locations.find((l) => l.id === locationId);
  if (!loc) throw new HttpError(404, "location_not_found");
  if (!Array.isArray(entries) || entries.length === 0)
    throw new HttpError(400, "entries_required");

  const picked = [];
  const seenCodes = new Set();
  for (const e of entries) {
    const itemCode = String(e.itemCode || "").trim();
    const item = db.items.find((i) => i.code === itemCode);
    if (!item) throw new HttpError(404, "item_not_found", { itemCode });
    if (
      db.labels.some((l) => l.itemCode === itemCode && l.status === "active")
    )
      throw new HttpError(409, "item_already_labeled", { itemCode });

    let code = normalizeCode(e.code);
    if (!code) code = genLabelCode(db);
    assertCodeFormat(code);
    if (seenCodes.has(code))
      throw new HttpError(409, "duplicate_code_in_batch", { code });
    if (findLabelByCode(db, code))
      throw new HttpError(409, "code_already_exists", { code });
    seenCodes.add(code);
    picked.push({ code, itemCode, item });
  }

  if (activeLabelCount(db, locationId) + picked.length > loc.capacity)
    throw new HttpError(409, "location_capacity_exceeded", {
      capacity: loc.capacity,
      used: activeLabelCount(db, locationId),
      requested: picked.length,
    });

  const batchId = "B" + String(nextSeq(db)).padStart(6, "0");
  const issuedAt = nowIso();
  const created = picked.map(({ code, itemCode }) => {
    const label = {
      code,
      itemCode,
      locationId,
      status: "active",
      issuedAt,
      batchId,
    };
    db.labels.push(label);
    // 墨锭的存放位置文本与库位保持一致
    const item = db.items.find((i) => i.code === itemCode);
    if (item) item.storage = loc.name;
    return label;
  });
  return { batchId, locationId, labels: created };
}

export function listLabels(db, { status, locationId, q } = {}) {
  const locName = (id) => db.locations.find((l) => l.id === id)?.name || null;
  return db.labels
    .filter((l) => !status || l.status === status)
    .filter((l) => !locationId || l.locationId === locationId)
    .filter((l) => {
      if (!q) return true;
      return l.code.includes(q) || l.itemCode.includes(q);
    })
    .map((l) => ({ ...l, locationName: locName(l.locationId) }));
}

// 换签：旧码立即作废，新码生效；扫旧码时可指出当前库位但拒绝入账
export function replaceLabel(db, oldCode, newCodeRaw) {
  oldCode = normalizeCode(oldCode);
  const old = findLabelByCode(db, oldCode);
  if (!old) throw new HttpError(404, "label_not_found", { code: oldCode });
  if (old.status !== "active")
    throw new HttpError(409, "label_not_active", { code: oldCode });

  const newCode = normalizeCode(newCodeRaw);
  if (!newCode) throw new HttpError(400, "new_code_required");
  if (newCode === oldCode) throw new HttpError(400, "same_code");
  assertCodeFormat(newCode);
  if (findLabelByCode(db, newCode))
    throw new HttpError(409, "code_already_exists", { code: newCode });

  old.status = "void";
  old.voidedAt = nowIso();
  old.voidReason = "replaced";
  old.replacedBy = newCode;

  const label = {
    code: newCode,
    itemCode: old.itemCode,
    locationId: old.locationId,
    status: "active",
    issuedAt: nowIso(),
    batchId: "REPLACE",
  };
  db.labels.push(label);
  return {
    voided: { ...old, locationName: locNameOf(db, old.locationId) },
    active: { ...label, locationName: locNameOf(db, label.locationId) },
  };
}

// 移库：旧码立即作废并换发新码（旧码指向新库位），目标库位做容量校验
export function moveLabel(db, oldCode, targetLocationId, newCodeRaw) {
  oldCode = normalizeCode(oldCode);
  const old = findLabelByCode(db, oldCode);
  if (!old) throw new HttpError(404, "label_not_found", { code: oldCode });
  if (old.status !== "active")
    throw new HttpError(409, "label_not_active", { code: oldCode });
  const target = db.locations.find((l) => l.id === targetLocationId);
  if (!target) throw new HttpError(404, "location_not_found");
  if (target.id === old.locationId)
    throw new HttpError(400, "same_location");
  if (activeLabelCount(db, target.id) + 1 > target.capacity)
    throw new HttpError(409, "location_capacity_exceeded", {
      capacity: target.capacity,
      used: activeLabelCount(db, target.id),
    });

  const newCode = normalizeCode(newCodeRaw);
  if (!newCode) throw new HttpError(400, "new_code_required");
  if (newCode === oldCode) throw new HttpError(400, "same_code");
  assertCodeFormat(newCode);
  if (findLabelByCode(db, newCode))
    throw new HttpError(409, "code_already_exists", { code: newCode });

  old.status = "void";
  old.voidedAt = nowIso();
  old.voidReason = "moved";
  old.replacedBy = newCode;

  const label = {
    code: newCode,
    itemCode: old.itemCode,
    locationId: target.id,
    status: "active",
    issuedAt: nowIso(),
    batchId: "MOVE",
  };
  db.labels.push(label);
  const item = db.items.find((i) => i.code === old.itemCode);
  if (item) item.storage = target.name;
  return {
    voided: { ...old, locationName: locNameOf(db, old.locationId) },
    active: { ...label, locationName: target.name },
  };
}

function locNameOf(db, id) {
  return db.locations.find((l) => l.id === id)?.name || null;
}

// 查码（含已作废）：扫旧码时告诉盘点人墨锭当前所在库位
export function lookupCode(db, rawCode) {
  const code = normalizeCode(rawCode);
  const label = findLabelByCode(db, code);
  if (!label) return { code, status: "unknown" };
  const current =
    label.status === "void"
      ? db.labels.find(
          (l) => l.status === "active" && l.itemCode === label.itemCode
        ) || null
      : label;
  return {
    code,
    status: label.status,
    itemCode: label.itemCode,
    voidReason: label.voidReason || null,
    replacedBy: label.replacedBy || null,
    currentCode: current ? current.code : null,
    currentLocationId: current ? current.locationId : null,
    currentLocationName: current ? locNameOf(db, current.locationId) : null,
  };
}

// ———————————————— 盘点 ————————————————

function openSessionFor(db, locationId) {
  return db.sessions.find(
    (s) => s.locationId === locationId && s.status === "open"
  );
}

export function startSession(db, { locationId, clientKey, counter }) {
  const loc = db.locations.find((l) => l.id === locationId);
  if (!loc) throw new HttpError(404, "location_not_found");
  const open = openSessionFor(db, locationId);
  if (open) {
    // 同 clientKey 是断网重试：幂等返回；不同 clientKey 是并发抢占：拒绝
    if (clientKey && open.clientKey === clientKey)
      return { reused: true, session: summarizeSession(db, open) };
    throw new HttpError(409, "session_already_open", {
      sessionId: open.id,
    });
  }
  const session = {
    id: "PD" + String(nextSeq(db)).padStart(6, "0"),
    locationId,
    status: "open",
    counter: String(counter || "").slice(0, 30),
    clientKey: clientKey || null,
    startedAt: nowIso(),
    finishedAt: null,
    finishIdemKey: null,
    events: [], // 每次扫码一条（含重复、错位、未知；作废/结束后拒绝的不入账）
    report: null, // 结束时的不可变快照
  };
  db.sessions.push(session);
  return { reused: false, session: summarizeSession(db, session) };
}

export function listSessions(db) {
  return db.sessions
    .slice()
    .reverse()
    .map((s) => summarizeSession(db, s));
}

export function getSession(db, id) {
  const s = db.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, "session_not_found");
  return summarizeSession(db, s);
}

// 扫码入账。返回分类；作废码与结束后扫码直接拒绝（409，不落任何记录）
export function scanCode(db, sessionId, rawCode, { eventKey } = {}) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new HttpError(404, "session_not_found");
  if (session.status !== "open")
    throw new HttpError(409, "session_closed", {
      report: session.report,
    });

  const code = normalizeCode(rawCode);
  if (!code) throw new HttpError(400, "code_required");

  // 断网恢复后的重放：同一 eventKey 幂等返回首次结果，不计为重复
  if (eventKey) {
    const prior = session.events.find((e) => e.eventKey === eventKey);
    if (prior)
      return { replayed: true, scan: publicEvent(prior), summary: countEvents(session) };
  }

  const label = findLabelByCode(db, code);
  const at = nowIso();
  let event;

  if (!label) {
    event = { eventKey: eventKey || null, code, category: "unknown", at };
  } else if (label.status === "void") {
    // 旧码立即作废：指出当前库位并拒绝入账
    const current =
      db.labels.find(
        (l) => l.status === "active" && l.itemCode === label.itemCode
      ) || null;
    throw new HttpError(409, "void_code_rejected", {
      code,
      itemCode: label.itemCode,
      currentCode: current ? current.code : null,
      currentLocationName: current ? locNameOf(db, current.locationId) : null,
    });
  } else {
    const priorIdx = session.events.findIndex(
      (e) => e.category !== "unknown" && e.code === code
    );
    if (priorIdx >= 0) {
      event = {
        eventKey: eventKey || null,
        code,
        category: "duplicate",
        firstCategory: session.events[priorIdx].category,
        itemCode: label.itemCode,
        at,
      };
    } else if (label.locationId === session.locationId) {
      event = {
        eventKey: eventKey || null,
        code,
        category: "match",
        itemCode: label.itemCode,
        at,
      };
    } else {
      event = {
        eventKey: eventKey || null,
        code,
        category: "misplaced",
        itemCode: label.itemCode,
        expectedLocationName: locNameOf(db, label.locationId),
        at,
      };
    }
  }

  session.events.push(event);
  return { replayed: false, scan: publicEvent(event), summary: countEvents(session) };
}

function publicEvent(e) {
  return {
    code: e.code,
    category: e.category,
    itemCode: e.itemCode || null,
    expectedLocationName: e.expectedLocationName || null,
    at: e.at,
  };
}

function countEvents(session) {
  // 唯一码：以第一次入账为准；重复/未知按事件统计
  const first = new Map();
  let unknown = 0;
  let duplicate = 0;
  for (const e of session.events) {
    if (e.category === "unknown") {
      unknown += 1;
      continue;
    }
    if (e.category === "duplicate") {
      duplicate += 1;
      continue;
    }
    if (!first.has(e.code)) first.set(e.code, e.category);
  }
  let match = 0;
  let misplaced = 0;
  for (const cat of first.values()) {
    if (cat === "match") match += 1;
    if (cat === "misplaced") misplaced += 1;
  }
  return {
    totalEvents: session.events.length,
    uniqueCount: first.size,
    match,
    misplaced,
    unknown,
    duplicate,
  };
}

// 结束盘点：同库位并发结束 / 断网重复结束只成功一次，差异清单即时冻结
export function finishSession(db, sessionId, { idemKey } = {}) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new HttpError(404, "session_not_found");

  if (session.status === "finished") {
    if (idemKey && session.finishIdemKey === idemKey)
      return { reused: true, report: session.report };
    throw new HttpError(409, "already_finished", { report: session.report });
  }

  const loc = db.locations.find((l) => l.id === session.locationId);
  const firstByCode = new Map();
  const unknownCodes = new Set();
  const duplicateCounts = new Map();
  for (const e of session.events) {
    if (e.category === "unknown") unknownCodes.add(e.code);
    else if (e.category === "duplicate")
      duplicateCounts.set(e.code, (duplicateCounts.get(e.code) || 0) + 1);
    else if (!firstByCode.has(e.code)) firstByCode.set(e.code, e);
  }

  // 冻结时刻该库位应有的活跃标签基线
  const expectedLabels = db.labels
    .filter(
      (l) => l.status === "active" && l.locationId === session.locationId
    )
    .map((l) => ({ code: l.code, itemCode: l.itemCode }));
  const scannedCodes = new Set(firstByCode.keys());

  const missing = expectedLabels
    .filter((l) => !scannedCodes.has(l.code))
    .map((l) => ({ code: l.code, itemCode: l.itemCode }));
  const misplaced = [...firstByCode.values()]
    .filter((e) => e.category === "misplaced")
    .map((e) => ({
      code: e.code,
      itemCode: e.itemCode,
      belongsTo: e.expectedLocationName,
    }));
  const duplicates = [...duplicateCounts.entries()].map(([code, times]) => ({
    code,
    extraTimes: times,
  }));

  const counts = countEvents(session);
  session.report = {
    sessionId: session.id,
    locationId: session.locationId,
    locationName: loc ? loc.name : null,
    finishedAt: nowIso(),
    frozen: true,
    counts,
    expectedCount: expectedLabels.length,
    scannedUnique: [...scannedCodes],
    missing,
    misplaced,
    unknown: [...unknownCodes],
    duplicates,
  };
  session.status = "finished";
  session.finishedAt = session.report.finishedAt;
  session.finishIdemKey = idemKey || null;
  // 结束后不再接受新事件；report 为深快照，后续换签/移库不影响它
  return { reused: false, report: session.report };
}

export function summarizeSession(db, s) {
  const loc = db.locations.find((l) => l.id === s.locationId);
  return {
    id: s.id,
    locationId: s.locationId,
    locationName: loc ? loc.name : null,
    status: s.status,
    counter: s.counter,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    summary: s.status === "open" ? countEvents(s) : s.report.counts,
    report: s.report,
    events: s.status === "open" ? s.events.slice(-50).map(publicEvent) : undefined,
  };
}
