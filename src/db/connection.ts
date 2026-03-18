import { Database, constants } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH } from "../utils/paths.ts";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH, { strict: true });
  _db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -128000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 1073741824;
    PRAGMA foreign_keys = ON;
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA wal_autocheckpoint = 1000;
  `);
  return _db;
}

export function dbExists(): boolean {
  return existsSync(DB_PATH);
}
