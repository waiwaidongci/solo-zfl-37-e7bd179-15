import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/store.js";
import { createApi } from "./lib/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const publicDir = join(__dirname, "public");

const store = createStore(dbPath);
const handleApi = createApi(store, {
  allowFaultInjection: process.env.ALLOW_FAULT_INJECTION === "1",
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  readFile(file)
    .then((buf) => {
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(500);
      res.end("read error");
    });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method === "GET") return serveStatic(res, url.pathname);
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

store.init().then(() => {
  server.listen(port, () =>
    console.log("墨锭试磨室 listening on http://localhost:" + port)
  );
});
