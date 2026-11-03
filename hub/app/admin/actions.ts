'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { keyWorks, prodDeps } from '@/lib/deps';
import { adminSessionValue, isAdminSession, isAdminToken, isViewerToken, SESSION_SECONDS, viewerSessionValue } from '@/lib/secrets';
import { t } from '@/lib/i18n';
import { AccountError, addAccount, createClient, deleteAccount, MissingOrgError, setClientEnabled, setClientPaidFallback, updateAccount, validateAccount, type Kind } from '@/lib/store';

const COOKIE = 'hub_admin';
const VIEWER_COOKIE = 'hub_viewer';

async function requireAdmin() {
  const jar = await cookies();
  if (!isAdminSession(jar.get(COOKIE)?.value)) throw new Error(t().loginRequired);
}

export async function login(_: unknown, form: FormData): Promise<{ error?: string }> {
  const token = String(form.get('token') ?? '');
  const jar = await cookies();
  if (isAdminToken(token)) {
    jar.delete(VIEWER_COOKIE);
    jar.set(COOKIE, adminSessionValue()!, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS });
  } else if (isViewerToken(token)) {
    jar.delete(COOKIE);
    jar.set(VIEWER_COOKIE, viewerSessionValue()!, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS });
  } else {
    return { error: t().wrongPassword };
  }
  revalidatePath('/admin');
  return {};
}

export async function logout() {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(VIEWER_COOKIE);
  revalidatePath('/admin');
}

export async function addAccountAction(_: unknown, form: FormData): Promise<{ error?: string; ok?: string }> {
  await requireAdmin();
  const input = {
    label: String(form.get('label') ?? ''),
    kind: String(form.get('kind') ?? 'credit') as Kind,
    apiKey: String(form.get('apiKey') ?? ''),
    monthlyCreditUsd: Number(form.get('monthlyCreditUsd') || 0),
    renewalDay: Number(form.get('renewalDay') || 0),
  };
  const problem = validateAccount(input);
  if (problem) return { error: problem };
  const check = await keyWorks(input.apiKey);
  if (!check.ok) return { error: t().keyRefused(check.status, check.message ?? '') };
  if (!check.orgId) return { error: new MissingOrgError().message };
  const { db } = await prodDeps();
  try {
    await addAccount(db, input, check.orgId);
  } catch (e) {
    if (e instanceof AccountError) return { error: e.message };
    throw e;
  }
  revalidatePath('/admin');
  return { ok: t().added(input.label) };
}

export async function accountAction(form: FormData) {
  await requireAdmin();
  const id = Number(form.get('id'));
  const op = String(form.get('op'));
  const { db } = await prodDeps();
  if (op === 'disable') await updateAccount(db, id, { enabled: false });
  if (op === 'enable') await updateAccount(db, id, { enabled: true });
  if (op === 'reset') await updateAccount(db, id, { clearState: true });
  if (op === 'delete') await deleteAccount(db, id);
  if (op === 'edit') {
    const credit = Number(form.get('monthlyCreditUsd'));
    const day = Number(form.get('renewalDay'));
    await updateAccount(db, id, {
      ...(credit > 0 ? { monthlyCreditUsd: credit } : {}),
      ...(day >= 1 && day <= 31 ? { renewalDay: day } : {}),
    });
  }
  revalidatePath('/admin');
}

export async function createClientAction(_: unknown, form: FormData): Promise<{ error?: string; key?: string; name?: string }> {
  await requireAdmin();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: t().needProjectName };
  const { db } = await prodDeps();
  try {
    const { key } = await createClient(db, name, { paidFallback: form.get('creditOnly') !== 'on' });
    revalidatePath('/admin');
    return { key, name };
  } catch {
    return { error: t().projectExists };
  }
}

export async function clientAction(form: FormData) {
  await requireAdmin();
  const { db } = await prodDeps();
  const id = Number(form.get('id'));
  const op = String(form.get('op'));
  if (op === 'enable' || op === 'disable') await setClientEnabled(db, id, op === 'enable');
  if (op === 'credit-only' || op === 'allow-paid') await setClientPaidFallback(db, id, op === 'allow-paid');
  revalidatePath('/admin');
}
