/**
 * All dates are local timezone. Epoch ms and ISO 8601 inputs are
 * converted to the system timezone before bucketing into days/weeks/hours.
 * Never group by UTC date.
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const FIVE_HOURS = 5 * 60 * 60 * 1000;

/** Round epoch ms down to the start of its 5-hour billing block. */
export function billingBlockStart(ms: number): number {
  return Math.floor(ms / FIVE_HOURS) * FIVE_HOURS;
}

/** End of the 5-hour billing block containing the given epoch ms. */
export function billingBlockEnd(ms: number): number {
  return billingBlockStart(ms) + FIVE_HOURS;
}

/** Local timezone offset in seconds (east of UTC is positive). */
export const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

export function dateToMs(dateStr: string): number {
  return new Date(dateStr + "T00:00:00").getTime();
}

export function endOfDayMs(dateStr: string): number {
  return new Date(dateStr + "T23:59:59.999").getTime();
}

