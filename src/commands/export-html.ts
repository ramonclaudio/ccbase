import { getDb } from "../db/connection.ts";
import { DATA_DIR } from "../utils/paths.ts";
import { today } from "../utils/dates.ts";

export async function exportHtmlCommand(args: string[]): Promise<void> {
  const db = getDb();
  const outPath = args[0] || DATA_DIR + "/dashboard.html";

  // Pull all data in one shot
  const daily = db.prepare(`SELECT date, message_count, session_count, tool_call_count FROM daily_stats ORDER BY date`).all() as any[];
  const projects = db.prepare(`SELECT project_path, COUNT(*) as n, ROUND(SUM(duration_minutes)) as mins FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY n DESC LIMIT 15`).all() as any[];
  const tasks = db.prepare(`SELECT status, COUNT(*) as n FROM tasks GROUP BY status`).all() as any[];
  const commits = db.prepare(`SELECT SUBSTR(date,1,10) as d, COUNT(*) as n FROM commits GROUP BY d ORDER BY d`).all() as any[];
  const hourly = db.prepare(`SELECT CAST(((started_at / 1000) % 86400) / 3600 AS INTEGER) as hour, COUNT(*) as n FROM sessions WHERE started_at > 0 GROUP BY hour ORDER BY hour`).all() as any[];
  const topCommitTypes = db.prepare(`SELECT commit_type, COUNT(*) as n FROM commits WHERE commit_type IS NOT NULL AND commit_type != '' GROUP BY commit_type ORDER BY n DESC LIMIT 8`).all() as any[];

  const name = (p: string) => p.split("/").pop() || p;
  const projData = projects.map((r: any) => ({ name: name(r.project_path), sessions: r.n, mins: r.mins || 0 }));
  const taskData = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of tasks) taskData[t.status as keyof typeof taskData] = t.n;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Code Analyzer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:20px;font-weight:600;margin-bottom:4px;color:#e6edf3}
.sub{color:#7d8590;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h2{font-size:14px;font-weight:500;color:#7d8590;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
canvas{width:100%;height:auto}
.stat{display:inline-block;margin-right:24px;margin-bottom:8px}
.stat .n{font-size:28px;font-weight:700;color:#e6edf3}
.stat .l{font-size:12px;color:#7d8590}
.row{display:flex;align-items:center;margin-bottom:4px;font-size:13px}
.row .bar{height:14px;background:#238636;border-radius:2px;margin-left:8px}
.row .name{width:140px;text-align:right;padding-right:8px;color:#7d8590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .val{width:50px;text-align:right;font-size:12px;color:#7d8590;margin-left:8px}
.heatmap{display:flex;gap:2px;flex-wrap:wrap}
.heatmap .day{width:10px;height:10px;border-radius:2px}
.legend{display:flex;gap:4px;align-items:center;margin-top:8px;font-size:11px;color:#7d8590}
.legend .day{width:10px;height:10px;border-radius:2px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>Claude Code Analyzer</h1>
<div class="sub">Generated ${today()} &middot; ${daily.length} days tracked</div>

<div style="margin-bottom:24px">
<span class="stat"><span class="n">${db.prepare("SELECT COUNT(*) as n FROM sessions").get<any>().n}</span><span class="l"> sessions</span></span>
<span class="stat"><span class="n">${db.prepare("SELECT COUNT(*) as n FROM history_messages").get<any>().n.toLocaleString()}</span><span class="l"> messages</span></span>
<span class="stat"><span class="n">${db.prepare("SELECT COUNT(*) as n FROM commits").get<any>().n}</span><span class="l"> commits</span></span>
<span class="stat"><span class="n">${db.prepare("SELECT COUNT(*) as n FROM projects").get<any>().n}</span><span class="l"> projects</span></span>
<span class="stat"><span class="n">${taskData.completed}</span><span class="l"> tasks done</span></span>
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
${projData.map(p => {
  const maxS = Math.max(...projData.map(x => x.sessions));
  const w = Math.round((p.sessions / maxS) * 200);
  const h = Math.floor(p.mins / 60);
  const m = Math.round(p.mins % 60);
  return `<div class="row"><span class="name">${p.name}</span><span class="bar" style="width:${w}px"></span><span class="val">${p.sessions}</span><span class="val" style="color:#484f58">${h}h${m}m</span></div>`;
}).join("\n")}
</div>
<div class="card">
<h2>Commit Types</h2>
<canvas id="c3" height="160"></canvas>
<div style="margin-top:12px">
<h2>Tasks</h2>
<div class="row"><span class="name" style="color:#238636">completed</span><span class="bar" style="width:${Math.round(taskData.completed/Math.max(taskData.completed,taskData.pending,taskData.in_progress,1)*200)}px"></span><span class="val">${taskData.completed}</span></div>
<div class="row"><span class="name" style="color:#d29922">in progress</span><span class="bar" style="width:${Math.round(taskData.in_progress/Math.max(taskData.completed,taskData.pending,taskData.in_progress,1)*200)}px;background:#d29922"></span><span class="val">${taskData.in_progress}</span></div>
<div class="row"><span class="name" style="color:#484f58">pending</span><span class="bar" style="width:${Math.round(taskData.pending/Math.max(taskData.completed,taskData.pending,taskData.in_progress,1)*200)}px;background:#484f58"></span><span class="val">${taskData.pending}</span></div>
</div>
</div>
</div>

<div class="card" style="margin-bottom:16px">
<h2>Activity Heatmap</h2>
<div class="heatmap" id="heatmap"></div>
<div class="legend"><span class="day" style="background:#161b22;border:1px solid #30363d"></span>0<span class="day" style="background:#0e4429"></span><span class="day" style="background:#006d32"></span><span class="day" style="background:#26a641"></span><span class="day" style="background:#39d353"></span>more</div>
</div>

<script>
const daily=${JSON.stringify(daily)};
const hourly=${JSON.stringify(hourly)};
const commitTypes=${JSON.stringify(topCommitTypes)};
const commits=${JSON.stringify(commits)};

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
  ctx.fillStyle="#7d8590";ctx.font="10px system-ui";
  data.forEach((d,i)=>{
    const x=pad+i*(bw+1);
    const bh=(d[valueKey]/max)*(h-pad-4);
    ctx.fillStyle=color;
    ctx.fillRect(x,h-pad-bh,bw,bh);
  });
  // x labels
  ctx.fillStyle="#484f58";ctx.font="9px system-ui";
  const step=Math.max(1,Math.floor(data.length/8));
  data.forEach((d,i)=>{
    if(i%step===0){
      const x=pad+i*(bw+1);
      const label=typeof d[labelKey]==="number"?d[labelKey]+"":d[labelKey].slice(5);
      ctx.fillText(label,x,h-4);
    }
  });
}

bar(document.getElementById("c1"),daily,"date","session_count","#238636");
bar(document.getElementById("c2"),hourly,"hour","n","#1f6feb");

// commit types donut
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
  const colors=["#238636","#1f6feb","#d29922","#da3633","#8b949e","#6e7681","#484f58","#30363d"];
  let angle=-Math.PI/2;
  commitTypes.forEach((d,i)=>{
    const slice=(d.n/total)*Math.PI*2;
    ctx.beginPath();ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,angle,angle+slice);ctx.closePath();
    ctx.fillStyle=colors[i%colors.length];ctx.fill();
    angle+=slice;
  });
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);
  ctx.fillStyle="#161b22";ctx.fill();
  // legend
  ctx.font="11px system-ui";
  commitTypes.forEach((d,i)=>{
    const y=16+i*18;const x=160;
    ctx.fillStyle=colors[i%colors.length];
    ctx.fillRect(x,y-8,10,10);
    ctx.fillStyle="#c9d1d9";
    ctx.fillText(d.commit_type+" ("+d.n+")",x+16,y);
  });
})();

// heatmap
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
    const q=v===0?0:v<max*.25?1:v<max*.5?2:v<max*.75?3:4;
    const colors=["#161b22","#0e4429","#006d32","#26a641","#39d353"];
    const div=document.createElement("div");
    div.className="day";div.style.background=colors[q];
    div.title=key+": "+v+" sessions";
    el.appendChild(div);
  }
})();
</script>
</body>
</html>`;

  await Bun.write(outPath, html);
  console.log(`Dashboard written to ${outPath}`);
  console.log(`Open: file://${outPath}`);
}
