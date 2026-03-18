import type { Database } from "bun:sqlite";
import { CLAUDE_CONFIG } from "../utils/paths.ts";
import { parseJsonFile, type RootConfig } from "../utils/parse.ts";

export async function ingestRootConfig(db: Database): Promise<number> {
  if (!await Bun.file(CLAUDE_CONFIG).exists()) return 0;

  const config = await parseJsonFile<RootConfig>(CLAUDE_CONFIG);
  if (!config?.projects) return 0;

  const update = db.query(`
    UPDATE sessions
    SET cost_usd = ?, input_tokens = ?, output_tokens = ?, lines_added = ?, lines_removed = ?,
        api_duration_ms = ?, tool_duration_ms = ?,
        total_cache_read_tokens = ?, total_cache_creation_tokens = ?,
        total_web_search_requests = ?
    WHERE id = ?
  `);

  let count = 0;

  const tx = db.transaction(() => {
    for (const [, project] of Object.entries(config.projects)) {
      try {
        if (!project.lastSessionId) continue;

        update.run(
          project.lastCost ?? null,
          project.lastTotalInputTokens ?? null,
          project.lastTotalOutputTokens ?? null,
          project.lastLinesAdded ?? null,
          project.lastLinesRemoved ?? null,
          project.lastAPIDuration ?? null,
          (project as Record<string, unknown>).lastToolDuration ?? null,
          project.lastTotalCacheReadInputTokens ?? null,
          project.lastTotalCacheCreationInputTokens ?? null,
          project.lastTotalWebSearchRequests ?? null,
          project.lastSessionId,
        );

        count++;
      } catch (e) {
        console.error(`Failed to update session cost:`, e);
      }
    }
  });

  tx();
  return count;
}
