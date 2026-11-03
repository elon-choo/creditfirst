import { PGlite } from '@electric-sql/pglite';
import { ensureSchema, type Db } from '@/lib/db';
import { addAccount, createClient } from '@/lib/store';

process.env.HUB_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64');

export async function memoryDb(): Promise<Db> {
  const pg = new PGlite();
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    query: (text, params) => pg.query(text, params as unknown[]) as never,
    // PGlite has one connection; queue transactions so they run one at a time, like row locks would force.
    tx(fn) {
      const run = chain.then(() => pg.transaction((t) => fn({ query: (text, params) => t.query(text, params as unknown[]) as never })));
      chain = run.catch(() => {});
      return run;
    },
  };
  await ensureSchema(db);
  return db;
}

export async function seed(db: Db, accounts: Array<{ label: string; kind: 'credit' | 'paid'; key: string; credit?: number; day?: number; margin?: number; org?: string }>) {
  const ids: number[] = [];
  for (const a of accounts) {
    // Every account has its own Anthropic organization unless a test says otherwise.
    ids.push(await addAccount(db, { label: a.label, kind: a.kind, apiKey: a.key, monthlyCreditUsd: a.credit, renewalDay: a.day, safetyMarginUsd: a.margin ?? 0 }, a.org ?? `org-${a.key}`));
  }
  const client = await createClient(db, 'test-project');
  return { ids, clientKey: client.key, clientId: client.id };
}

export interface Call { key: string; body: Record<string, unknown> }

/** A stand-in for api.anthropic.com: `respond` decides the reply for each key. */
export function fakeAnthropic(respond: (key: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get('x-api-key')!;
    const body = JSON.parse(String(init.body));
    calls.push({ key, body });
    return respond(key, body);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

export function okMessage(usage: Record<string, unknown>) {
  return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
  });
}

export function lowBalance() {
  return new Response(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' },
  }), { status: 400, headers: { 'content-type': 'application/json' } });
}

export function hubRequest(clientKey: string, body: Record<string, unknown>) {
  return new Request('https://hub.test/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': clientKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
}

export const KEY = (n: string) => `sk-ant-api03-${n.padEnd(20, 'x')}`;
