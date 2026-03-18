import { getDb } from "../db/connection.ts";
import { safeFts, type Row, type QueryFn } from "../db/queries.ts";
import { today, billingBlockStart, TZ_OFFSET_SEC } from "../utils/dates.ts";
import { highlight } from "../utils/highlight.ts";

const EXT_LANG: Record<string, string> = {
  ts:"ts",tsx:"tsx",js:"js",jsx:"jsx",mjs:"js",cjs:"js",mts:"ts",cts:"ts",
  py:"py",sh:"bash",bash:"bash",zsh:"bash",
  sql:"sql",json:"json",jsonc:"json",css:"css",scss:"css",
  go:"go",rs:"rs",yaml:"yaml",yml:"yaml",toml:"toml",
  swift:"",kt:"",rb:"py",html:"",htm:"",md:"",txt:"",
};

function renderEditDiff(seg: string): string | null {
  const body = seg.replace(/<tool_use[^>]*>/, "").replace(/<\/tool_use>$/, "").trim();
  try {
    const d = JSON.parse(body);
    if (!d.file_path || typeof d.old_string !== "string" || typeof d.new_string !== "string") return null;

    const fileName = d.file_path.split("/").pop() || d.file_path;
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const lang = EXT_LANG[ext] || "";
    const hl = (s: string) => highlight(s, lang);

    const oL = d.old_string.split("\n");
    const nL = d.new_string.split("\n");

    let pre = 0;
    while (pre < oL.length && pre < nL.length && oL[pre] === nL[pre]) pre++;
    let suf = 0;
    while (suf < oL.length - pre && suf < nL.length - pre &&
           oL[oL.length - 1 - suf] === nL[nL.length - 1 - suf]) suf++;

    const ctx1 = oL.slice(0, pre);
    const removed = oL.slice(pre, oL.length - suf);
    const added = nL.slice(pre, nL.length - suf);
    const ctx2 = suf > 0 ? oL.slice(oL.length - suf) : [];

    let h = `<div class="diff-header"><span class="diff-file">${Bun.escapeHTML(fileName)}</span><span class="diff-stats">`;
    if (added.length) h += `<span class="diff-stat-add">+${added.length}</span>`;
    if (removed.length) h += `<span class="diff-stat-del">-${removed.length}</span>`;
    h += `</span></div>`;

    const ln = (cls: string, sign: string, code: string) =>
      `<div class="diff-line ${cls}"><span class="diff-sign">${sign}</span>${hl(code)}</div>`;
    for (const l of ctx1) h += ln("diff-ctx", " ", l);
    for (const l of removed) h += ln("diff-del", "-", l);
    for (const l of added) h += ln("diff-add", "+", l);
    for (const l of ctx2) h += ln("diff-ctx", " ", l);

    return `<tool_use name="Edit" html="1" file="${Bun.escapeHTML(fileName)}">${h}</tool_use>`;
  } catch {
    return null;
  }
}

interface ConversationAgg { sessions: number; total_lines: number; messages: number; tool_calls: number; thinking_blocks: number; sidechain_msgs: number; subagents: number; errors: number; plan_sessions: number; inp: number; outp: number; plan_value: number; cache_read_tokens: number; total_input: number; web_searches: number }
interface SessionAgg { total_lines: number; total_minutes: number }
interface HistoryAgg { paste_rate: number; rewinds: number }
interface CountRow { n: number }

const PAGES_DIR = import.meta.dir + "/../pages";
const CORS = { "access-control-allow-origin": "*" } as const;
const STRIP_XML_RE = /<(thinking|tool_use|tool_result)[^>]*>[\s\S]*?<\/\1>/g;

const SQL_CONV_AGG = `SELECT
  COUNT(DISTINCT session_id) as sessions,
  COUNT(*) as total_lines,
  COUNT(CASE WHEN type IN ('user','assistant') THEN 1 END) as messages,
  COUNT(CASE WHEN tool_name IS NOT NULL THEN 1 END) as tool_calls,
  COUNT(CASE WHEN has_thinking=1 THEN 1 END) as thinking_blocks,
  COUNT(CASE WHEN is_sidechain=1 THEN 1 END) as sidechain_msgs,
  COUNT(DISTINCT CASE WHEN agent_id IS NOT NULL THEN agent_id END) as subagents,
  COUNT(CASE WHEN is_error=1 THEN 1 END) as errors,
  COUNT(DISTINCT CASE WHEN tool_name='EnterPlanMode' THEN session_id END) as plan_sessions,
  SUM(COALESCE(input_tokens,0)) as inp,
  SUM(COALESCE(output_tokens,0)) as outp,
  ROUND(SUM(CASE
    WHEN model LIKE '%opus%' THEN COALESCE(input_tokens,0)/1e6*15+COALESCE(output_tokens,0)/1e6*75
    WHEN model LIKE '%sonnet%' THEN COALESCE(input_tokens,0)/1e6*3+COALESCE(output_tokens,0)/1e6*15
    WHEN model LIKE '%haiku%' THEN COALESCE(input_tokens,0)/1e6*1+COALESCE(output_tokens,0)/1e6*5
    ELSE COALESCE(input_tokens,0)/1e6*3+COALESCE(output_tokens,0)/1e6*15
  END),2) as plan_value,
  SUM(COALESCE(cache_read_tokens,0)) as cache_read_tokens,
  SUM(COALESCE(input_tokens,0)) as total_input,
  SUM(COALESCE(web_search_count,0)) as web_searches
FROM conversation_messages`;

const SQL_SESS_AGG = `SELECT
  SUM(COALESCE(lines_added,0))+SUM(COALESCE(lines_removed,0)) as total_lines,
  COALESCE(SUM(CASE WHEN duration_minutes>0 THEN duration_minutes END),0) as total_minutes
FROM sessions`;

const SQL_HIST_AGG = `SELECT
  ROUND(SUM(has_paste)*100.0/COUNT(*),1) as paste_rate,
  SUM(CASE WHEN display LIKE '%/rewind%' THEN 1 ELSE 0 END) as rewinds
FROM history_messages`;

const statsCache = { data: null as Record<string, unknown> | null, ts: 0 };

function getStats(q: QueryFn): Record<string, unknown> {
  const now = Date.now();
  if (statsCache.data && now - statsCache.ts < 5000) return statsCache.data;

  const cm = q(SQL_CONV_AGG)[0] as ConversationAgg;
  const sess = q(SQL_SESS_AGG)[0] as SessionAgg;
  const hist = q(SQL_HIST_AGG)[0] as HistoryAgg;

  const cacheHitPct = cm.total_input > 0
    ? Math.round(cm.cache_read_tokens * 100 / cm.total_input * 10) / 10
    : 0;

  const latencyRows = q(`SELECT (MIN(a.timestamp) - u.timestamp) as latency_ms FROM conversation_messages u JOIN conversation_messages a ON a.session_id=u.session_id AND a.role='assistant' AND a.timestamp>u.timestamp WHERE u.role='user' AND u.type='user' AND u.content NOT LIKE '<tool_%' GROUP BY u.id HAVING latency_ms>0 AND latency_ms<600000`) as { latency_ms: number }[];
  const avgTurnLatency = latencyRows.length
    ? Math.round(latencyRows.reduce((s, r) => s + r.latency_ms, 0) / latencyRows.length)
    : 0;

  statsCache.data = {
    sessions: { n: cm.sessions },
    messages: { n: cm.messages },
    totalConvLines: { n: cm.total_lines },
    commits: q(`SELECT COUNT(*) as n FROM commits`)[0],
    projects: q(`SELECT COUNT(*) as n FROM projects`)[0],
    tasks: q(`SELECT status,COUNT(*) as n FROM tasks GROUP BY status`),
    planValue: { n: cm.plan_value },
    totalTokens: { n: cm.inp + cm.outp },
    totalLines: { n: sess.total_lines },
    totalMinutes: { n: sess.total_minutes },
    toolCalls: { n: cm.tool_calls },
    thinkingBlocks: { n: cm.thinking_blocks },
    sidechainMsgs: { n: cm.sidechain_msgs },
    subagents: { n: cm.subagents },
    errors: { n: cm.errors },
    pasteRate: { n: hist.paste_rate },
    planSessions: { n: cm.plan_sessions },
    rewinds: { n: hist.rewinds },
    cacheHitPct: { n: cacheHitPct },
    webSearches: { n: cm.web_searches },
    avgTurnLatency: { n: avgTurnLatency },
    today: today(),
  };
  statsCache.ts = now;
  return statsCache.data;
}

const streaksCache = { data: null as Record<string, unknown> | null, ts: 0 };

/** Check if two YYYY-MM-DD date strings are consecutive calendar days. */
function isConsecutiveDay(a: string, b: string): boolean {
  const d = new Date(a + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10) === b;
}

function computeStreaks(q: QueryFn): Record<string, unknown> {
  const now = Date.now();
  if (streaksCache.data && now - streaksCache.ts < 5000) return streaksCache.data;
  const days = q(`SELECT date FROM daily_stats ORDER BY date`) as { date: string }[];
  if (!days.length) return { current: 0, longest: 0, longestStart: "", longestEnd: "", totalDays: 0 };

  let longest = 1, longestStart = 0, longestEnd = 0, run = 1, runStart = 0;
  for (let i = 1; i < days.length; i++) {
    if (isConsecutiveDay(days[i - 1].date, days[i].date)) {
      run++;
    } else {
      if (run > longest) { longest = run; longestStart = runStart; longestEnd = i - 1; }
      run = 1; runStart = i;
    }
  }
  if (run > longest) { longest = run; longestStart = runStart; longestEnd = days.length - 1; }

  const t = today();
  let curStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (i === days.length - 1 && days[i].date !== t && !isConsecutiveDay(days[i].date, t)) break;
    if (i < days.length - 1 && !isConsecutiveDay(days[i].date, days[i + 1].date)) break;
    curStreak++;
  }
  streaksCache.data = { current: curStreak, longest, longestStart: days[longestStart].date, longestEnd: days[longestEnd].date, totalDays: days.length };
  streaksCache.ts = now;
  return streaksCache.data;
}

export function serveCommand(args: string[]): void {
  const port = parseInt(args.find(a => /^\d+$/.test(a)) || "3000");
  const db = getDb();
  const q: QueryFn = (sql, ...p) => db.query(sql).all(...p) as Row[];

  Bun.serve({
    port,
    development: true,
    routes: {
      "/": Bun.file(PAGES_DIR + "/dashboard.html"),
      "/chat": Bun.file(PAGES_DIR + "/chat.html"),

      "/api/stats": () => Response.json(getStats(q), { headers: CORS }),
      "/api/daily": () => Response.json(q(`SELECT date,session_count,message_count,tool_call_count FROM daily_stats ORDER BY date`), { headers: CORS }),
      "/api/projects": () => Response.json(q(`SELECT p.*,g.dirty_file_count,g.stash_count,g.branch_count,g.current_branch FROM projects p LEFT JOIN project_git_state g ON g.project_path=p.path ORDER BY p.total_commits DESC`), { headers: CORS }),
      "/api/tasks": () => Response.json(q(`SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,suite_id`), { headers: CORS }),
      "/api/commits": () => Response.json(q(`SELECT hash,project_path,date,message,commit_type,commit_scope FROM commits ORDER BY date DESC LIMIT 200`), { headers: CORS }),
      "/api/hours": () => Response.json(q(`SELECT CAST(((started_at/1000+?1)%86400)/3600 AS INTEGER) as hour,COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`, TZ_OFFSET_SEC), { headers: CORS }),
      "/api/project-sessions": () => Response.json(q(`SELECT project_path,COUNT(*) as sessions,ROUND(SUM(duration_minutes)) as minutes,SUM(COALESCE(lines_added,0)) as added,SUM(COALESCE(lines_removed,0)) as removed,SUM(COALESCE(cost_usd,0)) as cost,SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY sessions DESC LIMIT 20`), { headers: CORS }),
      "/api/commit-types": () => Response.json(q(`SELECT commit_type,COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type!='' GROUP BY commit_type ORDER BY n DESC LIMIT 10`), { headers: CORS }),
      "/api/duration-dist": () => Response.json(q(`SELECT CASE WHEN duration_minutes<1 THEN '<1m' WHEN duration_minutes<5 THEN '1-5m' WHEN duration_minutes<15 THEN '5-15m' WHEN duration_minutes<30 THEN '15-30m' WHEN duration_minutes<60 THEN '30-60m' WHEN duration_minutes<120 THEN '1-2h' WHEN duration_minutes<240 THEN '2-4h' ELSE '4h+' END as bucket,COUNT(*) as n FROM sessions GROUP BY bucket ORDER BY MIN(duration_minutes)`), { headers: CORS }),
      "/api/branches": () => Response.json(q(`SELECT git_branch,COUNT(*) as n FROM sessions WHERE git_branch IS NOT NULL AND git_branch!='' GROUP BY git_branch ORDER BY n DESC LIMIT 15`), { headers: CORS }),
      "/api/usage-by-project": () => Response.json(q(`SELECT project_path,SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp,COUNT(*) as sessions FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY (inp+outp) DESC LIMIT 15`), { headers: CORS }),
      "/api/lines-by-day": () => Response.json(q(`SELECT SUBSTR(date,1,10) as d,SUM(CASE WHEN commit_type='feat' THEN 1 ELSE 0 END) as feats,SUM(CASE WHEN commit_type='fix' THEN 1 ELSE 0 END) as fixes,COUNT(*) as total FROM commits GROUP BY d ORDER BY d`), { headers: CORS }),
      "/api/git-state": () => Response.json(q(`SELECT project_path,dirty_file_count,stash_count,branch_count,current_branch FROM project_git_state WHERE dirty_file_count>0 OR stash_count>0 ORDER BY dirty_file_count DESC`), { headers: CORS }),
      "/api/tokens-by-model": () => Response.json(q(`SELECT model,COUNT(*) as msgs,SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp,SUM(has_thinking) as thinking_msgs,ROUND(AVG(CASE WHEN thinking_length>0 THEN thinking_length END)) as avg_think_len,MAX(thinking_length) as max_think_len,SUM(is_error) as errors FROM conversation_messages WHERE model IS NOT NULL AND model!='<synthetic>' GROUP BY model ORDER BY (inp+outp) DESC`), { headers: CORS }),
      "/api/agents": () => Response.json(q(`SELECT agent_id,COUNT(*) as msgs,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) as tokens FROM conversation_messages WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY msgs DESC LIMIT 20`), { headers: CORS }),
      "/api/message-types": () => Response.json(q(`SELECT raw_type,COUNT(*) as n FROM conversation_messages GROUP BY raw_type ORDER BY n DESC`), { headers: CORS }),
      "/api/tool-errors": () => Response.json(q(`SELECT tool_name,COUNT(*) as calls,SUM(is_error) as errors,ROUND(SUM(is_error)*100.0/COUNT(*),1) as error_pct FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY calls DESC LIMIT 20`), { headers: CORS }),
      "/api/commit-scopes": () => Response.json(q(`SELECT commit_type,commit_scope,COUNT(*) as n FROM commits WHERE commit_scope IS NOT NULL AND commit_scope!='' GROUP BY commit_type,commit_scope ORDER BY n DESC LIMIT 20`), { headers: CORS }),
      "/api/pr-links": () => Response.json(q(`SELECT content,timestamp FROM conversation_messages WHERE raw_type='pr-link' ORDER BY timestamp DESC`), { headers: CORS }),
      "/api/session-summaries": () => Response.json(q(`SELECT id,summary,first_prompt,project_path,duration_minutes,message_count FROM sessions WHERE summary IS NOT NULL AND summary!='' ORDER BY started_at DESC LIMIT 50`), { headers: CORS }),
      "/api/paste-stats": () => Response.json(q(`SELECT COUNT(*) as total,SUM(has_paste) as with_paste,ROUND(SUM(has_paste)*100.0/COUNT(*),1) as pct FROM history_messages`)[0], { headers: CORS }),
      "/api/project-staleness": () => Response.json(q(`SELECT name,type,path,last_commit_date,last_session_date,total_commits,total_sessions FROM projects ORDER BY COALESCE(last_commit_date,last_session_date,'1970') DESC`), { headers: CORS }),
      "/api/streaks": () => Response.json(computeStreaks(q), { headers: CORS }),
      "/api/billing-blocks": () => {
        const blocks = q(`SELECT *, CASE WHEN block_start = ? THEN 1 ELSE 0 END as is_current FROM billing_blocks ORDER BY block_start DESC LIMIT 20`, billingBlockStart(Date.now()));
        return Response.json(blocks, { headers: CORS });
      },
      "/api/plan-mode": () => Response.json(q(`SELECT session_id,COUNT(*) as n FROM conversation_messages WHERE tool_name='EnterPlanMode' GROUP BY session_id ORDER BY n DESC`), { headers: CORS }),

      "/api/tool-durations": () => {
        // Use LEAD window function to get next message timestamp, compute duration in JS
        const rows = q(`SELECT tool_name, timestamp,
          LEAD(timestamp) OVER (PARTITION BY session_id ORDER BY rowid) as next_ts
          FROM conversation_messages
          WHERE tool_name IS NOT NULL OR (role = 'user' AND content LIKE '<tool_result%')
          ORDER BY session_id, rowid`) as { tool_name: string | null; timestamp: string; next_ts: string | null }[];
        const durations: Record<string, number[]> = {};
        for (const r of rows) {
          if (!r.tool_name || !r.next_ts) continue;
          const dur = new Date(r.next_ts).getTime() - new Date(r.timestamp).getTime();
          if (dur > 0 && dur < 300000) {
            (durations[r.tool_name] ??= []).push(dur);
          }
        }
        const result = Object.entries(durations).map(([tool_name, durs]) => ({
          tool_name, calls: durs.length,
          avg_ms: Math.round(durs.reduce((s, v) => s + v, 0) / durs.length),
          max_ms: Math.max(...durs), min_ms: Math.min(...durs),
        })).sort((a, b) => b.avg_ms - a.avg_ms).slice(0, 20);
        return Response.json(result, { headers: CORS });
      },

      "/api/mcp-usage": () => {
        const rows = q(`SELECT tool_name, COUNT(*) as calls, SUM(is_error) as errors FROM conversation_messages WHERE tool_name LIKE 'mcp__%' GROUP BY tool_name ORDER BY calls DESC`);
        const grouped: Record<string, { calls: number; errors: number }> = {};
        for (const r of rows as { tool_name: string; calls: number; errors: number }[]) {
          const parts = r.tool_name.split("__");
          const server = parts.length >= 2 ? parts[0] + "__" + parts[1] : r.tool_name;
          if (!grouped[server]) grouped[server] = { calls: 0, errors: 0 };
          grouped[server].calls += r.calls;
          grouped[server].errors += r.errors;
        }
        const result = Object.entries(grouped).map(([mcp_server, v]) => ({ mcp_server, ...v })).sort((a, b) => b.calls - a.calls);
        return Response.json(result, { headers: CORS });
      },

      "/api/context-usage": (req) => {
        const session = new URL(req.url).searchParams.get("session") || "";
        if (!session) return Response.json([], { headers: CORS });
        const rows = q(`SELECT session_id, model, timestamp, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) OVER (PARTITION BY session_id ORDER BY timestamp) as cumulative_tokens FROM conversation_messages WHERE session_id = ? AND model IS NOT NULL ORDER BY timestamp`, session);
        return Response.json(rows, { headers: CORS });
      },

      "/api/turn-latency": () => {
        // Use native turn_duration records from Claude Code (subtype='turn_duration', duration_ms field)
        const deltas = q(`SELECT duration_ms as latency_ms FROM conversation_messages WHERE subtype='turn_duration' AND duration_ms > 0 AND duration_ms < 600000`) as { latency_ms: number }[];
        if (!deltas.length) return Response.json({ avg: 0, p50: 0, p95: 0, deltas: [] }, { headers: CORS });
        const vals = deltas.map(r => r.latency_ms).sort((a, b) => a - b);
        const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
        const p50 = vals[Math.floor(vals.length * 0.5)];
        const p95 = vals[Math.floor(vals.length * 0.95)];
        return Response.json({ avg, p50, p95, deltas: vals }, { headers: CORS });
      },

      "/api/cache-stats": () => {
        // cache_hit_pct = cache_read / (cache_read + non-cached input)
        const row = q(`SELECT SUM(cache_read_tokens) as total_cache_hits, SUM(cache_creation_tokens) as total_cache_writes, SUM(input_tokens) as total_input,
          ROUND(SUM(cache_read_tokens)*100.0/NULLIF(SUM(cache_read_tokens)+SUM(input_tokens),0),1) as cache_hit_pct,
          ROUND(SUM(cache_read_tokens)*0.9/1e6*3,2) as estimated_savings_usd
          FROM conversation_messages WHERE input_tokens > 0 OR cache_read_tokens > 0`)[0];
        return Response.json(row, { headers: CORS });
      },

      "/api/web-usage": () => {
        const row = q(`SELECT
          SUM(CASE WHEN tool_name='WebSearch' THEN 1 ELSE 0 END) as searches,
          SUM(CASE WHEN tool_name='WebFetch' THEN 1 ELSE 0 END) as fetches,
          COUNT(DISTINCT session_id) as sessions_with_web
          FROM conversation_messages WHERE tool_name IN ('WebSearch','WebFetch')`)[0];
        return Response.json(row, { headers: CORS });
      },

      "/api/model-switches": () => {
        const rows = q(`SELECT session_id, GROUP_CONCAT(DISTINCT model) as models, COUNT(DISTINCT model) as model_count FROM conversation_messages WHERE model IS NOT NULL GROUP BY session_id HAVING model_count > 1 ORDER BY model_count DESC`);
        return Response.json(rows, { headers: CORS });
      },

      "/api/session-efficiency": () => {
        const rows = q(`SELECT s.id, s.project_path, COALESCE(s.input_tokens,0)+COALESCE(s.output_tokens,0) as total_tokens, s.lines_added, s.lines_removed, (SELECT COUNT(*) FROM commits c WHERE c.project_path=s.project_path AND c.date BETWEEN datetime(s.started_at/1000,'unixepoch') AND datetime(s.ended_at/1000,'unixepoch')) as commits_during FROM sessions s WHERE COALESCE(s.input_tokens,0)+COALESCE(s.output_tokens,0) > 0 ORDER BY total_tokens DESC LIMIT 50`);
        return Response.json(rows, { headers: CORS });
      },

      "/api/compact-events": () => {
        const rows = q(`SELECT session_id, COUNT(*) as compactions FROM conversation_messages WHERE raw_type='summary' GROUP BY session_id ORDER BY compactions DESC`);
        return Response.json(rows, { headers: CORS });
      },

      "/api/service-tiers": () => {
        const rows = q(`SELECT service_tier, COUNT(*) as n, SUM(output_tokens) as total_output FROM conversation_messages WHERE service_tier IS NOT NULL GROUP BY service_tier ORDER BY n DESC`);
        return Response.json(rows, { headers: CORS });
      },
      "/api/hook-stats": () => {
        const rows = q(`SELECT COUNT(*) as total_hooks, SUM(CASE WHEN subtype='stop_hook_summary' THEN 1 ELSE 0 END) as stop_hooks, SUM(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as total_hook_ms, ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END)) as avg_hook_ms FROM conversation_messages WHERE subtype='stop_hook_summary'`)[0];
        return Response.json(rows, { headers: CORS });
      },
      "/api/model-usage-breakdown": () => {
        return Response.json(q(`SELECT * FROM model_usage ORDER BY input_tokens + output_tokens DESC`), { headers: CORS });
      },
      "/api/daily-model-tokens": () => {
        return Response.json(q(`SELECT * FROM daily_model_tokens ORDER BY date`), { headers: CORS });
      },
      "/api/pr-sessions": () => {
        return Response.json(q(`SELECT id, project_path, summary, pr_number, pr_url, pr_repository, slug, started_at, duration_minutes FROM sessions WHERE pr_url IS NOT NULL ORDER BY started_at DESC`), { headers: CORS });
      },
      "/api/session-slugs": () => {
        return Response.json(q(`SELECT id, slug, summary, project_path FROM sessions WHERE slug IS NOT NULL ORDER BY started_at DESC LIMIT 100`), { headers: CORS });
      },
      "/api/tool-usage": () => {
        return Response.json(q(`SELECT * FROM tool_usage ORDER BY usage_count DESC`), { headers: CORS });
      },
      "/api/skill-usage": () => {
        return Response.json(q(`SELECT * FROM skill_usage ORDER BY usage_count DESC`), { headers: CORS });
      },
      "/api/app-meta": () => {
        const rows = q(`SELECT * FROM app_meta`) as { key: string; value: string }[];
        const meta: Record<string, unknown> = {};
        for (const r of rows) {
          try { meta[r.key] = JSON.parse(r.value); } catch { meta[r.key] = r.value; }
        }
        return Response.json(meta, { headers: CORS });
      },
      "/api/compaction-events": () => {
        return Response.json(q(`SELECT session_id, subtype, duration_ms, timestamp FROM conversation_messages WHERE subtype IN ('microcompact_boundary','compact_boundary') ORDER BY timestamp DESC`), { headers: CORS });
      },
      "/api/api-errors": () => {
        return Response.json(q(`SELECT session_id, timestamp, cli_version FROM conversation_messages WHERE subtype='api_error' ORDER BY timestamp DESC`), { headers: CORS });
      },
      "/api/version-distribution": () => {
        return Response.json(q(`SELECT cli_version, COUNT(DISTINCT session_id) as sessions, COUNT(*) as messages FROM conversation_messages WHERE cli_version IS NOT NULL GROUP BY cli_version ORDER BY sessions DESC`), { headers: CORS });
      },
      "/api/permission-modes": () => {
        return Response.json(q(`SELECT permission_mode, COUNT(*) as n FROM conversation_messages WHERE permission_mode IS NOT NULL GROUP BY permission_mode ORDER BY n DESC`), { headers: CORS });
      },
      "/api/conversation-stats": () => {
        const s = getStats(q);
        return Response.json({
          total: s.totalConvLines,
          byType: q(`SELECT type,COUNT(*) as n FROM conversation_messages GROUP BY type ORDER BY n DESC`),
          byModel: q(`SELECT model,COUNT(*) as n FROM conversation_messages WHERE model IS NOT NULL AND model!='<synthetic>' GROUP BY model ORDER BY n DESC`),
          toolUsage: q(`SELECT tool_name,COUNT(*) as n FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 15`),
          totalTokens: s.totalTokens,
          sessions: s.sessions,
          thinkingBlocks: s.thinkingBlocks,
          errors: s.errors,
        }, { headers: CORS });
      },
      "/api/sidechain-stats": () => {
        const s = getStats(q);
        return Response.json({
          total: s.sidechainMsgs,
          agents: s.subagents,
          byAgent: q(`SELECT agent_id,COUNT(*) as msgs,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) as tokens FROM conversation_messages WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY msgs DESC LIMIT 10`),
        }, { headers: CORS });
      },

      "/api/sessions": (req) => {
        const sp = new URL(req.url).searchParams;
        const proj = sp.get("project") || "";
        const dateFrom = sp.get("from") || "";
        const dateTo = sp.get("to") || "";
        const lim = parseInt(sp.get("limit") || "200");
        let sql = `SELECT id,project_path,started_at,ended_at,message_count,duration_minutes,first_prompt,git_branch,cost_usd,input_tokens,output_tokens,lines_added,lines_removed,is_sidechain FROM sessions WHERE 1=1`;
        const params: (string | number)[] = [];
        if (proj) { sql += ` AND project_path LIKE ?`; params.push(`%${proj}%`); }
        if (dateFrom) { sql += ` AND started_at >= ?`; params.push(new Date(dateFrom + "T00:00:00").getTime()); }
        if (dateTo) { sql += ` AND started_at <= ?`; params.push(new Date(dateTo + "T23:59:59").getTime()); }
        sql += ` ORDER BY started_at DESC LIMIT ?`;
        params.push(lim);
        return Response.json(db.query(sql).all(...params), { headers: CORS });
      },
      "/api/search": (req) => {
        const query = new URL(req.url).searchParams.get("q") || "";
        if (!query) return Response.json([], { headers: CORS });
        try {
          return Response.json(q(`SELECT hm.timestamp,hm.project_path,hm.display FROM history_fts f JOIN history_messages hm ON hm.id=f.rowid WHERE history_fts MATCH ? ORDER BY hm.timestamp DESC LIMIT 30`, safeFts(query)), { headers: CORS });
        } catch { return Response.json([], { headers: CORS }); }
      },
      "/api/chat/sessions": (req) => {
        const sp = new URL(req.url).searchParams;
        const limit = parseInt(sp.get("limit") || "100");
        const offset = parseInt(sp.get("offset") || "0");
        return Response.json(q(`SELECT s.session_id, s.first_ts, s.last_ts, s.msg_count,
          SUBSTR((SELECT content FROM conversation_messages WHERE session_id=s.session_id AND role='user' AND content IS NOT NULL ORDER BY rowid LIMIT 1), 1, 120) as first_msg
          FROM (SELECT session_id, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as msg_count
            FROM conversation_messages WHERE type IN ('user','assistant') GROUP BY session_id ORDER BY first_ts DESC LIMIT ? OFFSET ?) s`, limit, offset), { headers: CORS });
      },
      "/api/chat-search": (req) => {
        const query = new URL(req.url).searchParams.get("q") || "";
        if (!query) return Response.json([], { headers: CORS });
        try {
          const results = q(`SELECT cm.session_id,cm.timestamp,cm.role,cm.content
            FROM conversation_fts f JOIN conversation_messages cm ON cm.id=f.rowid
            WHERE conversation_fts MATCH ?
            ORDER BY cm.timestamp DESC`, safeFts(query)) as {session_id:string;timestamp:string;role:string;content:string}[];
          const cleaned = results.map(r => {
            const preview = (r.content || "").slice(0, 500).replace(STRIP_XML_RE, "").trim().slice(0, 200);
            return { session_id: r.session_id, timestamp: r.timestamp, role: r.role, content: preview };
          });
          return Response.json(cleaned, { headers: CORS });
        } catch { return Response.json([], { headers: CORS }); }
      },
      "/api/chat/:sessionId": (req) => {
        const sid = req.params.sessionId;
        const sp = new URL(req.url).searchParams;
        const limit = parseInt(sp.get("limit") || "500");
        const offset = parseInt(sp.get("offset") || "0");
        const render = sp.get("render") === "html";
        const total = q(`SELECT COUNT(*) as n FROM conversation_messages WHERE session_id=?`, sid)[0] as CountRow;
        const msgs = q(`SELECT uuid,parent_uuid,type,role,content,model,timestamp,tool_name,tool_use_id,input_tokens,output_tokens FROM conversation_messages WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?`, sid, limit, offset) as Record<string, unknown>[];
        if (render) {
          const mdOpts = { tables: true, strikethrough: true, tasklists: true, autolinks: true };
          /** Strip Claude Code system XML tags, keep inner content where meaningful. */
          const stripSystemXml = (text: string) => text
            .replace(/<(system-reminder|command-message|command-name|local-command-caveat|task-notification|user-prompt-submit-hook)[^>]*>[\s\S]*?<\/\1>/g, "")
            .replace(/<(task-id|tool-use-id|output-file|status|summary|result)>[^<]*<\/\1>/g, "")
            .trim();
          const renderMd = (text: string) => {
            let html = Bun.markdown.html(text, mdOpts);
            html = html.replace(/<pre><code(?: class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g,
              (_, lang, code) => {
                const raw = code.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
                const highlighted = highlight(raw, lang || "");
                const label = lang ? `<span class="code-lang">${Bun.escapeHTML(lang)}</span>` : "";
                const copyBtn = `<button class="code-copy" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent);this.textContent='copied!';setTimeout(()=>this.textContent='copy',1500)">copy</button>`;
                return `<div class="code-block">${label}${copyBtn}<pre><code${lang ? ` class="language-${lang}"` : ""}>${highlighted}</code></pre></div>`;
              });
            return html;
          };
          const hasXml = (s: string) => s.includes("<thinking>") || s.includes("<tool_use") || s.includes("<tool_result");
          for (const m of msgs) {
            const c = m.content;
            if (typeof c !== "string" || !c) continue;
            const clean = stripSystemXml(c);
            if (!clean) continue;
            if (!hasXml(clean)) {
              m.html = renderMd(clean);
            } else {
              const segments = clean.split(/(<thinking>[\s\S]*?<\/thinking>|<tool_use[^>]*>[\s\S]*?<\/tool_use>|<tool_result[^>]*>[\s\S]*?<\/tool_result>)/);
              const rendered: string[] = [];
              for (const seg of segments) {
                if (seg.startsWith("<tool_use") && seg.includes('name="Edit"')) {
                  rendered.push(renderEditDiff(seg) || seg);
                } else if (seg.startsWith("<thinking>") || seg.startsWith("<tool_use") || seg.startsWith("<tool_result")) {
                  rendered.push(seg);
                } else if (seg.trim()) {
                  rendered.push("<!--md-->" + renderMd(seg.trim()) + "<!--/md-->");
                }
              }
              m.htmlParts = rendered;
            }
          }
        }
        return Response.json({ total: total.n, msgs, offset, limit }, { headers: CORS });
      },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Dashboard: http://localhost:${port}`);
}
