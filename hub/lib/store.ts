/**
 * Account bookkeeping: which accounts can take the next request, setting credit
 * aside while a request runs, recording what it really cost, and marking
 * accounts that Anthropic reports as empty or broken.
 */

import { cycleFor, monthCycle, type Cycle } from './cycle';
import type { Db, Q } from './db';
import { t } from './i18n';
import type { Usage } from './pricing';
import { decrypt, encrypt, keyHint, newClientKey, sha256 } from './secrets';

export type Kind = 'credit' | 'paid';

export interface AccountRow {
  id: number;
  label: string;
  kind: Kind;
  api_key_enc: string;
  key_hint: string;
  monthly_credit_usd: number;
  renewal_day: number | null;
  safety_margin_usd: number;
  priority: number;
  enabled: boolean;
  cooldown_until: Date | null;
  exhausted_cycle: string | null;
  last_error: string | null;
  last_error_at: Date | null;
  key_fingerprint: string | null;
  org_id: string | null;
  deleted: boolean;
}

export interface AccountState {
  row: AccountRow;
  cycle: Cycle;
  spent: number;
  reserved: number;
  /** Credit still usable by the hub: credit − safety margin − spent − set aside. */
  usable: number;
  status: 'ready' | 'cooldown' | 'exhausted' | 'disabled' | 'paid';
}

/**
 * Requests are cut off at maxDuration (at most 800 seconds), so a set-aside older than this was never
 * recorded (the process died or recording failed). It is then charged in full —
 * never silently dropped, because Anthropic may have billed it.
 */
const STALE_RESERVATION_MIN = 30;

function cycleOf(row: AccountRow, now: Date): Cycle {
  return row.kind === 'credit' && row.renewal_day ? cycleFor(row.renewal_day, now) : monthCycle(now);
}

/**
 * Spending is everything recorded since the cycle began (by time, so editing the
 * billing day never hides money already spent); every set-aside still open counts.
 */
async function spentAndReserved(q: Q, accountId: number, cycle: Cycle): Promise<{ spent: number; reserved: number }> {
  const { rows } = await q.query<{ spent: number | null; reserved: number | null }>(
    `select
       (select coalesce(sum(cost_usd), 0) from usage_log where account_id = $1 and at >= $2) as spent,
       (select coalesce(sum(amount_usd), 0) from reservations where account_id = $1) as reserved`,
    [accountId, cycle.startsAt.toISOString()],
  );
  return { spent: Number(rows[0]?.spent ?? 0), reserved: Number(rows[0]?.reserved ?? 0) };
}

function stateOf(row: AccountRow, cycle: Cycle, spent: number, reserved: number, now: Date): AccountState {
  const usable = row.kind === 'credit' ? row.monthly_credit_usd - row.safety_margin_usd - spent - reserved : Infinity;
  const coolingDown = !!row.cooldown_until && new Date(row.cooldown_until) > now;
  let status: AccountState['status'] = row.kind === 'paid' ? 'paid' : 'ready';
  if (!row.enabled) status = 'disabled';
  // Anthropic said "empty" this cycle: shown as used up, but re-checked whenever the pause ends.
  else if (row.kind === 'credit' && ((row.exhausted_cycle === cycle.start && coolingDown) || usable <= 0)) status = 'exhausted';
  else if (coolingDown) status = 'cooldown';
  return { row, cycle, spent, reserved, usable, status };
}

/** Charges set-asides that were never recorded, in full. */
export async function sweepStale(db: Db): Promise<void> {
  await db.query(
    `with stale as (
       delete from reservations where created_at < now() - interval '${STALE_RESERVATION_MIN} minutes' returning id, account_id, cycle_start, amount_usd
     )
     insert into usage_log (account_id, pool, cycle_start, cost_usd, status, note, request_key)
     select s.account_id, coalesce(a.kind, 'credit'), s.cycle_start, s.amount_usd, 0, 'unrecorded request charged in full', 'sweep:' || s.id
       from stale s left join accounts a on a.id = s.account_id`,
  );
}

export async function accountStates(db: Db, now = new Date()): Promise<AccountState[]> {
  const { rows } = await db.query<AccountRow>('select * from accounts where not deleted order by id');
  const out: AccountState[] = [];
  for (const row of rows) {
    const cycle = cycleOf(row, now);
    const { spent, reserved } = await spentAndReserved(db, row.id, cycle);
    out.push(stateOf(row, cycle, spent, reserved, now));
  }
  return out;
}

/**
 * The order to try accounts in: credit accounts whose credit expires soonest
 * first (unused credit is lost at expiry), then paid keys.
 */
export function routingOrder(states: AccountState[]): { credit: AccountState[]; paid: AccountState[] } {
  const credit = states
    .filter((s) => s.row.kind === 'credit' && s.status === 'ready')
    .sort((a, b) => a.cycle.endsAt.getTime() - b.cycle.endsAt.getTime() || b.row.priority - a.row.priority || a.row.id - b.row.id);
  const paid = states
    .filter((s) => s.row.kind === 'paid' && s.status === 'paid')
    .sort((a, b) => b.row.priority - a.row.priority || a.row.id - b.row.id);
  return { credit, paid };
}

/**
 * Sets `amount` aside on a credit account if, counting everything already spent
 * and set aside this cycle, it still fits under credit − safety margin.
 * The row lock makes concurrent requests take turns, so they cannot overshoot together.
 */
export async function tryReserve(db: Db, accountId: number, amount: number, now = new Date()): Promise<{ id: number; cycleStart: string } | null> {
  return db.tx(async (q) => {
    const { rows } = await q.query<AccountRow>('select * from accounts where id = $1 for update', [accountId]);
    const row = rows[0];
    if (!row || row.kind !== 'credit' || !row.enabled || row.deleted || !row.renewal_day) return null;
    const cycle = cycleFor(row.renewal_day, now);
    // An account Anthropic called empty stays paused; once the pause ends it gets one more try.
    if (row.cooldown_until && new Date(row.cooldown_until) > now) return null;
    const { spent, reserved } = await spentAndReserved(q, accountId, cycle);
    if (spent + reserved + amount > row.monthly_credit_usd - row.safety_margin_usd) return null;
    const ins = await q.query<{ id: number }>(
      'insert into reservations (account_id, cycle_start, amount_usd) values ($1, $2, $3) returning id',
      [accountId, cycle.start, amount],
    );
    return { id: Number(ins.rows[0].id), cycleStart: cycle.start };
  });
}

/**
 * HUB_PAID_MONTHLY_CAP_USD: sets `amount` aside on a paid key only if this calendar month's paid spending
 * (every paid key, deleted ones included) plus every paid set-aside still open plus `amount` stays within
 * `capUsd`. All paid rows are locked first, so concurrent requests take turns and cannot pass the cap together.
 */
export async function tryReservePaid(
  db: Db, accountId: number, amount: number, capUsd: number, now = new Date(),
): Promise<{ ok: true; id: number; cycleStart: string } | { ok: false; reason: 'cap'; committedUsd: number } | { ok: false; reason: 'unavailable' }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<AccountRow>("select * from accounts where kind = 'paid' order by id for update");
    const row = rows.find((r) => Number(r.id) === accountId);
    if (!row || !row.enabled || row.deleted) return { ok: false as const, reason: 'unavailable' as const };
    const month = monthCycle(now);
    const { rows: sums } = await q.query<{ spent: number | null; reserved: number | null }>(
      `select
         (select coalesce(sum(cost_usd), 0) from usage_log where pool = 'paid' and at >= $1) as spent,
         (select coalesce(sum(r.amount_usd), 0) from reservations r join accounts a on a.id = r.account_id where a.kind = 'paid') as reserved`,
      [month.startsAt.toISOString()],
    );
    const committedUsd = Number(sums[0]?.spent ?? 0) + Number(sums[0]?.reserved ?? 0);
    if (committedUsd + amount > capUsd) return { ok: false as const, reason: 'cap' as const, committedUsd };
    const ins = await q.query<{ id: number }>(
      'insert into reservations (account_id, cycle_start, amount_usd) values ($1, $2, $3) returning id',
      [accountId, month.start, amount],
    );
    return { ok: true as const, id: Number(ins.rows[0].id), cycleStart: month.start };
  });
}

export async function release(db: Db, reservationId: number): Promise<void> {
  await db.query('delete from reservations where id = $1', [reservationId]);
}

export interface SettleInput {
  /** One id per request outcome: a retried write with the same id is recorded once. */
  requestKey: string;
  reservationId?: number;
  /** The amount that was set aside (kept for callers; the swept row is corrected in place). */
  reservedUsd?: number;
  clientId: number | null;
  accountId: number | null;
  pool: Kind | 'none';
  cycleStart: string | null;
  model?: string;
  usage: Usage;
  costUsd: number;
  status: number;
  stream: boolean;
  durationMs: number;
  note?: string;
  /** When the request happened; defaults to the database clock. Billing cycles are counted from this time. */
  at?: Date;
}

/** Records the real cost and frees the set-aside in one step. */
export async function settle(db: Db, s: SettleInput): Promise<void> {
  const u = s.usage;
  const write = (u.cache_creation_input_tokens ?? 0) || ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0));
  await db.tx(async (q) => {
    const fields = [s.clientId, s.model ?? null, u.input_tokens ?? 0, u.output_tokens ?? 0, write, u.cache_read_input_tokens ?? 0,
      u.server_tool_use?.web_search_requests ?? 0, s.costUsd, s.status, s.stream, s.durationMs];
    if (s.reservationId) {
      const freed = await q.query('delete from reservations where id = $1 returning id', [s.reservationId]);
      if (freed.rows.length === 0) {
        // Already charged in full by sweepStale: correct that row in place, keeping its time and
        // billing cycle. Repeating this is harmless. If no swept row exists, an earlier try of this
        // same write committed, and the insert below is a no-op by request_key.
        const fixed = await q.query(
          `update usage_log set client_id = $2, model = $3, input_tokens = $4, output_tokens = $5, cache_write_tokens = $6,
             cache_read_tokens = $7, web_searches = $8, cost_usd = $9, status = $10, stream = $11, duration_ms = $12,
             note = 'recorded late (was charged in full)' where request_key = $1 returning id`,
          [`sweep:${s.reservationId}`, ...fields],
        );
        if (fixed.rows.length) return;
      }
    }
    await q.query(
      `insert into usage_log (client_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches,
         cost_usd, status, stream, duration_ms, account_id, pool, cycle_start, note, request_key, at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, coalesce($17::timestamptz, now()))
       on conflict (request_key) do nothing`,
      [...fields, s.accountId, s.pool, s.cycleStart, s.note ?? null, s.requestKey, s.at ? s.at.toISOString() : null],
    );
  });
}

/** settle(), retried: a lost record would let later requests overspend. */
export async function settleWithRetry(db: Db, s: SettleInput): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await settle(db, s); } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }
}

/**
 * Anthropic said the account has no credit left. Anthropic is the authority, so
 * the account is shown as used up and skipped; it is asked again after a pause
 * (credit can arrive later, e.g. hours after the billing date). Each re-check
 * costs a few rejected requests at most (those already in flight), never money.
 */
export async function markLowBalance(db: Db, state: AccountState, message: string): Promise<void> {
  await db.query(
    `update accounts set exhausted_cycle = $2, cooldown_until = now() + interval '30 minutes', last_error = $3, last_error_at = now() where id = $1`,
    [state.row.id, state.cycle.start, message.slice(0, 500)],
  );
}

export async function markCooldown(db: Db, accountId: number, minutes: number, message: string): Promise<void> {
  await db.query(
    `update accounts set cooldown_until = now() + ($2 || ' minutes')::interval, last_error = $3, last_error_at = now() where id = $1`,
    [accountId, String(minutes), message.slice(0, 500)],
  );
}

export function accountKey(row: AccountRow): string {
  return decrypt(row.api_key_enc);
}

// ---- projects (clients) ----

export interface ClientRow {
  id: number;
  name: string;
  /** false = credit only: when no credit account can take a request, answer 402 instead of using a paid key. */
  paid_fallback: boolean;
}

export async function authClient(db: Db, key: string | null): Promise<ClientRow | null> {
  if (!key || !key.startsWith('cf_')) return null;
  const { rows } = await db.query<ClientRow>('select id, name, paid_fallback from clients where key_hash = $1 and enabled', [sha256(key)]);
  return rows[0] ?? null;
}

export async function createClient(db: Db, name: string, opts: { paidFallback?: boolean } = {}): Promise<{ id: number; key: string }> {
  const key = newClientKey();
  const { rows } = await db.query<{ id: number }>(
    'insert into clients (name, key_hash, key_hint, paid_fallback) values ($1, $2, $3, $4) returning id',
    [name.trim(), sha256(key), keyHint(key), opts.paidFallback ?? true],
  );
  return { id: Number(rows[0].id), key };
}

/**
 * Credit only (paidFallback = false) suits apps that already pay for Claude elsewhere: they try the hub first
 * and, on the hub's 402 `credit-unavailable`, send the same request down their own paid route.
 */
export async function setClientPaidFallback(db: Db, id: number, paidFallback: boolean): Promise<void> {
  await db.query('update clients set paid_fallback = $2 where id = $1', [id, paidFallback]);
}

export async function setClientEnabled(db: Db, id: number, enabled: boolean): Promise<void> {
  await db.query('update clients set enabled = $2 where id = $1', [id, enabled]);
}

// ---- accounts admin ----

export interface AccountInput {
  label: string;
  kind: Kind;
  apiKey: string;
  monthlyCreditUsd?: number;
  renewalDay?: number;
  safetyMarginUsd?: number;
  priority?: number;
}

export function validateAccount(a: AccountInput): string | null {
  const w = t();
  if (!a || typeof a !== 'object') return w.badKind;
  if (typeof a.label !== 'string' || !a.label.trim()) return w.needLabel;
  if (a.kind !== 'credit' && a.kind !== 'paid') return w.badKind;
  if (typeof a.apiKey !== 'string' || !/^sk-ant-[a-z]+\d*-/.test(a.apiKey.trim())) return w.badKeyShape;
  if (a.kind === 'credit') {
    if (!(Number(a.monthlyCreditUsd) > 0)) return w.needCredit;
    const d = Number(a.renewalDay);
    if (!(d >= 1 && d <= 31)) return w.needRenewal;
  }
  return null;
}

/** A registration the hub refuses; `status` is the HTTP status the admin API answers with. */
export class AccountError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** The key or its organization is already registered, or credit and paid would share an organization (409). */
export class DuplicateAccountError extends AccountError {
  constructor(message: string) { super(message, 409); }
}
/** Anthropic's key test gave no organization id, so the organization rules cannot be checked (400). */
export class MissingOrgError extends AccountError {
  constructor() { super(t().noOrg, 400); }
}

function kindName(kind: Kind): string {
  return kind === 'credit' ? t().kindCredit : t().kindPaid;
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}

/**
 * One row per Anthropic organization: each organization has one credit balance,
 * so two rows for it would let the hub count the same money twice. A credit
 * account and a paid key must never share an organization either: the credit
 * organization must have no card, and the paid one is the one that pays.
 * The organization id from Anthropic's key test is required.
 */
export async function addAccount(db: Db, a: AccountInput, orgId: string | undefined): Promise<number> {
  if (!orgId?.trim()) throw new MissingOrgError();
  const key = a.apiKey.trim();
  const fingerprint = sha256(key);
  const dup = await db.query<{ id: number; label: string; kind: Kind; deleted: boolean }>(
    'select id, label, kind, deleted from accounts where key_fingerprint = $1 or org_id = $2 order by deleted, id', [fingerprint, orgId],
  );
  const live = dup.rows.find((r) => !r.deleted);
  if (live) {
    throw new DuplicateAccountError(live.kind !== a.kind ? t().creditPaidSameOrg(live.label, kindName(live.kind)) : t().dupOrg(live.label));
  }
  if (dup.rows.length > 1) throw new DuplicateAccountError(t().dupOrg(dup.rows[0].label));
  const revived = dup.rows[0];
  if (revived && revived.kind !== a.kind) throw new DuplicateAccountError(t().revivedOtherKind(kindName(revived.kind)));
  try {
    return await writeAccount(db, a, key, fingerprint, orgId, revived);
  } catch (e) {
    // Two registrations of the same organization at once: the unique index stops the second.
    if (isUniqueViolation(e)) throw new DuplicateAccountError(t().dupOrg(a.label.trim()));
    throw e;
  }
}

async function writeAccount(db: Db, a: AccountInput, key: string, fingerprint: string, orgId: string, revived?: { id: number }): Promise<number> {
  if (revived) {
    // A deleted account coming back keeps its id, so this cycle's spending still counts.
    await db.query(
      `update accounts set label = $2, kind = $3, api_key_enc = $4, key_hint = $5, monthly_credit_usd = $6, renewal_day = $7,
         safety_margin_usd = $8, priority = $9, key_fingerprint = $10, org_id = coalesce($11, org_id), deleted = false, enabled = true,
         cooldown_until = null, exhausted_cycle = null, last_error = null, last_error_at = null
       where id = $1`,
      [revived.id, a.label.trim(), a.kind, encrypt(key), keyHint(key), a.kind === 'credit' ? Number(a.monthlyCreditUsd) : 0,
        a.kind === 'credit' ? Number(a.renewalDay) : null, a.safetyMarginUsd ?? 3, a.priority ?? 0, fingerprint, orgId],
    );
    return Number(revived.id);
  }
  const { rows } = await db.query<{ id: number }>(
    `insert into accounts (label, kind, api_key_enc, key_hint, monthly_credit_usd, renewal_day, safety_margin_usd, priority, key_fingerprint, org_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [a.label.trim(), a.kind, encrypt(key), keyHint(key), a.kind === 'credit' ? Number(a.monthlyCreditUsd) : 0,
      a.kind === 'credit' ? Number(a.renewalDay) : null, a.safetyMarginUsd ?? 3, a.priority ?? 0, fingerprint, orgId],
  );
  return Number(rows[0].id);
}

export async function updateAccount(
  db: Db,
  id: number,
  patch: { enabled?: boolean; monthlyCreditUsd?: number; renewalDay?: number; safetyMarginUsd?: number; label?: string; clearState?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.enabled !== undefined) add('enabled', patch.enabled);
  if (patch.monthlyCreditUsd !== undefined) add('monthly_credit_usd', patch.monthlyCreditUsd);
  if (patch.renewalDay !== undefined) add('renewal_day', patch.renewalDay);
  if (patch.safetyMarginUsd !== undefined) add('safety_margin_usd', patch.safetyMarginUsd);
  if (patch.label !== undefined) add('label', patch.label);
  if (patch.clearState) sets.push('cooldown_until = null', 'exhausted_cycle = null', 'last_error = null', 'last_error_at = null');
  if (!sets.length) return;
  await db.query(`update accounts set ${sets.join(', ')} where id = $1`, params);
}

/**
 * Swaps an account's key for another key of the same organization (history stays on the same row).
 * The organization id from Anthropic's key test is required, and it may not belong to any other row.
 */
export async function replaceKey(db: Db, id: number, apiKey: string, orgId: string | undefined): Promise<void> {
  if (!orgId?.trim()) throw new MissingOrgError();
  const key = apiKey.trim();
  const fingerprint = sha256(key);
  const { rows } = await db.query<{ org_id: string | null }>('select org_id from accounts where id = $1 and not deleted', [id]);
  if (!rows[0]) throw new AccountError(t().noSuchAccount, 404);
  if (rows[0].org_id && rows[0].org_id !== orgId) throw new DuplicateAccountError(t().otherOrg);
  const other = await db.query<{ label: string; kind: Kind }>(
    'select label, kind from accounts where id <> $1 and (org_id = $2 or key_fingerprint = $3) order by deleted, id limit 1', [id, orgId, fingerprint],
  );
  if (other.rows[0]) throw new DuplicateAccountError(t().dupOrg(other.rows[0].label));
  try {
    await db.query(
      'update accounts set api_key_enc = $2, key_hint = $3, key_fingerprint = $4, org_id = coalesce(org_id, $5) where id = $1',
      [id, encrypt(key), keyHint(key), fingerprint, orgId],
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new DuplicateAccountError(t().dupOrg(''));
    throw e;
  }
}

/** Hides the account but keeps its row, so re-adding the same organization keeps its spending history. */
export async function deleteAccount(db: Db, id: number): Promise<void> {
  await db.query('update accounts set deleted = true, enabled = false where id = $1', [id]);
}

// ---- dashboard ----

export async function overview(db: Db, now = new Date()) {
  const accounts = await accountStates(db, now);
  const month = monthCycle(now);
  const { rows: byClient } = await db.query<{ name: string | null; pool: string; cost: number; requests: number }>(
    `select c.name, u.pool, coalesce(sum(u.cost_usd), 0) as cost, count(*)::int as requests
       from usage_log u left join clients c on c.id = u.client_id
      where u.at >= $1 group by c.name, u.pool order by cost desc`,
    [month.startsAt.toISOString()],
  );
  const { rows: recent } = await db.query<Record<string, unknown>>(
    `select u.at, c.name as client, a.label as account, u.pool, u.model, u.input_tokens, u.output_tokens, u.cost_usd, u.status, u.note
       from usage_log u left join clients c on c.id = u.client_id left join accounts a on a.id = u.account_id
      order by u.id desc limit 40`,
  );
  const { rows: clients } = await db.query<{ id: number; name: string; key_hint: string; enabled: boolean; paid_fallback: boolean }>(
    'select id, name, key_hint, enabled, paid_fallback from clients order by id',
  );
  return { accounts, month, byClient: byClient.map((r) => ({ ...r, cost: Number(r.cost) })), recent, clients };
}
