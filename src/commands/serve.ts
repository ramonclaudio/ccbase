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
      if (pathname === "/api/sessions") return json(q(`SELECT id,project_path,started_at,ended_at,message_count,duration_minutes,first_prompt,git_branch,cost_usd,input_tokens,output_tokens,lines_added,lines_removed,is_sidechain FROM sessions ORDER BY started_at DESC LIMIT 200`));
      if (pathname === "/api/projects") return json(q(`SELECT p.*,g.dirty_file_count,g.stash_count,g.branch_count,g.current_branch FROM projects p LEFT JOIN project_git_state g ON g.project_path=p.path ORDER BY p.total_commits DESC`));
      if (pathname === "/api/tasks") return json(q(`SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,suite_id`));
      if (pathname === "/api/commits") return json(q(`SELECT hash,project_path,date,message,commit_type,commit_scope FROM commits ORDER BY date DESC LIMIT 200`));
      if (pathname === "/api/hours") return json(q(`SELECT CAST(((started_at/1000)%86400)/3600 AS INTEGER) as hour,COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`));
      if (pathname === "/api/project-sessions") return json(q(`SELECT project_path,COUNT(*) as sessions,ROUND(SUM(duration_minutes)) as minutes,SUM(COALESCE(lines_added,0)) as added,SUM(COALESCE(lines_removed,0)) as removed,SUM(COALESCE(cost_usd,0)) as cost,SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY sessions DESC LIMIT 20`));
      if (pathname === "/api/commit-types") return json(q(`SELECT commit_type,COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type!='' GROUP BY commit_type ORDER BY n DESC LIMIT 10`));
      if (pathname === "/api/duration-dist") return json(q(`SELECT CASE WHEN duration_minutes<1 THEN '<1m' WHEN duration_minutes<5 THEN '1-5m' WHEN duration_minutes<15 THEN '5-15m' WHEN duration_minutes<30 THEN '15-30m' WHEN duration_minutes<60 THEN '30-60m' WHEN duration_minutes<120 THEN '1-2h' WHEN duration_minutes<240 THEN '2-4h' ELSE '4h+' END as bucket,COUNT(*) as n FROM sessions GROUP BY bucket ORDER BY MIN(duration_minutes)`));
      if (pathname === "/api/branches") return json(q(`SELECT git_branch,COUNT(*) as n FROM sessions WHERE git_branch IS NOT NULL AND git_branch!='' GROUP BY git_branch ORDER BY n DESC LIMIT 15`));
      if (pathname === "/api/cost-by-project") return json(q(`SELECT project_path,SUM(cost_usd) as cost,SUM(input_tokens) as inp,SUM(output_tokens) as outp FROM sessions WHERE cost_usd>0 GROUP BY project_path ORDER BY cost DESC LIMIT 15`));
      if (pathname === "/api/churn") return json(q(`SELECT SUBSTR(s.started_at,1,10) as date, SUM(COALESCE(c.added,0)) as added, SUM(COALESCE(c.removed,0)) as removed FROM (SELECT DISTINCT SUBSTR(date,1,10) as d FROM commits) dates LEFT JOIN commits c ON SUBSTR(c.date,1,10)=dates.d LEFT JOIN (SELECT id, CAST(started_at/1000 AS TEXT) as started_at FROM sessions) s ON 1=0 GROUP BY dates.d ORDER BY dates.d`));
      if (pathname === "/api/lines-by-day") return json(q(`SELECT SUBSTR(date,1,10) as d,SUM(CASE WHEN commit_type='feat' THEN 1 ELSE 0 END) as feats,SUM(CASE WHEN commit_type='fix' THEN 1 ELSE 0 END) as fixes,COUNT(*) as total FROM commits GROUP BY d ORDER BY d`));
      if (pathname === "/api/git-state") return json(q(`SELECT project_path,dirty_file_count,stash_count,branch_count,current_branch FROM project_git_state WHERE dirty_file_count>0 OR stash_count>0 ORDER BY dirty_file_count DESC`));
      if (pathname === "/api/search") {
        const query = searchParams.get("q") || "";
        if (!query) return json([]);
        return json(q(`SELECT hm.timestamp,hm.project_path,hm.display FROM history_fts f JOIN history_messages hm ON hm.id=f.rowid WHERE history_fts MATCH ? ORDER BY hm.timestamp DESC LIMIT 30`, query));
      }
      // Conversation endpoints
      if (pathname === "/api/chat/sessions") return json(q(`SELECT DISTINCT session_id, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as msg_count, (SELECT content FROM conversation_messages c2 WHERE c2.session_id=c.session_id AND c2.role='user' AND c2.content IS NOT NULL ORDER BY c2.timestamp LIMIT 1) as first_msg FROM conversation_messages c WHERE type IN ('user','assistant') GROUP BY session_id ORDER BY first_ts DESC LIMIT 100`));
      if (pathname.startsWith("/api/chat/")) {
        const sid = pathname.slice(10);
        if (sid) return json(q(`SELECT uuid,parent_uuid,type,role,content,model,timestamp,tool_name,tool_use_id,input_tokens,output_tokens FROM conversation_messages WHERE session_id=? ORDER BY rowid`, sid));
      }
      if (pathname === "/api/chat-search") {
        const query = searchParams.get("q") || "";
        if (!query) return json([]);
        return json(q(`SELECT cm.session_id,cm.timestamp,cm.role,cm.content FROM conversation_fts f JOIN conversation_messages cm ON cm.id=f.rowid WHERE conversation_fts MATCH ? ORDER BY cm.timestamp DESC LIMIT 40`, query));
      }
      if (pathname === "/api/conversation-stats") return json({
        total: q(`SELECT COUNT(*) as n FROM conversation_messages`)[0],
        byType: q(`SELECT type,COUNT(*) as n FROM conversation_messages GROUP BY type ORDER BY n DESC`),
        byModel: q(`SELECT model,COUNT(*) as n FROM conversation_messages WHERE model IS NOT NULL GROUP BY model ORDER BY n DESC`),
        toolUsage: q(`SELECT tool_name,COUNT(*) as n FROM conversation_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 15`),
        totalTokens: q(`SELECT SUM(COALESCE(input_tokens,0)) as inp,SUM(COALESCE(output_tokens,0)) as outp FROM conversation_messages`)[0],
      });
      if (pathname === "/api/stats") return json({
        sessions: q(`SELECT COUNT(*) as n FROM sessions`)[0],
        messages: q(`SELECT COUNT(*) as n FROM history_messages`)[0],
        commits: q(`SELECT COUNT(*) as n FROM commits`)[0],
        projects: q(`SELECT COUNT(*) as n FROM projects`)[0],
        tasks: q(`SELECT status,COUNT(*) as n FROM tasks GROUP BY status`),
        totalCost: q(`SELECT ROUND(SUM(cost_usd),2) as n FROM sessions`)[0],
        totalTokens: q(`SELECT SUM(input_tokens)+SUM(output_tokens) as n FROM sessions`)[0],
        totalLines: q(`SELECT SUM(COALESCE(lines_added,0))+SUM(COALESCE(lines_removed,0)) as n FROM sessions`)[0],
        today: today(),
      });

      if (pathname === "/") return html(PAGE);
      if (pathname === "/chat") return html(CHAT_PAGE);
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Dashboard: http://localhost:${port}`);
}

function json(d: unknown) { return new Response(JSON.stringify(d), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
function html(b: string) { return new Response(b, { headers: { "content-type": "text/html; charset=utf-8" } }); }

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Analyzer</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#7d8590;--faint:#484f58;--green:#238636;--blue:#1f6feb;--yellow:#d29922;--red:#da3633;--accent:#39d353;--purple:#8957e5}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:16px 20px;max-width:1400px;margin:0 auto;font-size:13px}
h1{font-size:18px;font-weight:600;color:#e6edf3;display:inline}
.sub{color:var(--dim);font-size:12px;margin:4px 0 16px}
.stats{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px}
.stat .n{font-size:24px;font-weight:700;color:#e6edf3}
.stat .l{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.g4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.c{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:12px 14px;overflow:hidden}
.c h2{font-size:11px;font-weight:500;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
canvas{width:100%!important;display:block}
.br{display:flex;align-items:center;font-size:11px;margin-bottom:2px;gap:4px}
.br .nm{width:110px;text-align:right;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.br .b{height:10px;border-radius:2px}
.br .v{color:var(--faint);min-width:32px;text-align:right;flex-shrink:0;font-size:10px}
.tk{font-size:11px;padding:2px 0;border-bottom:1px solid #21262d;display:flex;gap:6px;align-items:baseline}
.tk:last-child{border:0}
.bg{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0}
.bg.d{background:#0e4429;color:var(--accent)}.bg.w{background:#3d2e00;color:var(--yellow)}.bg.p{background:#21262d;color:var(--dim)}
.sn{font-size:11px;padding:3px 0;border-bottom:1px solid #21262d;display:flex;gap:6px}
.sn:last-child{border:0}
.sn .t{color:var(--dim);flex-shrink:0;width:36px}
.sn .pj{color:var(--blue);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.sn .pr{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sn .m{color:var(--faint);font-size:10px;flex-shrink:0}
.hm{display:flex;gap:2px;flex-wrap:wrap}.hm .d{width:8px;height:8px;border-radius:2px}
.lg{display:flex;gap:3px;align-items:center;margin-top:4px;font-size:9px;color:var(--dim)}.lg .d{width:8px;height:8px;border-radius:2px}
.tabs{display:flex;gap:6px;margin-bottom:8px}
.tab{font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;color:var(--dim);border:1px solid var(--border);background:transparent}
.tab.on{color:#e6edf3;background:var(--border)}
.sc{max-height:280px;overflow-y:auto}
.search{margin-bottom:10px;display:flex;gap:8px}
.search input{flex:1;background:var(--card);border:1px solid var(--border);border-radius:4px;padding:6px 10px;color:var(--text);font-size:12px;outline:none}
.search input:focus{border-color:var(--blue)}
.search button{background:var(--border);color:var(--text);border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px}
.wip-row{font-size:11px;padding:2px 0;display:flex;gap:8px;align-items:center}
.wip-row .pj{color:var(--blue);width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wip-row .info{color:var(--dim)}
.cm{font-size:11px;padding:2px 0;border-bottom:1px solid #21262d;display:flex;gap:6px}
.cm:last-child{border:0}
.cm .dt{color:var(--dim);flex-shrink:0;width:60px;font-size:10px}
.cm .tp{font-size:9px;padding:0 4px;border-radius:2px;background:#21262d;color:var(--accent);flex-shrink:0}
.cm .msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.cm .pj{color:var(--blue);font-size:10px;flex-shrink:0;width:80px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proj-row{font-size:11px;padding:3px 0;border-bottom:1px solid #21262d;display:flex;gap:6px;align-items:center}
.proj-row:last-child{border:0}
.proj-row .nm{color:var(--blue);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.proj-row .tp{font-size:9px;padding:0 4px;border-radius:2px;background:#21262d;color:var(--dim);flex-shrink:0}
.proj-row .dots{display:flex;gap:3px;flex-shrink:0}
.proj-row .dot{width:8px;height:8px;border-radius:50%}
.proj-row .info{color:var(--faint);font-size:10px;margin-left:auto}
@media(max-width:900px){.g2,.g3,.g4{grid-template-columns:1fr}}
</style></head><body>
<h1>Claude Code Analyzer</h1> <a href="/chat" style="color:var(--blue);font-size:12px;margin-left:12px;text-decoration:none">Chat History →</a>
<div class="sub" id="sub">loading...</div>
<div class="stats" id="stats"></div>

<div class="search"><input id="sq" placeholder="Search history (FTS5)..." /><button onclick="doSearch()">Search</button></div>
<div class="c" id="sr" style="display:none;margin-bottom:10px"><h2>Search Results</h2><div class="sc" id="sres"></div></div>

<div class="g2">
<div class="c"><h2>Sessions per Day</h2><canvas id="c_daily" height="130"></canvas></div>
<div class="c"><h2>Messages per Day</h2><canvas id="c_msgs" height="130"></canvas></div>
</div>
<div class="g3">
<div class="c"><h2>Tool Calls per Day</h2><canvas id="c_tools" height="120"></canvas></div>
<div class="c"><h2>Hour of Day</h2><canvas id="c_hours" height="120"></canvas></div>
<div class="c"><h2>Session Duration</h2><canvas id="c_dur" height="120"></canvas></div>
</div>
<div class="g2">
<div class="c"><h2>Projects by Sessions</h2><div id="p_sess"></div></div>
<div class="c"><h2>Projects by Cost</h2><div id="p_cost"></div></div>
</div>
<div class="g3">
<div class="c"><h2>Commit Types</h2><canvas id="c_types" height="150"></canvas></div>
<div class="c"><h2>Commits per Day</h2><canvas id="c_cpd" height="150"></canvas></div>
<div class="c"><h2>Branches</h2><div id="p_branches" class="sc"></div></div>
</div>
<div class="g2">
<div class="c"><h2>Activity Heatmap</h2><div class="hm" id="heatmap"></div><div class="lg"><span class="d" style="background:var(--card);border:1px solid var(--border)"></span>0<span class="d" style="background:#0e4429"></span><span class="d" style="background:#006d32"></span><span class="d" style="background:#26a641"></span><span class="d" style="background:var(--accent)"></span>more</div></div>
<div class="c"><h2>Work in Progress</h2><div class="sc" id="wip"></div></div>
</div>
<div class="g3">
<div class="c"><h2>Tasks</h2>
<div class="tabs"><span class="tab on" data-f="w">In Progress</span><span class="tab" data-f="p">Pending</span><span class="tab" data-f="d">Done</span></div>
<div class="sc" id="tasks"></div></div>
<div class="c"><h2>Recent Sessions</h2><div class="sc" id="sess"></div></div>
<div class="c"><h2>Recent Commits</h2><div class="sc" id="commits"></div></div>
</div>
<div class="g2">
<div class="c"><h2>Project Health</h2><div class="sc" id="health"></div></div>
<div class="c"><h2>Tokens by Project</h2><div id="p_tokens"></div></div>
</div>

<script>
const F=s=>fetch(s).then(r=>r.json());
const nm=p=>p?p.split("/").pop():"?";
const e=s=>(s||"").replace(/</g,"&lt;").slice(0,100);
const dur=m=>{if(!m||m<1)return"<1m";const h=Math.floor(m/60);return h?h+"h "+Math.round(m%60)+"m":Math.round(m)+"m"};
const $=id=>document.getElementById(id);
const cs=["#238636","#1f6feb","#d29922","#da3633","#8b949e","#6e7681","#484f58","#30363d","#388bfd","#f78166","#8957e5","#d2a8ff"];
const money=n=>n!=null?"$"+n.toFixed(2):"$0";
const tok=n=>{if(!n)return"0";if(n>1e6)return(n/1e6).toFixed(1)+"M";if(n>1e3)return(n/1e3).toFixed(1)+"K";return n+""};

function bar(cv,data,lk,vk,color,h){
  if(!data.length)return;
  const ctx=cv.getContext("2d"),dpr=devicePixelRatio||1;
  const W=cv.parentElement.clientWidth-28;h=h||cv.height;
  cv.width=W*dpr;cv.height=h*dpr;cv.style.height=h+"px";
  ctx.scale(dpr,dpr);
  const mx=Math.max(...data.map(d=>d[vk]),1),bw=Math.max(1,(W-20)/data.length-1),pad=16;
  data.forEach((d,i)=>{const x=16+i*(bw+1),bh=(d[vk]/mx)*(h-pad-4);ctx.fillStyle=typeof color==="function"?color(d,i):color;ctx.fillRect(x,h-pad-bh,bw,bh)});
  ctx.fillStyle="#484f58";ctx.font="8px system-ui";
  const step=Math.max(1,Math.floor(data.length/8));
  data.forEach((d,i)=>{if(i%step===0){const x=16+i*(bw+1);const l=typeof d[lk]==="number"?d[lk]+"":String(d[lk]).slice(5);ctx.fillText(l,x,h-2)}});
}

function donut(cv,data,key){
  if(!data.length)return;
  const ctx=cv.getContext("2d"),dpr=devicePixelRatio||1;
  const W=cv.parentElement.clientWidth-28,H=cv.height;
  cv.width=W*dpr;cv.height=H*dpr;cv.style.height=H+"px";ctx.scale(dpr,dpr);
  const cx=60,cy=H/2,r=45,ir=25,tot=data.reduce((s,d)=>s+d.n,0);
  let a=-Math.PI/2;
  data.forEach((d,i)=>{const sl=(d.n/tot)*Math.PI*2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+sl);ctx.closePath();ctx.fillStyle=cs[i%cs.length];ctx.fill();a+=sl});
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.fillStyle="#161b22";ctx.fill();
  ctx.font="10px system-ui";
  data.forEach((d,i)=>{const y=12+i*15,x=130;ctx.fillStyle=cs[i%cs.length];ctx.fillRect(x,y-7,7,7);ctx.fillStyle="#c9d1d9";ctx.fillText(d[key]+" ("+d.n+")",x+12,y)});
}

function bars(el,data,nk,vk,maxW,color,fmt){
  const mx=Math.max(...data.map(d=>d[vk]),1);
  el.innerHTML=data.slice(0,12).map(d=>{
    const w=Math.round(d[vk]/mx*maxW);
    return '<div class="br"><span class="nm">'+e(typeof d[nk]==="string"?nm(d[nk]):d[nk])+'</span><span class="b" style="width:'+w+'px;background:'+(color||"var(--green)")+'"></span><span class="v">'+(fmt?fmt(d):d[vk])+'</span></div>'
  }).join("");
}

async function doSearch(){
  const q=$("sq").value.trim();if(!q)return;
  const res=await F("/api/search?q="+encodeURIComponent(q));
  $("sr").style.display="block";
  $("sres").innerHTML=res.map(r=>{
    const d=r.timestamp?new Date(r.timestamp).toLocaleDateString("en",{month:"short",day:"numeric",year:"numeric"}):"?";
    return '<div class="sn"><span class="t">'+d+'</span><span class="pj">'+e(nm(r.project_path))+'</span><span class="pr">'+e(r.display)+'</span></div>'
  }).join("")||'<div style="color:var(--dim)">no results</div>';
}
$("sq").addEventListener("keydown",ev=>{if(ev.key==="Enter")doSearch()});

async function load(){
  const[stats,daily,hours,projs,types,tasks,sessions,commits,durDist,branches,costProj,gitState,cpd]=await Promise.all([
    F("/api/stats"),F("/api/daily"),F("/api/hours"),F("/api/project-sessions"),F("/api/commit-types"),
    F("/api/tasks"),F("/api/sessions"),F("/api/commits"),F("/api/duration-dist"),F("/api/branches"),
    F("/api/cost-by-project"),F("/api/git-state"),F("/api/lines-by-day")
  ]);
  const allProjects=await F("/api/projects");

  const tm={};(stats.tasks||[]).forEach(t=>{tm[t.status]=t.n});
  $("sub").textContent=stats.today+" · "+daily.length+" days · "+(stats.totalCost?.n?money(stats.totalCost.n):"$0")+" total cost · "+tok(stats.totalTokens?.n)+" tokens";
  $("stats").innerHTML=[
    [stats.sessions.n,"sessions"],[stats.messages.n.toLocaleString(),"messages"],
    [stats.commits.n,"commits"],[stats.projects.n,"projects"],
    [tm.completed||0,"done"],[tm.in_progress||0,"wip"],[tm.pending||0,"pending"],
    [money(stats.totalCost?.n||0),"cost"],[tok(stats.totalTokens?.n||0),"tokens"]
  ].map(([n,l])=>'<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>').join("");

  // Charts
  bar($("c_daily"),daily,"date","session_count","#238636");
  bar($("c_msgs"),daily,"date","message_count","#1f6feb");
  bar($("c_tools"),daily,"date","tool_call_count","#8957e5");
  bar($("c_hours"),hours,"hour","n","#1f6feb");
  bar($("c_dur"),durDist,"bucket","n","#d29922");
  donut($("c_types"),types,"commit_type");
  bar($("c_cpd"),cpd,"d","total",(d)=>d.feats>d.fixes?"#238636":"#da3633");

  // Project bars
  bars($("p_sess"),projs,"project_path","sessions",150,"var(--green)",d=>d.sessions+" · "+dur(d.minutes));
  bars($("p_cost"),costProj.filter(c=>c.cost>0),"project_path","cost",150,"var(--yellow)",d=>money(d.cost));
  bars($("p_tokens"),costProj.filter(c=>c.inp>0),"project_path","inp",150,"var(--purple)",d=>tok(d.inp+d.outp));

  // Branches
  const bmax=Math.max(...branches.map(b=>b.n),1);
  $("p_branches").innerHTML=branches.map(b=>{
    const w=Math.round(b.n/bmax*120);
    return '<div class="br"><span class="nm">'+e(b.git_branch)+'</span><span class="b" style="width:'+w+'px;background:var(--blue)"></span><span class="v">'+b.n+'</span></div>';
  }).join("");

  // Heatmap
  const hm=$("heatmap"),hmap={};daily.forEach(d=>{hmap[d.date]=d.session_count});
  const dts=Object.keys(hmap).sort();
  if(dts.length){const mx=Math.max(...Object.values(hmap));const s=new Date(dts[0]+"T00:00:00"),en=new Date(dts[dts.length-1]+"T00:00:00");
  for(let d=new Date(s);d<=en;d.setDate(d.getDate()+1)){const k=d.toISOString().slice(0,10),v=hmap[k]||0;const q=v===0?0:v<mx*.25?1:v<mx*.5?2:v<mx*.75?3:4;
  const cl=["#161b22","#0e4429","#006d32","#26a641","#39d353"][q];const el=document.createElement("div");el.className="d";el.style.background=cl;el.title=k+": "+v;hm.appendChild(el)}}

  // WIP
  $("wip").innerHTML=gitState.length?gitState.map(g=>'<div class="wip-row"><span class="pj">'+e(nm(g.project_path))+'</span><span class="info">'+g.dirty_file_count+' dirty'+(g.stash_count?' · '+g.stash_count+' stash':'')+(g.current_branch?' · '+g.current_branch:'')+'</span></div>').join(""):'<div style="color:var(--dim)">all clean</div>';

  // Tasks
  function renderTasks(f){
    const fl=tasks.filter(t=>f==="w"?t.status==="in_progress":f==="p"?t.status==="pending":t.status==="completed");
    $("tasks").innerHTML=fl.slice(0,60).map(t=>{
      const b=t.status==="completed"?"d":t.status==="in_progress"?"w":"p";
      const sid=t.suite_id.length>12?t.suite_id.slice(0,8)+"..":t.suite_id;
      const owner=t.owner?'<span style="color:var(--purple);font-size:10px">'+e(t.owner)+'</span>':"";
      const blocked=t.blocked_by&&t.blocked_by!=="[]"?'<span style="color:var(--red);font-size:9px">blocked</span>':"";
      return '<div class="tk"><span class="bg '+b+'">'+(b==="d"?"done":b==="w"?"wip":"todo")+'</span><span style="color:var(--blue);font-size:10px">'+e(sid)+'</span><span style="flex:1">'+e(t.subject)+'</span>'+owner+blocked+'</div>';
    }).join("")||'<div style="color:var(--dim)">none</div>';
  }
  renderTasks("w");
  document.querySelectorAll(".tab").forEach(tab=>{tab.onclick=()=>{document.querySelectorAll(".tab").forEach(t=>t.classList.remove("on"));tab.classList.add("on");renderTasks(tab.dataset.f)}});

  // Sessions
  $("sess").innerHTML=sessions.slice(0,50).map(s=>{
    const d=s.started_at?new Date(s.started_at):null;
    const time=d?d.toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",hour12:false}):"?";
    const cost=s.cost_usd?'<span style="color:var(--yellow)">'+money(s.cost_usd)+'</span>':"";
    const lines=(s.lines_added||s.lines_removed)?'<span style="color:var(--green)">+'+( s.lines_added||0)+'</span><span style="color:var(--red)">-'+(s.lines_removed||0)+'</span>':"";
    return '<div class="sn"><span class="t">'+time+'</span><span class="pj">'+e(nm(s.project_path))+'</span><span class="pr">'+e(s.first_prompt)+'</span><span class="m">'+dur(s.duration_minutes)+' '+cost+' '+lines+'</span></div>';
  }).join("");

  // Commits
  $("commits").innerHTML=commits.slice(0,50).map(c=>{
    const d=c.date?c.date.slice(5,10):"?";
    const tp=c.commit_type?'<span class="tp">'+c.commit_type+'</span>':"";
    return '<div class="cm"><span class="pj">'+e(nm(c.project_path))+'</span>'+tp+'<span class="msg">'+e(c.message)+'</span><span class="dt">'+d+'</span></div>';
  }).join("");

  // Project Health
  $("health").innerHTML=allProjects.map(p=>{
    const git=p.has_git?'<span class="dot" style="background:var(--green)" title="git"></span>':'<span class="dot" style="background:var(--red)" title="no git"></span>';
    const md=p.has_claude_md?'<span class="dot" style="background:var(--blue)" title="CLAUDE.md"></span>':'<span class="dot" style="background:var(--faint)" title="no CLAUDE.md"></span>';
    const dirty=p.dirty_file_count>0?'<span class="dot" style="background:var(--yellow)" title="dirty"></span>':'';
    const info=[];if(p.total_commits)info.push(p.total_commits+"c");if(p.stash_count)info.push(p.stash_count+"s");
    return '<div class="proj-row"><span class="nm">'+e(p.name)+'</span><span class="tp">'+p.type+'</span><span class="dots">'+git+md+dirty+'</span><span class="info">'+info.join(" · ")+'</span></div>';
  }).join("");
}
load();
</script></body></html>`;

const CHAT_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat History</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#7d8590;--faint:#484f58;--green:#238636;--blue:#1f6feb;--yellow:#d29922;--red:#da3633;--accent:#39d353;--purple:#8957e5;--user-bg:#1c2333;--asst-bg:#161b22}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column}
.top{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0}
.top h1{font-size:16px;font-weight:600;color:#e6edf3}
.top a{color:var(--blue);font-size:12px;text-decoration:none}
.top .stats{margin-left:auto;font-size:11px;color:var(--dim)}
.search-bar{padding:8px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:8px}
.search-bar input{flex:1;background:var(--card);border:1px solid var(--border);border-radius:4px;padding:6px 10px;color:var(--text);font-size:12px;outline:none}
.search-bar input:focus{border-color:var(--blue)}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:320px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
.sess-item{padding:8px 12px;border-bottom:1px solid #21262d;cursor:pointer;font-size:12px}
.sess-item:hover{background:#1c2128}
.sess-item.active{background:var(--user-bg);border-left:2px solid var(--blue)}
.sess-item .date{color:var(--dim);font-size:10px}
.sess-item .preview{color:var(--text);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess-item .meta{color:var(--faint);font-size:10px;margin-top:2px}
.chat{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.user{background:var(--user-bg);border:1px solid #293548;align-self:flex-end;border-radius:8px 8px 2px 8px}
.msg.assistant{background:var(--asst-bg);border:1px solid var(--border);align-self:flex-start;border-radius:8px 8px 8px 2px}
.msg .role{font-size:10px;font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.msg.user .role{color:var(--blue)}
.msg.assistant .role{color:var(--accent)}
.msg .tool-badge{background:#21262d;padding:2px 7px;border-radius:3px;font-size:10px;color:var(--purple);margin:2px 0;display:inline-block}
.msg .model{font-size:9px;color:var(--faint);margin-top:4px}
.msg .tokens{font-size:9px;color:var(--faint)}
.thinking{background:#1c1c2e;border:1px solid #2d2d44;border-radius:4px;padding:8px 10px;margin:6px 0;font-size:11px;color:#a0a0c0;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.thinking-toggle{font-size:10px;color:var(--purple);cursor:pointer;user-select:none}
.tool-block{background:#0d1520;border:1px solid #1c3050;border-radius:4px;margin:6px 0;overflow:hidden}
.tool-header{padding:4px 10px;font-size:10px;font-weight:600;color:var(--blue);background:#111827;cursor:pointer;user-select:none;display:flex;justify-content:space-between}
.tool-body{padding:6px 10px;font-size:11px;color:var(--dim);max-height:300px;overflow-y:auto;white-space:pre-wrap;display:none}
.tool-body.open{display:block}
.tool-result{background:#0d1a0d;border:1px solid #1a3a1a;border-radius:4px;margin:6px 0;overflow:hidden}
.tool-result.error{background:#1a0d0d;border-color:#3a1a1a}
.result-header{padding:4px 10px;font-size:10px;font-weight:600;color:var(--green);background:#0a1a0a;cursor:pointer;user-select:none}
.tool-result.error .result-header{color:var(--red);background:#1a0a0a}
.result-body{padding:6px 10px;font-size:11px;color:var(--dim);max-height:300px;overflow-y:auto;white-space:pre-wrap;display:none}
.result-body.open{display:block}
.progress-msg{font-size:10px;color:var(--faint);padding:2px 0;border-left:2px solid var(--border);padding-left:8px;margin:2px 0}
.system-msg{font-size:10px;color:var(--yellow);padding:2px 8px;background:#1a1800;border-radius:3px;margin:2px 0}
.empty{color:var(--dim);text-align:center;padding:40px;font-size:13px}
.tool-stats{padding:8px 12px;border-top:1px solid var(--border);font-size:10px;color:var(--dim)}
.tool-stats span{margin-right:10px}
@media(max-width:768px){.sidebar{width:200px}}
</style></head><body>
<div class="top">
  <h1>Chat History</h1>
  <a href="/">← Dashboard</a>
  <div class="stats" id="cstats"></div>
</div>
<div class="search-bar">
  <input id="csearch" placeholder="Search conversations (FTS5)..." />
  <label style="font-size:10px;color:var(--dim);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showThinking" checked> thinking</label>
  <label style="font-size:10px;color:var(--dim);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showTools" checked> tools</label>
  <label style="font-size:10px;color:var(--dim);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showProgress"> progress</label>
  <label style="font-size:10px;color:var(--dim);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showSystem"> system</label>
</div>
<div class="main">
  <div class="sidebar" id="sidebar"><div class="empty">loading...</div></div>
  <div class="chat" id="chat"><div class="empty">select a session</div></div>
</div>
<div class="tool-stats" id="tstats"></div>
<script>
const F=s=>fetch(s).then(r=>r.json());
const $=id=>document.getElementById(id);
const esc=s=>(s||"").replace(/</g,"&lt;");
const nm=p=>p?p.split("/").pop():"?";

let allSessions=[];

async function loadSessions(){
  const[sessions,stats]=await Promise.all([F("/api/chat/sessions"),F("/api/conversation-stats")]);
  allSessions=sessions;
  $("cstats").textContent=stats.total.n.toLocaleString()+" messages · "+(stats.totalTokens?.inp?Math.round((stats.totalTokens.inp+stats.totalTokens.outp)/1e6)+"M tokens":"");

  // Tool stats bar
  const tools=(stats.toolUsage||[]).slice(0,10);
  $("tstats").innerHTML="<b>Tools:</b> "+tools.map(t=>'<span>'+t.tool_name+' <b>'+t.n+'</b></span>').join("")+" | <b>Models:</b> "+(stats.byModel||[]).map(m=>'<span>'+nm(m.model)+' <b>'+m.n+'</b></span>').join("");

  renderSessions(sessions);
}

function renderSessions(sessions){
  $("sidebar").innerHTML=sessions.map(s=>{
    const d=s.first_ts?new Date(s.first_ts).toLocaleDateString("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"?";
    const preview=esc(s.first_msg||"(no content)").slice(0,80);
    return '<div class="sess-item" data-id="'+s.session_id+'" onclick="loadChat(this)"><div class="date">'+d+' · '+s.msg_count+' msgs</div><div class="preview">'+preview+'</div><div class="meta">'+s.session_id.slice(0,8)+'...</div></div>';
  }).join("")||'<div class="empty">no sessions</div>';
}

let currentMsgs=[];
async function loadChat(el){
  document.querySelectorAll(".sess-item").forEach(e=>e.classList.remove("active"));
  el.classList.add("active");
  const sid=el.dataset.id;
  currentMsgs=await F("/api/chat/"+sid);
  renderChat();
}

function renderChat(){
  const showThinking=$("showThinking").checked;
  const showTools=$("showTools").checked;
  const showProgress=$("showProgress").checked;
  const showSystem=$("showSystem").checked;
  let uid=0;

  $("chat").innerHTML=currentMsgs.map(m=>{
    const t=m.type;
    const content=m.content||"";

    // Filter
    if(t==="progress"&&!showProgress)return"";
    if((t==="system"||t==="summary")&&!showSystem)return"";
    if(t==="file-history-snapshot"&&!showSystem)return"";

    // Progress events
    if(t==="progress"){return'<div class="progress-msg">'+esc(content).slice(0,200)+'</div>'}
    if(t==="system"||t==="summary"||t==="file-history-snapshot"||t==="queue-operation"||t==="pr-link"||t==="last-prompt"||t==="custom-title"){
      return'<div class="system-msg"><b>'+t+'</b> '+esc(content).slice(0,300)+'</div>'
    }

    if(t!=="user"&&t!=="assistant")return"";

    const cls=m.role==="user"?"user":"assistant";
    const role=m.role==="user"?"You":"Claude";
    const model=m.model?'<div class="model">'+nm(m.model)+'</div>':"";
    const tokens=(m.input_tokens||m.output_tokens)?'<span class="tokens">'+(m.input_tokens?m.input_tokens.toLocaleString()+" in":"")+(m.output_tokens?" "+m.output_tokens.toLocaleString()+" out":"")+'</span>':"";

    // Parse structured content
    let html="";
    const escaped=esc(content);

    // Split on our XML-like tags
    const parts=content.split(/(<thinking>|<\\/thinking>|<tool_use[^>]*>|<\\/tool_use>|<tool_result[^>]*>|<\\/tool_result>)/);
    let inThinking=false,inTool=false,inResult=false,toolMeta="",resultMeta="";

    for(const part of parts){
      if(part==="<thinking>"){inThinking=true;continue}
      if(part==="</thinking>"){inThinking=false;continue}
      if(part.startsWith("<tool_use")){inTool=true;toolMeta=part;continue}
      if(part==="</tool_use>"){inTool=false;continue}
      if(part.startsWith("<tool_result")){inResult=true;resultMeta=part;continue}
      if(part==="</tool_result>"){inResult=false;continue}

      if(inThinking&&showThinking){
        const id="th"+(uid++);
        html+='<div class="thinking-toggle" onclick="let b=document.getElementById(\\''+id+"\\');b.style.display=b.style.display==='none'?'block':'none'\">thinking ("+part.length+" chars) ▾</div>";
        html+='<div class="thinking" id="'+id+'" style="display:none">'+esc(part)+'</div>';
      }else if(inTool&&showTools){
        const nameMatch=toolMeta.match(/name="([^"]+)"/);
        const tn=nameMatch?nameMatch[1]:"tool";
        const id="tb"+(uid++);
        html+='<div class="tool-block"><div class="tool-header" onclick="document.getElementById(\\''+id+"\\').classList.toggle('open')\">"+tn+' <span style="font-weight:normal">▾</span></div>';
        html+='<div class="tool-body" id="'+id+'">'+esc(part.trim())+'</div></div>';
      }else if(inResult&&showTools){
        const isErr=resultMeta.includes('error="true"');
        const id="tr"+(uid++);
        html+='<div class="tool-result'+(isErr?" error":"")+'"><div class="result-header" onclick="document.getElementById(\\''+id+"\\').classList.toggle('open')\">"+(isErr?"error":"result")+' <span style="font-weight:normal">▾</span></div>';
        html+='<div class="result-body" id="'+id+'">'+esc(part.trim()).slice(0,10000)+'</div></div>';
      }else if(!inThinking&&!inTool&&!inResult){
        const text=part.trim();
        if(text)html+=esc(text);
      }
    }

    if(!html.trim())return"";
    return '<div class="msg '+cls+'"><div class="role">'+role+'</div>'+html+model+tokens+'</div>';
  }).filter(Boolean).join("")||'<div class="empty">empty session</div>';

  $("chat").scrollTop=0;
}

// Re-render on filter change
["showThinking","showTools","showProgress","showSystem"].forEach(id=>{
  $(id).addEventListener("change",()=>{if(currentMsgs.length)renderChat()});
});

// Search
$("csearch").addEventListener("input", async function(){
  const q=this.value.trim();
  if(!q){renderSessions(allSessions);return}
  if(q.length<2)return;
  const res=await F("/api/chat-search?q="+encodeURIComponent(q));
  // Group by session
  const sids=[...new Set(res.map(r=>r.session_id))];
  const fake=sids.map(sid=>{
    const msgs=res.filter(r=>r.session_id===sid);
    return{session_id:sid,first_ts:msgs[0]?.timestamp,msg_count:msgs.length,first_msg:msgs[0]?.content};
  });
  renderSessions(fake);
});

loadSessions();
</script></body></html>`;
