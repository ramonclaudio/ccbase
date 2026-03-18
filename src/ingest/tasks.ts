import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { TASKS_DIR, listDirs } from "../utils/paths.ts";
import { safeParseJson } from "../utils/parse.ts";

interface RawTask {
  id: number | string;
  subject?: string;
  description?: string;
  status?: string;
  owner?: string;
  activeForm?: string;
  blocks?: number[];
  blockedBy?: number[];
  metadata?: { _internal?: boolean; [key: string]: unknown };
}

async function readTaskFiles(): Promise<{ suiteId: string; task: RawTask }[]> {
  const suiteDirNames = listDirs(TASKS_DIR);
  const results: { suiteId: string; task: RawTask }[] = [];

  for (const raw of suiteDirNames) {
    const suiteId = raw.replace(/\/$/, "");
    const suitePath = TASKS_DIR + "/" + suiteId;

    let files: string[];
    try {
      files = [...new Glob("*.json").scanSync(suitePath)];
    } catch (e) {
      console.error(`Failed to list ${suitePath}:`, e);
      continue;
    }

    for (const file of files) {
      try {
        const text = await Bun.file(suitePath + "/" + file).text();
        const task = safeParseJson<RawTask>(text);
        if (task) results.push({ suiteId, task });
      } catch (e) {
        console.error(`Failed to read task ${file} in ${suiteId}:`, e);
      }
    }
  }

  return results;
}

export async function ingestTasks(db: Database): Promise<number> {
  if (!existsSync(TASKS_DIR)) return 0;

  const taskData = await readTaskFiles();
  if (taskData.length === 0) return 0;

  const insert = db.query(`
    INSERT OR REPLACE INTO tasks (id, suite_id, subject, description, status, owner, blocks, blocked_by, is_internal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  db.transaction(() => {
    for (const { suiteId, task } of taskData) {
      try {
        insert.run(
          String(task.id), suiteId,
          task.subject ?? null, task.description ?? null,
          task.status ?? "pending", task.owner ?? null,
          task.blocks ? JSON.stringify(task.blocks) : null,
          task.blockedBy ? JSON.stringify(task.blockedBy) : null,
          task.metadata?._internal ? 1 : 0,
        );
        count++;
      } catch (e) {
        console.error(`Failed to ingest task ${task.id} in ${suiteId}:`, e);
      }
    }
  })();

  return count;
}
