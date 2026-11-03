/**
 * Billing-cycle dates, in the hub's time zone (HUB_TIMEZONE, an IANA zone such as
 * "Asia/Seoul" or "America/Los_Angeles"; default UTC).
 *
 * Each Max plan refreshes its API credit on the plan's billing day, and unused
 * credit expires at that moment. The hub stores the billing day (1–31) per
 * account; the cycle runs from the latest billing day up to the next one.
 * Months shorter than the billing day use their last day. Days begin at local
 * midnight, so daylight-saving changes are handled by the zone rules.
 */

import { hubTimeZone } from './config';

const DAY_MS = 24 * 3600 * 1000;

interface Ymd { y: number; m: number; d: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

function wall(t: Date, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of partsFormatter(tz).formatToParts(t)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The calendar date in `tz` at instant `now`. */
export function localYmd(now: Date, tz: string = hubTimeZone()): Ymd {
  const w = wall(now, tz);
  return { y: w.y, m: w.m, d: w.d };
}

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function offsetAt(t: number, tz: string): number {
  const w = wall(new Date(t), tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function clampDay(y: number, m: number, day: number): Ymd {
  return { y, m, d: Math.min(day, daysInMonth(y, m)) };
}

function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export function ymdString(v: Ymd): string {
  return `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
}

/**
 * The UTC instant at which that date begins in `tz` (local 00:00, or the first
 * moment of the day when a daylight-saving jump skips midnight).
 */
export function localMidnight(v: Ymd, tz: string = hubTimeZone()): Date {
  const naive = Date.UTC(v.y, v.m - 1, v.d);
  // Two passes settle the offset on either side of a daylight-saving change.
  let t = naive - offsetAt(naive, tz);
  t = naive - offsetAt(t, tz);
  // If midnight does not exist that day (clock jumps 00:00 → 01:00), step to the first local minute of the date.
  const want = ymdString(v);
  for (let i = 0; i < 4 && ymdString(localYmd(new Date(t), tz)) < want; i++) t += 3600_000;
  // If an earlier instant is still the same date (clock fell back over midnight), move back to it.
  while (ymdString(localYmd(new Date(t - 3600_000), tz)) === want) t -= 3600_000;
  return new Date(t);
}

export interface Cycle {
  /** First day of the cycle, YYYY-MM-DD (hub time zone). Usage rows are tagged with it. */
  start: string;
  startsAt: Date;
  /** The next billing day, YYYY-MM-DD (hub time zone): the credit expires as this day begins. */
  end: string;
  endsAt: Date;
  /** Whole and partial days until the credit expires. */
  daysLeft: number;
}

export function cycleFor(renewalDay: number, now: Date = new Date(), tz: string = hubTimeZone()): Cycle {
  const day = Math.min(31, Math.max(1, Math.floor(renewalDay)));
  const today = localYmd(now, tz);
  let start = clampDay(today.y, today.m, day);
  if (start.d > today.d) {
    const prev = addMonths(today.y, today.m, -1);
    start = clampDay(prev.y, prev.m, day);
  }
  const next = addMonths(start.y, start.m, 1);
  const end = clampDay(next.y, next.m, day);
  const endsAt = localMidnight(end, tz);
  return { start: ymdString(start), startsAt: localMidnight(start, tz), end: ymdString(end), endsAt, daysLeft: (endsAt.getTime() - now.getTime()) / DAY_MS };
}

/** Calendar month in the hub time zone, used to group paid-key usage and for the paid monthly cap. */
export function monthCycle(now: Date = new Date(), tz: string = hubTimeZone()): Cycle {
  return cycleFor(1, now, tz);
}
