import { getDb } from "../db/connection.ts";
import type { Row } from "../db/queries.ts";
import { DATA_DIR, projectName } from "../utils/paths.ts";
import { today, TZ_OFFSET_SEC } from "../utils/dates.ts";

interface DashboardData {
  daily: Row[];
  projects: { name: string; sessions: number; mins: number }[];
  tasks: { pending: number; in_progress: number; completed: number };
  commits: Row[];
  hourly: Row[];
  topCommitTypes: Row[];
  sessionCount: number;
  messageCount: number;
  commitCount: number;
  projectCount: number;
}

const DASHBOARD_CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#1f1f1e;color:#c3c2b7;padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:20px;font-weight:600;margin-bottom:4px;color:#f8f8f6}
.sub{color:#7b7974;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.card{background:#171716;border:1px solid #373635;border-radius:8px;padding:16px}
.card h2{font-size:14px;font-weight:500;color:#7b7974;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
canvas{width:100%;height:auto}
.stat{display:inline-block;margin-right:24px;margin-bottom:8px}
.stat .n{font-size:28px;font-weight:700;color:#f8f8f6}
.stat .l{font-size:12px;color:#7b7974}
.row{display:flex;align-items:center;margin-bottom:4px;font-size:13px}
.row .bar{height:14px;background:#d97757;border-radius:2px;margin-left:8px}
.row .name{width:140px;text-align:right;padding-right:8px;color:#7b7974;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .val{width:50px;text-align:right;font-size:12px;color:#7b7974;margin-left:8px}
.heatmap{display:flex;gap:2px;flex-wrap:wrap}
.heatmap .day{width:10px;height:10px;border-radius:2px}
.legend{display:flex;gap:4px;align-items:center;margin-top:8px;font-size:11px;color:#7b7974}
.legend .day{width:10px;height:10px;border-radius:2px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}`;

const DASHBOARD_SCRIPTS = `function quantize(v,max){return v===0?0:v<max*.25?1:v<max*.5?2:v<max*.75?3:4}
function bar(canvas,data,labelKey,valueKey,color){
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height;
  const max=Math.max(...data.map(d=>d[valueKey]),1);
  const bw=Math.max(1,Math.floor((w-40)/data.length)-1);
  const pad=20;
  ctx.fillStyle="#7b7974";ctx.font="10px system-ui";
  data.forEach((d,i)=>{
    const x=pad+i*(bw+1);
    const bh=(d[valueKey]/max)*(h-pad-4);
    ctx.fillStyle=color;
    ctx.fillRect(x,h-pad-bh,bw,bh);
  });
  ctx.fillStyle="#5e5d59";ctx.font="9px system-ui";
  const step=Math.max(1,Math.floor(data.length/8));
  data.forEach((d,i)=>{
    if(i%step===0){
      const x=pad+i*(bw+1);
      const label=typeof d[labelKey]==="number"?d[labelKey]+"":d[labelKey].slice(5);
      ctx.fillText(label,x,h-4);
    }
  });
}

bar(document.getElementById("c1"),daily,"date","session_count","#d97757");
bar(document.getElementById("c2"),hourly,"hour","n","#6a9bcc");

(function(){
  const canvas=document.getElementById("c3");
  const ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height;
  const cx=80,cy=h/2,r=50,ir=30;
  const total=commitTypes.reduce((s,d)=>s+d.n,0);
  const colors=["#d97757","#6a9bcc","#d4a27f","#c46686","#b0aea5","#788c5d","#cbcadb","#5e5d59"];
  let angle=-Math.PI/2;
  commitTypes.forEach((d,i)=>{
    const slice=(d.n/total)*Math.PI*2;
    ctx.beginPath();ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,angle,angle+slice);ctx.closePath();
    ctx.fillStyle=colors[i%colors.length];ctx.fill();
    angle+=slice;
  });
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);
  ctx.fillStyle="#171716";ctx.fill();
  ctx.font="11px system-ui";
  commitTypes.forEach((d,i)=>{
    const y=16+i*18;const x=160;
    ctx.fillStyle=colors[i%colors.length];
    ctx.fillRect(x,y-8,10,10);
    ctx.fillStyle="#c3c2b7";
    ctx.fillText(d.commit_type+" ("+d.n+")",x+16,y);
  });
})();

(function(){
  const el=document.getElementById("heatmap");
  const map={};daily.forEach(d=>{map[d.date]=d.session_count});
  commits.forEach(d=>{if(!map[d.d])map[d.d]=0;});
  const dates=Object.keys(map).sort();
  if(!dates.length)return;
  const start=new Date(dates[0]+"T00:00:00");
  const end=new Date(dates[dates.length-1]+"T00:00:00");
  const max=Math.max(...Object.values(map));
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const key=d.toISOString().slice(0,10);
    const v=map[key]||0;
    const q=quantize(v,max);
    const colors=["#171716","#4a2d1f","#8b4c30","#c6613f","#d97757"];
    const div=document.createElement("div");
    div.className="day";div.style.background=colors[q];
    div.title=key+": "+v+" sessions";
    el.appendChild(div);
  }
})();`;

function renderProjectRows(projects: DashboardData["projects"]): string {
  const maxS = Math.max(...projects.map(x => x.sessions));
  return projects.map(p => {
    const w = Math.round((p.sessions / maxS) * 200);
    const h = Math.floor(p.mins / 60);
    const m = Math.round(p.mins % 60);
    return `<div class="row"><span class="name">${Bun.escapeHTML(p.name)}</span><span class="bar" style="width:${w}px"></span><span class="val">${p.sessions}</span><span class="val" style="color:#5e5d59">${h}h${m}m</span></div>`;
  }).join("\n");
}

function renderTaskBars(tasks: DashboardData["tasks"]): string {
  const max = Math.max(tasks.completed, tasks.pending, tasks.in_progress, 1);
  return `<div class="row"><span class="name" style="color:#788c5d">completed</span><span class="bar" style="width:${Math.round(tasks.completed / max * 200)}px;background:#788c5d"></span><span class="val">${tasks.completed}</span></div>
<div class="row"><span class="name" style="color:#d4a27f">in progress</span><span class="bar" style="width:${Math.round(tasks.in_progress / max * 200)}px;background:#d4a27f"></span><span class="val">${tasks.in_progress}</span></div>
<div class="row"><span class="name" style="color:#5e5d59">pending</span><span class="bar" style="width:${Math.round(tasks.pending / max * 200)}px;background:#5e5d59"></span><span class="val">${tasks.pending}</span></div>`;
}

function renderDashboard(data: DashboardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Code Analyzer</title>
<style>
${DASHBOARD_CSS}
</style>
</head>
<body>
<h1>Claude Code Analyzer</h1>
<div class="sub">Generated ${today()} &middot; ${data.daily.length} days tracked</div>

<div style="margin-bottom:24px">
<span class="stat"><span class="n">${data.sessionCount}</span><span class="l"> sessions</span></span>
<span class="stat"><span class="n">${data.messageCount.toLocaleString()}</span><span class="l"> messages</span></span>
<span class="stat"><span class="n">${data.commitCount}</span><span class="l"> commits</span></span>
<span class="stat"><span class="n">${data.projectCount}</span><span class="l"> projects</span></span>
<span class="stat"><span class="n">${data.tasks.completed}</span><span class="l"> tasks done</span></span>
</div>

<div class="grid">
<div class="card">
<h2>Sessions per Day</h2>
<canvas id="c1" height="160"></canvas>
</div>
<div class="card">
<h2>Hour of Day</h2>
<canvas id="c2" height="160"></canvas>
</div>
</div>

<div class="grid">
<div class="card">
<h2>Projects by Sessions</h2>
${renderProjectRows(data.projects)}
</div>
<div class="card">
<h2>Commit Types</h2>
<canvas id="c3" height="160"></canvas>
<div style="margin-top:12px">
<h2>Tasks</h2>
${renderTaskBars(data.tasks)}
</div>
</div>
</div>

<div class="card" style="margin-bottom:16px">
<h2>Activity Heatmap</h2>
<div class="heatmap" id="heatmap"></div>
<div class="legend"><span class="day" style="background:#171716;border:1px solid #373635"></span>0<span class="day" style="background:#4a2d1f"></span><span class="day" style="background:#8b4c30"></span><span class="day" style="background:#c6613f"></span><span class="day" style="background:#d97757"></span>more</div>
</div>

<script>
const daily=${JSON.stringify(data.daily).replace(/</g, "\\u003c")};
const hourly=${JSON.stringify(data.hourly).replace(/</g, "\\u003c")};
const commitTypes=${JSON.stringify(data.topCommitTypes).replace(/</g, "\\u003c")};
const commits=${JSON.stringify(data.commits).replace(/</g, "\\u003c")};

${DASHBOARD_SCRIPTS}
</script>
</body>
</html>`;
}

export async function exportHtmlCommand(args: string[]): Promise<void> {
  const db = getDb();
  const outPath = args[0] || DATA_DIR + "/dashboard.html";
  const q = (sql: string, ...p: (string | number)[]) => db.query(sql).all(...p) as Row[];

  const daily = q(`SELECT SUBSTR(datetime(timestamp,'localtime'),1,10) as date,COUNT(DISTINCT session_id) as session_count,COUNT(*) as message_count,SUM(CASE WHEN tool_name IS NOT NULL THEN 1 ELSE 0 END) as tool_call_count FROM conversation_messages WHERE timestamp LIKE '20%' AND type IN ('user','assistant') GROUP BY date ORDER BY date`);
  const rawProjects = q(`SELECT project_path, COUNT(*) as n, ROUND(SUM(duration_minutes)) as mins FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY n DESC LIMIT 15`);
  const rawTasks = q(`SELECT status, COUNT(*) as n FROM tasks GROUP BY status`);
  const commits = q(`SELECT SUBSTR(date,1,10) as d, COUNT(*) as n FROM commits GROUP BY d ORDER BY d`);
  const hourly = q(`SELECT CAST(((started_at/1000+?1)%86400)/3600 AS INTEGER) as hour, COUNT(*) as n FROM sessions WHERE started_at>0 GROUP BY hour ORDER BY hour`, TZ_OFFSET_SEC);
  const topCommitTypes = q(`SELECT commit_type, COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type != '' GROUP BY commit_type ORDER BY n DESC LIMIT 8`);

  const projects = rawProjects.map(r => ({ name: projectName(r.project_path as string), sessions: r.n as number, mins: (r.mins as number) || 0 }));
  const tasks = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of rawTasks) {
    const s = t.status as string;
    if (s in tasks) tasks[s as keyof typeof tasks] = t.n as number;
  }

  const html = renderDashboard({
    daily, projects, tasks, commits, hourly, topCommitTypes,
    sessionCount: db.query("SELECT COUNT(*) as n FROM sessions").get<{ n: number }>()!.n,
    messageCount: db.query("SELECT SUM(message_count) as n FROM sessions").get<{ n: number }>()!.n,
    commitCount: db.query("SELECT COUNT(*) as n FROM commits").get<{ n: number }>()!.n,
    projectCount: db.query("SELECT COUNT(*) as n FROM projects").get<{ n: number }>()!.n,
  });

  await Bun.write(outPath, html);
  console.log(`Dashboard written to ${outPath}`);
  console.log(`Open: file://${outPath}`);
}
