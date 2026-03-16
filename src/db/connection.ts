import { Database } from "bun:sqlite";

const PROJECT_ROOT = import.meta.dir.split("/").slice(0, -2).join("/");
const DATA_DIR = PROJECT_ROOT + "/data";
const DB_PATH = DATA_DIR + "/analyzer.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  Bun.spawnSync(["mkdir", "-p", DATA_DIR], { stdout: "ignore", stderr: "ignore" });
  _db = new Database(DB_PATH, { strict: true });
  // Tuned for 856MB DB on Apple Silicon M4
  _db.exec("PRAGMA page_size = 8192");             // larger pages for big rows (must be first)
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA busy_timeout = 5000");           // wait up to 5s for locks
  _db.exec("PRAGMA cache_size = -128000");           // 128MB cache
  _db.exec("PRAGMA temp_store = MEMORY");
  _db.exec("PRAGMA mmap_size = 1073741824");         // 1GB mmap
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  _db.exec("PRAGMA wal_autocheckpoint = 1000");      // checkpoint every 1000 pages
  _db.exec("PRAGMA optimize");                       // analyze indexes on open
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
