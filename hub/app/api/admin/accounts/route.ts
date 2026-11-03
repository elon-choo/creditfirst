import { keyWorks, prodDeps } from '@/lib/deps';
import { keyHint } from '@/lib/secrets';
import { AccountError, accountStates, addAccount, MissingOrgError, replaceKey, updateAccount, validateAccount, type AccountInput } from '@/lib/store';
import { adminOnly } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function refused(e: unknown): Response {
  if (e instanceof AccountError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

/** Account list without keys: status, cycle, spent and usable credit. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const { db } = await prodDeps();
  const states = await accountStates(db);
  return Response.json(states.map((s) => ({
    id: s.row.id, label: s.row.label, kind: s.row.kind, keyHint: s.row.key_hint, orgId: s.row.org_id, status: s.status, enabled: s.row.enabled,
    monthlyCreditUsd: s.row.monthly_credit_usd, renewalDay: s.row.renewal_day, cycleStart: s.cycle.start, cycleEnd: s.cycle.end,
    spentUsd: s.spent, reservedUsd: s.reserved, usableUsd: Number.isFinite(s.usable) ? s.usable : null, lastError: s.row.last_error,
  })));
}

/**
 * Registers an account: `{ label, kind: 'credit' | 'paid', apiKey, monthlyCreditUsd, renewalDay }` → `{ id, keyHint, orgId }`.
 * 400 when the key fails Anthropic's test or Anthropic gives no organization id; 409 when the organization is already
 * registered, or when a credit account and a paid key would share one organization.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const input = (await readJson(req)) as AccountInput | null;
  if (!input) return Response.json({ error: 'JSON object body required' }, { status: 400 });
  const problem = validateAccount(input);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const check = await keyWorks(input.apiKey);
  if (!check.ok) return Response.json({ error: `Anthropic rejected the key (${check.status}) ${check.message ?? ''}`.trim() }, { status: 400 });
  if (!check.orgId) return refused(new MissingOrgError());
  const { db } = await prodDeps();
  try {
    const id = await addAccount(db, input, check.orgId);
    return Response.json({ id, keyHint: keyHint(input.apiKey.trim()), orgId: check.orgId });
  } catch (e) {
    return refused(e);
  }
}

/** Edits an account: `apiKey` (same organization only), `label`, `monthlyCreditUsd`, `renewalDay`, `enabled`. */
export async function PATCH(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const body = (await readJson(req)) as { id?: number; apiKey?: string; label?: string; monthlyCreditUsd?: number; renewalDay?: number; enabled?: boolean } | null;
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 });
  const { db } = await prodDeps();
  try {
    if (body.apiKey) {
      if (typeof body.apiKey !== 'string' || !/^sk-ant-[a-z]+\d*-/.test(body.apiKey.trim())) return Response.json({ error: 'apiKey is not an Anthropic API key' }, { status: 400 });
      const check = await keyWorks(body.apiKey);
      if (!check.ok) return Response.json({ error: `Anthropic rejected the key (${check.status})` }, { status: 400 });
      if (!check.orgId) return refused(new MissingOrgError());
      await replaceKey(db, body.id, body.apiKey, check.orgId);
    }
  } catch (e) {
    return refused(e);
  }
  await updateAccount(db, body.id, {
    label: body.label, monthlyCreditUsd: body.monthlyCreditUsd, renewalDay: body.renewalDay, enabled: body.enabled,
  });
  return Response.json({ ok: true });
}
