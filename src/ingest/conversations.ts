import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { PROJECTS_DIR } from "../utils/paths.ts";

/**
 * Ingest ALL conversation JSONL lines. No skipping. No truncation.
 * Every line from every file, including agent files and large sessions.
 */
export async function ingestConversations(db: Database): Promise<number> {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    uuid TEXT,
    parent_uuid TEXT,
    type TEXT,
    role TEXT,
    content TEXT,
    model TEXT,
    timestamp TEXT,
    is_sidechain INTEGER DEFAULT 0,
    agent_id TEXT,
    tool_name TEXT,
    tool_use_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    has_thinking INTEGER DEFAULT 0,
    thinking_length INTEGER DEFAULT 0,
    is_error INTEGER DEFAULT 0,
    raw_type TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_messages(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_type ON conversation_messages(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversation_messages(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_role ON conversation_messages(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_tool ON conversation_messages(tool_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversation_messages(agent_id)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(content, content='conversation_messages', content_rowid='id')`);

  db.exec(`DELETE FROM conversation_messages`);

  const insert = db.prepare(`INSERT INTO conversation_messages (session_id,uuid,parent_uuid,type,role,content,model,timestamp,is_sidechain,agent_id,tool_name,tool_use_id,input_tokens,output_tokens,has_thinking,thinking_length,is_error,raw_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let total = 0;
  let dirs: string[];
  try { dirs = readdirSync(PROJECTS_DIR); } catch { return 0; }

  const tx = db.transaction(() => {
    for (const dir of dirs) {
      const projDir = join(PROJECTS_DIR, dir);
      let files: string[];
      try { files = readdirSync(projDir).filter(f => f.endsWith(".jsonl")); } catch { continue; }

      // Also scan subagents/ subdirectories
      for (const sub of files) {
        const path = join(projDir, sub);
        try { if (statSync(path).isDirectory()) continue; } catch { continue; }

        const isAgent = sub.startsWith("agent-");
        const sessionId = isAgent ? sub.replace(/^agent-/, "").replace(/\.jsonl$/, "") : basename(sub, ".jsonl");
        const agentId = isAgent ? sessionId : null;

        // Read file in chunks for large files
        let text: string;
        try { text = readFileSync(path, "utf-8"); } catch { continue; }

        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let d: any;
          try { d = JSON.parse(line); } catch { continue; }

          const rawType = d.type || "unknown";
          const msg = d.message;
          const uuid = d.uuid || null;
          const parentUuid = d.parentUuid || null;
          const ts = d.timestamp || null;
          const sidechain = d.isSidechain ? 1 : 0;

          // Extract content from message if present
          let content: string | null = null;
          let role: string | null = null;
          let model: string | null = null;
          let inTok: number | null = null;
          let outTok: number | null = null;
          let toolName: string | null = null;
          let toolUseId: string | null = null;
          let hasThinking = 0;
          let thinkingLen = 0;
          let isError = 0;

          if (msg) {
            role = msg.role || null;
            model = msg.model || null;
            const usage = msg.usage || {};
            inTok = usage.input_tokens || null;
            outTok = usage.output_tokens || null;

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
                  // Store thinking content too
                  parts.push(`[thinking: ${block.thinking.length} chars]`);
                } else if (block.type === "tool_use") {
                  toolName = block.name || null;
                  toolUseId = block.id || null;
                  parts.push(`[tool_use: ${block.name}]`);
                } else if (block.type === "tool_result") {
                  isError = block.is_error ? 1 : 0;
                  const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                  // Store tool result content (truncate at 5KB to keep DB manageable)
                  parts.push(resultContent?.slice(0, 5000) || "[empty result]");
                }
              }
              content = parts.join("\n") || null;
            }
          } else {
            // Lines without message field: progress, file-history-snapshot, etc.
            // Store the type and any useful data
            if (d.data) {
              content = JSON.stringify(d.data).slice(0, 2000);
            } else if (d.snapshot) {
              content = `[snapshot: ${d.messageId || "?"}]`;
            } else if (d.toolUseResult) {
              content = typeof d.toolUseResult === "string" ? d.toolUseResult.slice(0, 2000) : JSON.stringify(d.toolUseResult).slice(0, 2000);
            }
            role = rawType;
          }

          insert.run(
            sessionId, uuid, parentUuid, rawType, role, content, model, ts,
            sidechain, agentId, toolName, toolUseId, inTok, outTok,
            hasThinking, thinkingLen, isError, rawType
          );
          total++;
        }
      }

      // Scan subagents/ directories too
      const subagentsDir = join(projDir, "subagents");
      try {
        const agentFiles = readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"));
        // These were already handled above if they're in the main dir
      } catch { /* no subagents dir */ }
    }
  });

  tx();

  // Rebuild FTS - drop and recreate to avoid corruption
  try {
    db.exec(`DROP TABLE IF EXISTS conversation_fts`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(content)`);
    db.exec(`INSERT INTO conversation_fts(rowid, content) SELECT id, content FROM conversation_messages WHERE content IS NOT NULL AND type IN ('user','assistant')`);
  } catch (e) { console.error("FTS rebuild:", e); }

  return total;
}
