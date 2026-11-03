/**
 * The Messages API pass-through.
 *
 * For each request: credit accounts whose credit expires soonest are tried
 * first, each only if the request's worst-case cost fits in what is left; when
 * no credit account can take it, the paid keys are used. Every reply is metered
 * from the usage the API reports.
 */

import { randomUUID } from 'node:crypto';
import { accountTroubleText, creditOnlyText, paidCapText, paidSwitchText, raise, stoppedText, switchReason, type Notify } from './alerts';
import { hubName, paidMonthlyCapUsd } from './config';
import type { Db } from './db';
import { reserveUsd, shapeOf, unboundedReasons, type RequestShape } from './estimate';
import { costOf, type Usage } from './pricing';
import { UsageTap } from './sse';
import {
  accountKey, accountStates, authClient, markCooldown, markLowBalance, release, routingOrder, settleWithRetry as settle,
  sweepStale, tryReserve, tryReservePaid, type AccountState,
} from './store';

export interface ProxyDeps {
  db: Db;
  fetch: typeof fetch;
  upstream: string;
  now?: () => Date;
  /** Sends an alert to the owner (Slack and/or webhook in production); absent in tests and local runs. */
  notify?: Notify;
  /** HUB_PAID_MONTHLY_CAP_USD; undefined = no cap. Production reads it from the environment. */
  paidCapUsd?: number;
  /** Runs alert work after the reply is finished (production); without it the work is awaited (tests). */
  defer?: (work: Promise<unknown>) => void;
}

const FORWARD_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta'];
const FORWARD_RESPONSE_HEADERS = /^(content-type|request-id|retry-after|anthropic-ratelimit-.*|x-should-retry)$/i;

/** Alert work must never hold up a reply: hand it to `deps.defer` when there is one, else wait for it. */
function fire(deps: ProxyDeps, work: Promise<unknown>): Promise<unknown> | undefined {
  work.catch(() => {});
  if (deps.defer) { deps.defer(work); return undefined; }
  return work;
}

export function hubError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-hub-error': '1' },
  });
}

export function clientKeyOf(req: Request): string | null {
  const x = req.headers.get('x-api-key');
  if (x) return x.trim();
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

function upstreamHeaders(req: Request, key: string): Headers {
  const h = new Headers({ 'content-type': 'application/json', 'x-api-key': key });
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  if (!h.has('anthropic-version')) h.set('anthropic-version', '2023-06-01');
  return h;
}

function responseHeaders(up: Response, pool: string, accountId: number): Headers {
  const h = new Headers();
  up.headers.forEach((v, k) => { if (FORWARD_RESPONSE_HEADERS.test(k)) h.set(k, v); });
  h.set('x-hub-pool', pool);
  h.set('x-hub-account', String(accountId));
  return h;
}

type Verdict =
  | { kind: 'ok' }
  | { kind: 'next'; lowBalance?: boolean; cooldownMin?: number; message: string }
  | { kind: 'client' };

/** What a failed upstream reply means for routing. */
function judge(status: number, bodyText: string): Verdict {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  let message = '';
  try { message = String(JSON.parse(bodyText)?.error?.message ?? ''); } catch { message = bodyText.slice(0, 200); }
  if (status === 400 && /credit balance/i.test(message)) return { kind: 'next', lowBalance: true, message };
  if (status === 401 || status === 403) return { kind: 'next', cooldownMin: 60, message: `${status} ${message}` };
  if (status === 429) return { kind: 'next', cooldownMin: 1, message: `429 ${message}` };
  if (status >= 500) return { kind: 'next', message: `${status} ${message}` };
  // Anything else (bad request, unknown model, too large) would fail the same way on every account.
  return { kind: 'client' };
}

interface Attempt {
  state: AccountState;
  pool: 'credit' | 'paid';
  reservationId?: number;
  cycleStart: string;
  /** The worst case set aside for this attempt (and charged when the outcome is uncertain). */
  estimate: number;
}

export async function handleMessages(req: Request, deps: ProxyDeps): Promise<Response> {
  const started = Date.now();
  const now = deps.now ?? (() => new Date());
  const client = await authClient(deps.db, clientKeyOf(req));
  if (!client) return hubError(401, 'authentication_error', `${hubName()} hub: unknown or disabled project key`);

  const raw = await req.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return hubError(400, 'invalid_request_error', 'Request body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return hubError(400, 'invalid_request_error', 'Request body must be a JSON object');

  const shape = shapeOf(body);
  const estimate = reserveUsd(shape);
  // Under a paid cap the paid key is charged against a hard bound (every request byte counted), not the guess.
  const strictEstimate = reserveUsd(shape, true);
  await sweepStale(deps.db);
  const states = await accountStates(deps.db, now());
  const order = routingOrder(states);
  const notes: string[] = [];
  const alertDeps = { db: deps.db, notify: deps.notify, now };
  let lastFailure: { status: number; text: string; headers: Headers } | null = null;
  const cap = deps.paidCapUsd;
  let capHit: { committedUsd: number } | null = null;
  // With a paid cap, the paid key only takes requests whose cost the estimate really bounds.
  const unbounded = cap !== undefined && client.paid_fallback ? unboundedReasons(body, shape) : [];
  let unboundedHit = false;

  const candidates: Array<() => Promise<Attempt | null>> = [
    ...order.credit.map((state) => async () => {
      const r = await tryReserve(deps.db, state.row.id, estimate, now());
      if (!r) { notes.push(`#${state.row.id} skip(fit)`); return null; }
      return { state, pool: 'credit' as const, reservationId: r.id, cycleStart: r.cycleStart, estimate };
    }),
    // Credit-only projects never reach a paid key; they get a 402 below and use their own paid route.
    ...(client.paid_fallback ? order.paid : []).map((state) => async (): Promise<Attempt | null> => {
      if (cap === undefined) return { state, pool: 'paid' as const, cycleStart: state.cycle.start, estimate };
      // The cap is for all paid keys together: once it is reached, no paid key is tried.
      if (capHit || unboundedHit) return null;
      if (unbounded.length) { unboundedHit = true; notes.push(`#${state.row.id} skip(paid-cap-unbounded)`); return null; }
      const r = await tryReservePaid(deps.db, state.row.id, strictEstimate, cap, now());
      if (r.ok) return { state, pool: 'paid' as const, reservationId: r.id, cycleStart: r.cycleStart, estimate: strictEstimate };
      if (r.reason === 'cap') { capHit = { committedUsd: r.committedUsd }; notes.push(`#${state.row.id} skip(paid-cap)`); }
      return null;
    }),
  ];

  for (const next of candidates) {
    const attempt = await next();
    if (!attempt) continue;
    const { state } = attempt;
    let up: Response;
    try {
      up = await deps.fetch(`${deps.upstream}/v1/messages`, {
        method: 'POST',
        headers: upstreamHeaders(req, accountKey(state.row)),
        body: raw,
        signal: req.signal,
      });
    } catch {
      // The request may have reached Anthropic and been billed: charge the full worst case, never refund on a guess.
      await settle(deps.db, {
        requestKey: randomUUID(), reservationId: attempt.reservationId, reservedUsd: attempt.estimate, clientId: client.id, accountId: state.row.id, pool: attempt.pool,
        cycleStart: attempt.cycleStart, model: shape.model, usage: {}, costUsd: attempt.estimate, status: 0, stream: shape.stream,
        durationMs: Date.now() - started, note: 'connection lost; charged worst case', at: now(),
      });
      if (req.signal.aborted) return hubError(499, 'api_error', 'Client closed the request');
      notes.push(`#${state.row.id} network`);
      continue;
    }

    if (up.ok) {
      const ctx: Settling = { attempt, shape, estimate: attempt.estimate, deps, clientId: client.id, clientName: client.name, states, started, notes };
      return shape.stream ? streamThrough(up, ctx) : bufferThrough(up, ctx);
    }

    const text = await up.text();
    const verdict = judge(up.status, text);
    if (attempt.reservationId) await release(deps.db, attempt.reservationId);
    if (verdict.kind === 'next') {
      notes.push(`#${state.row.id} ${up.status}`);
      if (verdict.lowBalance) {
        if (attempt.pool === 'credit') await markLowBalance(deps.db, state, verdict.message);
        else await markCooldown(deps.db, state.row.id, 2, verdict.message);
        const [kind, windowMin] = attempt.pool === 'credit' ? ['credit-empty' as const, 360] : ['paid-empty' as const, 60];
        await fire(deps, raise(alertDeps, `${kind}:${state.row.id}`, windowMin, async () => accountTroubleText(kind, state, verdict.message)));
      } else if (verdict.cooldownMin) {
        await markCooldown(deps.db, state.row.id, verdict.cooldownMin, verdict.message);
        if (up.status === 401 || up.status === 403) {
          await fire(deps, raise(alertDeps, `key-rejected:${state.row.id}`, 360, async () => accountTroubleText('key-rejected', state, verdict.message)));
        }
      }
      lastFailure = { status: up.status, text, headers: responseHeaders(up, attempt.pool, state.row.id) };
      continue;
    }
    // A request problem: hand Anthropic's answer back unchanged.
    await settle(deps.db, {
      requestKey: randomUUID(), clientId: client.id, accountId: state.row.id, pool: attempt.pool, cycleStart: attempt.cycleStart, model: shape.model,
      usage: {}, costUsd: 0, status: up.status, stream: shape.stream, durationMs: Date.now() - started, note: notes.join(' ') || undefined, at: now(),
    });
    return new Response(text, { status: up.status, headers: responseHeaders(up, attempt.pool, state.row.id) });
  }

  const capped = capHit as { committedUsd: number } | null;
  const refusedUnbounded = unboundedHit as boolean;
  await settle(deps.db, {
    requestKey: randomUUID(), clientId: client.id, accountId: null, pool: 'none', cycleStart: null, model: shape.model, usage: {}, costUsd: 0,
    status: client.paid_fallback && !capped && !refusedUnbounded ? lastFailure?.status ?? 503 : 402, stream: shape.stream, durationMs: Date.now() - started,
    note: notes.join(' ') || 'no accounts', at: now(),
  });
  if (refusedUnbounded) {
    const res = hubError(402, 'billing_error', `${hubName()} hub: no credit could take this request, and with HUB_PAID_MONTHLY_CAP_USD set the paid key only takes requests whose cost can be bounded. Not bounded here: ${unbounded.join(', ')}`);
    res.headers.set('x-hub-error', 'paid-cap-unbounded');
    res.headers.set('x-hub-pool', 'none');
    return res;
  }
  if (capped && cap !== undefined) {
    await fire(deps, raise(alertDeps, 'paid-cap', 60, async () => paidCapText(client.name, capped.committedUsd, cap)));
    // 402 billing_error, like a credit-only project: SDKs do not retry it.
    const res = hubError(402, 'billing_error', `${hubName()} hub: the paid monthly cap (HUB_PAID_MONTHLY_CAP_USD) would be exceeded by this request`);
    res.headers.set('x-hub-error', 'paid-cap-reached');
    res.headers.set('x-hub-pool', 'none');
    return res;
  }
  if (!client.paid_fallback) {
    await fire(deps, raise(alertDeps, `credit-only:${client.id}`, 30, async () => creditOnlyText(client.name, switchReason(states, notes))));
    // 402 billing_error: SDKs do not retry it, so the app can move straight to its own paid route.
    const res = hubError(402, 'billing_error', `${hubName()} hub: no credit available for this credit-only project`);
    res.headers.set('x-hub-error', 'credit-unavailable');
    res.headers.set('x-hub-pool', 'none');
    return res;
  }
  await fire(deps, raise(alertDeps, 'stopped', 10, async () => stoppedText(client.name, lastFailure?.status ?? 503, notes)));
  if (lastFailure) {
    lastFailure.headers.set('x-hub-error', 'all-accounts-failed');
    return new Response(lastFailure.text, { status: lastFailure.status, headers: lastFailure.headers });
  }
  return hubError(503, 'overloaded_error', `${hubName()} hub: no account can take this request right now`);
}

interface Settling {
  attempt: Attempt;
  shape: RequestShape;
  estimate: number;
  deps: ProxyDeps;
  clientId: number;
  clientName: string;
  states: AccountState[];
  started: number;
  notes: string[];
}

/** Records a finished reply; when its totals are missing or unreadable, the full worst case is charged. */
async function record(c: Settling, status: number, usage: Usage, servedModel: string | undefined, certain: boolean, stream: boolean, note?: string) {
  const metered = costOf(usage, { model: c.shape.model, servedModel, fast: c.shape.fast, usOnly: c.shape.usOnly });
  const costUsd = certain ? metered : Math.max(metered, c.estimate);
  const now = c.deps.now ?? (() => new Date());
  await settle(c.deps.db, {
    requestKey: randomUUID(), reservationId: c.attempt.reservationId, reservedUsd: c.estimate, clientId: c.clientId, accountId: c.attempt.state.row.id,
    pool: c.attempt.pool, cycleStart: c.attempt.cycleStart, model: servedModel || c.shape.model, usage,
    costUsd,
    status, stream, durationMs: Date.now() - c.started,
    note: [...c.notes, note, certain ? undefined : 'incomplete; charged worst case'].filter(Boolean).join(' ') || undefined,
    at: now(),
  });
  // A paid key served this request: real money. Tell the owner (once per project per 30 minutes).
  if (c.attempt.pool === 'paid' && status >= 200 && status < 300) {
    const row = c.attempt.state.row;
    await fire(c.deps, raise({ db: c.deps.db, notify: c.deps.notify, now }, `paid-switch:${c.clientId}`, 30, (since) => paidSwitchText(c.deps.db, {
      client: c.clientName, clientId: c.clientId, accountId: row.id, accountLabel: row.label, model: servedModel || c.shape.model || '(model not shown)', costUsd,
      reason: switchReason(c.states, c.notes),
    }, since)));
  }
}

async function bufferThrough(up: Response, c: Settling): Promise<Response> {
  const text = await up.text();
  let parsed: { usage?: Usage; model?: string } | undefined;
  try { parsed = JSON.parse(text); } catch { /* unreadable: charged worst case */ }
  await record(c, up.status, parsed?.usage ?? {}, parsed?.model, !!parsed?.usage, false);
  return new Response(text, { status: up.status, headers: responseHeaders(up, c.attempt.pool, c.attempt.state.row.id) });
}

function streamThrough(up: Response, c: Settling): Response {
  const { attempt } = c;
  const tap = new UsageTap();
  const reader = up.body!.getReader();
  let settled = false;
  const finish = async (note?: string) => {
    if (settled) return;
    settled = true;
    await record(c, up.status, tap.finalUsage(), tap.model, tap.complete, true, note)
      .catch((e) => console.error('settle failed', e));
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          controller.close();
          return;
        }
        tap.push(value);
        controller.enqueue(value);
      } catch (e) {
        await finish('upstream-stream-error');
        controller.error(e);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      await finish('client-cancelled');
    },
  });
  return new Response(body, { status: up.status, headers: responseHeaders(up, attempt.pool, attempt.state.row.id) });
}

/** count_tokens and models: free endpoints, sent through the first account that answers. */
export async function handleFree(req: Request, path: string, deps: ProxyDeps): Promise<Response> {
  const client = await authClient(deps.db, clientKeyOf(req));
  if (!client) return hubError(401, 'authentication_error', `${hubName()} hub: unknown or disabled project key`);
  const raw = req.method === 'GET' ? undefined : await req.text();
  const order = routingOrder(await accountStates(deps.db, (deps.now ?? (() => new Date()))()));
  let last: Response | null = null;
  // Credit-only projects never reach a paid key, not even for the free endpoints.
  for (const state of [...order.credit, ...(client.paid_fallback ? order.paid : [])]) {
    try {
      const up = await deps.fetch(`${deps.upstream}${path}`, { method: req.method, headers: upstreamHeaders(req, accountKey(state.row)), body: raw });
      const text = await up.text();
      const res = new Response(text, { status: up.status, headers: responseHeaders(up, state.row.kind, state.row.id) });
      if (judge(up.status, text).kind !== 'next') return res;
      last = res;
    } catch { /* try the next account */ }
  }
  if (!last && !client.paid_fallback) {
    const res = hubError(402, 'billing_error', `${hubName()} hub: no credit available for this credit-only project`);
    res.headers.set('x-hub-error', 'credit-unavailable');
    res.headers.set('x-hub-pool', 'none');
    return res;
  }
  return last ?? hubError(503, 'overloaded_error', `${hubName()} hub: no account available`);
}
