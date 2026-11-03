import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db';
import { KEY, memoryDb } from './helpers';

// The admin route with its production wiring swapped out: an in-memory database and a scripted key test.
const state = vi.hoisted(() => ({ db: undefined as unknown, check: { ok: true, status: 200, orgId: undefined as string | undefined } }));
vi.mock('@/lib/deps', () => ({
  prodDeps: async () => ({ db: state.db, fetch, upstream: 'https://up' }),
  keyWorks: async () => state.check,
}));

const { POST, PATCH } = await import('@/app/api/admin/accounts/route');

const TOKEN = 'admin-route-test-token-0123456789';
process.env.HUB_ADMIN_TOKEN = TOKEN;

function call(method: 'POST' | 'PATCH', body: unknown, token = TOKEN) {
  return new Request('https://hub.test/api/admin/accounts', {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const creditBody = (key: string) => ({ label: 'Max', kind: 'credit', apiKey: key, monthlyCreditUsd: 200, renewalDay: 5 });

describe('POST /api/admin/accounts', () => {
  beforeEach(async () => { state.db = (await memoryDb()) as Db; });

  it('needs the admin token', async () => {
    expect((await POST(call('POST', creditBody(KEY('a')), 'wrong'))).status).toBe(401);
  });

  it('answers 400 with a clear message when Anthropic gives no organization id', async () => {
    state.check = { ok: true, status: 200, orgId: undefined };
    const res = await POST(call('POST', creditBody(KEY('a'))));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/organization id/);
  });

  it('returns { id, keyHint, orgId }, and 409 for a paid key from the same organization', async () => {
    state.check = { ok: true, status: 200, orgId: 'org-1' };
    const res = await POST(call('POST', creditBody(KEY('a'))));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(Number), keyHint: `…${KEY('a').slice(-4)}`, orgId: 'org-1' });
    expect(JSON.stringify(body)).not.toContain(KEY('a'));
    const dup = await POST(call('POST', { label: 'Paid', kind: 'paid', apiKey: KEY('p') }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/different Anthropic organizations/);
  });

  it('refuses a key replacement without an organization id (400) or from another organization (409)', async () => {
    state.check = { ok: true, status: 200, orgId: 'org-1' };
    const { id } = await (await POST(call('POST', creditBody(KEY('a'))))).json();
    state.check = { ok: true, status: 200, orgId: undefined };
    expect((await PATCH(call('PATCH', { id, apiKey: KEY('a2') }))).status).toBe(400);
    state.check = { ok: true, status: 200, orgId: 'org-2' };
    expect((await PATCH(call('PATCH', { id, apiKey: KEY('a3') }))).status).toBe(409);
    state.check = { ok: true, status: 200, orgId: 'org-1' };
    expect((await PATCH(call('PATCH', { id, apiKey: KEY('a4') }))).status).toBe(200);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const req = new Request('https://hub.test/api/admin/accounts', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: 'nope' });
    expect((await POST(req)).status).toBe(400);
  });
});
