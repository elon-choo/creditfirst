import { prodDeps } from '@/lib/deps';
import { createClient } from '@/lib/store';
import { adminOnly } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Creates a project key: `{ name, paidFallback? }` → `{ id, name, key }`. The key is returned once and only its hash is kept. */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  let body: { name?: unknown; paidFallback?: unknown };
  try { body = (await req.json()) ?? {}; } catch { return Response.json({ error: 'JSON body required' }, { status: 400 }); }
  const { name, paidFallback } = body;
  if (typeof name !== 'string' || !name.trim()) return Response.json({ error: 'name required' }, { status: 400 });
  // Only a real boolean counts; a string such as "false" must not silently leave paid fallback on.
  if (paidFallback !== undefined && typeof paidFallback !== 'boolean') return Response.json({ error: 'paidFallback must be true or false' }, { status: 400 });
  const { db } = await prodDeps();
  try {
    const { id, key } = await createClient(db, name, { paidFallback: paidFallback !== false });
    return Response.json({ id, name: name.trim(), key });
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') return Response.json({ error: 'a project with that name already exists' }, { status: 409 });
    throw e;
  }
}
