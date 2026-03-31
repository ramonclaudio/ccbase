# claude-code-analyzer

Analytics dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) usage. Parses your local conversation history, git activity, and session data into a searchable SQLite database with a live web dashboard.

All data stays local. Nothing leaves your machine.

## What it tracks

- **Sessions**: count, duration, tokens, cost breakdown by model
- **Messages**: daily/hourly activity, tool calls, thinking blocks, errors
- **Projects**: per-project token usage, git state (dirty files, branches, stashes)
- **Commits**: conventional commit breakdown, daily frequency
- **Tools**: usage counts, error rates, durations
- **Skills**: invocation counts, error rates (extracted from conversation history)
- **Billing**: 5-hour block tracking with burn rate
- **Tasks**: team task status with blocking/ownership
- **Insights**: session outcomes, helpfulness ratings (from Claude Code facets)
- **Cache**: hit rate, tokens saved, estimated cost savings

## Requirements

- [Bun](https://bun.sh) v1.3+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with conversation history at `~/.claude/`

## Install

```bash
git clone https://github.com/ramonclaudio/claude-code-analyzer.git
cd claude-code-analyzer
bun install
```

## Usage

```bash
# Build the binary
bun run build

# Ingest your Claude Code data
./dist/claude-analyzer ingest

# Start the dashboard
./dist/claude-analyzer serve
```

Open `http://localhost:3847` in your browser.

Or run directly without building:

```bash
bun run src/index.ts ingest
bun run src/index.ts serve
```

## Commands

| Command | Description |
|---|---|
| `ingest` | Parse `~/.claude/` data into SQLite |
| `ingest --force` | Drop all tables and re-ingest from scratch |
| `serve [port]` | Start live dashboard (default: 3847) |
| `export [path]` | Generate static HTML dashboard |
| `log [--week\|DATE]` | Sessions by date |
| `tasks` | Open tasks across projects |
| `wip` | Dirty repos, stashes, open tasks |
| `progress` | What shipped this week |
| `search QUERY` | Full-text search across conversations |
| `sql "SELECT ..."` | Raw SQL against the database |

## Configuration

### Project directory

By default, the analyzer scans `~/Developer` for git repos (one level deep). Override with:

```bash
ANALYZER_DEV_DIR=~/projects ./dist/claude-analyzer ingest
```

It finds git repos at `$ANALYZER_DEV_DIR/*/` and `$ANALYZER_DEV_DIR/*/*/` (for nested layouts like `~/Developer/work/my-app`).

### Git author

Commits are filtered to your git identity (`git config user.name` and the username portion of `git config user.email`). No configuration needed.

## Data sources

Everything is read from local `~/.claude/` files. No API calls, no telemetry.

| Source | What |
|---|---|
| `~/.claude/projects/*/*.jsonl` | Raw conversation messages (ground truth) |
| `~/.claude/projects/*/sessions-index.json` | Session metadata (project path, lines changed) |
| `~/.claude/tasks/` | Team task state |
| `~/.claude/teams/` | Team configuration |
| `~/.claude/usage-data/facets/` | Session quality ratings |
| `~/.claude/stats-cache.json` | App metadata |
| `~/.claude.json` | Config, pricing, repo mappings |
| `~/Developer/` (or `$ANALYZER_DEV_DIR`) | Git repos for commit/branch/stash data |

## Database

Single SQLite file at `data/analyzer.db`. All counts and token metrics are derived from `conversation_messages` (the JSONL ground truth). The `sessions` table provides metadata only (project paths, lines changed, git context).

Core tables:

| Table | Rows (typical) | Source |
|---|---|---|
| `conversation_messages` | 300K+ | JSONL conversation files |
| `sessions` | 1K+ | sessions-index.json |
| `commits` | 1K+ | git log |
| `tasks` | varies | ~/.claude/tasks/ |
| `projects` | varies | filesystem scan |
| `billing_blocks` | ~30 | Claude billing data |
| `session_facets` | varies | usage-data/facets/ |
| `app_meta` | ~10 | .claude.json + stats-cache |

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Database**: SQLite (via `bun:sqlite`)
- **Server**: `Bun.serve()`
- **Frontend**: Vanilla HTML/CSS/JS (no framework, no build step)
- **Charts**: Canvas API (no chart library)

## License

MIT
