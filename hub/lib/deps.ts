import { alertNotifier } from './alerts';
import { paidMonthlyCapUsd } from './config';
import { ensureSchema, getDb } from './db';
import type { ProxyDeps } from './proxy';

/** Production wiring: the Postgres (Neon) database, the real Anthropic API, alert destinations and the paid cap. */
export async function prodDeps(): Promise<ProxyDeps> {
  const db = getDb();
  await ensureSchema(db);
  return { db, fetch, upstream: (process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com').replace(/\/$/, ''), notify: alertNotifier(), paidCapUsd: paidMonthlyCapUsd() };
}

/** Checks a key against Anthropic's free models list before it is saved. */
export async function keyWorks(apiKey: string): Promise<{ ok: boolean; status: number; orgId?: string; message?: string }> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' },
  });
  // The organization behind the key: used to refuse a second key for the same credit balance.
  if (res.ok) return { ok: true, status: res.status, orgId: res.headers.get('anthropic-organization-id') ?? undefined };
  let message = '';
  try { message = (await res.json())?.error?.message ?? ''; } catch { /* ignore */ }
  return { ok: false, status: res.status, message };
}
