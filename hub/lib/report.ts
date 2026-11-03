/**
 * The daily usage report, written as Slack-style text: what the last 24 hours cost
 * and where it was charged (credit or paid), per project and per credit
 * account, how much credit is left before each renewal, and anything that
 * looks wrong. Amounts are the hub's own metering of the usage Anthropic
 * reports, so they can differ slightly from Anthropic's invoices.
 */

import { esc, localTime, usd } from './alerts';
import { hubName, hubTimeZone } from './config';
import { monthCycle } from './cycle';
import type { Db } from './db';
import { locale, t } from './i18n';
import { accountStates } from './store';

const DAY_MS = 86_400_000;
const MAX_PROJECTS = 12;

function money0(n: number): string {
  return `$${Math.round(Math.max(0, n)).toLocaleString('en-US')}`;
}

function statusName(status: number): string {
  const w = t();
  if (status === 0) return w.statusNone;
  if (status === 402) return w.status402;
  if (status === 429) return w.status429;
  if (status === 529) return w.status529;
  if (status >= 500) return w.status5xx(status);
  if (status === 401 || status === 403) return w.statusKey(status);
  return w.statusClient(status);
}

interface ClientRow { name: string; pool: string; n: number; cost: number }

export async function buildReport(db: Db, now = new Date()): Promise<string> {
  const w = t();
  const tz = hubTimeZone();
  const sinceAt = new Date(now.getTime() - DAY_MS);
  const since = sinceAt.toISOString();
  const until = now.toISOString();
  const monthStart = monthCycle(now).startsAt.toISOString();
  // A request is counted once, by its final outcome: lost-connection attempts and swept set-asides are
  // bookkeeping rows (their cost still counts), not requests.
  const final = "not (coalesce(request_key, '') like 'sweep:%' and status = 0) and coalesce(note, '') not like 'connection lost%'";

  const { rows: pools } = await db.query<{ pool: string; n: number; ok: number; cost: number }>(
    `select pool, count(*) filter (where ${final})::int as n, count(*) filter (where status between 200 and 299)::int as ok, coalesce(sum(cost_usd), 0) as cost
       from usage_log where at >= $1 and at < $2 group by pool`, [since, until],
  );
  const clientSql = `select coalesce(c.name, $3) as name, u.pool,
         count(*) filter (where not (coalesce(u.request_key, '') like 'sweep:%' and u.status = 0) and coalesce(u.note, '') not like 'connection lost%')::int as n,
         coalesce(sum(u.cost_usd), 0) as cost
       from usage_log u left join clients c on c.id = u.client_id where u.at >= $1 and u.at < $2 group by 1, 2`;
  const { rows: byClientDay } = await db.query<ClientRow>(clientSql, [since, until, w.noProject]);
  const { rows: byClientMonth } = await db.query<ClientRow>(clientSql, [monthStart, until, w.noProject]);
  const { rows: perAccount } = await db.query<{ account_id: number; n: number; cost: number }>(
    `select account_id, count(*)::int as n, coalesce(sum(cost_usd), 0) as cost from usage_log where at >= $1 and at < $2 and account_id is not null group by account_id`, [since, until],
  );
  const { rows: errors } = await db.query<{ status: number; n: number }>(
    `select status, count(*)::int as n from usage_log where at >= $1 and at < $2 and not (status between 200 and 299) and ${final} group by status order by n desc limit 6`, [since, until],
  );
  const { rows: alertFails } = await db.query<{ key: string; last_error: string | null }>('select key, last_error from alert_state where last_ok = false');
  const states = await accountStates(db, now);

  const poolOf = (p: string) => pools.find((r) => r.pool === p);
  const creditCost = Number(poolOf('credit')?.cost ?? 0);
  const paidCost = Number(poolOf('paid')?.cost ?? 0);
  const total = pools.reduce((a, r) => a + r.n, 0);
  const unserved = poolOf('none')?.n ?? 0;

  const lines: string[] = [];
  const weekday = new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: 'short' }).format(now);
  lines.push(w.reportTitle(esc(hubName()), localTime(sinceAt, tz), localTime(now, tz), tz, weekday));
  lines.push(w.reportSummary(total.toLocaleString('en-US'), usd(creditCost), usd(paidCost), unserved));

  // Paid switches
  const paidRows = byClientDay.filter((r) => r.pool === 'paid');
  lines.push('');
  lines.push(w.reportPaidHeader);
  if (!paidRows.length) lines.push(w.reportNoPaid);
  else for (const r of paidRows.sort((a, b) => Number(b.cost) - Number(a.cost))) lines.push(w.reportItems(esc(r.name), r.n, usd(Number(r.cost))));

  // Projects
  type Row = { name: string; dayN: number; dayCost: number; dayPaid: number; monthCost: number; monthPaid: number };
  const projects = new Map<string, Row>();
  const row = (name: string): Row => {
    let r = projects.get(name);
    if (!r) projects.set(name, (r = { name, dayN: 0, dayCost: 0, dayPaid: 0, monthCost: 0, monthPaid: 0 }));
    return r;
  };
  for (const r of byClientDay) { const p = row(r.name); p.dayN += r.n; p.dayCost += Number(r.cost); if (r.pool === 'paid') p.dayPaid += Number(r.cost); }
  for (const r of byClientMonth) { const p = row(r.name); p.monthCost += Number(r.cost); if (r.pool === 'paid') p.monthPaid += Number(r.cost); }
  const ranked = [...projects.values()].sort((a, b) => b.dayCost - a.dayCost || b.monthCost - a.monthCost);
  lines.push('');
  lines.push(w.reportProjectsHeader);
  const active = ranked.filter((p) => p.dayN > 0 || p.dayCost > 0);
  const idle = ranked.filter((p) => !(p.dayN > 0 || p.dayCost > 0) && p.monthCost > 0);
  if (!active.length && !idle.length) lines.push(w.reportNoUsage);
  for (const p of active.slice(0, MAX_PROJECTS)) {
    const paid = p.monthPaid > 0 ? w.reportPaidPart(usd(p.monthPaid)) : '';
    lines.push(w.reportProjectLine(esc(p.name), p.dayN, usd(p.dayCost), usd(p.monthCost), paid));
  }
  if (active.length > MAX_PROJECTS) lines.push(w.reportMoreProjects(active.length - MAX_PROJECTS));
  if (idle.length) {
    const shown = idle.slice(0, 8).map((p) => `${esc(p.name)} ${usd(p.monthCost)}`).join(', ');
    lines.push(w.reportIdle(shown, idle.length - 8));
  }

  // Credit accounts
  lines.push('');
  lines.push(w.reportCreditHeader);
  let usableTotal = 0;
  let unusedTotal = 0;
  for (const s of states.filter((x) => x.row.kind === 'credit')) {
    const day = perAccount.find((r) => r.account_id === s.row.id);
    const usable = Math.max(0, s.usable);
    const elapsed = Math.max(1, (now.getTime() - s.cycle.startsAt.getTime()) / DAY_MS);
    const live = s.status === 'ready' || s.status === 'cooldown';
    const unused = live ? Math.max(0, usable - (s.spent / elapsed) * s.cycle.daysLeft) : 0;
    if (live) { usableTotal += usable; unusedTotal += unused; }
    const tag = s.status === 'ready' ? '' : ` [${s.status === 'disabled' ? w.tagDisabled : s.status === 'exhausted' ? w.tagExhausted : w.tagCooldown}]`;
    lines.push(w.reportCreditLine(s.row.id, esc(s.row.label), tag, money0(usable), Math.ceil(s.cycle.daysLeft), usd(Number(day?.cost ?? 0)), live ? money0(unused) : ''));
  }
  lines.push(w.reportCreditTotal(money0(usableTotal), money0(unusedTotal)));

  // Signals
  const signals: string[] = [];
  for (const e of errors) signals.push(w.reportErrorLine(e.n, statusName(e.status)));
  for (const s of states) {
    if (s.row.last_error_at && now.getTime() - new Date(s.row.last_error_at).getTime() < DAY_MS) {
      signals.push(w.reportAccountError(s.row.id, esc(s.row.label), esc(String(s.row.last_error ?? '').slice(0, 100)), localTime(new Date(s.row.last_error_at), tz)));
    }
  }
  for (const a of alertFails) signals.push(w.reportAlertFail(esc(a.key), esc(String(a.last_error ?? '').slice(0, 100))));
  lines.push('');
  lines.push(w.reportSignalsHeader);
  if (!signals.length) lines.push(w.reportNoSignals);
  else lines.push(...signals);

  lines.push('');
  lines.push(w.reportFooter);
  return lines.join('\n');
}
