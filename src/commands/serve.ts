import { getDb } from "../db/connection.ts";
import { today } from "../utils/dates.ts";

const PAGES_DIR = import.meta.dir + "/../pages";
const CORS = { "access-control-allow-origin": "*" } as const;
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

export async function serveCommand(args: string[]): Promise<void> {
  const port = parseInt(args.find(a => /^\d+$/.test(a)) || "3000");
  const db = getDb();
  const q = (sql: string, ...p: any[]) => db.query(sql).all(...p);

  const dashboardBytes = await Bun.file(PAGES_DIR + "/dashboard.html").bytes();
  const chatBytes = await Bun.file(PAGES_DIR + "/chat.html").bytes();

  // Pre-cache heavy queries that don't change between ingests
  const statsCache = { data: null as any, ts: 0 };
  function getStats() {
    const now = Date.now();
    if (statsCache.data && now - statsCache.ts < 5000) return statsCache.data;
    statsCache.data = {
      sessions: q(`SELECT COUNT(DISTINCT session_id) as n FROM conversation_messages`)[0],
      messages: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE type IN ('user','assistant')`)[0],
      totalConvLines: q(`SELECT COUNT(*) as n FROM conversation_messages`)[0],
      commits: q(`SELECT COUNT(*) as n FROM commits`)[0],
      projects: q(`SELECT COUNT(*) as n FROM projects`)[0],
      tasks: q(`SELECT status,COUNT(*) as n FROM tasks GROUP BY status`),
      planValue: q(`SELECT ROUND(SUM(CASE WHEN model LIKE '%opus%' THEN COALESCE(input_tokens,0)/1000000.0*15+COALESCE(output_tokens,0)/1000000.0*75 WHEN model LIKE '%sonnet%' THEN COALESCE(input_tokens,0)/1000000.0*3+COALESCE(output_tokens,0)/1000000.0*15 WHEN model LIKE '%haiku%' THEN COALESCE(input_tokens,0)/1000000.0*1+COALESCE(output_tokens,0)/1000000.0*5 ELSE COALESCE(input_tokens,0)/1000000.0*3+COALESCE(output_tokens,0)/1000000.0*15 END),2) as n FROM conversation_messages`)[0],
      totalTokens: q(`SELECT SUM(COALESCE(input_tokens,0))+SUM(COALESCE(output_tokens,0)) as n FROM conversation_messages`)[0],
      totalLines: q(`SELECT SUM(COALESCE(lines_added,0))+SUM(COALESCE(lines_removed,0)) as n FROM sessions`)[0],
      totalMinutes: q(`SELECT COALESCE(SUM(duration_minutes),0) as n FROM sessions WHERE duration_minutes>0`)[0],
      toolCalls: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE tool_name IS NOT NULL`)[0],
      thinkingBlocks: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE has_thinking=1`)[0],
      sidechainMsgs: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_sidechain=1`)[0],
      subagents: q(`SELECT COUNT(DISTINCT agent_id) as n FROM conversation_messages WHERE agent_id IS NOT NULL`)[0],
      errors: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_error=1`)[0],
      pasteRate: q(`SELECT ROUND(SUM(has_paste)*100.0/COUNT(*),1) as n FROM history_messages`)[0],
      planSessions: q(`SELECT COUNT(DISTINCT session_id) as n FROM conversation_messages WHERE tool_name='EnterPlanMode'`)[0],
      rewinds: q(`SELECT COUNT(*) as n FROM history_messages WHERE display LIKE '%/rewind%'`)[0],
      today: today(),
    };
    statsCache.ts = now;
    return statsCache.data;
  }

  function computeStreaks() {
    const days = q(`SELECT date FROM daily_stats ORDER BY date`) as { date: string }[];
    let current = 0, longest = 0, longestStart = "", longestEnd = "", curStart = "";
    for (let i = 0; i < days.length; i++) {
      const d = new Date(days[i].date + "T00:00:00");
      const prev = i > 0 ? new Date(days[i - 1].date + "T00:00:00") : null;
      if (prev && (d.getTime() - prev.getTime()) === 86400000) {
        current++;
      } else {
        if (current > longest) { longest = current; longestStart = curStart; longestEnd = days[i - 1]?.date || curStart; }
        current = 1; curStart = days[i].date;
      }
    }
    if (current > longest) { longest = current; longestStart = curStart; longestEnd = days[days.length - 1]?.date || curStart; }
    let curStreak = 0;
    const t = today();
    for (let i = days.length - 1; i >= 0; i--) {
      const d = new Date(days[i].date + "T00:00:00");
      const diff = Math.abs(new Date(t + "T00:00:00").getTime() - d.getTime()) / 86400000;
      if (i === days.length - 1 && diff > 1) break;
      if (i < days.length - 1) {
        const prev = new Date(days[i + 1].date + "T00:00:00");
        if ((prev.getTime() - d.getTime()) !== 86400000) break;
      }
      curStreak++;
    }
    return { current: curStreak, longest, longestStart, longestEnd, totalDays: days.length };
  }

  Bun.serve({
    port,
    routes: {
      "/": new Response(dashboardBytes, { headers: HTML_HEADERS }),
      "/chat": new Response(chatBytes, { headers: HTML_HEADERS }),

      "/api/stats": () => Response.json(getStats(), { headers: CORS }),
      "/api/daily": () => Response.json(q(`SELECT date,session_count,message_count,tool_call_count FROM daily_stats ORDER BY date`), { headers: CORS }),
      "/api/projects": () => Response.json(q(`SELECT p.*,g.dirty_file_count,g.stash_count,g.branch_count,g.current_branch FROM projects p LEFT JOIN project_git_state g ON g.project_path=p.path ORDER BY p.total_commits DESC`), { headers: CORS }),
      "/api/tasks": () => Response.json(q(`SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,suite_id`), { headers: CORS }),
      "/api/commits": () => Response.json(q(`SELECT hash,project_path,date,message,commit_type,commit_scope FROM commits ORDER BY date DESC LIMIT 200`), { headers: CORS }),
      "/api/hours": () => Response.json(q(`SELECT CAST(((started_at/1000)%86400)/3600 AS INTEGER) as hour,COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`), { headers: CORS }),
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
      "/api/streaks": () => Response.json(computeStreaks(), { headers: CORS }),
      "/api/billing-blocks": () => {
        const blocks = q(`SELECT *, CASE WHEN block_start = ? THEN 1 ELSE 0 END as is_current FROM billing_blocks ORDER BY block_start DESC LIMIT 20`, Math.floor(Date.now() / 18000000) * 18000000);
        return Response.json(blocks, { headers: CORS });
      },
      "/api/plan-mode": () => Response.json(q(`SELECT session_id,COUNT(*) as n FROM conversation_messages WHERE tool_name='EnterPlanMode' GROUP BY session_id ORDER BY n DESC`), { headers: CORS }),
      "/api/conversation-stats": () => Response.json({
        total: q(`SELECT COUNT(*) as n FROM conversation_messages`)[0],
        byType: q(`SELECT type,COUNT(*) as n FROM conversation_messages GROUP BY type ORDER BY n DESC`),
        byModel: q(`SELECT model,COUNT(*) as n FROM conversation_messages WHERE model IS NOT NULL AND model!='<synthetic>' GROUP BY model ORDER BY n DESC`),
        toolUsage: q(`SELECT tool_name,COUNT(*) as n FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 15`),
        totalTokens: q(`SELECT SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM conversation_messages`)[0],
        sessions: q(`SELECT COUNT(DISTINCT session_id) as n FROM conversation_messages`)[0],
        thinkingBlocks: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE has_thinking=1`)[0],
        errors: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_error=1`)[0],
      }, { headers: CORS }),
      "/api/sidechain-stats": () => Response.json({
        total: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_sidechain=1`)[0],
        agents: q(`SELECT COUNT(DISTINCT agent_id) as n FROM conversation_messages WHERE agent_id IS NOT NULL`)[0],
        byAgent: q(`SELECT agent_id,COUNT(*) as msgs,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) as tokens FROM conversation_messages WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY msgs DESC LIMIT 10`),
      }, { headers: CORS }),

      "/api/sessions": (req) => {
        const sp = new URL(req.url).searchParams;
        const proj = sp.get("project") || "";
        const dateFrom = sp.get("from") || "";
        const dateTo = sp.get("to") || "";
        const lim = parseInt(sp.get("limit") || "200");
        let sql = `SELECT id,project_path,started_at,ended_at,message_count,duration_minutes,first_prompt,git_branch,cost_usd,input_tokens,output_tokens,lines_added,lines_removed,is_sidechain FROM sessions WHERE 1=1`;
        const params: any[] = [];
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
        return Response.json(q(`SELECT hm.timestamp,hm.project_path,hm.display FROM history_fts f JOIN history_messages hm ON hm.id=f.rowid WHERE history_fts MATCH ? ORDER BY hm.timestamp DESC LIMIT 30`, query), { headers: CORS });
      },
      "/api/chat/sessions": () => {
        const sessions = q(`SELECT session_id,MIN(timestamp) as first_ts,MAX(timestamp) as last_ts,COUNT(*) as msg_count FROM conversation_messages WHERE type IN ('user','assistant') GROUP BY session_id ORDER BY first_ts DESC LIMIT 100`);
        const firstMsg = db.query(`SELECT content FROM conversation_messages WHERE session_id=? AND role='user' AND content IS NOT NULL ORDER BY rowid LIMIT 1`);
        for (const s of sessions as any[]) s.first_msg = firstMsg.get(s.session_id)?.content?.slice(0, 120) || null;
        return Response.json(sessions, { headers: CORS });
      },
      "/api/chat-search": (req) => {
        const query = new URL(req.url).searchParams.get("q") || "";
        if (!query) return Response.json([], { headers: CORS });
        return Response.json(q(`SELECT cm.session_id,cm.timestamp,cm.role,cm.content FROM conversation_fts f JOIN conversation_messages cm ON cm.id=f.rowid WHERE conversation_fts MATCH ? ORDER BY cm.timestamp DESC LIMIT 40`, query), { headers: CORS });
      },
      "/api/chat/:sessionId": (req) => {
        const sid = req.params.sessionId;
        const sp = new URL(req.url).searchParams;
        const limit = parseInt(sp.get("limit") || "500");
        const offset = parseInt(sp.get("offset") || "0");
        const total = q(`SELECT COUNT(*) as n FROM conversation_messages WHERE session_id=?`, sid)[0] as any;
        const msgs = q(`SELECT uuid,parent_uuid,type,role,content,model,timestamp,tool_name,tool_use_id,input_tokens,output_tokens FROM conversation_messages WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?`, sid, limit, offset);
        return Response.json({ total: total.n, msgs, offset, limit }, { headers: CORS });
      },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Dashboard: http://localhost:${port}`);
}
