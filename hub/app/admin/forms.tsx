'use client';

import { useActionState } from 'react';
import type { Dict } from '@/lib/i18n';
import { addAccountAction, createClientAction, login } from './actions';

/** The wording the forms need; the server page picks the language and passes it down. */
export type FormWords = Pick<Dict,
  'password' | 'enter' | 'fName' | 'fNamePh' | 'fKind' | 'fKindCredit' | 'fKindPaid' | 'fCredit' | 'fDay' | 'fDayPh' | 'fKey' |
  'checking' | 'register' | 'fProject' | 'fProjectPh' | 'fCreditOnly' | 'makeKey'> & { keyOnce: string };

export function LoginForm({ w }: { w: FormWords }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action} className="card">
      <label htmlFor="token">{w.password}</label>
      <input id="token" name="token" type="password" autoComplete="current-password" required />
      {state?.error && <p className="bad">{state.error}</p>}
      <div className="actions"><button className="primary" disabled={pending}>{w.enter}</button></div>
    </form>
  );
}

export function AddAccountForm({ w }: { w: FormWords }) {
  const [state, action, pending] = useActionState(addAccountAction, {});
  return (
    <form action={action} className="card">
      <div className="grid">
        <div><label htmlFor="label">{w.fName}</label><input id="label" name="label" placeholder={w.fNamePh} required /></div>
        <div>
          <label htmlFor="kind">{w.fKind}</label>
          <select id="kind" name="kind" defaultValue="credit">
            <option value="credit">{w.fKindCredit}</option>
            <option value="paid">{w.fKindPaid}</option>
          </select>
        </div>
        <div><label htmlFor="monthlyCreditUsd">{w.fCredit}</label><input id="monthlyCreditUsd" name="monthlyCreditUsd" type="number" step="1" placeholder="200" /></div>
        <div><label htmlFor="renewalDay">{w.fDay}</label><input id="renewalDay" name="renewalDay" type="number" min={1} max={31} placeholder={w.fDayPh} /></div>
      </div>
      <label htmlFor="apiKey">{w.fKey}</label>
      <input id="apiKey" name="apiKey" type="password" autoComplete="off" placeholder="sk-ant-api03-…" required />
      {state?.error && <p className="bad">{state.error}</p>}
      {state?.ok && <p className="ok">{state.ok}</p>}
      <div className="actions"><button className="primary" disabled={pending}>{pending ? w.checking : w.register}</button></div>
    </form>
  );
}

export function NewClientForm({ w }: { w: FormWords }) {
  const [state, action, pending] = useActionState(createClientAction, {});
  return (
    <form action={action} className="card">
      <label htmlFor="name">{w.fProject}</label>
      <input id="name" name="name" placeholder={w.fProjectPh} required />
      <label><input name="creditOnly" type="checkbox" /> {w.fCreditOnly}</label>
      {state?.error && <p className="bad">{state.error}</p>}
      {state?.key && (
        <p>
          {w.keyOnce.replace('{name}', state.name ?? '')}<br />
          <code>{state.key}</code>
        </p>
      )}
      <div className="actions"><button className="primary" disabled={pending}>{w.makeKey}</button></div>
    </form>
  );
}
