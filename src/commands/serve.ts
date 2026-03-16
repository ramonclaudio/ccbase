import { getDb } from "../db/connection.ts";
import { today } from "../utils/dates.ts";

export function serveCommand(args: string[]): void {
  const port = parseInt(args.find(a => /^\d+$/.test(a)) || "3000");
  const db = getDb();
  const q = (sql: string, ...p: any[]) => db.prepare(sql).all(...p);

  Bun.serve({
    port,
    fetch(req) {
      const { pathname, searchParams } = new URL(req.url);

      if (pathname === "/api/daily") return json(q(`SELECT date,session_count,message_count,tool_call_count FROM daily_stats ORDER BY date`));
      if (pathname === "/api/sessions") {
        const proj = searchParams.get("project") || "";
        const dateFrom = searchParams.get("from") || "";
        const dateTo = searchParams.get("to") || "";
        const lim = parseInt(searchParams.get("limit") || "200");
        let sql = `SELECT id,project_path,started_at,ended_at,message_count,duration_minutes,first_prompt,git_branch,cost_usd,input_tokens,output_tokens,lines_added,lines_removed,is_sidechain FROM sessions WHERE 1=1`;
        const params: any[] = [];
        if (proj) { sql += ` AND project_path LIKE ?`; params.push(`%${proj}%`); }
        if (dateFrom) { sql += ` AND started_at >= ?`; params.push(new Date(dateFrom + "T00:00:00").getTime()); }
        if (dateTo) { sql += ` AND started_at <= ?`; params.push(new Date(dateTo + "T23:59:59").getTime()); }
        sql += ` ORDER BY started_at DESC LIMIT ?`;
        params.push(lim);
        return json(db.prepare(sql).all(...params));
      }
      if (pathname === "/api/projects") return json(q(`SELECT p.*,g.dirty_file_count,g.stash_count,g.branch_count,g.current_branch FROM projects p LEFT JOIN project_git_state g ON g.project_path=p.path ORDER BY p.total_commits DESC`));
      if (pathname === "/api/tasks") return json(q(`SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,suite_id`));
      if (pathname === "/api/commits") return json(q(`SELECT hash,project_path,date,message,commit_type,commit_scope FROM commits ORDER BY date DESC LIMIT 200`));
      if (pathname === "/api/hours") return json(q(`SELECT CAST(((started_at/1000)%86400)/3600 AS INTEGER) as hour,COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`));
      if (pathname === "/api/project-sessions") return json(q(`SELECT project_path,COUNT(*) as sessions,ROUND(SUM(duration_minutes)) as minutes,SUM(COALESCE(lines_added,0)) as added,SUM(COALESCE(lines_removed,0)) as removed,SUM(COALESCE(cost_usd,0)) as cost,SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY sessions DESC LIMIT 20`));
      if (pathname === "/api/commit-types") return json(q(`SELECT commit_type,COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type!='' GROUP BY commit_type ORDER BY n DESC LIMIT 10`));
      if (pathname === "/api/duration-dist") return json(q(`SELECT CASE WHEN duration_minutes<1 THEN '<1m' WHEN duration_minutes<5 THEN '1-5m' WHEN duration_minutes<15 THEN '5-15m' WHEN duration_minutes<30 THEN '15-30m' WHEN duration_minutes<60 THEN '30-60m' WHEN duration_minutes<120 THEN '1-2h' WHEN duration_minutes<240 THEN '2-4h' ELSE '4h+' END as bucket,COUNT(*) as n FROM sessions GROUP BY bucket ORDER BY MIN(duration_minutes)`));
      if (pathname === "/api/branches") return json(q(`SELECT git_branch,COUNT(*) as n FROM sessions WHERE git_branch IS NOT NULL AND git_branch!='' GROUP BY git_branch ORDER BY n DESC LIMIT 15`));
      if (pathname === "/api/usage-by-project") return json(q(`SELECT project_path, SUM(COALESCE(input_tokens,0)) as inp, SUM(COALESCE(output_tokens,0)) as outp, COUNT(*) as sessions FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY (inp+outp) DESC LIMIT 15`));
      if (pathname === "/api/churn") return json(q(`SELECT SUBSTR(s.started_at,1,10) as date, SUM(COALESCE(c.added,0)) as added, SUM(COALESCE(c.removed,0)) as removed FROM (SELECT DISTINCT SUBSTR(date,1,10) as d FROM commits) dates LEFT JOIN commits c ON SUBSTR(c.date,1,10)=dates.d LEFT JOIN (SELECT id, CAST(started_at/1000 AS TEXT) as started_at FROM sessions) s ON 1=0 GROUP BY dates.d ORDER BY dates.d`));
      if (pathname === "/api/lines-by-day") return json(q(`SELECT SUBSTR(date,1,10) as d,SUM(CASE WHEN commit_type='feat' THEN 1 ELSE 0 END) as feats,SUM(CASE WHEN commit_type='fix' THEN 1 ELSE 0 END) as fixes,COUNT(*) as total FROM commits GROUP BY d ORDER BY d`));
      if (pathname === "/api/git-state") return json(q(`SELECT project_path,dirty_file_count,stash_count,branch_count,current_branch FROM project_git_state WHERE dirty_file_count>0 OR stash_count>0 ORDER BY dirty_file_count DESC`));
      if (pathname === "/api/search") {
        const query = searchParams.get("q") || "";
        if (!query) return json([]);
        return json(q(`SELECT hm.timestamp,hm.project_path,hm.display FROM history_fts f JOIN history_messages hm ON hm.id=f.rowid WHERE history_fts MATCH ? ORDER BY hm.timestamp DESC LIMIT 30`, query));
      }
      // Conversation endpoints
      if (pathname === "/api/chat/sessions") {
        const sessions = q(`SELECT session_id, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as msg_count FROM conversation_messages WHERE type IN ('user','assistant') GROUP BY session_id ORDER BY first_ts DESC LIMIT 100`);
        const firstMsg = db.prepare(`SELECT content FROM conversation_messages WHERE session_id=? AND role='user' AND content IS NOT NULL ORDER BY rowid LIMIT 1`);
        for (const s of sessions as any[]) s.first_msg = firstMsg.get(s.session_id)?.content?.slice(0, 120) || null;
        return json(sessions);
      }
      if (pathname.startsWith("/api/chat/")) {
        const sid = pathname.slice(10);
        if (sid) {
          const limit = parseInt(searchParams.get("limit") || "500");
          const offset = parseInt(searchParams.get("offset") || "0");
          const total = q(`SELECT COUNT(*) as n FROM conversation_messages WHERE session_id=?`, sid)[0] as any;
          const msgs = q(`SELECT uuid,parent_uuid,type,role,content,model,timestamp,tool_name,tool_use_id,input_tokens,output_tokens FROM conversation_messages WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?`, sid, limit, offset);
          return json({ total: total.n, msgs, offset, limit });
        }
      }
      if (pathname === "/api/chat-search") {
        const query = searchParams.get("q") || "";
        if (!query) return json([]);
        return json(q(`SELECT cm.session_id,cm.timestamp,cm.role,cm.content FROM conversation_fts f JOIN conversation_messages cm ON cm.id=f.rowid WHERE conversation_fts MATCH ? ORDER BY cm.timestamp DESC LIMIT 40`, query));
      }
      if (pathname === "/api/conversation-stats") return json({
        total: q(`SELECT COUNT(*) as n FROM conversation_messages`)[0],
        byType: q(`SELECT type,COUNT(*) as n FROM conversation_messages GROUP BY type ORDER BY n DESC`),
        byModel: q(`SELECT model,COUNT(*) as n FROM conversation_messages WHERE model IS NOT NULL AND model!='<synthetic>' GROUP BY model ORDER BY n DESC`),
        toolUsage: q(`SELECT tool_name,COUNT(*) as n FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 15`),
        totalTokens: q(`SELECT SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM conversation_messages`)[0],
        sessions: q(`SELECT COUNT(DISTINCT session_id) as n FROM conversation_messages`)[0],
        thinkingBlocks: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE has_thinking=1`)[0],
        errors: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_error=1`)[0],
      });
      // New endpoints for missing data
      if (pathname === "/api/tokens-by-model") return json(q(`SELECT model, COUNT(*) as msgs, SUM(COALESCE(input_tokens,0)) as inp, SUM(COALESCE(output_tokens,0)) as outp, SUM(has_thinking) as thinking_msgs, ROUND(AVG(CASE WHEN thinking_length>0 THEN thinking_length END)) as avg_think_len, MAX(thinking_length) as max_think_len, SUM(is_error) as errors FROM conversation_messages WHERE model IS NOT NULL AND model!='<synthetic>' GROUP BY model ORDER BY (inp+outp) DESC`));
      if (pathname === "/api/agents") return json(q(`SELECT agent_id, COUNT(*) as msgs, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) as tokens FROM conversation_messages WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY msgs DESC LIMIT 20`));
      if (pathname === "/api/message-types") return json(q(`SELECT raw_type, COUNT(*) as n FROM conversation_messages GROUP BY raw_type ORDER BY n DESC`));
      if (pathname === "/api/tool-errors") return json(q(`SELECT tool_name, COUNT(*) as calls, SUM(is_error) as errors, ROUND(SUM(is_error)*100.0/COUNT(*),1) as error_pct FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY calls DESC LIMIT 20`));
      if (pathname === "/api/commit-scopes") return json(q(`SELECT commit_type, commit_scope, COUNT(*) as n FROM commits WHERE commit_scope IS NOT NULL AND commit_scope!='' GROUP BY commit_type, commit_scope ORDER BY n DESC LIMIT 20`));
      if (pathname === "/api/pr-links") return json(q(`SELECT content, timestamp FROM conversation_messages WHERE raw_type='pr-link' ORDER BY timestamp DESC`));
      if (pathname === "/api/session-summaries") return json(q(`SELECT id, summary, first_prompt, project_path, duration_minutes, message_count FROM sessions WHERE summary IS NOT NULL AND summary!='' ORDER BY started_at DESC LIMIT 50`));
      if (pathname === "/api/paste-stats") return json(q(`SELECT COUNT(*) as total, SUM(has_paste) as with_paste, ROUND(SUM(has_paste)*100.0/COUNT(*),1) as pct FROM history_messages`)[0]);
      if (pathname === "/api/project-staleness") return json(q(`SELECT name, type, path, last_commit_date, last_session_date, total_commits, total_sessions FROM projects ORDER BY COALESCE(last_commit_date, last_session_date, '1970') DESC`));
      if (pathname === "/api/streaks") {
        const days = q(`SELECT date FROM daily_stats ORDER BY date`) as {date:string}[];
        let current=0,longest=0,longestStart="",longestEnd="",curStart="";
        for(let i=0;i<days.length;i++){
          const d=new Date(days[i].date+"T00:00:00");
          const prev=i>0?new Date(days[i-1].date+"T00:00:00"):null;
          if(prev&&(d.getTime()-prev.getTime())===86400000){
            current++;
          }else{
            if(current>longest){longest=current;longestStart=curStart;longestEnd=days[i-1]?.date||curStart}
            current=1;curStart=days[i].date;
          }
        }
        if(current>longest){longest=current;longestStart=curStart;longestEnd=days[days.length-1]?.date||curStart}
        // Current streak from most recent date
        let curStreak=0;
        const today2=today();
        for(let i=days.length-1;i>=0;i--){
          const d=new Date(days[i].date+"T00:00:00");
          const expected=new Date(today2+"T00:00:00");
          expected.setDate(expected.getDate()-(days.length-1-i));
          const diff=Math.abs(new Date(today2+"T00:00:00").getTime()-d.getTime())/86400000;
          if(i===days.length-1&&diff>1)break;
          if(i<days.length-1){
            const prev=new Date(days[i+1].date+"T00:00:00");
            if((prev.getTime()-d.getTime())!==86400000)break;
          }
          curStreak++;
        }
        return json({current:curStreak,longest,longestStart,longestEnd,totalDays:days.length});
      }
      if (pathname === "/api/plan-mode") return json(q(`SELECT session_id, COUNT(*) as n FROM conversation_messages WHERE tool_name='EnterPlanMode' GROUP BY session_id ORDER BY n DESC`));
      if (pathname === "/api/sidechain-stats") return json({
        total: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE is_sidechain=1`)[0],
        agents: q(`SELECT COUNT(DISTINCT agent_id) as n FROM conversation_messages WHERE agent_id IS NOT NULL`)[0],
        byAgent: q(`SELECT agent_id, COUNT(*) as msgs, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) as tokens FROM conversation_messages WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY msgs DESC LIMIT 10`),
      });

      if (pathname === "/api/stats") return json({
        sessions: q(`SELECT COUNT(DISTINCT session_id) as n FROM conversation_messages`)[0],
        messages: q(`SELECT COUNT(*) as n FROM conversation_messages WHERE type IN ('user','assistant')`)[0],
        totalConvLines: q(`SELECT COUNT(*) as n FROM conversation_messages`)[0],
        commits: q(`SELECT COUNT(*) as n FROM commits`)[0],
        projects: q(`SELECT COUNT(*) as n FROM projects`)[0],
        tasks: q(`SELECT status,COUNT(*) as n FROM tasks GROUP BY status`),
        // Plan value: what this would cost at API rates (Opus: $15/3 per MTok, Sonnet: $15/3, Haiku: $4/1)
        planValue: q(`SELECT ROUND(
          SUM(CASE
            WHEN model LIKE '%opus%' THEN COALESCE(input_tokens,0)/1000000.0*15 + COALESCE(output_tokens,0)/1000000.0*75
            WHEN model LIKE '%sonnet%' THEN COALESCE(input_tokens,0)/1000000.0*3 + COALESCE(output_tokens,0)/1000000.0*15
            WHEN model LIKE '%haiku%' THEN COALESCE(input_tokens,0)/1000000.0*1 + COALESCE(output_tokens,0)/1000000.0*5
            ELSE COALESCE(input_tokens,0)/1000000.0*3 + COALESCE(output_tokens,0)/1000000.0*15
          END), 2) as n FROM conversation_messages`)[0],
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
      });

      if (pathname === "/") return html(readPage("dashboard.html"));
      if (pathname === "/chat") return html(readPage("chat.html"));
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Dashboard: http://localhost:${port}`);
}

function json(d: unknown) { return new Response(JSON.stringify(d), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
function html(b: string) { return new Response(b, { headers: { "content-type": "text/html; charset=utf-8" } }); }

import { readFileSync } from "node:fs";
import { join } from "node:path";
const PAGES_DIR = join(import.meta.dir, "..", "pages");
function readPage(name: string): string { return readFileSync(join(PAGES_DIR, name), "utf-8"); }
