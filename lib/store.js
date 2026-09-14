// 原子 JSON 存储：互斥串行化「读-改-写」；临时文件 + fsync + rename 原子落盘；
// 写入失败时调用方的内存修改全部丢弃（下次读取重新从磁盘加载），不会留下半条数据。
import { mkdir, readFile, rename, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// —— 简单的链式互斥锁，保证同一时刻只有一个事务在修改数据库 ——
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  // 无论成功失败都让锁链继续
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const CURRENT_VERSION = 2;

// —— 故障注入：armWriteFailure() 后下一次写盘抛错，用于回滚验证 ——
let failNextWrite = process.env.STORE_FAIL_WRITE === "1";

export function armWriteFailure() {
  failNextWrite = true;
}

// 仅在旧版本数据文件上执行一次：把历史 storage 文本升级为库位、给旧墨锭补首枚标签。
// 迁移之后新建的墨锭一律走发标签流程，不会被自动补码。
function migrate(db) {
  if (!Array.isArray(db.items)) db.items = [];
  if (!Array.isArray(db.locations)) db.locations = [];
  if (!Array.isArray(db.labels)) db.labels = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  if (typeof db.seq !== "number") db.seq = 0;

  const locByName = new Map(db.locations.map((l) => [l.name, l]));
  for (const item of db.items) {
    if (item.storage && !locByName.has(item.storage)) {
      db.seq += 1;
      const loc = {
        id: "LOC" + String(db.seq).padStart(5, "0"),
        name: item.storage,
        capacity: 50,
        createdAt: new Date().toISOString(),
      };
      db.locations.push(loc);
      locByName.set(loc.name, loc);
    }
  }
  for (const item of db.items) {
    const hasActive = db.labels.some(
      (l) => l.itemCode === item.code && l.status === "active"
    );
    if (!hasActive) {
      db.seq += 1;
      const loc = item.storage ? locByName.get(item.storage) : undefined;
      db.labels.push({
        code: "MQ" + String(db.seq).padStart(5, "0"),
        itemCode: item.code,
        locationId: loc ? loc.id : null,
        status: "active",
        issuedAt: new Date().toISOString(),
        batchId: "SEED",
      });
    }
  }
  db.__schemaVersion = CURRENT_VERSION;
}

async function loadRaw(dbPath) {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const fresh = {
      __schemaVersion: CURRENT_VERSION,
      items: [], locations: [], labels: [], sessions: [], seq: 0,
    };
    await atomicWrite(dbPath, fresh);
    return { db: fresh, migrated: false };
  }
  const text = await readFile(dbPath, "utf8");
  // 读到半截文件（写盘中崩溃）时直接报错，绝不拿截断数据继续写
  const db = JSON.parse(text);
  let migrated = false;
  if (db.__schemaVersion !== CURRENT_VERSION) {
    migrate(db);
    migrated = true;
  }
  return { db, migrated };
}

async function atomicWrite(dbPath, db) {
  if (failNextWrite) {
    failNextWrite = false;
    throw new Error("INJECTED_WRITE_FAILURE");
  }
  const tmp = join(
    dirname(dbPath),
    ".write-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + ".tmp"
  );
  const fd = await open(tmp, "w");
  try {
    await fd.writeFile(JSON.stringify(db, null, 2), "utf8");
    await fd.sync(); // 内容先落盘
  } finally {
    await fd.close();
  }
  await rename(tmp, dbPath); // 同目录 rename 是原子的：要么旧文件，要么新文件
}

export function createStore(dbPath) {
  // 每个事务：拿锁 → 从磁盘读最新数据 → 业务修改 → 原子写回。
  // mutate 抛错（包括写盘错误）时磁盘与后续读取都不受影响。
  async function transaction(mutate, { persist = true } = {}) {
    return withLock(async () => {
      const { db, migrated } = await loadRaw(dbPath);
      const out = await mutate(db);
      if (persist === false) return out;
      // 迁移写与业务写同一次落盘完成；写失败则迁移也不生效（下次重试）
      await atomicWrite(dbPath, db);
      void migrated;
      return out;
    });
  }

  // 启动时迁移并落盘一次
  async function init() {
    await withLock(async () => {
      const { db, migrated } = await loadRaw(dbPath);
      if (migrated) await atomicWrite(dbPath, db);
    });
  }

  return {
    init,
    transaction,
  };
}
