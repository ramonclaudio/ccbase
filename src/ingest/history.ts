import type { Database } from "bun:sqlite";
import { HISTORY_FILE } from "../utils/paths.ts";
import { decodeProjectPath } from "../utils/paths.ts";
import type { HistoryEntry } from "../utils/parse.ts";
import { safeParseJson } from "../utils/parse.ts";

export async function ingestHistory(db: Database): Promise<number> {
  if (!await Bun.file(HISTORY_FILE).exists()) return 0;

  const text = await Bun.file(HISTORY_FILE).text();
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO history_messages (session_id, project_path, display, timestamp, has_paste)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;

  const tx = db.transaction(() => {
    for (const line of lines) {
      try {
        const entry = safeParseJson<HistoryEntry>(line);
        if (!entry?.display) continue;

        const projectPath = entry.project ? decodeProjectPath(entry.project) : null;
        const hasPaste =
          entry.pastedContents && Object.keys(entry.pastedContents).length > 0 ? 1 : 0;

        insert.run(
          entry.sessionId || null,
          projectPath,
          entry.display,
          entry.timestamp ?? null,
          hasPaste,
        );

        count++;
      } catch (e) {
        console.error("Failed to parse history line:", e);
      }
    }
  });

  tx();

  // Rebuild FTS after data is committed
  db.exec("INSERT INTO history_fts(history_fts) VALUES('rebuild')");

  return count;
}
