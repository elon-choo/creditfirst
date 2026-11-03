/**
 * Alerts to the owner: a Slack message (bot token + channel) and/or a generic
 * JSON webhook (`{"text": …}`, e.g. a Slack incoming webhook, or a Discord webhook URL ending in /slack).
 *
 * Three things are worth an immediate message: a request that was paid for with
 * a paid key (or handed back to a credit-only project's own paid route), a
 * request the hub could not serve at all, and an account that stopped working.
 * The same alert is sent at most once per window, so a busy period gives one
 * message, not hundreds; the next message after the window says how much
 * happened in between. Sending never delays or breaks a request: it is skipped
 * when no destination is configured, bounded by a short timeout, and errors are
 * only logged and remembered in `alert_state`.
 */

import { hubTimeZone } from './config';
import type { Db } from './db';
import { locale, t } from './i18n';
import type { AccountState } from './store';

export type Notify = (text: string) => Promise<void>;

/** Posts a message to the owner's Slack DM; undefined when the hub has no Slack settings. */
export function slackNotifier(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Notify | undefined {
  const token = env.SLACK_BOT_TOKEN;
  const channel = env.HUB_ALERT_SLACK_CHANNEL;
  if (!token || !channel) return undefined;
  return async (text) => {
    const res = await fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new Error(`slack ${body.error ?? res.status}`);
  };
}

/** Posts `{"text": …}` as JSON to HUB_ALERT_WEBHOOK_URL (https only); undefined when it is not set. */
export function webhookNotifier(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Notify | undefined {
  const url = env.HUB_ALERT_WEBHOOK_URL?.trim();
  if (!url) return undefined;
  if (!/^https:\/\//i.test(url)) {
    console.error('HUB_ALERT_WEBHOOK_URL must start with https://; webhook alerts are off');
    return undefined;
  }
  return async (text) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  };
}

/**
 * Every configured destination. A message counts as delivered when at least one destination took it,
 * so a retry never sends a duplicate to the destination that already worked.
 */
export function alertNotifier(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Notify | undefined {
  const all = [slackNotifier(env, fetchFn), webhookNotifier(env, fetchFn)].filter((n): n is Notify => !!n);
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return async (text) => {
    const results = await Promise.allSettled(all.map((n) => n(text)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const f of failed) console.error('alert destination failed', maskSecrets(String(f.reason)).slice(0, 200));
    if (failed.length === all.length) throw failed[0].reason;
  };
}

export interface AlertDeps {
  db: Db;
  notify?: Notify;
  now?: () => Date;
}

/** Per process shortcut: while a key is known to be inside its window, skip the database. */
const quiet = new WeakMap<Db, Map<string, number>>();

/** A claim that never reported back (the process died) stops blocking after this long. */
const IN_FLIGHT_MS = 2 * 60_000;

/**
 * Sends `build(previousSentAt)` unless this key was already sent within `windowMin` minutes.
 * Never throws. `raiseResult` says what happened ('sent', 'quiet' = inside a window, 'failed', 'off' = no destination);
 * `raise` just says whether a message went out.
 *
 * The row in `alert_state` is claimed first (`last_ok` null = on its way), then the message is sent.
 * A failed send hands the window back; a delivered one is kept even if recording it fails, so a
 * message is never sent twice. Only confirmed windows are cached in memory, so a claim that later
 * fails cannot silence retries elsewhere.
 */
export async function raise(deps: AlertDeps, key: string, windowMin: number, build: (since: Date | null) => Promise<string>): Promise<boolean> {
  return (await raiseResult(deps, key, windowMin, build)) === 'sent';
}

export type RaiseResult = 'sent' | 'quiet' | 'failed' | 'off';

export async function raiseResult(deps: AlertDeps, key: string, windowMin: number, build: (since: Date | null) => Promise<string>): Promise<RaiseResult> {
  if (!deps.notify) return 'off';
  try {
    const now = (deps.now ?? (() => new Date()))();
    const windowMs = windowMin * 60_000;
    let skip = quiet.get(deps.db);
    if (!skip) quiet.set(deps.db, (skip = new Map()));
    const until = skip.get(key);
    if (until !== undefined && now.getTime() < until) return 'quiet';
    const claim = await deps.db.tx(async (t) => {
      await t.query('insert into alert_state (key) values ($1) on conflict do nothing', [key]);
      const { rows } = await t.query<{ last_sent: Date | string | null; last_ok: boolean | null }>('select last_sent, last_ok from alert_state where key = $1 for update', [key]);
      const prev = rows[0]?.last_sent ? new Date(rows[0].last_sent) : null;
      const age = prev ? now.getTime() - prev.getTime() : Infinity;
      const abandoned = rows[0]?.last_ok == null && age > IN_FLIGHT_MS;
      if (prev && age < windowMs && !abandoned) return { send: false, confirmed: rows[0].last_ok === true, prev, restore: prev };
      await t.query('update alert_state set last_sent = $2, last_ok = null where key = $1', [key, now.toISOString()]);
      // If this send fails, go back to the last delivery that really happened (an unfinished claim delivered nothing).
      return { send: true, confirmed: false, prev, restore: rows[0]?.last_ok === true ? prev : null };
    });
    if (!claim.send) {
      if (claim.confirmed) skip.set(key, claim.prev!.getTime() + windowMs);
      return 'quiet';
    }
    try {
      await deps.notify(await build(claim.prev));
    } catch (e) {
      // Not delivered: give the window back (unless a newer claim replaced ours) so the next event tries again.
      await deps.db.query(
        'update alert_state set last_sent = $3, last_ok = false, last_error = $4 where key = $1 and last_sent = $2',
        [key, now.toISOString(), claim.restore ? claim.restore.toISOString() : null, maskSecrets(String(e)).slice(0, 300)],
      ).catch(() => {});
      console.error('alert not delivered', key, maskSecrets(String(e)).slice(0, 200));
      return 'failed';
    }
    skip.set(key, now.getTime() + windowMs);
    await deps.db.query('update alert_state set last_ok = true, last_error = null where key = $1 and last_sent = $2', [key, now.toISOString()]).catch(() => {});
    return 'sent';
  } catch (e) {
    console.error('alert failed', key, maskSecrets(String(e)).slice(0, 200));
    return 'failed';
  }
}

// ---- wording ----

/** Keeps only the start of anything shaped like an API key or token, so error text can never carry one into an alert. */
export function maskSecrets(s: string): string {
  return s.replace(/(sk-ant-[A-Za-z0-9_-]{4}|cf_[A-Za-z0-9_-]{4}|xox[a-z]-)[A-Za-z0-9_-]+/g, '$1…');
}

/** Text from outside (project names, error messages) made safe for Slack: secrets cut short, & < > escaped. */
export function esc(s: string): string {
  return maskSecrets(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function usd(n: number): string {
  const v = Number(n) || 0;
  if (v === 0) return '$0';
  if (v < 0.0001) return t().lessThanTenthCent;
  return `$${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
}

/** "10/19 15:32" in the hub time zone (HUB_TIMEZONE). */
export function localTime(d: Date, tz: string = hubTimeZone()): string {
  const f = new Intl.DateTimeFormat(locale(), { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** Why the credit accounts did not take a request, in plain words. */
export function switchReason(states: AccountState[], notes: string[]): string {
  const w = t();
  const credit = states.filter((s) => s.row.kind === 'credit');
  const count = (st: AccountState['status']) => credit.filter((s) => s.status === st).length;
  const ready = count('ready');
  const parts: string[] = [];
  if (ready === 0) {
    const detail = [
      count('exhausted') ? w.exhaustedN(count('exhausted')) : '',
      count('cooldown') ? w.cooldownN(count('cooldown')) : '',
      count('disabled') ? w.disabledN(count('disabled')) : '',
    ].filter(Boolean).join(', ');
    parts.push(w.noCreditReady(detail));
  } else {
    parts.push(w.creditCouldNot(ready));
  }
  const fit = notes.filter((n) => /skip\(fit\)/.test(n)).map((n) => n.split(' ')[0]);
  if (fit.length) parts.push(w.fitShort(fit.join(' ')));
  const upstream = notes.filter((n) => /^#\d+ (\d{3}|network)$/.test(n)).map((n) => n.replace(/^(#\d+) /, '$1 → '));
  if (upstream.length) parts.push(w.upstreamSaid(upstream.join(', ')));
  return parts.join(' ');
}

export interface PaidSwitch {
  client: string;
  clientId: number;
  accountId: number;
  accountLabel: string;
  model: string;
  costUsd: number;
  reason: string;
}

export async function paidSwitchText(db: Db, i: PaidSwitch, since: Date | null): Promise<string> {
  const w = t();
  const lines = [
    w.paidSwitchTitle(esc(i.client)),
    w.paidSwitchBody(i.accountId, esc(i.accountLabel), esc(i.model), usd(i.costUsd)),
    w.reason(esc(i.reason)),
  ];
  if (since) {
    const { rows } = await db.query<{ n: number; cost: number }>(
      `select count(*)::int as n, coalesce(sum(cost_usd), 0) as cost from usage_log where pool = 'paid' and client_id = $1 and at > $2`,
      [i.clientId, since.toISOString()],
    );
    lines.push(w.paidSince(localTime(since), rows[0].n, usd(Number(rows[0].cost))));
  }
  lines.push(w.paidSwitchWindow);
  return lines.join('\n');
}

export function creditOnlyText(client: string, reason: string): string {
  const w = t();
  return [w.creditOnlyTitle(esc(client)), w.creditOnlyBody, w.reason(esc(reason)), w.creditOnlyWindow].join('\n');
}

export function stoppedText(client: string, status: number, notes: string[]): string {
  const w = t();
  return [w.stoppedTitle(esc(client)), w.stoppedBody(status, esc(notes.join(' ') || w.none)), w.stoppedHint, w.stoppedWindow].join('\n');
}

export function paidCapText(client: string, spentUsd: number, capUsd: number): string {
  const w = t();
  return [w.paidCapTitle(usd(capUsd)), w.paidCapBody(esc(client), usd(spentUsd), usd(capUsd)), w.paidCapHint].join('\n');
}

export function accountTroubleText(kind: 'credit-empty' | 'paid-empty' | 'key-rejected', s: AccountState, detail: string): string {
  const w = t();
  const name = `#${s.row.id}(${esc(s.row.label)})`;
  if (kind === 'paid-empty') return w.paidEmpty(name, esc(detail.slice(0, 160)));
  if (kind === 'key-rejected') return w.keyRejected(name, esc(detail.slice(0, 160)));
  return w.creditEmpty(name, `$${s.usable.toFixed(0)}`);
}
