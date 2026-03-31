import { getDb } from "../db/connection.ts";
import { safeFts } from "../db/queries.ts";
import { projectName } from "../utils/paths.ts";
import { dim, cyan, truncate } from "../utils/format.ts";

export function searchCommand(args: string[]): void {
  const query = args.join(" ").trim();
  if (!query) {
    console.error("Usage: search <query>");
    return;
  }

  const db = getDb();

  try {
    const results = db.query(
      `SELECT cm.timestamp, s.project_path, SUBSTR(cm.content, 1, 200) as display
       FROM conversation_fts f
       JOIN conversation_messages cm ON cm.id = f.rowid
       LEFT JOIN sessions s ON s.id = cm.session_id
       WHERE conversation_fts MATCH ?
       ORDER BY cm.timestamp DESC
       LIMIT 20`,
    ).all(safeFts(query)) as { timestamp: string | null; project_path: string | null; display: string | null }[];

    if (results.length === 0) {
      console.log(dim("No results."));
      return;
    }

    for (const r of results) {
      const ts = r.timestamp ? new Date(Number(r.timestamp) / 1000).toLocaleString() : "?";
      const proj = r.project_path ? cyan(projectName(r.project_path)) : dim("unknown");
      const text = r.display ? truncate(r.display.replace(/\n/g, " "), 80) : dim("(empty)");
      console.log(`${dim(ts)}  ${proj}  ${text}`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
}
