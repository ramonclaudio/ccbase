import type { Database } from "bun:sqlite";

export interface Row { [key: string]: unknown }
export type QueryFn = (sql: string, ...p: (string | number)[]) => Row[];

export interface Session {
  id: string;
  project_path: string | null;
  started_at: number | null;
  ended_at: number | null;
  message_count: number | null;
  duration_minutes: number | null;
  first_prompt: string | null;
  summary: string | null;
  git_branch: string | null;
  is_sidechain: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}


interface Project {
  path: string;
  name: string | null;
  type: string | null;
  has_git: number;
  has_claude_md: number;
  last_commit_date: string | null;
  last_session_date: string | null;
  total_sessions: number;
  total_messages: number;
  total_commits: number;
}

export interface Task {
  id: string;
  suite_id: string;
  subject: string | null;
  description: string | null;
  status: string | null;
  owner: string | null;
  blocks: string | null;
  blocked_by: string | null;
  is_internal: number;
}

interface ProjectWithGitState extends Project {
  branch_count: number | null;
  stash_count: number | null;
  dirty_file_count: number | null;
  uncommitted_changes: number;
  current_branch: string | null;
  last_captured: string | null;
}

interface SessionSummary {
  project_path: string;
  session_count: number;
  total_duration: number | null;
  total_lines_added: number | null;
  total_lines_removed: number | null;
}


export function sessionsByDateRange(
  db: Database,
  startMs: number,
  endMs: number,
): Session[] {
  return db
    .query(
      "SELECT * FROM sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at",
    )
    .all(startMs, endMs) as Session[];
}

export function openTasks(db: Database): Task[] {
  return db
    .query(
      "SELECT * FROM tasks WHERE status IN ('pending', 'in_progress') ORDER BY status DESC, suite_id",
    )
    .all() as Task[];
}

export function completedTasks(db: Database): Task[] {
  return db
    .query("SELECT * FROM tasks WHERE status = 'completed'")
    .all() as Task[];
}

export function dirtyProjects(db: Database): ProjectWithGitState[] {
  return db
    .query(
      `SELECT p.*, g.branch_count, g.stash_count, g.dirty_file_count,
              g.uncommitted_changes, g.current_branch, g.last_captured
       FROM project_git_state g
       JOIN projects p ON p.path = g.project_path
       WHERE g.dirty_file_count > 0`,
    )
    .all() as ProjectWithGitState[];
}

interface Commit {
  hash: string;
  project_path: string | null;
  author: string | null;
  date: string | null;
  message: string | null;
  commit_type: string | null;
  commit_scope: string | null;
}

export function commitsInRange(
  db: Database,
  startDate: string,
  endDate: string,
): Commit[] {
  return db
    .query(
      "SELECT * FROM commits WHERE date >= ? AND date <= ? ORDER BY date DESC",
    )
    .all(startDate, endDate) as Commit[];
}

/** Quote a string for FTS5 MATCH: wraps in double quotes, strips internal quotes. */
export const safeFts = (q: string): string => `"${q.replace(/"/g, "")}"`;


const ALLOWED_PREFIXES = ["SELECT", "PRAGMA", "EXPLAIN"];

export function rawQuery(db: Database, sql: string): unknown[] {
  const trimmed = sql.trimStart().toUpperCase();
  const allowed = ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!allowed) {
    throw new Error("Only SELECT, PRAGMA, and EXPLAIN statements are allowed");
  }
  return db.prepare(sql).all();
}

export function sessionSummaryByProject(
  db: Database,
  startMs: number,
  endMs: number,
): SessionSummary[] {
  return db
    .query(
      `SELECT project_path,
              COUNT(*) as session_count,
              SUM(duration_minutes) as total_duration,
              SUM(lines_added) as total_lines_added,
              SUM(lines_removed) as total_lines_removed
       FROM sessions
       WHERE started_at >= ? AND started_at <= ?
       GROUP BY project_path`,
    )
    .all(startMs, endMs) as SessionSummary[];
}
