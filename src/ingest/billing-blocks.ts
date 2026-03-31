import type { Database } from "bun:sqlite";
import { billingBlockStart, billingBlockEnd } from "../utils/dates.ts";

interface SessionRow {
  started_at: number;
  ended_at: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

interface BillingBlock {
  start: number;
  end: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
  firstStart: number;
  lastEnd: number;
}

function aggregateBillingBlocks(sessions: SessionRow[]): Map<number, BillingBlock> {
  const blocks = new Map<number, BillingBlock>();

  for (const s of sessions) {
    const startMs = typeof s.started_at === "string" ? new Date(s.started_at).getTime() : s.started_at;
    const endMs = s.ended_at ? (typeof s.ended_at === "string" ? new Date(s.ended_at as unknown as string).getTime() : s.ended_at) : startMs;
    if (!startMs || isNaN(startMs)) continue;
    const bs = billingBlockStart(startMs);
    const end = endMs;
    const existing = blocks.get(bs);
    if (existing) {
      existing.cost += s.cost_usd ?? 0;
      existing.inputTokens += s.input_tokens ?? 0;
      existing.outputTokens += s.output_tokens ?? 0;
      existing.count++;
      if (startMs < existing.firstStart) existing.firstStart = startMs;
      if (end > existing.lastEnd) existing.lastEnd = end;
    } else {
      blocks.set(bs, {
        start: bs,
        end: billingBlockEnd(startMs),
        cost: s.cost_usd ?? 0,
        inputTokens: s.input_tokens ?? 0,
        outputTokens: s.output_tokens ?? 0,
        count: 1,
        firstStart: startMs,
        lastEnd: end,
      });
    }
  }

  return blocks;
}

export async function ingestBillingBlocks(db: Database): Promise<number> {
  const sessions = db.query(
    `SELECT
       strftime('%s', MIN(timestamp)) * 1000 as started_at,
       strftime('%s', MAX(timestamp)) * 1000 as ended_at,
       ROUND(SUM(CASE
         WHEN model LIKE '%opus-4-6%' THEN COALESCE(input_tokens,0)/1e6*5+COALESCE(output_tokens,0)/1e6*25+COALESCE(cache_read_tokens,0)/1e6*0.5+COALESCE(cache_creation_tokens,0)/1e6*6.25
         WHEN model LIKE '%opus%' THEN COALESCE(input_tokens,0)/1e6*15+COALESCE(output_tokens,0)/1e6*75+COALESCE(cache_read_tokens,0)/1e6*1.5+COALESCE(cache_creation_tokens,0)/1e6*18.75
         WHEN model LIKE '%sonnet%' THEN COALESCE(input_tokens,0)/1e6*3+COALESCE(output_tokens,0)/1e6*15+COALESCE(cache_read_tokens,0)/1e6*0.3+COALESCE(cache_creation_tokens,0)/1e6*3.75
         WHEN model LIKE '%haiku%' THEN COALESCE(input_tokens,0)/1e6*1+COALESCE(output_tokens,0)/1e6*5+COALESCE(cache_read_tokens,0)/1e6*0.1+COALESCE(cache_creation_tokens,0)/1e6*1.25
         ELSE COALESCE(input_tokens,0)/1e6*3+COALESCE(output_tokens,0)/1e6*15
       END),4) as cost_usd,
       SUM(COALESCE(input_tokens,0)) as input_tokens,
       SUM(COALESCE(output_tokens,0)) as output_tokens
     FROM conversation_messages
     WHERE timestamp LIKE '20%' AND type IN ('user','assistant')
     GROUP BY session_id
     HAVING input_tokens > 0 OR output_tokens > 0
     ORDER BY started_at`,
  ).all() as SessionRow[];

  if (sessions.length === 0) return 0;

  const blocks = aggregateBillingBlocks(sessions);
  const currentBlock = billingBlockStart(Date.now());

  const insert = db.query(
    `INSERT OR REPLACE INTO billing_blocks
     (block_start, block_end, status, total_cost, total_input_tokens, total_output_tokens,
      session_count, burn_rate_tokens_per_min, burn_rate_cost_per_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const b of blocks.values()) {
      const durationMin = Math.max(1, (b.lastEnd - b.firstStart) / 60_000);
      const totalTokens = b.inputTokens + b.outputTokens;
      insert.run(
        b.start, b.end,
        b.start === currentBlock ? "active" : "completed",
        Math.round(b.cost * 100) / 100,
        b.inputTokens, b.outputTokens, b.count,
        Math.round(totalTokens / durationMin),
        Math.round((b.cost / durationMin) * 10000) / 10000,
      );
    }
  })();

  return blocks.size;
}
