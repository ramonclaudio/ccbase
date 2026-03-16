/**
 * All dates are local timezone. Epoch ms and ISO 8601 inputs are
 * converted to the system timezone before bucketing into days/weeks/hours.
 * Never group by UTC date.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** System timezone name (e.g. "America/New_York"). */
export { tz as timezone };

export function today(): string {
  return formatDate(new Date());
}

export function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

/** Monday of the current week (ISO week starts Monday). */
export function thisWeekStart(): string {
  const d = new Date();
  const day = d.getDay();
  // Sunday=0, Monday=1, ..., Saturday=6
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return formatDate(d);
}

export function epochMsToDate(ms: number): string {
  return formatDate(new Date(ms));
}

export function epochMsToTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoToEpochMs(iso: string): number {
  return new Date(iso).getTime();
}

export function durationMinutes(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / 60_000);
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Round epoch ms down to the start of its 5-hour billing block. */
export function billingBlockStart(ms: number): number {
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  return Math.floor(ms / FIVE_HOURS) * FIVE_HOURS;
}

/** End of the 5-hour billing block containing the given epoch ms. */
export function billingBlockEnd(ms: number): number {
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  return billingBlockStart(ms) + FIVE_HOURS;
}

/**
 * Human-friendly relative date.
 * Input: YYYY-MM-DD string.
 */
export function relativeDate(dateStr: string): string {
  const t = today();
  if (dateStr === t) return "today";

  const y = yesterday();
  if (dateStr === y) return "yesterday";

  const target = new Date(dateStr + "T00:00:00");
  const now = new Date(t + "T00:00:00");
  const diffDays = Math.round(
    (now.getTime() - target.getTime()) / 86_400_000,
  );

  if (diffDays > 0 && diffDays <= 14) return `${diffDays} days ago`;

  // Format as "Mar 12"
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[target.getMonth()]} ${target.getDate()}`;
}
