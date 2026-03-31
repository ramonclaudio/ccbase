import type { Database } from "bun:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  message_count INTEGER,
  duration_minutes REAL,
  first_prompt TEXT,
  summary TEXT,
  git_branch TEXT,
  is_sidechain INTEGER DEFAULT 0,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  lines_added INTEGER,
  lines_removed INTEGER,
  git_sha TEXT,
  git_origin_url TEXT,
  slug TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_repository TEXT,
  api_duration_ms INTEGER,
  tool_duration_ms INTEGER,
  total_cache_read_tokens INTEGER,
  total_cache_creation_tokens INTEGER,
  total_web_search_requests INTEGER
);


CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  has_git INTEGER DEFAULT 0,
  has_claude_md INTEGER DEFAULT 0,
  last_commit_date TEXT,
  last_session_date TEXT,
  total_sessions INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  total_commits INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT,
  suite_id TEXT,
  subject TEXT,
  description TEXT,
  status TEXT,
  owner TEXT,
  blocks TEXT,
  blocked_by TEXT,
  is_internal INTEGER DEFAULT 0,
  active_form TEXT,
  team_name TEXT,
  total_created INTEGER DEFAULT 0,
  PRIMARY KEY (suite_id, id)
);

CREATE TABLE IF NOT EXISTS project_git_state (
  project_path TEXT PRIMARY KEY,
  branch_count INTEGER,
  stash_count INTEGER,
  dirty_file_count INTEGER,
  uncommitted_changes INTEGER DEFAULT 0,
  current_branch TEXT,
  last_captured TEXT
);

CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  project_path TEXT,
  author TEXT,
  date TEXT,
  message TEXT,
  commit_type TEXT,
  commit_scope TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE TABLE IF NOT EXISTS billing_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_start INTEGER UNIQUE,
  block_end INTEGER,
  status TEXT,
  total_cost REAL,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  session_count INTEGER,
  burn_rate_tokens_per_min REAL,
  burn_rate_cost_per_min REAL
);

CREATE INDEX IF NOT EXISTS idx_tasks_suite_id ON tasks(suite_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_commits_project_path ON commits(project_path);
CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date);
CREATE INDEX IF NOT EXISTS idx_billing_blocks_start ON billing_blocks(block_start);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  uuid TEXT,
  parent_uuid TEXT,
  type TEXT,
  role TEXT,
  content TEXT,
  model TEXT,
  timestamp TEXT,
  is_sidechain INTEGER DEFAULT 0,
  agent_id TEXT,
  tool_name TEXT,
  tool_use_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  has_thinking INTEGER DEFAULT 0,
  thinking_length INTEGER DEFAULT 0,
  is_error INTEGER DEFAULT 0,
  raw_type TEXT,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  stop_reason TEXT,
  service_tier TEXT,
  web_search_count INTEGER DEFAULT 0,
  web_fetch_count INTEGER DEFAULT 0,
  cli_version TEXT,
  slug TEXT,
  permission_mode TEXT,
  duration_ms INTEGER,
  subtype TEXT
);

CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_type ON conversation_messages(type);
CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversation_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_conv_role ON conversation_messages(role);
CREATE INDEX IF NOT EXISTS idx_conv_tool ON conversation_messages(tool_name);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversation_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_conv_session_type ON conversation_messages(session_id, type);
CREATE INDEX IF NOT EXISTS idx_conv_session_role ON conversation_messages(session_id, role);
CREATE INDEX IF NOT EXISTS idx_conv_subtype ON conversation_messages(subtype);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(content);


CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS github_repos (
  repo TEXT,
  local_path TEXT,
  PRIMARY KEY (repo, local_path)
);

CREATE TABLE IF NOT EXISTS session_facets (
  session_id TEXT PRIMARY KEY,
  outcome TEXT,
  claude_helpfulness TEXT,
  session_type TEXT,
  underlying_goal TEXT,
  brief_summary TEXT,
  primary_success TEXT,
  friction_detail TEXT,
  goal_categories TEXT,
  friction_counts TEXT,
  user_satisfaction_counts TEXT
);
`;

export function createSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
