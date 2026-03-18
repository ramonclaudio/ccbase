import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { PROJECTS_DIR, listDirs } from "../utils/paths.ts";

interface ParsedRecord {
  uuid: unknown;
  parentUuid: unknown;
  rawType: unknown;
  role: string | null;
  content: string | null;
  model: string | null;
  ts: unknown;
  sidechain: number;
  toolName: string | null;
  toolUseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  hasThinking: number;
  thinkingLen: number;
  isError: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  stopReason: string | null;
  serviceTier: string | null;
  webSearchCount: number;
  webFetchCount: number;
  cliVersion: string | null;
  slug: string | null;
  permissionMode: string | null;
  durationMs: number | null;
  subtype: string | null;
}

function parseMessageContent(msg: Record<string, unknown>): Pick<ParsedRecord, "content" | "toolName" | "toolUseId" | "hasThinking" | "thinkingLen" | "isError"> {
  let content: string | null = null;
  let toolName: string | null = null;
  let toolUseId: string | null = null;
  let hasThinking = 0;
  let thinkingLen = 0;
  let isError = 0;

  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "thinking" && block.thinking) {
        hasThinking = 1;
        thinkingLen += block.thinking.length;
        parts.push(`<thinking>\n${block.thinking}\n</thinking>`);
      } else if (block.type === "tool_use") {
        toolName = block.name || null;
        toolUseId = block.id || null;
        const inputStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
        parts.push(`<tool_use name="${block.name}" id="${block.id}">\n${inputStr}\n</tool_use>`);
      } else if (block.type === "tool_result") {
        isError = block.is_error ? 1 : 0;
        const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        parts.push(`<tool_result${block.is_error ? ' error="true"' : ''}>\n${resultContent || ""}\n</tool_result>`);
      }
    }
    content = parts.join("\n") || null;
  }

  return { content, toolName, toolUseId, hasThinking, thinkingLen, isError };
}

function parseRecord(d: Record<string, unknown>): ParsedRecord | null {
  if (!d || typeof d !== "object") return null;

  const rawType = d.type ?? "unknown";
  const msg = d.message as Record<string, unknown> | undefined;
  const uuid = d.uuid || null;
  const parentUuid = d.parentUuid || null;
  const ts = d.timestamp || null;
  const sidechain = d.isSidechain ? 1 : 0;

  if (msg) {
    const role = (msg.role as string) || null;
    const model = (msg.model as string) || null;
    const usage = (msg.usage as Record<string, unknown>) || {};
    const inputTokens = (usage.input_tokens as number) ?? null;
    const outputTokens = (usage.output_tokens as number) ?? null;
    const cacheReadTokens = (usage.cache_read_input_tokens as number) ?? null;
    const cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? null;
    const serviceTier = (usage.service_tier as string) ?? null;
    const serverToolUse = (usage.server_tool_use as Record<string, unknown>) ?? {};
    const webSearchCount = (serverToolUse.web_search_requests as number) ?? 0;
    const webFetchCount = (serverToolUse.web_fetch_requests as number) ?? 0;
    const stopReason = (msg.stop_reason as string) ?? null;
    const cliVersion = (d.version as string) ?? null;
    const slug = (d.slug as string) ?? null;
    const permissionMode = (d.permissionMode as string) ?? null;
    const durationMs = (d.durationMs as number) ?? null;
    const subtype = (d.subtype as string) ?? null;
    const parsed = parseMessageContent(msg);
    return { uuid, parentUuid, rawType, role, model, ts, sidechain, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, stopReason, serviceTier, webSearchCount, webFetchCount, cliVersion, slug, permissionMode, durationMs, subtype, ...parsed };
  }

  let content: string | null = null;
  if (rawType === "pr-link") {
    content = JSON.stringify({ prNumber: d.prNumber, prUrl: d.prUrl, prRepository: d.prRepository });
  } else if (d.data) {
    content = JSON.stringify(d.data).slice(0, 2000);
  } else if (d.snapshot) {
    content = `[snapshot: ${d.messageId || "?"}]`;
  } else if (d.toolUseResult) {
    content = typeof d.toolUseResult === "string" ? d.toolUseResult.slice(0, 2000) : JSON.stringify(d.toolUseResult).slice(0, 2000);
  }

  return {
    uuid, parentUuid, rawType, role: rawType as string, content, model: null,
    ts, sidechain, toolName: null, toolUseId: null, inputTokens: null, outputTokens: null,
    hasThinking: 0, thinkingLen: 0, isError: 0,
    cacheReadTokens: null, cacheCreationTokens: null, stopReason: null, serviceTier: null,
    webSearchCount: 0, webFetchCount: 0, cliVersion: (d.version as string) ?? null,
    slug: (d.slug as string) ?? null, permissionMode: (d.permissionMode as string) ?? null,
    durationMs: (d.durationMs as number) ?? null, subtype: (d.subtype as string) ?? null,
  };
}

/**
 * Stream-ingest conversation JSONL files. Reads one file at a time
 * instead of buffering all records in memory.
 */
export async function ingestConversations(db: Database): Promise<number> {
  db.exec(`DELETE FROM conversation_messages`);

  const insert = db.query(`INSERT INTO conversation_messages (session_id,uuid,parent_uuid,type,role,content,model,timestamp,is_sidechain,agent_id,tool_name,tool_use_id,input_tokens,output_tokens,has_thinking,thinking_length,is_error,raw_type,cache_read_tokens,cache_creation_tokens,stop_reason,service_tier,web_search_count,web_fetch_count,cli_version,slug,permission_mode,duration_ms,subtype) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let dirs: string[];
  try { dirs = listDirs(PROJECTS_DIR); } catch { return 0; }

  let total = 0;

  const tx = db.transaction((sessionId: string, agentId: string | null, records: Record<string, unknown>[]) => {
    for (const d of records) {
      const r = parseRecord(d);
      if (!r) continue;
      insert.run(
        sessionId, r.uuid, r.parentUuid, r.rawType, r.role, r.content, r.model, r.ts,
        r.sidechain, agentId, r.toolName, r.toolUseId, r.inputTokens, r.outputTokens,
        r.hasThinking, r.thinkingLen, r.isError, r.rawType,
        r.cacheReadTokens, r.cacheCreationTokens, r.stopReason, r.serviceTier,
        r.webSearchCount, r.webFetchCount, r.cliVersion,
        r.slug, r.permissionMode, r.durationMs, r.subtype,
      );
      total++;
    }
  });

  for (const dir of dirs) {
    const projDir = PROJECTS_DIR + "/" + dir;
    let files: string[];
    try { files = [...new Glob("*.jsonl").scanSync(projDir)]; } catch { continue; }

    for (const sub of files) {
      const isAgent = sub.startsWith("agent-");
      const sessionId = isAgent ? sub.replace(/^agent-/, "").replace(/\.jsonl$/, "") : sub.replace(/\.jsonl$/, "");
      const agentId = isAgent ? sessionId : null;

      try {
        const bytes = await Bun.file(projDir + "/" + sub).bytes();
        const result = Bun.JSONL.parseChunk(bytes);
        if (result.values.length) tx(sessionId, agentId, result.values);
      } catch { continue; }
    }
  }

  // Backfill session slugs from conversation data
  try {
    db.exec(`UPDATE sessions SET slug = (SELECT slug FROM conversation_messages cm WHERE cm.session_id = sessions.id AND cm.slug IS NOT NULL LIMIT 1) WHERE slug IS NULL`);
  } catch { /* ignore */ }

  // Backfill PR data from pr-link records in conversations
  try {
    db.exec(`UPDATE sessions SET
      pr_number = COALESCE(pr_number, (SELECT json_extract(cm.content, '$.prNumber') FROM conversation_messages cm WHERE cm.session_id = sessions.id AND cm.type = 'pr-link' AND cm.content IS NOT NULL LIMIT 1)),
      pr_url = COALESCE(pr_url, (SELECT json_extract(cm.content, '$.prUrl') FROM conversation_messages cm WHERE cm.session_id = sessions.id AND cm.type = 'pr-link' AND cm.content IS NOT NULL LIMIT 1)),
      pr_repository = COALESCE(pr_repository, (SELECT json_extract(cm.content, '$.prRepository') FROM conversation_messages cm WHERE cm.session_id = sessions.id AND cm.type = 'pr-link' AND cm.content IS NOT NULL LIMIT 1))
    WHERE pr_url IS NULL AND id IN (SELECT DISTINCT session_id FROM conversation_messages WHERE type = 'pr-link' AND content IS NOT NULL)`);
  } catch { /* ignore */ }

  // Rebuild FTS
  try {
    db.exec(`DROP TABLE IF EXISTS conversation_fts`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(content)`);
    db.exec(`INSERT INTO conversation_fts(rowid, content) SELECT id, content FROM conversation_messages WHERE content IS NOT NULL AND type IN ('user','assistant') AND content NOT LIKE '<tool_%' AND content NOT LIKE '<thinking>%'`);
  } catch (e) { console.error("FTS rebuild:", e); }

  return total;
}
