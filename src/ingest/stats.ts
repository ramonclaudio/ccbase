import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { STATS_FILE, CLAUDE_CONFIG, FACETS_DIR } from "../utils/paths.ts";
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

  // Phase 1d: Import longestSession and hourCounts from stats-cache
  if (await Bun.file(STATS_FILE).exists()) {
    const stats = await parseJsonFile<StatsCache>(STATS_FILE);
    if (stats) {
      const insertMeta = db.query(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`);
      const tx = db.transaction(() => {
        if (stats.longestSession) insertMeta.run("longest_session", JSON.stringify(stats.longestSession));
        if (stats.hourCounts) insertMeta.run("hour_counts", JSON.stringify(stats.hourCounts));
        if (stats.totalSessions) insertMeta.run("stats_total_sessions", String(stats.totalSessions));
        if (stats.totalMessages) insertMeta.run("stats_total_messages", String(stats.totalMessages));
        if (stats.firstSessionDate) insertMeta.run("first_session_date", String(stats.firstSessionDate));
        if (stats.totalSpeculationTimeSavedMs) insertMeta.run("total_speculation_time_saved_ms", String(stats.totalSpeculationTimeSavedMs));
      });
      tx();
    }
  }

  // Phase 1e: Import toolUsage, skillUsage, and app meta from .claude.json
  if (await Bun.file(CLAUDE_CONFIG).exists()) {
    const config = await parseJsonFile<Record<string, unknown>>(CLAUDE_CONFIG);
    if (config) {
      const insertTool = db.query(`INSERT OR REPLACE INTO tool_usage (tool, usage_count, last_used_at) VALUES (?, ?, ?)`);
      const insertSkill = db.query(`INSERT OR REPLACE INTO skill_usage (skill, usage_count, last_used_at) VALUES (?, ?, ?)`);
      const insertMeta = db.query(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`);
      const tx = db.transaction(() => {
        const tu = config.toolUsage as Record<string, { usageCount: number; lastUsedAt: number }> | undefined;
        if (tu) for (const [tool, v] of Object.entries(tu)) insertTool.run(tool, v.usageCount ?? 0, v.lastUsedAt ?? 0);
        const su = config.skillUsage as Record<string, { usageCount: number; lastUsedAt: number }> | undefined;
        if (su) for (const [skill, v] of Object.entries(su)) insertSkill.run(skill, v.usageCount ?? 0, v.lastUsedAt ?? 0);
        if (config.numStartups) insertMeta.run("num_startups", String(config.numStartups));
        if (config.firstStartTime) insertMeta.run("first_start_time", String(config.firstStartTime));
        if (config.claudeCodeFirstTokenDate) insertMeta.run("first_token_date", String(config.claudeCodeFirstTokenDate));
        if (config.installMethod) insertMeta.run("install_method", String(config.installMethod));
        // GitHub repo paths
        const ghPaths = config.githubRepoPaths as Record<string, string[]> | undefined;
        if (ghPaths) {
          const insertRepo = db.query(`INSERT OR REPLACE INTO github_repos (repo, local_path) VALUES (?, ?)`);
          for (const [repo, paths] of Object.entries(ghPaths)) {
            for (const p of paths) insertRepo.run(repo, p);
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

  // Phase 2b: Compute file-history and paste-cache stats
  try {
    const fs = require("fs");
    const fhDir = process.env.HOME + "/.claude/file-history/";
    const pcDir = process.env.HOME + "/.claude/paste-cache/";
    const insertMeta = db.query(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`);
    if (fs.existsSync(fhDir)) {
      const sessions = fs.readdirSync(fhDir);
      let totalVersions = 0;
      for (const s of sessions) {
        try { totalVersions += fs.readdirSync(fhDir + s).length; } catch {}
      }
      insertMeta.run("file_history_sessions", String(sessions.length));
      insertMeta.run("file_history_versions", String(totalVersions));
    }
    if (fs.existsSync(pcDir)) {
      const files = fs.readdirSync(pcDir);
      insertMeta.run("paste_cache_files", String(files.length));
    }
  } catch { /* optional */ }

  // Phase 3: Import session facets from ~/.claude/usage-data/facets/
  try {
    const facetFiles = [...new Glob("*.json").scanSync(FACETS_DIR)];
    if (facetFiles.length) {
      const insertFacet = db.query(`INSERT OR REPLACE INTO session_facets (session_id, outcome, claude_helpfulness, session_type, underlying_goal, brief_summary, primary_success, friction_detail, goal_categories, friction_counts, user_satisfaction_counts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const tx = db.transaction(() => {
        for (const file of facetFiles) {
          try {
            const text = require("fs").readFileSync(FACETS_DIR + "/" + file, "utf-8");
            const f = JSON.parse(text) as Record<string, unknown>;
            insertFacet.run(
              (f.session_id as string) || file.replace(".json", ""),
              (f.outcome as string) ?? null,
              (f.claude_helpfulness as string) ?? null,
              (f.session_type as string) ?? null,
              (f.underlying_goal as string) ?? null,
              (f.brief_summary as string) ?? null,
              (f.primary_success as string) ?? null,
              (f.friction_detail as string) ?? null,
              f.goal_categories ? JSON.stringify(f.goal_categories) : null,
              f.friction_counts ? JSON.stringify(f.friction_counts) : null,
              f.user_satisfaction_counts ? JSON.stringify(f.user_satisfaction_counts) : null,
            );
          } catch { continue; }
        }
      });
      tx();
    }
  } catch { /* facets dir may not exist */ }

  return count;
}
