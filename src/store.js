import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// 记录存储模块：配胶复核记录的加载、内存缓存与串行落盘。
// 启动时加载一次，之后所有请求共享同一份内存数据，
// 保证并发请求在同一事件循环内看到一致的记录（重复/并发提交可命中首次结果）。
export function createStore(dbPath, seed) {
  let db = null;
  let queue = Promise.resolve();

  async function init() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      await writeFile(dbPath, JSON.stringify(seed, null, 2));
    }
    db = JSON.parse(await readFile(dbPath, "utf8"));
    db.batches ||= [];
    db.seq ||= 1000;
    return db;
  }

  function getDb() {
    if (!db) throw new Error("store_not_initialized");
    return db;
  }

  // 串行化写盘，避免并发写坏文件
  function save() {
    queue = queue.then(() => writeFile(dbPath, JSON.stringify(db, null, 2)));
    return queue;
  }

  return { init, getDb, save };
}
