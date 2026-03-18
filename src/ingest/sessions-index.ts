import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { PROJECTS_DIR, dirExists, listDirs, decodeProjectPath } from "../utils/paths.ts";
import { safeParseJson, type SessionsIndexFile } from "../utils/parse.ts";

type IndexData =
  | { type: "index"; dirPath: string; parsed: SessionsIndexFile }
  | { type: "fallback"; dirPath: string };

async function readIndexEntries(): Promise<IndexData[]> {
  const dirNames = listDirs(PROJECTS_DIR);
  const results: IndexData[] = [];

  for (const name of dirNames) {
    const dirPath = PROJECTS_DIR + "/" + name;
    try {
      const text = await Bun.file(dirPath + "/sessions-index.json").text();
      const parsed = safeParseJson<SessionsIndexFile>(text);
      if (parsed?.entries) results.push({ type: "index", dirPath, parsed });
    } catch {
      results.push({ type: "fallback", dirPath });
    }
  }

  return results;
}

interface FallbackSession {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  firstPrompt: string | null;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  isSidechain: boolean;
}

function extractFirstPrompt(content: unknown): string | null {
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "text" && b.text) return String(b.text).slice(0, 500);
    }
  }
  return null;
}

/** Scan JSONL records for session metadata. Skips large non-user records efficiently. */
async function parseSessionMetadata(path: string, sessionId: string, dirName: string): Promise<FallbackSession> {
  const bf = Bun.file(path);
  const mtime = bf.lastModified;
  const dirProjectPath = decodeProjectPath(dirName);
  const fallback: FallbackSession = { sessionId, projectPath: dirProjectPath, gitBranch: null, firstPrompt: null, startedAt: mtime, endedAt: mtime, messageCount: 0, isSidechain: false };

  try {
    const bytes = await bf.bytes();

    // Count newlines for message count
    let msgCount = 0;
    for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 10) msgCount++; }
    fallback.messageCount = msgCount;

    // Parse records using Bun.JSONL.parseChunk with byte offsets
    // Only scan until we have project path, branch, first prompt, and timestamps
    const result = Bun.JSONL.parseChunk(bytes);
    let firstTs = Infinity, lastTs = 0;

    for (const d of result.values as Record<string, unknown>[]) {
      if (!d || typeof d !== "object") continue;

      const ts = d.timestamp as number | undefined;
      if (ts) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }

      if (d.cwd) { const cwd = String(d.cwd); fallback.projectPath = cwd.startsWith("/") ? cwd : "/" + cwd; }
      if (!fallback.gitBranch && d.gitBranch) fallback.gitBranch = String(d.gitBranch);
      if (d.isSidechain) fallback.isSidechain = true;

      if (!fallback.firstPrompt && d.type === "user") {
        const msg = d.message as Record<string, unknown> | undefined;
        if (msg?.role === "user") fallback.firstPrompt = extractFirstPrompt(msg.content);
      }
    }

    if (firstTs < Infinity) fallback.startedAt = firstTs;
    if (lastTs > 0) fallback.endedAt = lastTs;
  } catch { /* use fallback defaults */ }

  return fallback;
}

async function loadFallbackSessions(dirPath: string, dirName: string): Promise<FallbackSession[]> {
  try {
    const files = [...new Glob("*.jsonl").scanSync(dirPath)].filter(f => !f.startsWith("agent-"));
    return await Promise.all(files.map(f => parseSessionMetadata(dirPath + "/" + f, f.replace(".jsonl", ""), dirName)));
  } catch { return []; }
}

interface ProjectAgg { latest: number; sessions: number; messages: number }

function insertIndexEntry(
  entry: SessionsIndexFile["entries"][0],
  stmt: ReturnType<Database["query"]>,
  projectAgg: Record<string, ProjectAgg>,
): void {
  const startedAt = typeof entry.created === "string" ? new Date(entry.created).getTime() : entry.created;
  const endedAt = typeof entry.modified === "string" ? new Date(entry.modified).getTime() : entry.modified;
  const duration = (endedAt - startedAt) / 60_000;
  const e = entry as Record<string, unknown>;
  stmt.run(
    entry.sessionId, entry.projectPath || null, startedAt, endedAt,
    entry.messageCount ?? 0, Math.round(duration * 100) / 100,
    entry.firstPrompt ? entry.firstPrompt.slice(0, 500) : null,
    entry.summary || null, entry.gitBranch || null, entry.isSidechain ? 1 : 0,
    null, null,
    (e.slug as string) || null,
    (e.prNumber as number) ?? null,
    (e.prUrl as string) || null,
    (e.prRepository as string) || null,
  );
  if (entry.projectPath) {
    const agg = projectAgg[entry.projectPath] ??= { latest: 0, sessions: 0, messages: 0 };
    agg.sessions++;
    agg.messages += entry.messageCount ?? 0;
    if (endedAt > agg.latest) agg.latest = endedAt;
  }
}

export async function ingestSessionsIndex(db: Database): Promise<number> {
  if (!dirExists(PROJECTS_DIR)) return 0;

  const insertSession = db.query(`
    INSERT OR REPLACE INTO sessions
    (id, project_path, started_at, ended_at, message_count, duration_minutes, first_prompt, summary, git_branch, is_sidechain, git_sha, git_origin_url, slug, pr_number, pr_url, pr_repository)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProject = db.query(`UPDATE projects SET last_session_date=?, total_sessions=?, total_messages=? WHERE path=?`);
  const indexDataList = await readIndexEntries();
  let count = 0;
  const projectAgg: Record<string, ProjectAgg> = {};

  // Pre-load fallback sessions (async, parallel per dir)
  const fallbackMap = new Map<string, FallbackSession[]>();
  await Promise.all(
    indexDataList.filter(i => i.type === "fallback").map(async item => {
      const dirName = item.dirPath.split("/").pop() || "";
      fallbackMap.set(item.dirPath, await loadFallbackSessions(item.dirPath, dirName));
    }),
  );

  const tx = db.transaction(() => {
    for (const item of indexDataList) {
      if (item.type === "fallback") {
        const sessions = fallbackMap.get(item.dirPath) || [];
        for (const s of sessions) {
          const duration = (s.endedAt - s.startedAt) / 60_000;
          insertSession.run(
            s.sessionId, s.projectPath, s.startedAt, s.endedAt,
            s.messageCount, Math.round(duration * 100) / 100,
            s.firstPrompt, null, s.gitBranch, s.isSidechain ? 1 : 0,
            null, null, null, null, null, null,
          );
          if (s.projectPath) {
            const agg = projectAgg[s.projectPath] ??= { latest: 0, sessions: 0, messages: 0 };
            agg.sessions++;
            agg.messages += s.messageCount;
            if (s.endedAt > agg.latest) agg.latest = s.endedAt;
          }
          count++;
        }
        continue;
      }
      for (const entry of item.parsed.entries) {
        try { insertIndexEntry(entry, insertSession, projectAgg); count++; }
        catch (e) { console.error(`Failed to ingest session ${entry.sessionId}:`, e); }
      }
    }
    for (const [path, agg] of Object.entries(projectAgg)) {
      updateProject.run(new Date(agg.latest).toISOString().slice(0, 10), agg.sessions, agg.messages, path);
    }
  });

  tx();
  return count;
}
