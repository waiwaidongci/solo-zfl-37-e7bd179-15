// HTTP 路由：解析请求体、角色校验、通用幂等键、JSON 响应。
import {
  HttpError,
  createLocation,
  updateLocation,
  deleteLocation,
  listLocations,
  issueLabels,
  listLabels,
  replaceLabel,
  moveLabel,
  lookupCode,
  startSession,
  scanCode,
  finishSession,
  listSessions,
  getSession,
  nowIso,
} from "./domain.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const errBody = (e) => ({ error: e.code, ...(e.extra || {}) });

export function createApi(store, { allowFaultInjection = false } = {}) {
  // 通用幂等：POST/PATCH/DELETE 带 Idem-Key 时，重放首次成功响应
  async function withIdempotency(db, req, fn) {
    const key = req.headers["idem-key"];
    if (key) {
      db.idem ||= { keys: [] };
      const hit = db.idem.keys.find((x) => x.key === key);
      if (hit) return { idemReplay: true, ...hit.result };
    }
    const result = await fn(db);
    if (key) {
      db.idem ||= { keys: [] };
      db.idem.keys.push({ key, at: nowIso(), result });
      while (db.idem.keys.length > 500) db.idem.keys.shift();
    }
    return result;
  }

  function requireAdmin(req) {
    if (req.headers["x-role"] !== "admin")
      throw new HttpError(403, "admin_only");
  }

  return async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = (re) => p.match(re);

    const run = async (mutate, opts = {}) => {
      // 只读事务不落盘；写事务经过通用幂等包装
      if (opts.readonly) {
        return store.transaction((db) => mutate(db), { persist: false });
      }
      return store.transaction((db) => withIdempotency(db, req, mutate));
    };

    try {
      // —— 墨锭（原有功能，保留） ——
      if (req.method === "GET" && p === "/api/items") {
        const items = await run((db) =>
          db.items.map((item) => ({
            ...item,
            logCount:
              (item.logs || []).length +
              (item.tests || []).length,
          })),
          { readonly: true }
        );
        return send(res, 200, items);
      }
      if (req.method === "GET" && p === "/api/stats") {
        const stats = await run(
          (db) => {
            const labels = ["待试磨", "已试磨", "重点观察"];
            const out = Object.fromEntries(labels.map((l) => [l, 0]));
            for (const it of db.items) if (out[it.status] !== undefined) out[it.status]++;
            return out;
          },
          { readonly: true }
        );
        return send(res, 200, stats);
      }
      if (req.method === "POST" && p === "/api/items") {
        const input = await readBody(req);
        const item = await run((db) => {
          const code = String(input.code || "").trim();
          if (!code) throw new HttpError(400, "code_required");
          if (db.items.some((i) => i.code === code))
            throw new HttpError(409, "item_code_exists", { code });
          const item = {
            id: code,
            ...input,
            code,
            logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }],
          };
          db.items.unshift(item);
          return item;
        });
        return send(res, 201, item);
      }
      const itemRef = m(/^\/api\/items\/([^/]+)$/);
      if (itemRef && req.method === "PATCH") {
        const input = await readBody(req);
        const item = await run((db) => {
          const it = db.items.find((x) => x.id === itemRef[1] || x.code === itemRef[1]);
          if (!it) throw new HttpError(404, "item_not_found");
          Object.assign(it, input);
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + it.status });
          return it;
        });
        return send(res, 200, item);
      }
      const itemLog = m(/^\/api\/items\/([^/]+)\/logs$/);
      if (itemLog && req.method === "POST") {
        const input = await readBody(req);
        const item = await run((db) => {
          const it = db.items.find((x) => x.id === itemLog[1] || x.code === itemLog[1]);
          if (!it) throw new HttpError(404, "item_not_found");
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
          return it;
        });
        return send(res, 201, item);
      }
      const itemAction = m(/^\/api\/items\/([^/]+)\/action$/);
      if (itemAction && req.method === "POST") {
        const input = await readBody(req);
        const item = await run((db) => {
          const it = db.items.find((x) => x.id === itemAction[1] || x.code === itemAction[1]);
          if (!it) throw new HttpError(404, "item_not_found");
          it.logs ||= [];
          const score = Number(input.score || 0);
          it.tests ||= [];
          it.tests.push({ at: new Date().toISOString(), ...input, score });
          it.status = score >= 85 ? "已试磨" : "重点观察";
          it.logs.push({ at: new Date().toISOString(), step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score });
          return it;
        });
        return send(res, 201, item);
      }

      // —— 库位 ——
      if (req.method === "GET" && p === "/api/locations") {
        return send(res, 200, await run((db) => listLocations(db), { readonly: true }));
      }
      if (req.method === "POST" && p === "/api/admin/locations") {
        requireAdmin(req);
        const input = await readBody(req);
        return send(res, 201, await run((db) => createLocation(db, input)));
      }
      const locRef = m(/^\/api\/admin\/locations\/([^/]+)$/);
      if (locRef && req.method === "PATCH") {
        requireAdmin(req);
        const input = await readBody(req);
        return send(res, 200, await run((db) => updateLocation(db, locRef[1], input)));
      }
      if (locRef && req.method === "DELETE") {
        requireAdmin(req);
        return send(res, 200, await run((db) => deleteLocation(db, locRef[1])));
      }

      // —— 标签 ——
      if (req.method === "GET" && p === "/api/labels") {
        const q = {
          status: url.searchParams.get("status") || undefined,
          locationId: url.searchParams.get("locationId") || undefined,
          q: (url.searchParams.get("q") || "").trim().toUpperCase() || undefined,
        };
        return send(res, 200, await run((db) => listLabels(db, q), { readonly: true }));
      }
      if (req.method === "POST" && p === "/api/admin/labels/issue") {
        requireAdmin(req);
        const input = await readBody(req);
        return send(res, 201, await run((db) => issueLabels(db, input)));
      }
      const labelRef = m(/^\/api\/admin\/labels\/([^/]+)\/(replace|move)$/);
      if (labelRef && req.method === "POST") {
        requireAdmin(req);
        const input = await readBody(req);
        const code = decodeURIComponent(labelRef[1]);
        const out = await run((db) =>
          labelRef[2] === "replace"
            ? replaceLabel(db, code, input.newCode)
            : moveLabel(db, code, input.locationId, input.newCode)
        );
        return send(res, 200, out);
      }
      if (req.method === "GET" && p === "/api/lookup") {
        const code = url.searchParams.get("code") || "";
        return send(res, 200, await run((db) => lookupCode(db, code), { readonly: true }));
      }

      // —— 盘点 ——
      if (req.method === "GET" && p === "/api/sessions") {
        return send(res, 200, await run((db) => listSessions(db), { readonly: true }));
      }
      if (req.method === "POST" && p === "/api/sessions") {
        const input = await readBody(req);
        const out = await run((db) => startSession(db, input));
        return send(res, out.reused ? 200 : 201, out.session);
      }
      const sessRef = m(/^\/api\/sessions\/([^/]+)$/);
      if (sessRef && req.method === "GET") {
        return send(res, 200, await run((db) => getSession(db, sessRef[1]), { readonly: true }));
      }
      const scanRef = m(/^\/api\/sessions\/([^/]+)\/scans$/);
      if (scanRef && req.method === "POST") {
        const input = await readBody(req);
        const out = await run((db) => scanCode(db, scanRef[1], input.code, { eventKey: input.eventKey }));
        if (out.idemReplay) out.replayed = true;
        return send(res, out.replayed ? 200 : 201, out);
      }
      const finishRef = m(/^\/api\/sessions\/([^/]+)\/finish$/);
      if (finishRef && req.method === "POST") {
        const input = await readBody(req);
        const out = await run((db) => finishSession(db, finishRef[1], { idemKey: input.idemKey }));
        return send(res, out.reused ? 200 : 200, out.report);
      }

      // —— 测试：故障注入（仅 ALLOW_FAULT_INJECTION=1 时可用） ——
      if (req.method === "POST" && p === "/api/test/arm-write-failure") {
        if (!allowFaultInjection) return send(res, 404, { error: "not_found" });
        const { armWriteFailure } = await import("./store.js");
        armWriteFailure();
        return send(res, 200, { armed: true });
      }

      send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, errBody(e));
      send(res, 500, { error: "internal_error", detail: String(e && e.message || e) });
    }
  };
}
