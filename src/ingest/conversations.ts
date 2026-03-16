import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { PROJECTS_DIR } from "../utils/paths.ts";

/**
 * Ingest full conversation JSONL files into conversation_messages.
 * Stores: user text, assistant text, tool_use names, model, tokens.
 * Skips: file-history-snapshot, queue-operation, raw tool results (huge).
 */
export async function ingestConversations(db: Database): Promise<number> {
  // Create table if not exists
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
    tool_name TEXT,
    tool_use_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_messages(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_type ON conversation_messages(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversation_messages(timestamp)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(content, content='conversation_messages', content_rowid='id')`);

  db.exec(`DELETE FROM conversation_messages`);

  const insert = db.prepare(`INSERT INTO conversation_messages (session_id,uuid,parent_uuid,type,role,content,model,timestamp,is_sidechain,tool_name,tool_use_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let total = 0;
  let dirs: string[];
  try { dirs = readdirSync(PROJECTS_DIR); } catch { return 0; }

  const tx = db.transaction(() => {
    for (const dir of dirs) {
      const projDir = join(PROJECTS_DIR, dir);
      let files: string[];
      try { files = readdirSync(projDir).filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-")); } catch { continue; }

      for (const file of files) {
        const sessionId = basename(file, ".jsonl");
        const path = join(projDir, file);

        let text: string;
        try {
          const stat = statSync(path);
          if (stat.size > 10_000_000) continue; // skip files > 10MB
          text = require("node:fs").readFileSync(path, "utf-8");
        } catch { continue; }

        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let d: any;
          try { d = JSON.parse(line); } catch { continue; }

          const type = d.type;
          if (type === "file-history-snapshot" || type === "queue-operation" || type === "summary") continue;

          const msg = d.message;
          if (!msg) continue;

          const uuid = d.uuid || null;
          const parentUuid = d.parentUuid || null;
          const ts = d.timestamp || null;
          const sidechain = d.isSidechain ? 1 : 0;
          const role = msg.role || type;
          const model = msg.model || null;
          const usage = msg.usage || {};
          const inTok = usage.input_tokens || null;
          const outTok = usage.output_tokens || null;

          // Extract content
          let content: string | null = null;
          let toolName: string | null = null;
          let toolUseId: string | null = null;

          if (typeof msg.content === "string") {
            content = msg.content.slice(0, 2000);
          } else if (Array.isArray(msg.content)) {
            const parts: string[] = [];
            for (const block of msg.content) {
              if (!block || typeof block !== "object") continue;
              if (block.type === "text" && block.text) {
                parts.push(block.text);
              } else if (block.type === "thinking" && block.thinking) {
                // skip thinking blocks (huge, internal)
              } else if (block.type === "tool_use") {
                toolName = block.name || null;
                toolUseId = block.id || null;
                parts.push(`[tool: ${block.name}]`);
              } else if (block.type === "tool_result") {
                // Store minimal: just the fact it happened, not the content
                const err = block.is_error ? " (error)" : "";
                parts.push(`[result${err}]`);
              }
            }
            content = parts.join("\n").slice(0, 2000);
          }

          if (!content && !toolName) continue;

          insert.run(sessionId, uuid, parentUuid, type, role, content, model, ts, sidechain, toolName, toolUseId, inTok, outTok);
          total++;
        }
      }
    }
  });

  tx();

  // Rebuild FTS
  try {
    db.exec(`DELETE FROM conversation_fts`);
    db.exec(`INSERT INTO conversation_fts(rowid, content) SELECT id, content FROM conversation_messages WHERE content IS NOT NULL`);
  } catch { /* FTS rebuild failed, non-fatal */ }

  return total;
}
