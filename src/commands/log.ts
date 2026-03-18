import { getDb } from "../db/connection.ts";
import { sessionsByDateRange, type Session } from "../db/queries.ts";
import { projectName } from "../utils/paths.ts";
import {
  today,
  yesterday,
  thisWeekStart,
  epochMsToDate,
  epochMsToTime,
  formatDuration,
  dateToMs,
  endOfDayMs,
} from "../utils/dates.ts";
import { bold, dim, cyan, header, truncate } from "../utils/format.ts";

function longDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface GroupedDay {
  date: string;
  projects: Map<string, Session[]>;
}

function groupByDayAndProject(sessions: Session[]): GroupedDay[] {
  const dayMap = new Map<string, Map<string, Session[]>>();

  for (const s of sessions) {
    if (!s.started_at) continue;
    const date = epochMsToDate(s.started_at);
    const proj = s.project_path ?? "unknown";

    let projMap = dayMap.get(date);
    if (!projMap) {
      projMap = new Map();
      dayMap.set(date, projMap);
    }

    let list = projMap.get(proj);
    if (!list) {
      list = [];
      projMap.set(proj, list);
    }
    list.push(s);
  }

  const days: GroupedDay[] = [];
  for (const [date, projects] of dayMap) {
    days.push({ date, projects });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function printDay(day: GroupedDay, showDate: boolean): void {
  if (showDate) {
    console.log(header(longDate(day.date)));
    console.log();
  }

  let totalSessions = 0;
  let totalMinutes = 0;
  let projectCount = 0;

  for (const [projPath, sessions] of day.projects) {
    projectCount++;
    const name = projectName(projPath);
    const projSessions = sessions.length;
    const projMinutes = sessions.reduce((a, s) => a + (s.duration_minutes ?? 0), 0);

    totalSessions += projSessions;
    totalMinutes += projMinutes;

    console.log(
      `  ${cyan(name)} ${dim(`(${projSessions} session${projSessions === 1 ? "" : "s"}, ${formatDuration(Math.round(projMinutes))})`)}`,
    );

    for (const s of sessions) {
      const time = s.started_at ? epochMsToTime(s.started_at) : "??:??";
      const prompt = s.first_prompt ? truncate(s.first_prompt, 60) : dim("(no prompt)");
      const dur = s.duration_minutes != null ? formatDuration(Math.round(s.duration_minutes)) : "?";
      const msgs = s.message_count ?? 0;

      console.log(
        `  |-- ${dim(time)}  ${prompt}  ${dim(`(${dur}, ${msgs} msgs)`)}`,
      );
    }
    console.log();
  }

  console.log(
    `  ${bold(`Total: ${totalSessions} session${totalSessions === 1 ? "" : "s"}, ${formatDuration(Math.round(totalMinutes))} across ${projectCount} project${projectCount === 1 ? "" : "s"}`)}`,
  );
  console.log();
}

export function logCommand(args: string[]): void {
  const db = getDb();

  let startDate: string;
  let endDate: string;
  let isWeek = false;

  if (args.includes("--yesterday")) {
    startDate = yesterday();
    endDate = startDate;
  } else if (args.includes("--week")) {
    startDate = thisWeekStart();
    endDate = today();
    isWeek = true;
  } else {
    // Check for YYYY-MM-DD arg
    const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    if (dateArg) {
      startDate = dateArg;
      endDate = dateArg;
    } else {
      startDate = today();
      endDate = today();
    }
  }

  const sessions = sessionsByDateRange(db, dateToMs(startDate), endOfDayMs(endDate));

  if (sessions.length === 0) {
    console.log(dim("No sessions found."));
    return;
  }

  const days = groupByDayAndProject(sessions);
  if (days.length === 0) { console.log(dim("No sessions with timestamps.")); return; }

  if (isWeek || days.length > 1) {
    for (const day of days) {
      printDay(day, true);
    }
  } else {
    console.log(header(longDate(startDate)));
    console.log();
    printDay(days[0]!, false);
  }
}
