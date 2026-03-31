import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { STATS_FILE, CLAUDE_CONFIG, CLAUDE_HOME, FACETS_DIR } from "../utils/paths.ts";
import { parseJsonFile, type StatsCache } from "../utils/parse.ts";

export async function ingestStats(db: Database): Promise<number> {
  const insertMeta = db.query(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`);
  const insertRepo = db.query(`INSERT OR REPLACE INTO github_repos (repo, local_path) VALUES (?, ?)`);
  const insertFacet = db.query(`INSERT OR REPLACE INTO session_facets (session_id, outcome, claude_helpfulness, session_type, underlying_goal, brief_summary, primary_success, friction_detail, goal_categories, friction_counts, user_satisfaction_counts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  let count = 0;

  // Phase 1: stats-cache.json (app meta only)
  if (await Bun.file(STATS_FILE).exists()) {
    const stats = await parseJsonFile<StatsCache>(STATS_FILE);
    if (stats) {
      db.transaction(() => {
        if (stats.longestSession) insertMeta.run("longest_session", JSON.stringify(stats.longestSession));
        if (stats.firstSessionDate) insertMeta.run("first_session_date", String(stats.firstSessionDate));
      })();
    }
  }

  // Phase 2: .claude.json (app meta, pricing, repos)
  if (await Bun.file(CLAUDE_CONFIG).exists()) {
    const config = await parseJsonFile<Record<string, unknown>>(CLAUDE_CONFIG);
    if (config) {
      db.transaction(() => {
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

  // Phase 3: File-history and paste-cache stats
  try {
    const fhDir = CLAUDE_HOME + "/file-history/";
    const pcDir = CLAUDE_HOME + "/paste-cache/";
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
