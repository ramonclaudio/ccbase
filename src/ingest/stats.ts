import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { STATS_FILE, CLAUDE_CONFIG, FACETS_DIR } from "../utils/paths.ts";
import { parseJsonFile, type StatsCache } from "../utils/parse.ts";

export async function ingestStats(db: Database): Promise<number> {
  const insertDaily = db.query(`INSERT OR REPLACE INTO daily_stats (date, message_count, session_count, tool_call_count) VALUES (?, ?, ?, ?)`);
  const insertModel = db.query(`INSERT OR REPLACE INTO model_usage (model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, web_search_requests, cost_usd, context_window, max_output_tokens) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertDMT = db.query(`INSERT OR REPLACE INTO daily_model_tokens (date, model, tokens) VALUES (?,?,?)`);
  const insertMeta = db.query(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`);
  const insertTool = db.query(`INSERT OR REPLACE INTO tool_usage (tool, usage_count, last_used_at) VALUES (?, ?, ?)`);
  const insertSkill = db.query(`INSERT OR REPLACE INTO skill_usage (skill, usage_count, last_used_at) VALUES (?, ?, ?)`);
  const insertRepo = db.query(`INSERT OR REPLACE INTO github_repos (repo, local_path) VALUES (?, ?)`);
  const insertFacet = db.query(`INSERT OR REPLACE INTO session_facets (session_id, outcome, claude_helpfulness, session_type, underlying_goal, brief_summary, primary_success, friction_detail, goal_categories, friction_counts, user_satisfaction_counts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  let count = 0;

  // Phase 1: stats-cache.json (single read for all sub-phases)
  if (await Bun.file(STATS_FILE).exists()) {
    const stats = await parseJsonFile<StatsCache>(STATS_FILE);
    if (stats) {
      db.transaction(() => {
        // Daily activity
        if (stats.dailyActivity?.length) {
          for (const day of stats.dailyActivity) {
            insertDaily.run(day.date, day.messageCount ?? 0, day.sessionCount ?? 0, day.toolCallCount ?? 0);
            count++;
          }
        }
        // Model usage
        if (stats.modelUsage) {
          for (const [model, u] of Object.entries(stats.modelUsage)) {
            insertModel.run(model, u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadInputTokens ?? 0, u.cacheCreationInputTokens ?? 0, u.webSearchRequests ?? 0, u.costUSD ?? 0, u.contextWindow ?? 0, u.maxOutputTokens ?? 0);
          }
        }
        // Daily model tokens
        if (stats.dailyModelTokens) {
          for (const entry of stats.dailyModelTokens as { date: string; tokensByModel: Record<string, number> }[]) {
            if (!entry?.date || !entry?.tokensByModel) continue;
            for (const [model, tokens] of Object.entries(entry.tokensByModel)) {
              insertDMT.run(entry.date, model, tokens);
            }
          }
        }
        // App meta from stats
        if (stats.longestSession) insertMeta.run("longest_session", JSON.stringify(stats.longestSession));
        if (stats.hourCounts) insertMeta.run("hour_counts", JSON.stringify(stats.hourCounts));
        if (stats.totalSessions) insertMeta.run("stats_total_sessions", String(stats.totalSessions));
        if (stats.totalMessages) insertMeta.run("stats_total_messages", String(stats.totalMessages));
        if (stats.firstSessionDate) insertMeta.run("first_session_date", String(stats.firstSessionDate));
        if (stats.totalSpeculationTimeSavedMs) insertMeta.run("total_speculation_time_saved_ms", String(stats.totalSpeculationTimeSavedMs));
      })();
    }
  }

  // Phase 2: .claude.json (single read)
  if (await Bun.file(CLAUDE_CONFIG).exists()) {
    const config = await parseJsonFile<Record<string, unknown>>(CLAUDE_CONFIG);
    if (config) {
      db.transaction(() => {
        const tu = config.toolUsage as Record<string, { usageCount: number; lastUsedAt: number }> | undefined;
        if (tu) for (const [tool, v] of Object.entries(tu)) insertTool.run(tool, v.usageCount ?? 0, v.lastUsedAt ?? 0);
        const su = config.skillUsage as Record<string, { usageCount: number; lastUsedAt: number }> | undefined;
        if (su) for (const [skill, v] of Object.entries(su)) insertSkill.run(skill, v.usageCount ?? 0, v.lastUsedAt ?? 0);
        if (config.numStartups) insertMeta.run("num_startups", String(config.numStartups));
        if (config.firstStartTime) insertMeta.run("first_start_time", String(config.firstStartTime));
        if (config.claudeCodeFirstTokenDate) insertMeta.run("first_token_date", String(config.claudeCodeFirstTokenDate));
        if (config.installMethod) insertMeta.run("install_method", String(config.installMethod));
        const pricing = {
          "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, context: 200000, display: "Opus 4.6" },
          "claude-opus-4-5-20251101": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, context: 200000, display: "Opus 4.5" },
          "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, context: 200000, display: "Sonnet 4.6" },
          "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, context: 200000, display: "Sonnet 4.5" },
          "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, context: 200000, display: "Haiku 4.5" },
        };
        insertMeta.run("model_pricing", JSON.stringify(pricing));
        const ghPaths = config.githubRepoPaths as Record<string, string[]> | undefined;
        if (ghPaths) for (const [repo, paths] of Object.entries(ghPaths)) for (const p of paths) insertRepo.run(repo, p);
      })();
    }
  }

  // Phase 3: Fill gaps from session data
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
    db.transaction(() => {
      for (const g of gaps) { insertDaily.run(g.date, g.message_count, g.session_count, g.tool_call_count); count++; }
    })();
  }

  // Phase 4: File-history and paste-cache stats
  try {
    const fhDir = process.env.HOME + "/.claude/file-history/";
    const pcDir = process.env.HOME + "/.claude/paste-cache/";
    if (existsSync(fhDir)) {
      const sessions = readdirSync(fhDir);
      let totalVersions = 0;
      for (const s of sessions) { try { totalVersions += readdirSync(fhDir + s).length; } catch {} }
      insertMeta.run("file_history_sessions", String(sessions.length));
      insertMeta.run("file_history_versions", String(totalVersions));
    }
    if (existsSync(pcDir)) insertMeta.run("paste_cache_files", String(readdirSync(pcDir).length));
  } catch { /* optional */ }

  // Phase 5: Session facets
  try {
    const facetFiles = [...new Glob("*.json").scanSync(FACETS_DIR)];
    if (facetFiles.length) {
      db.transaction(() => {
        for (const file of facetFiles) {
          try {
            const f = JSON.parse(readFileSync(FACETS_DIR + "/" + file, "utf-8")) as Record<string, unknown>;
            insertFacet.run(
              (f.session_id as string) || file.replace(".json", ""),
              (f.outcome as string) ?? null, (f.claude_helpfulness as string) ?? null,
              (f.session_type as string) ?? null, (f.underlying_goal as string) ?? null,
              (f.brief_summary as string) ?? null, (f.primary_success as string) ?? null,
              (f.friction_detail as string) ?? null,
              f.goal_categories ? JSON.stringify(f.goal_categories) : null,
              f.friction_counts ? JSON.stringify(f.friction_counts) : null,
              f.user_satisfaction_counts ? JSON.stringify(f.user_satisfaction_counts) : null,
            );
          } catch { continue; }
        }
      })();
    }
  } catch { /* facets dir may not exist */ }

  return count;
}
