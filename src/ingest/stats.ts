import type { Database } from "bun:sqlite";
import { STATS_FILE } from "../utils/paths.ts";
import { parseJsonFile, type StatsCache } from "../utils/parse.ts";

export async function ingestStats(db: Database): Promise<number> {
  const insert = db.query(`
    INSERT OR REPLACE INTO daily_stats (date, message_count, session_count, tool_call_count)
    VALUES (?, ?, ?, ?)
  `);

  let count = 0;

  // Phase 1: Import from Claude's stats-cache.json (may be stale)
  if (await Bun.file(STATS_FILE).exists()) {
    const stats = await parseJsonFile<StatsCache>(STATS_FILE);
    if (stats?.dailyActivity?.length) {
      const tx = db.transaction(() => {
        for (const day of stats.dailyActivity) {
          insert.run(day.date, day.messageCount ?? 0, day.sessionCount ?? 0, day.toolCallCount ?? 0);
          count++;
        }
      });
      tx();
    }
  }

  // Phase 1b: Import modelUsage
  if (await Bun.file(STATS_FILE).exists()) {
    const stats = await parseJsonFile<StatsCache>(STATS_FILE);
    if (stats?.modelUsage) {
      const insertModel = db.query(`INSERT OR REPLACE INTO model_usage (model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, web_search_requests, cost_usd, context_window, max_output_tokens) VALUES (?,?,?,?,?,?,?,?,?)`);
      const tx = db.transaction(() => {
        for (const [model, u] of Object.entries(stats.modelUsage)) {
          insertModel.run(model, u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadInputTokens ?? 0, u.cacheCreationInputTokens ?? 0, u.webSearchRequests ?? 0, u.costUSD ?? 0, u.contextWindow ?? 0, u.maxOutputTokens ?? 0);
        }
      });
      tx();
    }
    // Phase 1c: Import dailyModelTokens
    if (stats?.dailyModelTokens) {
      const insertDMT = db.query(`INSERT OR REPLACE INTO daily_model_tokens (date, model, tokens) VALUES (?,?,?)`);
      const tx = db.transaction(() => {
        for (const entry of stats.dailyModelTokens as { date: string; tokensByModel: Record<string, number> }[]) {
          if (!entry?.date || !entry?.tokensByModel) continue;
          for (const [model, tokens] of Object.entries(entry.tokensByModel)) {
            insertDMT.run(entry.date, model, tokens);
          }
        }
      });
      tx();
    }
  }

  // Phase 2: Fill gaps from session data (covers dates after stats-cache stopped updating)
  const gaps = db.query(`
    SELECT SUBSTR(datetime(s.started_at/1000, 'unixepoch', 'localtime'), 1, 10) as date,
           COUNT(DISTINCT cm.session_id) as session_count,
           COUNT(CASE WHEN cm.type IN ('user','assistant') THEN 1 END) as message_count,
           COUNT(CASE WHEN cm.tool_name IS NOT NULL THEN 1 END) as tool_call_count
    FROM sessions s
    LEFT JOIN conversation_messages cm ON cm.session_id = s.id
    WHERE s.started_at > 0
      AND SUBSTR(datetime(s.started_at/1000, 'unixepoch', 'localtime'), 1, 10) NOT IN (SELECT date FROM daily_stats)
    GROUP BY date
    ORDER BY date
  `).all() as { date: string; session_count: number; message_count: number; tool_call_count: number }[];

  if (gaps.length > 0) {
    const tx = db.transaction(() => {
      for (const g of gaps) {
        insert.run(g.date, g.message_count, g.session_count, g.tool_call_count);
        count++;
      }
    });
    tx();
  }

  return count;
}
