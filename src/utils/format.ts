// ── ANSI Colors ─────────────────────────────────────────────────────

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const dim = esc("2");
export const bold = esc("1");
const green = esc("32");
export const yellow = esc("33");
export const cyan = esc("36");

// ── Formatting ──────────────────────────────────────────────────────

export function header(title: string): string {
  return `\x1b[1;4m${title}\x1b[0m`;
}

interface TableOpts {
  /** Minimum column widths */
  minWidths?: number[];
  /** Right-align columns by index */
  rightAlign?: Set<number>;
  /** Padding between columns (default: 2) */
  gap?: number;
}

export function table(rows: string[][], opts: TableOpts = {}): string {
  if (rows.length === 0) return "";

  const gap = opts.gap ?? 2;
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = Array(cols).fill(0);

  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const len = Bun.stringWidth(row[c] ?? "");
      widths[c] = Math.max(widths[c] ?? 0, len);
    }
  }

  if (opts.minWidths) {
    for (let c = 0; c < opts.minWidths.length; c++) {
      widths[c] = Math.max(widths[c] ?? 0, opts.minWidths[c] ?? 0);
    }
  }

  const lines: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      const rawLen = Bun.stringWidth(cell);
      const pad = widths[c]! - rawLen;
      const isLast = c === cols - 1;
      const right = opts.rightAlign?.has(c);

      if (isLast) {
        cells.push(right ? " ".repeat(Math.max(0, pad)) + cell : cell);
      } else if (right) {
        cells.push(" ".repeat(Math.max(0, pad)) + cell + " ".repeat(gap));
      } else {
        cells.push(cell + " ".repeat(Math.max(0, pad + gap)));
      }
    }
    lines.push(cells.join(""));
  }

  return lines.join("\n");
}

export function truncate(s: string, maxLen: number): string {
  if (Bun.stringWidth(s) <= maxLen) return s;
  return Bun.sliceAnsi(s, 0, maxLen, "\u2026");
}

export function statusBadge(
  status: "completed" | "in_progress" | "pending" | string,
): string {
  switch (status) {
    case "completed":
      return green("\u25cf done");
    case "in_progress":
      return yellow("\u25cf wip");
    case "pending":
      return dim("\u25cb pending");
    default:
      return dim(`\u25cb ${status}`);
  }
}

