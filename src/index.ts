#!/usr/bin/env bun
import { getDb, dbExists } from "./db/connection.ts";
import { createSchema } from "./db/schema.ts";
import { logCommand } from "./commands/log.ts";
import { tasksCommand } from "./commands/tasks.ts";
import { wipCommand } from "./commands/wip.ts";
import { progressCommand } from "./commands/progress.ts";
import { sqlCommand } from "./commands/sql.ts";
import { searchCommand } from "./commands/search.ts";
import { ingestCommand } from "./commands/ingest.ts";
import { exportHtmlCommand } from "./commands/export-html.ts";
import { serveCommand } from "./commands/serve.ts";

const [, , command, ...args] = process.argv;

async function ensureDb() {
  if (!dbExists()) {
    console.log("First run. Ingesting data...\n");
    const db = getDb();
    createSchema(db);
    const { runIngest } = await import("./ingest/index.ts");
    await runIngest(false);
    console.log("");
  }
}

function printHelp() {
  console.log(`claude-analyzer - Task tracker powered by Claude Code session data

Commands:
  log [--yesterday|--week|DATE]   What did I do? Sessions by date
  tasks [--done|PROJECT]          Open tasks across projects
  wip                             Work in progress: dirty repos, stashes, open tasks
  progress [PROJECT]              What shipped this week
  search QUERY                    Full-text search across history
  sql "SELECT ..."                Raw SQL query
  serve [port]                     Live dashboard on localhost
  export [path]                   Generate static HTML dashboard
  ingest [--force]                Parse Claude Code data into database

Run 'ingest' first, or any command will auto-ingest on first use.`);
}

async function main() {
  switch (command) {
    case "log":
      await ensureDb();
      logCommand(args);
      break;
    case "tasks":
      await ensureDb();
      tasksCommand(args);
      break;
    case "wip":
      await ensureDb();
      await wipCommand(args);
      break;
    case "progress":
      await ensureDb();
      progressCommand(args);
      break;
    case "search":
      await ensureDb();
      searchCommand(args);
      break;
    case "sql":
      await ensureDb();
      sqlCommand(args);
      break;
    case "serve":
      await ensureDb();
      serveCommand(args);
      break;
    case "export":
      await ensureDb();
      exportHtmlCommand(args);
      break;
    case "ingest":
      await ingestCommand(args);
      break;
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\nRun with --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
