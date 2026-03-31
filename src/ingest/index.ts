import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection.ts";
import { createSchema } from "../db/schema.ts";
import { ingestProjects } from "./projects.ts";
import { ingestSessionsIndex } from "./sessions-index.ts";
import { ingestStats } from "./stats.ts";
import { ingestTasks } from "./tasks.ts";
import { ingestRootConfig } from "./root-config.ts";
import { ingestConversations } from "./conversations.ts";
import { ingestBillingBlocks } from "./billing-blocks.ts";

const TABLES = [
  "billing_blocks",
  "conversation_fts",
  "conversation_messages",
  "commits",
  "project_git_state",
  "tasks",
  "app_meta",
  "session_facets",
  "github_repos",
  "sessions",
  "projects",
];

interface IngestStep {
  name: string;
  fn: (db: Database) => Promise<number>;
}

const steps: IngestStep[] = [
  { name: "projects", fn: ingestProjects },
  { name: "sessions-index", fn: ingestSessionsIndex },
  { name: "tasks", fn: ingestTasks },
  { name: "root-config", fn: ingestRootConfig },
  { name: "billing-blocks", fn: ingestBillingBlocks },
  { name: "conversations", fn: ingestConversations },
  { name: "stats", fn: ingestStats },
];

export async function runIngest(force: boolean): Promise<void> {
  const totalStart = performance.now();
  const db = getDb();

  if (force) {
    for (const table of TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  createSchema(db);

  for (const step of steps) {
    const label = `Ingesting ${step.name}...`;
    process.stdout.write(label);
    const start = performance.now();

    try {
      const rows = await step.fn(db);
      const ms = Math.round(performance.now() - start);
      console.log(` ${rows} rows (${ms}ms)`);
    } catch (e) {
      const ms = Math.round(performance.now() - start);
      console.log(` FAILED (${ms}ms)`);
      console.error(e);
    }
  }

  // Flush WAL to main DB file and run query planner optimization
  db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  db.exec(`PRAGMA optimize`);

  const totalMs = Math.round(performance.now() - totalStart);
  console.log(`\nDone in ${totalMs}ms`);
}
