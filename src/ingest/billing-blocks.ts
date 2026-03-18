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
  inputTok: number;
  outputTok: number;
  count: number;
  firstStart: number;
  lastEnd: number;
}

function aggregateBillingBlocks(sessions: SessionRow[]): Map<number, BillingBlock> {
  const blocks = new Map<number, BillingBlock>();

  for (const s of sessions) {
    const bs = billingBlockStart(s.started_at);
    const end = s.ended_at ?? s.started_at;
    const existing = blocks.get(bs);
    if (existing) {
      existing.cost += s.cost_usd ?? 0;
      existing.inputTok += s.input_tokens ?? 0;
      existing.outputTok += s.output_tokens ?? 0;
      existing.count++;
      if (s.started_at < existing.firstStart) existing.firstStart = s.started_at;
      if (end > existing.lastEnd) existing.lastEnd = end;
    } else {
      blocks.set(bs, {
        start: bs,
        end: billingBlockEnd(s.started_at),
        cost: s.cost_usd ?? 0,
        inputTok: s.input_tokens ?? 0,
        outputTok: s.output_tokens ?? 0,
        count: 1,
        firstStart: s.started_at,
        lastEnd: end,
      });
    }
  }

  return blocks;
}

export async function ingestBillingBlocks(db: Database): Promise<number> {
  const sessions = db.query(
    `SELECT started_at, ended_at, cost_usd, input_tokens, output_tokens
     FROM sessions
     WHERE started_at > 0 AND (cost_usd > 0 OR input_tokens > 0)
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
      const totalTokens = b.inputTok + b.outputTok;
      insert.run(
        b.start, b.end,
        b.start === currentBlock ? "active" : "completed",
        Math.round(b.cost * 100) / 100,
        b.inputTok, b.outputTok, b.count,
        Math.round(totalTokens / durationMin),
        Math.round((b.cost / durationMin) * 10000) / 10000,
      );
    }
  })();

  return blocks.size;
}
