/**
 * GET /api/health: whether the hub is set up, with no secrets and no auth.
 * Only booleans and account counts are returned; error details stay in the server log.
 */

import type { Db } from './db';
import { adminTokenValid, encKeyValid } from './secrets';

export interface Health {
  ok: boolean;
  db: boolean;
  encKey: boolean;
  adminToken: boolean;
  accounts: { credit: number; paid: number };
}

export async function healthReport(getDb: () => Promise<Db>): Promise<Health> {
  const encKey = encKeyValid();
  const adminToken = adminTokenValid();
  let db = false;
  const accounts = { credit: 0, paid: 0 };
  try {
    const d = await getDb();
    const { rows } = await d.query<{ kind: string; n: number }>('select kind, count(*)::int as n from accounts where not deleted group by kind');
    for (const r of rows) if (r.kind === 'credit' || r.kind === 'paid') accounts[r.kind] = Number(r.n);
    db = true;
  } catch (e) {
    console.error('health: database check failed', String((e as Error)?.name ?? 'error'));
  }
  return { ok: db && encKey && adminToken, db, encKey, adminToken, accounts };
}
