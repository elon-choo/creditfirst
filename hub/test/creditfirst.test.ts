import { describe, expect, it } from 'vitest';
import { alertNotifier, webhookNotifier } from '@/lib/alerts';
import { reserveUsd, shapeOf, unboundedReasons } from '@/lib/estimate';
import { hubLang, hubName, paidMonthlyCapUsd } from '@/lib/config';
import { healthReport } from '@/lib/health';
import { handleMessages } from '@/lib/proxy';
import { buildReport } from '@/lib/report';
import { newClientKey } from '@/lib/secrets';
import {
  accountStates, addAccount, createClient, deleteAccount, DuplicateAccountError, MissingOrgError, replaceKey, sweepStale, tryReservePaid,
} from '@/lib/store';
import { fakeAnthropic, hubRequest, KEY, memoryDb, okMessage, seed } from './helpers';

const NOW = new Date('2026-10-16T03:00:00Z');
const now = () => NOW;
const small = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
const TINY_CREDIT = { label: 'A', kind: 'credit' as const, key: KEY('a'), credit: 0.000001, day: 18 };
const PAID = { label: 'P', kind: 'paid' as const, key: KEY('p') };
const credit = (label: string, key: string) => ({ label, kind: 'credit' as const, apiKey: key, monthlyCreditUsd: 200, renewalDay: 5 });
const paid = (label: string, key: string) => ({ label, kind: 'paid' as const, apiKey: key });

describe('organization rules', () => {
  it('refuses to register a key without an organization id', async () => {
    const db = await memoryDb();
    await expect(addAccount(db, credit('A', KEY('a')), undefined)).rejects.toThrow(MissingOrgError);
    await expect(addAccount(db, credit('A', KEY('a')), '  ')).rejects.toThrow(MissingOrgError);
    const err = await addAccount(db, paid('P', KEY('p')), undefined).catch((e) => e);
    expect(err.status).toBe(400);
    expect(await accountStates(db, NOW)).toHaveLength(0);
  });

  it('refuses a paid key from a credit account organization, and the other way round (409)', async () => {
    const db = await memoryDb();
    await addAccount(db, credit('Max', KEY('c')), 'org-credit');
    const e1 = await addAccount(db, paid('Paid', KEY('p')), 'org-credit').catch((e) => e);
    expect(e1).toBeInstanceOf(DuplicateAccountError);
    expect(e1.status).toBe(409);
    expect(e1.message).toMatch(/different Anthropic organizations/);

    await addAccount(db, paid('Paid', KEY('p2')), 'org-paid');
    const e2 = await addAccount(db, credit('Max2', KEY('c2')), 'org-paid').catch((e) => e);
    expect(e2).toBeInstanceOf(DuplicateAccountError);
    expect(e2.message).toMatch(/different Anthropic organizations/);
  });

  it('does not let a deleted credit organization come back as a paid key', async () => {
    const db = await memoryDb();
    const id = await addAccount(db, credit('Max', KEY('c')), 'org-1');
    await deleteAccount(db, id);
    await expect(addAccount(db, paid('Paid', KEY('p')), 'org-1')).rejects.toThrow(DuplicateAccountError);
    // The same kind may come back (and keeps its history).
    expect(await addAccount(db, credit('Max again', KEY('c-new')), 'org-1')).toBe(id);
  });

  it('replaces a key only with a key of the same organization, never one registered elsewhere', async () => {
    const db = await memoryDb();
    const a = await addAccount(db, credit('A', KEY('a')), 'org-a');
    await addAccount(db, paid('P', KEY('p')), 'org-p');
    await expect(replaceKey(db, a, KEY('a2'), undefined)).rejects.toThrow(MissingOrgError);
    await expect(replaceKey(db, a, KEY('x'), 'org-p')).rejects.toThrow(DuplicateAccountError);
    await expect(replaceKey(db, a, KEY('p'), 'org-a')).rejects.toThrow(DuplicateAccountError);
    await replaceKey(db, a, KEY('a2'), 'org-a');
    expect((await accountStates(db, NOW)).find((s) => s.row.id === a)!.row.key_hint).toBe(`…${KEY('a2').slice(-4)}`);
  });
});

describe('paid monthly cap (HUB_PAID_MONTHLY_CAP_USD)', () => {
  it('reads the setting: unset = no cap, a bad value fails closed', () => {
    expect(paidMonthlyCapUsd({})).toBeUndefined();
    expect(paidMonthlyCapUsd({ HUB_PAID_MONTHLY_CAP_USD: '' })).toBeUndefined();
    expect(paidMonthlyCapUsd({ HUB_PAID_MONTHLY_CAP_USD: '50' })).toBe(50);
    expect(paidMonthlyCapUsd({ HUB_PAID_MONTHLY_CAP_USD: 'lots' })).toBe(0);
    expect(paidMonthlyCapUsd({ HUB_PAID_MONTHLY_CAP_USD: '-1' })).toBe(0);
  });

  it('answers 402 paid-cap-reached once this month\'s paid spend plus the worst case would pass the cap, and alerts once', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [TINY_CREDIT, PAID]);
    // $0.80 already spent on paid keys this month (UTC), $0.10 last month (not counted).
    await db.query("insert into usage_log (account_id, pool, cost_usd, status, at) values ($1, 'paid', 0.8, 200, '2026-10-02T00:00:00Z')", [ids[1]]);
    await db.query("insert into usage_log (account_id, pool, cost_usd, status, at) values ($1, 'paid', 5, 200, '2026-09-30T23:00:00Z')", [ids[1]]);
    const sent: string[] = [];
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const deps = { db, fetch: api.fetch, upstream: 'https://up', now, notify: async (t: string) => { sent.push(t); }, paidCapUsd: 1 };
    // A small request fits under $1.
    const ok = await handleMessages(hubRequest(clientKey, small), deps);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-hub-pool')).toBe('paid');
    // A request whose worst case is about $0.40 does not.
    const big = { model: 'claude-sonnet-5-5', max_tokens: 40_000, messages: [{ role: 'user', content: 'x' }] };
    api.calls.length = 0;
    const res = await handleMessages(hubRequest(clientKey, big), deps);
    expect(res.status).toBe(402);
    expect(res.headers.get('x-hub-error')).toBe('paid-cap-reached');
    expect((await res.json()).error.type).toBe('billing_error');
    expect(api.calls).toHaveLength(0);
    await handleMessages(hubRequest(clientKey, big), deps);
    const capAlerts = sent.filter((m) => m.includes('Paid monthly cap reached'));
    expect(capAlerts).toHaveLength(1);
    expect(capAlerts[0]).toContain('test-project');
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from usage_log where pool = 'none' and status = 402");
    expect(rows[0].n).toBe(2);
    expect((await accountStates(db, NOW)).every((s) => s.reserved === 0)).toBe(true);
  });

  it('keeps concurrent paid requests under the cap together', async () => {
    const db = await memoryDb();
    // Each request may cost up to about $0.20 and really costs $0.15; the cap is $1.
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const api = fakeAnthropic(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return okMessage({ input_tokens: 0, output_tokens: 15_000 });
    });
    const body = { model: 'claude-sonnet-5-5', max_tokens: 20_000, messages: [{ role: 'user', content: 'x' }] };
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      handleMessages(hubRequest(clientKey, body), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 1 })));
    const p = (await accountStates(db, NOW)).find((s) => s.row.kind === 'paid')!;
    expect(p.spent).toBeLessThanOrEqual(1);
    expect(p.reserved).toBe(0);
    expect(api.calls.length).toBeGreaterThanOrEqual(4);
    const refused = results.filter((r) => r.status === 402);
    expect(refused.length).toBe(12 - api.calls.length);
    expect(refused.every((r) => r.headers.get('x-hub-error') === 'paid-cap-reached')).toBe(true);
  });

  it('counts paid requests still in flight, and charges a never-recorded paid set-aside to the paid pool', async () => {
    const db = await memoryDb();
    const { ids } = await seed(db, [PAID]);
    const first = await tryReservePaid(db, ids[0], 0.6, 1, NOW);
    expect(first.ok).toBe(true);
    const second = await tryReservePaid(db, ids[0], 0.6, 1, NOW);
    expect(second).toMatchObject({ ok: false, reason: 'cap' });
    await db.query("update reservations set created_at = now() - interval '31 minutes'");
    await sweepStale(db);
    const { rows } = await db.query<{ pool: string; cost_usd: number }>("select pool, cost_usd from usage_log where request_key like 'sweep:%'");
    expect(rows).toEqual([{ pool: 'paid', cost_usd: 0.6 }]);
    expect(await tryReservePaid(db, ids[0], 0.6, 1, NOW)).toMatchObject({ ok: false, reason: 'cap' });
    expect((await tryReservePaid(db, ids[0], 0.3, 1, NOW)).ok).toBe(true);
  });

  it('names what the estimate cannot bound', () => {
    expect(unboundedReasons(small)).toEqual([]);
    expect(unboundedReasons({ ...small, tools: [{ name: 'lookup', input_schema: { type: 'object' } }, { type: 'bash_20250124', name: 'bash' }] })).toEqual([]);
    expect(unboundedReasons({ ...small, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] })).toEqual(['server tool web_fetch_20250910']);
    expect(unboundedReasons({ ...small, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] })).toEqual(['server tool web_search_20250305']);
    expect(unboundedReasons({ ...small, model: 'claude-future-9' })).toEqual(['unknown model claude-future-9']);
    expect(unboundedReasons({ ...small, fallbacks: 'default' })).toEqual(['fallback/advisor to default routing']);
    expect(unboundedReasons({ ...small, mcp_servers: [{ type: 'url', url: 'https://mcp.test' }] })).toEqual(['mcp_servers']);
    const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } };
    const byUrl = { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } };
    const text = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' } };
    expect(unboundedReasons({ ...small, messages: [{ role: 'user', content: [pdf, byUrl, text] }] })).toEqual(['PDF document', 'document by url']);
  });

  it('with a cap, refuses to send a request it cannot bound to the paid key (402 paid-cap-unbounded), streaming too', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const api = fakeAnthropic(() => okMessage({ input_tokens: 150_000, output_tokens: 10 }));
    const deps = { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 0.05 };
    for (const stream of [false, true]) {
      const body = { ...small, stream, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] };
      const res = await handleMessages(hubRequest(clientKey, body), deps);
      expect(res.status).toBe(402);
      expect(res.headers.get('x-hub-error')).toBe('paid-cap-unbounded');
      expect((await res.json()).error.message).toContain('web_fetch');
    }
    expect(api.calls).toHaveLength(0);
    // Without a cap the same request goes to the paid key, as before.
    const res = await handleMessages(hubRequest(clientKey, { ...small, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }), { ...deps, paidCapUsd: undefined });
    expect(res.headers.get('x-hub-pool')).toBe('paid');
  });

  it('with a cap, bounds the prompt by every request byte, so inflated tool schema property names cannot slip under it', async () => {
    // ~102,500 bytes of property names in a custom tool's input_schema, with tiny values.
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 2_050; i++) properties[`p${i}_${'k'.repeat(44)}`] = {};
    const tools = [{ name: 'inflated', description: 'x', input_schema: { type: 'object', properties } }];
    const body = { ...small, tools };
    const shape = shapeOf(body);
    expect(shape.inputTokens).toBeGreaterThan(30_000);
    expect(shape.strictInputTokens).toBeGreaterThan(102_500);
    // Sonnet 5.5: >102,500 prompt tokens at the $4/M 1-hour write rate is more than $0.41.
    expect(reserveUsd(shape, true)).toBeGreaterThan(0.41);

    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    // What Anthropic would bill for it: about $0.15 (sonnet 5.5, ~75k input tokens).
    const sse = (n: number) => [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":${n},"output_tokens":1}}}\n\n`,
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const api = fakeAnthropic((_k, b) => (b.stream
      ? new Response(new ReadableStream({ start(c) { for (const x of sse(75_000)) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : okMessage({ input_tokens: 75_000, output_tokens: 10 })));
    for (const stream of [false, true]) {
      const res = await handleMessages(hubRequest(clientKey, { ...body, stream }), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 0.05 });
      expect(res.status).toBe(402);
      expect(res.headers.get('x-hub-error')).toBe('paid-cap-reached');
    }
    expect(api.calls).toHaveLength(0);
    const paidSpent = async () => Number((await db.query<{ s: number }>("select coalesce(sum(cost_usd), 0) as s from usage_log where pool = 'paid'")).rows[0].s);
    expect(await paidSpent()).toBe(0);

    // With room under the cap, both are served, and what they really cost stays within what was set aside.
    for (const stream of [false, true]) {
      const res = await handleMessages(hubRequest(clientKey, { ...body, stream }), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 2 });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(api.calls).toHaveLength(2);
    expect(await paidSpent()).toBeLessThanOrEqual(2 * reserveUsd(shapeOf({ ...body, stream: true }), true));
    expect(await paidSpent()).toBeGreaterThan(0.3);
  });

  it('counts base64-shaped JSON outside attachment blocks verbatim (tool_use.input), under a cap, buffered and streaming', async () => {
    const blob = 'A'.repeat(102_400);
    const messages = [
      { role: 'user', content: 'look this up' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { type: 'base64', media_type: 'image/png', data: blob } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'ok' }] }] },
    ];
    const body = { ...small, tools: [{ name: 'lookup', input_schema: { type: 'object' } }], messages };
    const shape = shapeOf(body);
    expect(shape.inputTokens).toBeGreaterThan(30_000);
    expect(shape.strictInputTokens).toBeGreaterThan(102_400);
    expect(reserveUsd(shape, true)).toBeGreaterThan(0.4);
    // A real image attachment is still bounded per item, not by its base64 length, in both places it can appear.
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: blob } };
    const withImages = shapeOf({ ...small, messages: [
      { role: 'user', content: [img] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [img] }] },
    ] });
    expect(withImages.strictInputTokens).toBeLessThan(25_000);
    expect(withImages.inputTokens).toBeLessThan(8_000);

    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const api = fakeAnthropic((_k, b) => (b.stream
      ? new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":75000,"output_tokens":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        c.close();
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : okMessage({ input_tokens: 75_000, output_tokens: 10 })));
    for (const stream of [false, true]) {
      const res = await handleMessages(hubRequest(clientKey, { ...body, stream }), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 0.05 });
      expect(res.status).toBe(402);
      expect(res.headers.get('x-hub-error')).toBe('paid-cap-reached');
    }
    expect(api.calls).toHaveLength(0);
    const { rows } = await db.query<{ s: number }>("select coalesce(sum(cost_usd), 0) as s from usage_log where pool = 'paid'");
    expect(Number(rows[0].s)).toBe(0);
  });

  it('with a cap, still lets credit serve requests it cannot bound', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const res = await handleMessages(hubRequest(clientKey, { ...small, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] }), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 1 });
    expect(res.headers.get('x-hub-pool')).toBe('credit');
  });

  it('does not change credit routing or credit-only projects', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const api = fakeAnthropic(() => okMessage({ input_tokens: 1, output_tokens: 1 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 0 });
    expect(res.headers.get('x-hub-pool')).toBe('credit');
    const db2 = await memoryDb();
    await seed(db2, [TINY_CREDIT, PAID]);
    const { key } = await createClient(db2, 'credit-only', { paidFallback: false });
    const res2 = await handleMessages(hubRequest(key, small), { db: db2, fetch: api.fetch, upstream: 'https://up', now, paidCapUsd: 0 });
    expect(res2.status).toBe(402);
    expect(res2.headers.get('x-hub-error')).toBe('credit-unavailable');
  });
});

describe('alert destinations', () => {
  it('posts {text} JSON to HUB_ALERT_WEBHOOK_URL (https only)', async () => {
    expect(webhookNotifier({}, fetch)).toBeUndefined();
    expect(webhookNotifier({ HUB_ALERT_WEBHOOK_URL: 'http://insecure.test/hook' }, fetch)).toBeUndefined();
    const seen: Array<{ url: string; body: unknown; type: string | null }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)), type: new Headers(init.headers).get('content-type') });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await webhookNotifier({ HUB_ALERT_WEBHOOK_URL: 'https://hooks.test/abc' }, fake)!('hello');
    expect(seen).toEqual([{ url: 'https://hooks.test/abc', body: { text: 'hello' }, type: 'application/json; charset=utf-8' }]);
    const failing = webhookNotifier({ HUB_ALERT_WEBHOOK_URL: 'https://hooks.test/abc' }, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch)!;
    await expect(failing('x')).rejects.toThrow('webhook 500');
  });

  it('sends to Slack and the webhook together; delivered if either one took it', async () => {
    const urls: string[] = [];
    let slackUp = true;
    let hookUp = true;
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.includes('slack.com')) return Response.json(slackUp ? { ok: true } : { ok: false, error: 'down' });
      return new Response('', { status: hookUp ? 200 : 503 });
    }) as unknown as typeof fetch;
    const env = { SLACK_BOT_TOKEN: 'xoxb-t', HUB_ALERT_SLACK_CHANNEL: 'CHAN', HUB_ALERT_WEBHOOK_URL: 'https://hooks.test/x' };
    const notify = alertNotifier(env, fake)!;
    await notify('a');
    expect(urls.sort()).toEqual(['https://hooks.test/x', 'https://slack.com/api/chat.postMessage']);
    slackUp = false;
    await expect(notify('b')).resolves.toBeUndefined();
    hookUp = false;
    await expect(notify('c')).rejects.toThrow();
    expect(alertNotifier({}, fake)).toBeUndefined();
  });
});

describe('health', () => {
  it('reports setup state and account counts, with no secrets', async () => {
    const saved = { e: process.env.HUB_ENC_KEY, a: process.env.HUB_ADMIN_TOKEN };
    try {
      const db = await memoryDb();
      await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, { label: 'B', kind: 'credit', key: KEY('b'), credit: 100, day: 3 }, PAID]);
      process.env.HUB_ADMIN_TOKEN = 'short';
      let h = await healthReport(async () => db);
      expect(h).toEqual({ ok: false, db: true, encKey: true, adminToken: false, accounts: { credit: 2, paid: 1 } });
      process.env.HUB_ADMIN_TOKEN = 'a'.repeat(24);
      h = await healthReport(async () => db);
      expect(h.ok).toBe(true);
      expect(JSON.stringify(h)).not.toContain('a'.repeat(24));
      const down = await healthReport(async () => { throw new Error('postgres://user:pw@host/db unreachable'); });
      expect(down).toEqual({ ok: false, db: false, encKey: true, adminToken: true, accounts: { credit: 0, paid: 0 } });
      process.env.HUB_ENC_KEY = 'too-short';
      expect((await healthReport(async () => db)).encKey).toBe(false);
    } finally {
      process.env.HUB_ENC_KEY = saved.e;
      if (saved.a === undefined) delete process.env.HUB_ADMIN_TOKEN; else process.env.HUB_ADMIN_TOKEN = saved.a;
    }
  });
});

describe('generic install defaults', () => {
  it('uses cf_ project keys, CreditFirst name and English by default', async () => {
    expect(newClientKey()).toMatch(/^cf_[A-Za-z0-9_-]{40}$/);
    expect(hubName({})).toBe('CreditFirst');
    expect(hubName({ HUB_NAME: 'My Hub' })).toBe('My Hub');
    expect(hubLang({})).toBe('en');
    expect(hubLang({ HUB_LANG: 'ko' })).toBe('ko');
    expect(hubLang({ HUB_LANG: 'fr' })).toBe('en');
  });

  it('writes the daily report in English with the hub name and time zone', async () => {
    const saved = { l: process.env.HUB_LANG, n: process.env.HUB_NAME, z: process.env.HUB_TIMEZONE };
    try {
      delete process.env.HUB_LANG;
      process.env.HUB_NAME = 'Acme Hub';
      process.env.HUB_TIMEZONE = 'America/Los_Angeles';
      const db = await memoryDb();
      await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
      const text = await buildReport(db, NOW);
      expect(text).toContain('Acme Hub daily report');
      expect(text).toContain('America/Los_Angeles');
      // 2026-10-16 03:00 UTC is 10/15 20:00 in Los Angeles.
      expect(text).toContain('~ 10/15 20:00');
      expect(text).toContain('None ✅ (no request was served by a paid key)');
      expect(text).not.toMatch(/[가-힣]/);
    } finally {
      for (const [k, v] of [['HUB_LANG', saved.l], ['HUB_NAME', saved.n], ['HUB_TIMEZONE', saved.z]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
