import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { PROJECTS_DIR } from "../utils/paths.ts";
import type { SessionsIndexFile } from "../utils/parse.ts";
import { safeParseJson } from "../utils/parse.ts";

type IndexData =
  | { type: "index"; dirPath: string; parsed: SessionsIndexFile }
  | { type: "fallback"; dirPath: string };

export async function ingestSessionsIndex(db: Database): Promise<number> {
  if (Bun.spawnSync(["test", "-d", PROJECTS_DIR], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) return 0;

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions
    (id, project_path, started_at, ended_at, message_count, duration_minutes, first_prompt, summary, git_branch, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateProject = db.prepare(`
    UPDATE projects SET last_session_date = ?, total_sessions = ?, total_messages = ?
    WHERE path = ?
  `);

  let count = 0;
  const projectAgg: Record<string, { latest: number; sessions: number; messages: number }> = {};

  let dirNames: string[];
  try { dirNames = [...new Glob("*/").scanSync({ cwd: PROJECTS_DIR, onlyFiles: false })]; } catch { return 0; }

  // Phase 1: Read all index files async before transaction
  const indexDataList: IndexData[] = [];
  for (const raw of dirNames) {
    const dirPath = PROJECTS_DIR + "/" + raw.replace(/\/$/, "");
    const indexPath = dirPath + "/sessions-index.json";

    if (await Bun.file(indexPath).exists()) {
      try {
        const text = await Bun.file(indexPath).text();
        const parsed = safeParseJson<SessionsIndexFile>(text);
        if (parsed?.entries) {
          indexDataList.push({ type: "index", dirPath, parsed });
        }
      } catch (e) {
        console.error(`Failed to parse ${indexPath}:`, e);
      }
    } else {
      indexDataList.push({ type: "fallback", dirPath });
    }
  }

  // Phase 2: Insert in transaction with pre-loaded data
  const tx = db.transaction(() => {
    for (const item of indexDataList) {
      if (item.type === "index") {
        for (const entry of item.parsed.entries) {
          try {
            const startedAt = typeof entry.created === "string"
              ? new Date(entry.created).getTime()
              : entry.created;
            const endedAt = typeof entry.modified === "string"
              ? new Date(entry.modified).getTime()
              : entry.modified;
            const duration = (endedAt - startedAt) / 60_000;
            const firstPrompt = entry.firstPrompt
              ? entry.firstPrompt.slice(0, 500)
              : null;

            insertSession.run(
              entry.sessionId,
              entry.projectPath || null,
              startedAt,
              endedAt,
              entry.messageCount ?? 0,
              Math.round(duration * 100) / 100,
              firstPrompt,
              entry.summary || null,
              entry.gitBranch || null,
              entry.isSidechain ? 1 : 0,
            );

            count++;

            if (entry.projectPath) {
              const agg = projectAgg[entry.projectPath] ??= { latest: 0, sessions: 0, messages: 0 };
              agg.sessions++;
              agg.messages += entry.messageCount ?? 0;
              if (endedAt > agg.latest) agg.latest = endedAt;
            }
          } catch (e) {
            console.error(`Failed to ingest session ${entry.sessionId}:`, e);
          }
        }
      } else {
        // Fallback: enumerate .jsonl files (sync, inside transaction)
        try {
          const files = [...new Glob("*.jsonl").scanSync(item.dirPath)];
          for (const file of files) {
            try {
              const sessionId = file.replace(".jsonl", "");
              const filePath = item.dirPath + "/" + file;
              const f = Bun.file(filePath);
              const mtime = f.lastModified;

              insertSession.run(
                sessionId,
                null,
                mtime,
                mtime,
                0,
                0,
                null,
                null,
                null,
                0,
              );

              count++;
            } catch (e) {
              console.error(`Failed to stat ${file}:`, e);
            }
          }
        } catch (e) {
          console.error(`Failed to enumerate ${item.dirPath}:`, e);
        }
      }
    }

    // Update project aggregates
    for (const [path, agg] of Object.entries(projectAgg)) {
      const dateStr = new Date(agg.latest).toISOString().slice(0, 10);
      updateProject.run(dateStr, agg.sessions, agg.messages, path);
    }
  });

  tx();
  return count;
}

