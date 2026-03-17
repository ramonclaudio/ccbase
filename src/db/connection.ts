import { Database } from "bun:sqlite";

const PROJECT_ROOT = import.meta.dir.split("/").slice(0, -2).join("/");
const DATA_DIR = PROJECT_ROOT + "/data";
const DB_PATH = DATA_DIR + "/analyzer.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  Bun.spawnSync(["mkdir", "-p", DATA_DIR], { stdout: "ignore", stderr: "ignore" });
  _db = new Database(DB_PATH, { strict: true });
  _db.exec(`
    PRAGMA page_size = 8192;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -128000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 1073741824;
    PRAGMA foreign_keys = ON;
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA optimize;
  `);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.exec("PRAGMA optimize");  // re-analyze before close
    _db.close();
  }
  _db = null;
}

export function dbExists(): boolean {
  return Bun.file(DB_PATH).size > 0;
}

export { DB_PATH, DATA_DIR };
