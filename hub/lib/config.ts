/**
 * Operator settings read from the environment. Every reader takes `env` so tests can pass their own.
 */

type Env = Record<string, string | undefined>;

export type Lang = 'en' | 'ko';

/** Display name in the admin page, alerts and API error messages. */
export function hubName(env: Env = process.env): string {
  return env.HUB_NAME?.trim() || 'CreditFirst';
}

export function hubLang(env: Env = process.env): Lang {
  return env.HUB_LANG?.trim().toLowerCase() === 'ko' ? 'ko' : 'en';
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const warned = new Set<string>();

/** IANA time zone for billing days, calendar months and shown times. Unset or invalid means UTC. */
export function hubTimeZone(env: Env = process.env): string {
  const tz = env.HUB_TIMEZONE?.trim();
  if (!tz) return 'UTC';
  if (isTimeZone(tz)) return tz;
  if (!warned.has(tz)) { warned.add(tz); console.error(`HUB_TIMEZONE "${tz}" is not a valid IANA time zone; using UTC`); }
  return 'UTC';
}

/**
 * HUB_PAID_MONTHLY_CAP_USD: the most the paid keys may spend in one calendar month (HUB_TIMEZONE).
 * Unset or empty = no cap. A value that is set but unreadable fails closed (cap 0 = no paid use),
 * because this setting exists to protect money.
 */
export function paidMonthlyCapUsd(env: Env = process.env): number | undefined {
  const raw = env.HUB_PAID_MONTHLY_CAP_USD?.trim();
  if (!raw) return undefined;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return v;
  if (!warned.has(`cap:${raw}`)) { warned.add(`cap:${raw}`); console.error('HUB_PAID_MONTHLY_CAP_USD is not a number >= 0; paid keys are blocked until it is fixed'); }
  return 0;
}

/** Minimum length of HUB_ADMIN_TOKEN. */
export const ADMIN_TOKEN_MIN = 24;
