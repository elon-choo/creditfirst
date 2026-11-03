import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { esc, raise, raiseResult, slackNotifier } from '@/lib/alerts';
import type { Db } from '@/lib/db';
import { handleMessages } from '@/lib/proxy';
import { buildReport } from '@/lib/report';
import { createClient } from '@/lib/store';
import { fakeAnthropic, hubRequest, KEY, lowBalance, memoryDb, okMessage, seed } from './helpers';

// 2026-10-16 03:00 UTC.
const NOW = new Date('2026-10-16T03:00:00Z');
const small = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
const MIN = 60_000;

// These tests check the Korean wording (HUB_LANG=ko); test/creditfirst.test.ts checks English.
const savedLang = process.env.HUB_LANG;
beforeAll(() => { process.env.HUB_LANG = 'ko'; });
afterAll(() => { if (savedLang === undefined) delete process.env.HUB_LANG; else process.env.HUB_LANG = savedLang; });

function inbox() {
  const sent: string[] = [];
  return { sent, notify: async (text: string) => { sent.push(text); } };
}

/** A credit account too small for any request, so every request goes to the paid key. */
const TINY_CREDIT = { label: 'A', kind: 'credit' as const, key: KEY('a'), credit: 0.000001, day: 18 };
const PAID = { label: 'P', kind: 'paid' as const, key: KEY('p') };

describe('alerts to the owner', () => {
  it('tells the owner when a paid key serves a request, once per 30 minutes, then summarises what happened in between', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const { sent, notify } = inbox();
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    let t = NOW;
    const deps = { db, fetch: api.fetch, upstream: 'https://up', now: () => t, notify };

    expect((await handleMessages(hubRequest(clientKey, small), deps)).headers.get('x-hub-pool')).toBe('paid');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('API 유료 전환');
    expect(sent[0]).toContain('test-project');
    expect(sent[0]).toContain('남은 크레딧이 이 요청의 최대 비용보다 적음');

    t = new Date(NOW.getTime() + 5 * MIN);
    await handleMessages(hubRequest(clientKey, small), deps);
    expect(sent).toHaveLength(1);

    t = new Date(NOW.getTime() + 35 * MIN);
    await handleMessages(hubRequest(clientKey, small), deps);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('지난 알림');
    expect(sent[1]).toContain('2건');
  });

  it('stays quiet while credit serves the requests', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const { sent, notify } = inbox();
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify });
    expect(res.headers.get('x-hub-pool')).toBe('credit');
    expect(sent).toHaveLength(0);
  });

  it('tells the owner when a credit-only project is turned away, once per window', async () => {
    const db = await memoryDb();
    await seed(db, [TINY_CREDIT, PAID]);
    const { key } = await createClient(db, 'cs-bot', { paidFallback: false });
    const { sent, notify } = inbox();
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const deps = { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify };
    expect((await handleMessages(hubRequest(key, small), deps)).status).toBe(402);
    expect((await handleMessages(hubRequest(key, small), deps)).status).toBe(402);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('크레딧 전용 프로젝트');
    expect(sent[0]).toContain('cs-bot');
    expect(api.calls).toHaveLength(0);
  });

  it('tells the owner when no account can serve a request', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const { sent, notify } = inbox();
    const api = fakeAnthropic(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), { status: 500 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify });
    expect(res.status).toBe(500);
    expect(sent.some((m) => m.includes('허브가 요청을 처리하지 못했어요') && m.includes('HTTP 500'))).toBe(true);
  });

  it('tells the owner when the paid key has no balance, and when a credit account is rejected', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const { sent, notify } = inbox();
    const api = fakeAnthropic((key) => (key === KEY('a') ? new Response(JSON.stringify({ type: 'error', error: { message: 'invalid x-api-key' } }), { status: 401 }) : lowBalance()));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify });
    expect(res.status).toBe(400);
    expect(sent.some((m) => m.includes(`#${ids[0]}(A)`) && m.includes('키가 거절됐어요'))).toBe(true);
    expect(sent.some((m) => m.includes('유료 키') && m.includes('잔액이 없어요'))).toBe(true);
  });

  it('tells the owner when Anthropic calls a credit account empty although the hub still counted credit', async () => {
    const db = await memoryDb();
    const { clientKey, ids } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const { sent, notify } = inbox();
    const api = fakeAnthropic((key) => (key === KEY('a') ? lowBalance() : okMessage({ input_tokens: 1, output_tokens: 1 })));
    await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify });
    expect(sent.some((m) => m.includes(`#${ids[0]}(A)`) && m.includes('잔액 부족'))).toBe(true);
  });

  it('never breaks a request when Slack is down, and tries again on the next event', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const sent: string[] = [];
    let calls = 0;
    const notify = async (text: string) => { calls += 1; if (calls === 1) throw new Error('slack down'); sent.push(text); };
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const deps = { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify };
    expect((await handleMessages(hubRequest(clientKey, small), deps)).status).toBe(200);
    expect(sent).toHaveLength(0);
    const state = await db.query<{ last_ok: boolean; last_error: string }>("select last_ok, last_error from alert_state where key like 'paid-switch:%'");
    expect(state.rows[0].last_ok).toBe(false);
    expect(state.rows[0].last_error).toContain('slack down');
    expect((await handleMessages(hubRequest(clientKey, small), deps)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('posts to the configured Slack channel with the bot token, and is off without settings', async () => {
    expect(slackNotifier({}, fetch)).toBeUndefined();
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const notify = slackNotifier({ SLACK_BOT_TOKEN: 'xoxb-test', HUB_ALERT_SLACK_CHANNEL: 'D123' }, fake)!;
    await notify('hello');
    expect(seen[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(seen[0].auth).toBe('Bearer xoxb-test');
    expect(seen[0].body).toMatchObject({ channel: 'D123', text: 'hello' });
    const bad = slackNotifier({ SLACK_BOT_TOKEN: 'x', HUB_ALERT_SLACK_CHANNEL: 'D1' }, (async () => Response.json({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch)!;
    await expect(bad('hi')).rejects.toThrow('channel_not_found');
  });
});

describe('alert delivery', () => {
  it('does not hold up the reply: with a defer hook the reply returns while Slack is still busy', async () => {
    const db = await memoryDb();
    const { clientKey } = await seed(db, [TINY_CREDIT, PAID]);
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const notify = async (text: string) => { await gate; sent.push(text); };
    const pending: Promise<unknown>[] = [];
    const api = fakeAnthropic(() => okMessage({ input_tokens: 5, output_tokens: 5 }));
    const res = await handleMessages(hubRequest(clientKey, small), { db, fetch: api.fetch, upstream: 'https://up', now: () => NOW, notify, defer: (w) => { pending.push(w); } });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(pending).toHaveLength(1);
    release();
    await Promise.allSettled(pending);
    expect(sent).toHaveLength(1);
  });

  it('a send that is still on its way blocks duplicates but is not remembered as done, so a failure can be retried', async () => {
    const db = await memoryDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const failing = async () => { await gate; throw new Error('slack down'); };
    const working = async (text: string) => { sent.push(text); };
    const first = raise({ db, notify: failing, now: () => NOW }, 'k', 30, async () => 'first');
    for (let i = 0; i < 100; i++) {
      const r = await db.query<{ last_sent: Date | null }>("select last_sent from alert_state where key = 'k'");
      if (r.rows[0]?.last_sent) break;
      await new Promise((r2) => setTimeout(r2, 10));
    }
    expect(await raise({ db, notify: working, now: () => NOW }, 'k', 30, async () => 'during')).toBe(false);
    release();
    expect(await first).toBe(false);
    expect(await raise({ db, notify: working, now: () => NOW }, 'k', 30, async () => 'retry')).toBe(true);
    expect(sent).toEqual(['retry']);
  });

  it('never sends a delivered alert twice, even when recording the delivery fails', async () => {
    const db = await memoryDb();
    const flaky: Db = { query: (t, p) => (/last_ok = true/.test(t) ? Promise.reject(new Error('db blip')) : db.query(t, p)), tx: (fn) => db.tx(fn) };
    const sent: string[] = [];
    const notify = async (text: string) => { sent.push(text); };
    expect(await raise({ db: flaky, notify, now: () => NOW }, 'k', 30, async () => 'one')).toBe(true);
    expect(await raise({ db: flaky, notify, now: () => NOW }, 'k', 30, async () => 'two')).toBe(false);
    expect(sent).toEqual(['one']);
  });

  it('stops waiting on a claim whose process died', async () => {
    const db = await memoryDb();
    await db.query("insert into alert_state (key, last_sent, last_ok) values ('k', $1, null)", [new Date(NOW.getTime() - 3 * MIN).toISOString()]);
    const sent: string[] = [];
    expect(await raise({ db, notify: async (t) => { sent.push(t); }, now: () => NOW }, 'k', 30, async () => 'late')).toBe(true);
    expect(sent).toEqual(['late']);
  });

  it('cuts anything shaped like a key or token short before it reaches Slack, and escapes markup', () => {
    const text = esc('bad key sk-ant-api03-ABCDEFGHIJKLMNOP and cf_abcdefghijklmnopqrst and xoxb-123-456-secret <b>&');
    expect(text).not.toContain('ABCDEFGHIJKLMNOP');
    expect(text).not.toContain('abcdefghijklmnopqrst');
    expect(text).not.toContain('123-456-secret');
    expect(text).toContain('&lt;b&gt;&amp;');
    const glued = esc('_sk-ant-api03-ZZZZZZZZZZZZZZ x_cf_QQQQQQQQQQQQQQQQ y_xoxb-9-8-7secret');
    expect(glued).not.toContain('ZZZZZZZZZZZZZZ');
    expect(glued).not.toContain('QQQQQQQQQQQQQQQQ');
    expect(glued).not.toContain('9-8-7secret');
  });

  it('after a takeover of an unfinished claim fails, the window is not treated as delivered', async () => {
    const db = await memoryDb();
    await db.query("insert into alert_state (key, last_sent, last_ok) values ('k', $1, null)", [new Date(NOW.getTime() - 3 * MIN).toISOString()]);
    const failing = async () => { throw new Error('slack down'); };
    expect(await raiseResult({ db, notify: failing, now: () => NOW }, 'k', 360, async () => 'x')).toBe('failed');
    const sent: string[] = [];
    expect(await raiseResult({ db, notify: async (t) => { sent.push(t); }, now: () => NOW }, 'k', 360, async () => 'again')).toBe('sent');
    expect(sent).toEqual(['again']);
  });

  it('says whether a message was sent, was inside its window, or failed', async () => {
    const db = await memoryDb();
    const notify = async () => {};
    expect(await raiseResult({ db, notify, now: () => NOW }, 'r', 30, async () => 'a')).toBe('sent');
    expect(await raiseResult({ db, notify, now: () => NOW }, 'r', 30, async () => 'b')).toBe('quiet');
    expect(await raiseResult({ db, now: () => NOW }, 'r', 30, async () => 'c')).toBe('off');
  });
});

describe('daily report', () => {
  it('lists the day by project and account, flags paid use and problems, and escapes Slack markup', async () => {
    const db = await memoryDb();
    const { ids, clientId } = await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const other = await createClient(db, 'x<y>&z');
    const at = new Date(NOW.getTime() - 2 * 60 * MIN).toISOString();
    const insert = (key: string, client: number | null, account: number | null, pool: string, cost: number, status: number, note: string | null = null) =>
      db.query('insert into usage_log (at, client_id, account_id, pool, cost_usd, status, request_key, note) values ($1,$2,$3,$4,$5,$6,$7,$8)', [at, client, account, pool, cost, status, key, note]);
    for (let i = 0; i < 3; i++) await insert(`c${i}`, clientId, ids[0], 'credit', 1.5, 200);
    await insert('p1', other.id, ids[1], 'paid', 0.25, 200);
    await insert('e1', clientId, ids[0], 'credit', 0, 429);
    await insert('n1', clientId, null, 'none', 0, 503);
    // Bookkeeping rows: a lost-connection attempt and a swept set-aside cost money but are not requests.
    await insert('a1', clientId, ids[0], 'credit', 0.5, 0, 'connection lost; charged worst case');
    await insert('sweep:7', null, ids[0], 'credit', 0.5, 0, 'unrecorded request charged in full');
    // A swept row that the late reply later settled (status 200) is a real request again.
    await insert('sweep:8', null, ids[0], 'credit', 0.3, 200);

    const text = await buildReport(db, NOW);
    expect(text).toContain('일일 보고');
    expect(text).toContain('요청 7건');
    expect(text).toContain('크레딧 $5.80');
    expect(text).toContain('유료 $0.2500');
    expect(text).toContain('허브가 처리 못 한 요청 1건');
    expect(text).toContain('*API 유료 전환*\n• x&lt;y&gt;&amp;z — 1건');
    expect(text).toContain('test-project — 5건');
    expect(text).toContain(`#${ids[0]} A`);
    expect(text).toContain('429 한도 초과');
    expect(text).not.toContain('응답 기록 없음');
    expect(text).not.toContain('sk-ant');
    expect(text.length).toBeLessThan(3500);
  });

  it('says so when nothing was paid and nothing went wrong', async () => {
    const db = await memoryDb();
    await seed(db, [{ label: 'A', kind: 'credit', key: KEY('a'), credit: 200, day: 18 }, PAID]);
    const text = await buildReport(db, NOW);
    expect(text).toContain('• 없었어요 ✅ (유료 키로 처리된 요청 없음)');
    expect(text).toContain('*문제 신호*\n• 없어요 ✅');
  });
});
