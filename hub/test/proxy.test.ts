import { describe, expect, it } from 'vitest';
import { handleFree, handleMessages } from '@/lib/proxy';
import { accountStates, addAccount, deleteAccount, DuplicateAccountError, settle, sweepStale, tryReserve } from '@/lib/store';
import { fakeAnthropic, hubRequest, KEY, lowBalance, memoryDb, okMessage, seed } from './helpers';

// 2026-10-16 03:00 UTC (the hub's default time zone).
const NOW = new Date('2026-10-16T03:00:00Z');
const now = () => NOW;
const small = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

describe('routing', () => {
  it('uses the credit account whose credit expires soonest first', async () => {
    const db = await memoryDb();
    // A renews on the 25th (expires in 9 days), B on the 18th (2 days), C is the paid key.
    const { clientKey } = await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 25 },
      { label: 'B', kind: 'credit', key: KEY('b'), credit: 200, day: 18 },
      { label: 'C', kind: 'paid', key: KEY('c') },
    ]);
    const api = fakeAnthropic(() => okMessage({ input_tokens: 10, output_tokens: 10 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(200);
    expect(api.calls.map((c) => c.key)).toEqual([KEY('b')]);
    expect(res.headers.get('x-hub-pool')).toBe('credit');
  });

  it('moves on when Anthropic reports the credit is gone, then uses the paid key last', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [
      { label: 'B', kind: 'credit', key: KEY('b'), credit: 200, day: 18 },
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 25 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const api = fakeAnthropic((key) => (key === KEY('p') ? okMessage({ input_tokens: 5, output_tokens: 5 }) : lowBalance()));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(200);
    expect(api.calls.map((c) => c.key)).toEqual([KEY('b'), KEY('a'), KEY('p')]);
    expect(res.headers.get('x-hub-pool')).toBe('paid');
    // Anthropic is the authority: both are shown as used up until their pause ends.
    const states = await accountStates(db, NOW);
    expect(states.find((s) => s.row.id === ids[0])!.status).toBe('exhausted');
    // The next request goes straight to the paid key.
    api.calls.length = 0;
    await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(api.calls.map((c) => c.key)).toEqual([KEY('p')]);
  });

  it('never sends a request whose worst-case cost does not fit in what is left', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [
      { label: 'tiny', kind: 'credit', key: KEY('t'), credit: 0.5, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const api = fakeAnthropic(() => okMessage({ input_tokens: 10, output_tokens: 10 }));
    // Opus 5.5 with 64k output tokens can cost about $1.28, more than the $0.50 left.
    const big = { model: 'claude-opus-5-5', max_tokens: 64_000, messages: [{ role: 'user', content: 'write' }] };
    await handleMessages(hubRequest(clientKey, big), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(api.calls.map((c) => c.key)).toEqual([KEY('p')]);
    // A small request still fits, so the leftover credit gets used.
    api.calls.length = 0;
    await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(api.calls.map((c) => c.key)).toEqual([KEY('t')]);
  });

  it('keeps concurrent requests under the cap together', async () => {
    const db = await memoryDb();
    // Each request may cost up to $0.20 (20k Sonnet 5.5 output tokens at $10/M) and really costs $0.15.
    const { clientKey } = await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 1.0, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const api = fakeAnthropic(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return okMessage({ input_tokens: 0, output_tokens: 15_000 });
    });
    const body = { model: 'claude-sonnet-5-5', max_tokens: 20_000, messages: [{ role: 'user', content: 'x' }] };
    await Promise.all(Array.from({ length: 12 }, () => handleMessages(hubRequest(clientKey, body), { db, fetch: api.fetch, upstream: 'https://up', now })));
    const onCredit = api.calls.filter((c) => c.key === KEY('a')).length;
    const states = await accountStates(db, NOW);
    const a = states.find((s) => s.row.label === 'A')!;
    expect(a.spent).toBeLessThanOrEqual(1.0);
    expect(a.reserved).toBe(0);
    expect(onCredit).toBeGreaterThanOrEqual(4);
    expect(api.calls.length).toBe(12);
  });

  it('returns request errors unchanged without trying other accounts', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const api = fakeAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } }), { status: 400 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('max_tokens');
    expect(api.calls.length).toBe(1);
  });

  it('re-checks a used-up account after its pause and resets at the next cycle', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 1, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    let empty = true;
    const api = fakeAnthropic((key) => (key === KEY('a') && empty ? lowBalance() : okMessage({ input_tokens: 1, output_tokens: 1 })));
    await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    const state = async (at: Date) => (await accountStates(db, at)).find((s) => s.row.id === ids[0])!;
    expect((await state(NOW)).status).toBe('exhausted');
    // Simulate the 30-minute pause ending before the test clock (NOW).
    await db.query("update accounts set cooldown_until = '2026-10-16T02:59:00Z' where id = $1", [ids[0]]);
    expect((await state(NOW)).status).toBe('ready');
    empty = false;
    api.calls.length = 0;
    await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(api.calls.map((c) => c.key)).toEqual([KEY('a')]);
    // Spending is counted per cycle; on the 18th it starts from zero.
    expect((await state(new Date('2026-10-18T01:00:00Z'))).spent).toBe(0);
  });

  it('charges the worst case when the connection drops after sending', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const api = fakeAnthropic((key) => { if (key === KEY('a')) throw new TypeError('socket hang up'); return okMessage({ input_tokens: 1, output_tokens: 1 }); });
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(200);
    const a = (await accountStates(db, NOW)).find((s) => s.row.id === ids[0])!;
    expect(a.spent).toBeGreaterThan(0.004);
    expect(a.reserved).toBe(0);
  });

  it('charges a never-recorded set-aside in full, and later records only the difference', async () => {
    const db = await memoryDb();
    const { ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 10, day: 18 }]);
    const r = (await tryReserve(db, ids[0], 2, NOW))!;
    await db.query("update reservations set created_at = now() - interval '31 minutes' where id = $1", [r.id]);
    await sweepStale(db);
    let a = (await accountStates(db, NOW))[0];
    expect([a.spent, a.reserved]).toEqual([2, 0]);
    // The request did finish after all and cost $0.50: the record brings the total to $0.50.
    await settle(db, { requestKey: 'late-1', reservationId: r.id, reservedUsd: 2, clientId: null, accountId: ids[0], pool: 'credit', cycleStart: r.cycleStart, usage: {}, costUsd: 0.5, status: 200, stream: false, durationMs: 1 });
    a = (await accountStates(db, NOW))[0];
    expect(a.spent).toBeCloseTo(0.5, 9);
  });

  it('corrects a swept charge in its own cycle when the request is recorded after the renewal', async () => {
    const db = await memoryDb();
    const { ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 10, day: 18 }]);
    const r = (await tryReserve(db, ids[0], 2, NOW))!;
    await db.query("update reservations set created_at = now() - interval '31 minutes' where id = $1", [r.id]);
    await sweepStale(db);
    const swept = await db.query<{ id: number }>('select id from usage_log where request_key = $1', [`sweep:${r.id}`]);
    expect(swept.rows).toHaveLength(1);
    // The sweep happened before the 18th (UTC); pin its time there, then record after the renewal.
    await db.query("update usage_log set at = '2026-10-17T14:40:00Z' where request_key = $1", [`sweep:${r.id}`]);
    await settle(db, { requestKey: 'after', reservationId: r.id, reservedUsd: 2, clientId: null, accountId: ids[0], pool: 'credit', cycleStart: r.cycleStart, usage: {}, costUsd: 0.5, status: 200, stream: false, durationMs: 1 });
    const newCycle = (await accountStates(db, new Date('2026-10-18T01:00:00Z')))[0];
    expect(newCycle.spent).toBe(0);
    expect(newCycle.usable).toBeLessThanOrEqual(10);
    const oldCycle = (await accountStates(db, new Date('2026-10-17T14:50:00Z')))[0];
    expect(oldCycle.spent).toBeCloseTo(0.5, 9);
    const row = await db.query<{ at: Date; cost_usd: number }>('select at, cost_usd from usage_log where request_key = $1', [`sweep:${r.id}`]);
    expect(new Date(row.rows[0].at).toISOString()).toBe('2026-10-17T14:40:00.000Z');
    expect(Number(row.rows[0].cost_usd)).toBe(0.5);
    expect((await db.query('select 1 from usage_log where request_key = $1', ['after'])).rows).toHaveLength(0);
  });

  it('records a retried write once, even when the first try committed', async () => {
    const db = await memoryDb();
    const { ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 10, day: 18 }]);
    const r = (await tryReserve(db, ids[0], 2, NOW))!;
    const write = { requestKey: 'req-1', reservationId: r.id, reservedUsd: 2, clientId: null, accountId: ids[0], pool: 'credit' as const, cycleStart: r.cycleStart, usage: {}, costUsd: 0.5, status: 200, stream: false, durationMs: 1 };
    await settle(db, write);
    await settle(db, write); // the acknowledgement was lost and the write is retried
    const a = (await accountStates(db, NOW))[0];
    expect([a.spent, a.reserved]).toEqual([0.5, 0]);
  });

  it('keeps spending history when an account is deleted and added again', async () => {
    const db = await memoryDb();
    const id = await addAccount(db, { label: 'A', kind: 'credit', apiKey: KEY('a'), monthlyCreditUsd: 10, renewalDay: 18 }, 'org-1');
    const r = (await tryReserve(db, id, 1, NOW))!;
    await settle(db, { requestKey: 'k', reservationId: r.id, reservedUsd: 1, clientId: null, accountId: id, pool: 'credit', cycleStart: r.cycleStart, usage: {}, costUsd: 3, status: 200, stream: false, durationMs: 1 });
    await deleteAccount(db, id);
    expect(await accountStates(db, NOW)).toHaveLength(0);
    const again = await addAccount(db, { label: 'A again', kind: 'credit', apiKey: KEY('a-new'), monthlyCreditUsd: 10, renewalDay: 18 }, 'org-1');
    expect(again).toBe(id);
    expect((await accountStates(db, NOW))[0].spent).toBe(3);
  });

  it('keeps this cycle\'s spending when the billing day is edited', async () => {
    const db = await memoryDb();
    const { ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 10, day: 18 }]);
    await db.query("insert into usage_log (account_id, pool, cycle_start, cost_usd, status, at) values ($1, 'credit', '2026-09-18', 1, 200, '2026-10-16T01:00:00Z')", [ids[0]]);
    await db.query('update accounts set renewal_day = 19 where id = $1', [ids[0]]);
    expect((await accountStates(db, NOW))[0].spent).toBe(1);
  });

  it('refuses a second key for an organization already registered', async () => {
    const db = await memoryDb();
    await addAccount(db, { label: 'A', kind: 'credit', apiKey: KEY('a'), monthlyCreditUsd: 200, renewalDay: 5 }, 'org-1');
    await expect(addAccount(db, { label: 'A2', kind: 'credit', apiKey: KEY('a2'), monthlyCreditUsd: 200, renewalDay: 5 }, 'org-1')).rejects.toThrow(DuplicateAccountError);
    await expect(addAccount(db, { label: 'A3', kind: 'credit', apiKey: KEY('a'), monthlyCreditUsd: 200, renewalDay: 5 }, 'org-2')).rejects.toThrow(DuplicateAccountError);
  });

  it('rejects unknown project keys before touching any account', async () => {
    const db = await memoryDb();
    await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }]);
    const api = fakeAnthropic(() => okMessage({}));
    const res = await handleMessages(hubRequest('cf_wrong', small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(401);
    expect(api.calls.length).toBe(0);
  });
});

describe('streaming', () => {
  it('passes the stream through unchanged and records its usage', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }]);
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"안녕"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const api = fakeAnthropic(() => new Response(new ReadableStream({
      start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const res = await handleMessages(hubRequest(clientKey, { ...small, stream: true }), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(await res.text()).toBe(sse.join(''));
    const a = (await accountStates(db, NOW)).find((s) => s.row.id === ids[0])!;
    // Sonnet 5.5: 1000 × $2/M + 500 × $10/M = $0.007.
    expect(a.spent).toBeCloseTo(0.007, 9);
    expect(a.reserved).toBe(0);
  });

  it('charges the worst case when the stream stops before message_stop', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }]);
    const api = fakeAnthropic(() => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'));
        c.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const body = { ...small, max_tokens: 5000, stream: true };
    const res = await handleMessages(hubRequest(clientKey, body), { db, fetch: api.fetch, upstream: 'https://up', now });
    await res.text();
    const a = (await accountStates(db, NOW)).find((s) => s.row.id === ids[0])!;
    // At least the 5,000 allowed output tokens on Sonnet 5.5 ($0.05).
    expect(a.spent).toBeGreaterThanOrEqual(0.05);
  });
});

describe('free endpoints', () => {
  it('forwards count_tokens without recording cost', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [{ label: 'P', kind: 'paid', key: KEY('p') }]);
    const api = fakeAnthropic(() => Response.json({ input_tokens: 12 }));
    const req = new Request('https://hub.test/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': clientKey }, body: JSON.stringify(small) });
    const res = await handleFree(req, '/v1/messages/count_tokens', { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(await res.json()).toEqual({ input_tokens: 12 });
  });
});

describe('credit-only projects', () => {
  it('answers 402 credit-unavailable instead of using a paid key', async () => {
    const db = await memoryDb();
    await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const { createClient } = await import('@/lib/store');
    const { key } = await createClient(db, 'credit-only-app', { paidFallback: false });
    const api = fakeAnthropic((k) => (k === KEY('a') ? lowBalance() : okMessage({ input_tokens: 1, output_tokens: 1 })));
    const res = await handleMessages(hubRequest(key, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-hub-error')).toBe('credit-unavailable');
    expect((await res.json()).error.type).toBe('billing_error');
    expect(api.calls.map((c) => c.key)).toEqual([KEY('a')]);
  });

  it('still uses credit when it is there', async () => {
    const db = await memoryDb();
    await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const { createClient } = await import('@/lib/store');
    const { key } = await createClient(db, 'cs-bot', { paidFallback: false });
    const api = fakeAnthropic(() => okMessage({ input_tokens: 1, output_tokens: 1 }));
    const res = await handleMessages(hubRequest(key, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-hub-pool')).toBe('credit');
  });

  it('answers 402 when no credit account fits, without trying paid keys', async () => {
    const db = await memoryDb();
    await seed(db, [
      { label: 'A', kind: 'credit', key: KEY('a'), credit: 0.000001, day: 18 },
      { label: 'P', kind: 'paid', key: KEY('p') },
    ]);
    const { createClient } = await import('@/lib/store');
    const { key } = await createClient(db, 'x', { paidFallback: false });
    const api = fakeAnthropic(() => okMessage({ input_tokens: 1, output_tokens: 1 }));
    const res = await handleMessages(hubRequest(key, small), { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(402);
    expect(api.calls).toHaveLength(0);
  });

  it('sends count_tokens to credit accounts only, and answers 402 when none can', async () => {
    const db = await memoryDb();
    await seed(db, [{ label: 'P', kind: 'paid', key: KEY('p') }]);
    const { createClient } = await import('@/lib/store');
    const { key } = await createClient(db, 'creditonly-free', { paidFallback: false });
    const api = fakeAnthropic(() => Response.json({ input_tokens: 12 }));
    const req = new Request('https://hub.test/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': key }, body: JSON.stringify(small) });
    const res = await handleFree(req, '/v1/messages/count_tokens', { db, fetch: api.fetch, upstream: 'https://up', now });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-hub-error')).toBe('credit-unavailable');
    expect(api.calls).toHaveLength(0);
  });
});
