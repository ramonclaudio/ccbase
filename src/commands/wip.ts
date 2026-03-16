import { Glob } from "bun";
import { getDb } from "../db/connection.ts";
import { dirtyProjects, openTasks } from "../db/queries.ts";
import type { ProjectWithGitState } from "../db/queries.ts";
import { projectName, CLAUDE_HOME } from "../utils/paths.ts";
import { bold, dim, cyan, yellow, header } from "../utils/format.ts";
import { safeParseJson } from "../utils/parse.ts";

interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function activeSessions(): Promise<SessionFile[]> {
  const dir = CLAUDE_HOME + "/sessions";
  let files: string[];
  try {
    files = [...new Glob("*.json").scanSync(dir)];
  } catch {
    return [];
  }

  const alive: SessionFile[] = [];
  for (const f of files) {
    try {
      const text = await Bun.file(dir + "/" + f).text();
      const data = safeParseJson<SessionFile>(text);
      if (data?.pid && isAlive(data.pid)) {
        alive.push(data);
      }
    } catch {
      // skip bad files
    }
  }
  return alive;
}

export async function wipCommand(_args: string[]): Promise<void> {
  const db = getDb();
  let hasOutput = false;

  console.log(header("Work In Progress"));
  console.log();

  // Dirty repos
  const dirty = dirtyProjects(db);
  if (dirty.length > 0) {
    console.log(`  ${bold(`Uncommitted Changes (${dirty.length} repo${dirty.length === 1 ? "" : "s"})`)}`);
    for (const p of dirty) {
      const name = projectName(p.path);
      const branch = p.current_branch ?? "unknown";
      console.log(
        `  |-- ${cyan(name)}: ${yellow(String(p.dirty_file_count))} file${p.dirty_file_count === 1 ? "" : "s"} on ${dim(branch)}`,
      );
    }
    console.log();
    hasOutput = true;
  }

  // Stashes
  const stashed = db
    .prepare(
      `SELECT p.path, p.name, g.stash_count
       FROM project_git_state g
       JOIN projects p ON p.path = g.project_path
       WHERE g.stash_count > 0`,
    )
    .all() as { path: string; name: string | null; stash_count: number }[];

  if (stashed.length > 0) {
    console.log(`  ${bold(`Stashes (${stashed.length})`)}`);
    for (const s of stashed) {
      const name = projectName(s.path);
      console.log(
        `  |-- ${cyan(name)}: ${s.stash_count} stash${s.stash_count === 1 ? "" : "es"}`,
      );
    }
    console.log();
    hasOutput = true;
  }

  // Open tasks
  const tasks = openTasks(db);
  if (tasks.length > 0) {
    const pending = tasks.filter((t) => t.status === "pending").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    console.log(`  ${bold("Open Tasks:")} ${pending} pending, ${inProgress} in_progress`);
    console.log();
    hasOutput = true;
  }

  // Active sessions
  const sessions = await activeSessions();
  if (sessions.length > 0) {
    console.log(`  ${bold(`Active Sessions (${sessions.length})`)}`);
    for (const s of sessions) {
      const name = projectName(s.cwd);
      console.log(`  |-- ${cyan(name)} ${dim(`(pid ${s.pid})`)}`);
    }
    console.log();
    hasOutput = true;
  }

  if (!hasOutput) {
    console.log(dim("  All clear. Nothing in flight."));
    console.log();
  }
}
