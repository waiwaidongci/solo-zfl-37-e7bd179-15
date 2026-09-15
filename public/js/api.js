// API 封装：角色头、幂等键、断网本地排队（恢复后按序提交，每条只提交一次）。
const QUEUE_KEY = "inkstock.offlineQueue.v1";

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function getRole() {
  return localStorage.getItem("inkstock.role") || "counter";
}
export function setRole(role) {
  localStorage.setItem("inkstock.role", role);
}

export function isOnline() {
  return navigator.onLine !== false;
}

async function raw(path, { method = "GET", body, idemKey } = {}) {
  const headers = { "X-Role": getRole() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idemKey) headers["Idem-Key"] = idemKey;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    const err = new Error("network_offline");
    err.network = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || "请求失败");
    err.status = res.status;
    // 错误标识统一取服务端的 error 字段挂到 err.code；
    // 注意 data.code 在部分错误里是「被扫短码」，不是错误标识，不能用它判断
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => raw(path),
  post: (path, body, opts = {}) => raw(path, { method: "POST", body, idemKey: opts.idemKey || uuid() }),
  patch: (path, body, opts = {}) => raw(path, { method: "PATCH", body, idemKey: opts.idemKey || uuid() }),
  del: (path, opts = {}) => raw(path, { method: "DELETE", idemKey: opts.idemKey || uuid() }),
};

// —— 离线队列（仅扫码需要断网继续工作）——
function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
  catch { return []; }
}
function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}
export function queueLength() {
  return loadQueue().length;
}
export function enqueueScan(sessionId, code, eventKey) {
  const q = loadQueue();
  q.push({ kind: "scan", sessionId, code, eventKey, ts: Date.now() });
  saveQueue(q);
  emitQueue();
}

const listeners = { queue: [], online: [] };
export function on(type, fn) {
  if (!listeners[type]) listeners[type] = [];
  listeners[type].push(fn);
}
function emitQueue() { listeners.queue.forEach((fn) => fn(queueLength())); }

export async function flushQueue(onScanResult) {
  if (!isOnline()) return { flushed: 0, remain: queueLength() };
  const q = loadQueue();
  let flushed = 0;
  // 从队首逐条提交：每条都有固定 eventKey，即使中途再断网恢复，重放也只入账一次
  while (q.length) {
    const job = q[0];
    try {
      if (job.kind === "scan") {
        const out = await raw(`/api/sessions/${job.sessionId}/scans`, {
          method: "POST",
          body: { code: job.code, eventKey: job.eventKey },
          idemKey: "http-" + job.eventKey,
        });
        onScanResult && (await onScanResult(job, out));
      }
      q.shift();
      saveQueue(q);
      flushed++;
    } catch (e) {
      if (e.network) break; // 仍然断网：保留剩余队列，稍后再试
      // 业务拒绝（如旧码作废、盘点已结束）：丢弃并回调提示，避免死信堵队列
      q.shift();
      saveQueue(q);
      flushed++;
      onScanResult && (await onScanResult(job, { error: e.message, data: e.data }));
    }
  }
  emitQueue();
  return { flushed, remain: queueLength() };
}

export function initConnectivity(onReconnect) {
  window.addEventListener("online", () => {
    listeners.online.forEach((fn) => fn(true));
    onReconnect && onReconnect();
  });
  window.addEventListener("offline", () => listeners.online.forEach((fn) => fn(false)));
  // 定期兜底重传（online 事件在个别移动浏览器上不可靠）
  setInterval(() => { if (isOnline() && queueLength()) onReconnect && onReconnect(); }, 15000);
}
