import { getDb } from "../db/connection.ts";
import { today } from "../utils/dates.ts";

export function serveCommand(args: string[]): void {
  const port = parseInt(args.find(a => /^\d+$/.test(a)) || "3000");
  const db = getDb();

  const q = (sql: string) => db.prepare(sql).all();
  const name = (p: string) => p?.split("/").pop() || "unknown";

  Bun.serve({
    port,
    fetch(req) {
      const { pathname } = new URL(req.url);

      // API
      if (pathname === "/api/daily") return json(q(`SELECT date, session_count, message_count, tool_call_count FROM daily_stats ORDER BY date`));
      if (pathname === "/api/sessions") return json(q(`SELECT id, project_path, started_at, ended_at, message_count, duration_minutes, first_prompt, summary, git_branch, cost_usd, input_tokens, output_tokens, lines_added, lines_removed FROM sessions ORDER BY started_at DESC LIMIT 200`));
      if (pathname === "/api/projects") return json(q(`SELECT p.*, g.dirty_file_count, g.stash_count, g.branch_count, g.current_branch FROM projects p LEFT JOIN project_git_state g ON g.project_path = p.path ORDER BY p.total_sessions DESC`));
      if (pathname === "/api/tasks") return json(q(`SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, suite_id`));
      if (pathname === "/api/commits") return json(q(`SELECT * FROM commits ORDER BY date DESC LIMIT 100`));
      if (pathname === "/api/hours") return json(q(`SELECT CAST(((started_at/1000)%86400)/3600 AS INTEGER) as hour, COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`));
      if (pathname === "/api/project-sessions") return json(q(`SELECT project_path, COUNT(*) as sessions, ROUND(SUM(duration_minutes)) as minutes, SUM(lines_added) as added, SUM(lines_removed) as removed FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY sessions DESC LIMIT 20`));
      if (pathname === "/api/commit-types") return json(q(`SELECT commit_type, COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type!='' GROUP BY commit_type ORDER BY n DESC LIMIT 10`));
      if (pathname === "/api/stats") return json({
        sessions: q(`SELECT COUNT(*) as n FROM sessions`)[0],
        messages: q(`SELECT COUNT(*) as n FROM history_messages`)[0],
        commits: q(`SELECT COUNT(*) as n FROM commits`)[0],
        projects: q(`SELECT COUNT(*) as n FROM projects`)[0],
        tasks: q(`SELECT status, COUNT(*) as n FROM tasks GROUP BY status`),
        today: today(),
      });

      // Dashboard
      if (pathname === "/") return html(dashboard());
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`Dashboard: http://localhost:${port}`);
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function dashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Analyzer</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--dim:#7d8590;--faint:#484f58;--green:#238636;--blue:#1f6feb;--yellow:#d29922;--red:#da3633;--accent:#39d353}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px 24px;max-width:1280px;margin:0 auto}
h1{font-size:20px;font-weight:600;color:#e6edf3}
.sub{color:var(--dim);font-size:13px;margin:4px 0 20px}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px}
.stat .n{font-size:28px;font-weight:700;color:#e6edf3}
.stat .l{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow:hidden}
.card h2{font-size:12px;font-weight:500;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
canvas{width:100%!important;display:block}
.bar-row{display:flex;align-items:center;font-size:12px;margin-bottom:3px;gap:6px}
.bar-row .name{width:120px;text-align:right;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.bar-row .bar{height:12px;border-radius:2px;transition:width .3s}
.bar-row .val{color:var(--faint);min-width:36px;text-align:right;flex-shrink:0;font-size:11px}
.task{font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:baseline}
.task:last-child{border:0}
.badge{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:500;flex-shrink:0}
.badge.done{background:#0e4429;color:var(--accent)}
.badge.wip{background:#3d2e00;color:var(--yellow)}
.badge.todo{background:#21262d;color:var(--dim)}
.task .suite{color:var(--blue);font-size:11px}
.task .subj{color:var(--text)}
.session{font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);display:flex;gap:8px}
.session:last-child{border:0}
.session .time{color:var(--dim);flex-shrink:0;width:40px}
.session .proj{color:var(--blue);width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.session .prompt{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.session .meta{color:var(--faint);font-size:11px;flex-shrink:0}
.heatmap{display:flex;gap:2px;flex-wrap:wrap}
.heatmap .d{width:9px;height:9px;border-radius:2px}
.legend{display:flex;gap:3px;align-items:center;margin-top:6px;font-size:10px;color:var(--dim)}
.legend .d{width:9px;height:9px;border-radius:2px}
.tabs{display:flex;gap:8px;margin-bottom:10px}
.tab{font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;color:var(--dim);border:1px solid var(--border);background:transparent}
.tab.active{color:#e6edf3;background:var(--border)}
.scroll{max-height:320px;overflow-y:auto}
@media(max-width:768px){.grid,.grid3{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>Claude Code Analyzer</h1>
<div class="sub" id="sub">loading...</div>
<div class="stats" id="stats"></div>

<div class="grid">
  <div class="card"><h2>Sessions per Day</h2><canvas id="daily" height="140"></canvas></div>
  <div class="card"><h2>Hour of Day</h2><canvas id="hourly" height="140"></canvas></div>
</div>

<div class="grid3">
  <div class="card"><h2>Projects</h2><div id="projects"></div></div>
  <div class="card"><h2>Commit Types</h2><canvas id="types" height="160"></canvas></div>
  <div class="card"><h2>Activity</h2><div class="heatmap" id="heatmap"></div><div class="legend"><span class="d" style="background:var(--card);border:1px solid var(--border)"></span>0<span class="d" style="background:#0e4429"></span><span class="d" style="background:#006d32"></span><span class="d" style="background:#26a641"></span><span class="d" style="background:var(--accent)"></span>more</div></div>
</div>

<div class="grid">
  <div class="card">
    <h2>Tasks</h2>
    <div class="tabs"><span class="tab active" data-f="wip">In Progress</span><span class="tab" data-f="todo">Pending</span><span class="tab" data-f="done">Done</span></div>
    <div class="scroll" id="tasks"></div>
  </div>
  <div class="card">
    <h2>Recent Sessions</h2>
    <div class="scroll" id="sessions"></div>
  </div>
</div>

<script>
const f=s=>fetch(s).then(r=>r.json());
const name=p=>p?p.split("/").pop():"?";
const esc=s=>(s||"").replace(/</g,"&lt;").slice(0,80);
const dur=m=>{if(!m||m<1)return"<1m";const h=Math.floor(m/60);return h?h+"h "+Math.round(m%60)+"m":Math.round(m)+"m"};
const colors=["#238636","#1f6feb","#d29922","#da3633","#8b949e","#6e7681","#484f58","#30363d","#388bfd","#f78166"];

function bar(canvas,data,lk,vk,color){
  const ctx=canvas.getContext("2d"),dpr=devicePixelRatio||1;
  const W=canvas.parentElement.clientWidth-32,H=canvas.height;
  canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.height=H+"px";
  ctx.scale(dpr,dpr);
  if(!data.length)return;
  const max=Math.max(...data.map(d=>d[vk]),1);
  const bw=Math.max(1,(W-24)/data.length-1);
  data.forEach((d,i)=>{
    const x=20+i*(bw+1),bh=(d[vk]/max)*(H-24);
    ctx.fillStyle=typeof color==="function"?color(d,i):color;
    ctx.fillRect(x,H-20-bh,bw,bh);
  });
  ctx.fillStyle="#484f58";ctx.font="9px system-ui";
  const step=Math.max(1,Math.floor(data.length/10));
  data.forEach((d,i)=>{if(i%step===0){const x=20+i*(bw+1);const l=typeof d[lk]==="number"?d[lk]+"":d[lk].slice(5);ctx.fillText(l,x,H-4)}});
}

function donut(canvas,data){
  const ctx=canvas.getContext("2d"),dpr=devicePixelRatio||1;
  const W=canvas.parentElement.clientWidth-32,H=canvas.height;
  canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.height=H+"px";
  ctx.scale(dpr,dpr);
  const cx=70,cy=H/2,r=50,ir=28,total=data.reduce((s,d)=>s+d.n,0);
  let a=-Math.PI/2;
  data.forEach((d,i)=>{const sl=(d.n/total)*Math.PI*2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+sl);ctx.closePath();ctx.fillStyle=colors[i%colors.length];ctx.fill();a+=sl});
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.fillStyle="#161b22";ctx.fill();
  ctx.font="11px system-ui";
  data.forEach((d,i)=>{const y=14+i*17,x=140;ctx.fillStyle=colors[i%colors.length];ctx.fillRect(x,y-8,8,8);ctx.fillStyle="#c9d1d9";ctx.fillText(d.commit_type+" ("+d.n+")",x+14,y)});
}

async function load(){
  const[stats,daily,hours,projs,types,tasks,sessions]=await Promise.all([
    f("/api/stats"),f("/api/daily"),f("/api/hours"),f("/api/project-sessions"),f("/api/commit-types"),f("/api/tasks"),f("/api/sessions")
  ]);

  const taskMap={};(stats.tasks||[]).forEach(t=>{taskMap[t.status]=t.n});
  document.getElementById("sub").textContent="Generated "+stats.today+" · "+daily.length+" days tracked";
  document.getElementById("stats").innerHTML=[
    [stats.sessions.n,"sessions"],[stats.messages.n.toLocaleString(),"messages"],
    [stats.commits.n,"commits"],[stats.projects.n,"projects"],
    [taskMap.completed||0,"tasks done"]
  ].map(([n,l])=>'<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>').join("");

  bar(document.getElementById("daily"),daily,"date","session_count","#238636");
  bar(document.getElementById("hourly"),hours,"hour","n","#1f6feb");
  donut(document.getElementById("types"),types);

  // Projects
  const maxS=Math.max(...projs.map(p=>p.sessions),1);
  document.getElementById("projects").innerHTML=projs.slice(0,12).map(p=>{
    const w=Math.round(p.sessions/maxS*160);
    return '<div class="bar-row"><span class="name">'+esc(name(p.project_path))+'</span><span class="bar" style="width:'+w+'px;background:var(--green)"></span><span class="val">'+p.sessions+'</span><span class="val">'+dur(p.minutes)+'</span></div>';
  }).join("");

  // Heatmap
  const hm=document.getElementById("heatmap"),map={};
  daily.forEach(d=>{map[d.date]=d.session_count});
  const dates=Object.keys(map).sort();
  if(dates.length){
    const max=Math.max(...Object.values(map));
    const start=new Date(dates[0]+"T00:00:00"),end=new Date(dates[dates.length-1]+"T00:00:00");
    for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
      const k=d.toISOString().slice(0,10),v=map[k]||0;
      const q=v===0?0:v<max*.25?1:v<max*.5?2:v<max*.75?3:4;
      const c=["#161b22","#0e4429","#006d32","#26a641","#39d353"][q];
      const el=document.createElement("div");el.className="d";el.style.background=c;el.title=k+": "+v;hm.appendChild(el);
    }
  }

  // Tasks
  function renderTasks(filter){
    const filtered=tasks.filter(t=>filter==="wip"?t.status==="in_progress":filter==="todo"?t.status==="pending":t.status==="completed");
    document.getElementById("tasks").innerHTML=filtered.slice(0,50).map(t=>{
      const badge=t.status==="completed"?"done":t.status==="in_progress"?"wip":"todo";
      const sid=t.suite_id.length>12?t.suite_id.slice(0,8)+"..":t.suite_id;
      return '<div class="task"><span class="badge '+badge+'">'+badge+'</span><span class="suite">'+esc(sid)+'</span><span class="subj">'+esc(t.subject)+'</span></div>';
    }).join("")||'<div style="color:var(--dim);font-size:12px">none</div>';
  }
  renderTasks("wip");
  document.querySelectorAll(".tab").forEach(tab=>{
    tab.onclick=()=>{document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));tab.classList.add("active");renderTasks(tab.dataset.f)};
  });

  // Sessions
  document.getElementById("sessions").innerHTML=sessions.slice(0,40).map(s=>{
    const d=s.started_at?new Date(s.started_at):null;
    const time=d?d.toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",hour12:false}):"?";
    return '<div class="session"><span class="time">'+time+'</span><span class="proj">'+esc(name(s.project_path))+'</span><span class="prompt">'+esc(s.first_prompt)+'</span><span class="meta">'+dur(s.duration_minutes)+'</span></div>';
  }).join("");
}

load();
</script>
</body>
</html>`;
}
