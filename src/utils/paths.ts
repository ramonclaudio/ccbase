import { existsSync } from "node:fs";

export const HOME = Bun.env.HOME!;
export const CLAUDE_HOME = HOME + "/.claude";
export const CLAUDE_CONFIG = HOME + "/.claude.json";
export const PROJECTS_DIR = CLAUDE_HOME + "/projects";
export const HISTORY_FILE = CLAUDE_HOME + "/history.jsonl";
export const STATS_FILE = CLAUDE_HOME + "/stats-cache.json";
export const TASKS_DIR = CLAUDE_HOME + "/tasks";
export const DEVELOPER_DIR = HOME + "/Developer";

/** Project root data directory (adjacent to src/) */
export const DATA_DIR = import.meta.dir.split("/").slice(0, -2).join("/") + "/data";
export const DB_PATH = DATA_DIR + "/analyzer.db";
export const INGEST_STATE_PATH = DATA_DIR + "/.ingest-state.json";

/**
 * Decode a dash-encoded project path back to its filesystem path.
 * e.g. "-Users-jane-Developer-my-project" -> "/Users/jane/Developer/my-project"
 *
 * Encoding: `/` -> `-`, `.` -> `-` (so `/.claude` becomes `--claude`).
 * Prefer sessions-index.json `projectPath` when available. This is the fallback heuristic.
 *
 * Strategy: split on `-`, handle empty segments (from `.` prefix encoding),
 * then greedily match longest existing filesystem paths.
 */
export function decodeProjectPath(encoded: string): string {
  // Split preserving empty segments (double dashes -> dot-prefixed names)
  const raw = encoded.split("-");
  // First element is always empty (leading dash)
  raw.shift();

  // Merge empty segments back as dot prefixes: ["", "claude"] -> [".claude"]
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "" && i + 1 < raw.length) {
      parts.push("." + raw[i + 1]);
      i++;
    } else if (raw[i] !== "") {
      parts.push(raw[i]!);
    }
  }

  if (parts.length === 0) return "/";

  let path = "";
  let i = 0;

  while (i < parts.length) {
    let matched = false;
    for (let end = parts.length; end > i; end--) {
      const segment = parts.slice(i, end).join("-");
      const candidate = path + "/" + segment;
      if (existsSync(candidate)) {
        path = candidate;
        i = end;
        matched = true;
        break;
      }
    }
    if (!matched) {
      path += "/" + parts[i];
      i++;
    }
  }

  return path;
}

/** Last component of a filesystem path. */
export function projectName(path: string): string {
  return path.split("/").pop() || path;
}
