#!/usr/bin/env bun
import { dbExists, getDb } from "./db/connection.ts";
import { createSchema } from "./db/schema.ts";

const [, , command, ...args] = Bun.argv;

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

declare const __VERSION__: string;
declare const __BUILD_TIME__: number;

function printHelp() {
  const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
  const built = typeof __BUILD_TIME__ !== "undefined" ? new Date(__BUILD_TIME__ * 1000).toLocaleDateString() : "";
  console.log(`claude-pulse ${version}${built ? ` (built ${built})` : ""} - Task tracker powered by Claude Code session data

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
  ingest --cron [schedule]        Schedule auto-ingest (default: hourly)
  ingest --no-cron                Remove auto-ingest schedule

Run 'ingest' first, or any command will auto-ingest on first use.`);
}

async function main() {
  switch (command) {
    case "log":
      await ensureDb();
      (await import("./commands/log.ts")).logCommand(args);
      break;
    case "tasks":
      await ensureDb();
      (await import("./commands/tasks.ts")).tasksCommand(args);
      break;
    case "wip":
      await ensureDb();
      await (await import("./commands/wip.ts")).wipCommand(args);
      break;
    case "progress":
      await ensureDb();
      (await import("./commands/progress.ts")).progressCommand(args);
      break;
    case "search":
      await ensureDb();
      (await import("./commands/search.ts")).searchCommand(args);
      break;
    case "sql":
      await ensureDb();
      (await import("./commands/sql.ts")).sqlCommand(args);
      break;
    case "serve":
      await ensureDb();
      (await import("./commands/serve.ts")).serveCommand(args);
      break;
    case "export":
      await ensureDb();
      await (await import("./commands/export-html.ts")).exportHtmlCommand(args);
      break;
    case "ingest":
      (await import("./commands/ingest.ts")).ingestCommand(args);
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
