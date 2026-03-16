import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { TASKS_DIR } from "../utils/paths.ts";
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

export async function ingestTasks(db: Database): Promise<number> {
  if (!existsSync(TASKS_DIR)) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO tasks (id, suite_id, subject, description, status, owner, blocks, blocked_by, is_internal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const suiteDirs = readdirSync(TASKS_DIR, { withFileTypes: true });

  // Phase 1: Read all task files async before transaction
  const taskData: { suiteId: string; file: string; task: RawTask }[] = [];
  for (const suiteDir of suiteDirs) {
    if (!suiteDir.isDirectory()) continue;
    const suiteId = suiteDir.name;
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
        const filePath = suitePath + "/" + file;
        const text = await Bun.file(filePath).text();
        const task = safeParseJson<RawTask>(text);
        if (!task) continue;
        taskData.push({ suiteId, file, task });
      } catch (e) {
        console.error(`Failed to read task ${file} in ${suiteId}:`, e);
      }
    }
  }

  // Phase 2: Insert in transaction with pre-loaded data
  const tx = db.transaction(() => {
    for (const { suiteId, task } of taskData) {
      try {
        insert.run(
          String(task.id),
          suiteId,
          task.subject ?? null,
          task.description ?? null,
          task.status ?? "pending",
          task.owner ?? null,
          task.blocks ? JSON.stringify(task.blocks) : null,
          task.blockedBy ? JSON.stringify(task.blockedBy) : null,
          task.metadata?._internal ? 1 : 0,
        );
        count++;
      } catch (e) {
        console.error(`Failed to ingest task ${task.id} in ${suiteId}:`, e);
      }
    }
  });

  tx();
  return count;
}
