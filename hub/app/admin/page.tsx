import { cookies, headers } from 'next/headers';
import { hubName, hubTimeZone, paidMonthlyCapUsd } from '@/lib/config';
import { prodDeps } from '@/lib/deps';
import { locale, t, type Dict } from '@/lib/i18n';
import { isAdminSession, isViewerSession } from '@/lib/secrets';
import { overview, routingOrder, type AccountState } from '@/lib/store';
import { accountAction, clientAction, logout } from './actions';
import { AddAccountForm, LoginForm, NewClientForm, type FormWords } from './forms';

export const dynamic = 'force-dynamic';

const usd = (v: number) => `$${v.toFixed(2)}`;
const when = (d: unknown) => new Date(String(d)).toLocaleString(locale(), { timeZone: hubTimeZone(), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function statusOf(w: Dict): Record<AccountState['status'], [string, string]> {
  return {
    ready: [w.statusReady, 'ok'],
    cooldown: [w.statusCooldown, 'warn'],
    exhausted: [w.statusExhausted, 'muted'],
    disabled: [w.statusDisabled, 'muted'],
    paid: [w.statusPaid, 'warn'],
  };
}

function formWords(w: Dict): FormWords {
  const { password, enter, fName, fNamePh, fKind, fKindCredit, fKindPaid, fCredit, fDay, fDayPh, fKey, checking, register, fProject, fProjectPh, fCreditOnly, makeKey } = w;
  return { password, enter, fName, fNamePh, fKind, fKindCredit, fKindPaid, fCredit, fDay, fDayPh, fKey, checking, register, fProject, fProjectPh, fCreditOnly, makeKey, keyOnce: w.keyOnce('{name}') };
}

function AccountCard({ s, rank, canEdit, w }: { s: AccountState; rank?: number; canEdit: boolean; w: Dict }) {
  const r = s.row;
  const STATUS = statusOf(w);
  const credit = r.kind === 'credit';
  const usedPct = credit && r.monthly_credit_usd > 0 ? Math.min(100, (s.spent / r.monthly_credit_usd) * 100) : 0;
  const [label, cls] = STATUS[s.status];
  return (
    <div className="card">
      <div className="row">
        <strong>{rank ? w.rank(rank) : ''}{r.label}</strong>
        <span className={`tag ${cls}`}>{label}</span>
      </div>
      {credit ? (
        <>
          <div className="bar"><i style={{ width: `${usedPct}%` }} /></div>
          <div className="row muted">
            <span>{w.usedOf(usd(s.spent), usd(r.monthly_credit_usd), usd(Math.max(0, s.usable)))}</span>
            <span>{w.resets(s.cycle.end, Math.max(0, Math.ceil(s.cycle.daysLeft)))}</span>
          </div>
        </>
      ) : (
        <div className="muted">{w.paidUsed(usd(s.spent))}</div>
      )}
      <div className="muted">{w.keyLine(r.key_hint, r.last_error ?? '')}</div>
      {canEdit &&       <form action={accountAction} className="actions">
        <input type="hidden" name="id" value={r.id} />
        {credit && <input name="monthlyCreditUsd" type="number" placeholder={w.creditPh(r.monthly_credit_usd)} style={{ width: 120 }} />}
        {credit && <input name="renewalDay" type="number" min={1} max={31} placeholder={w.dayPh(r.renewal_day)} style={{ width: 110 }} />}
        {credit && <button name="op" value="edit">{w.edit}</button>}
        <button name="op" value={r.enabled ? 'disable' : 'enable'}>{r.enabled ? w.disable : w.enable}</button>
        <button name="op" value="reset">{w.reset}</button>
        <button name="op" value="delete">{w.del}</button>
      </form>}
    </div>
  );
}

export default async function AdminPage() {
  const w = t();
  const name = hubName();
  const fw = formWords(w);
  const jar = await cookies();
  const canEdit = isAdminSession(jar.get('hub_admin')?.value);
  if (!canEdit && !isViewerSession(jar.get('hub_viewer')?.value)) {
    return (
      <main>
        <h1>{name}</h1>
        <p className="sub">{w.adminOnlySub}</p>
        <LoginForm w={fw} />
      </main>
    );
  }

  const { db } = await prodDeps();
  const data = await overview(db);
  const order = routingOrder(data.accounts);
  const rankOf = new Map(order.credit.map((s, i) => [s.row.id, i + 1]));
  const credits = data.accounts.filter((s) => s.row.kind === 'credit')
    .sort((a, b) => (rankOf.get(a.row.id) ?? 99) - (rankOf.get(b.row.id) ?? 99) || a.cycle.endsAt.getTime() - b.cycle.endsAt.getTime());
  const paid = data.accounts.filter((s) => s.row.kind === 'paid');
  const creditLeft = credits.filter((s) => s.row.enabled).reduce((t, s) => t + Math.max(0, s.usable), 0);
  const paidMonth = data.byClient.filter((r) => r.pool === 'paid').reduce((t, r) => t + r.cost, 0);
  const host = (await headers()).get('host') ?? '';
  const cap = paidMonthlyCapUsd();

  return (
    <main>
      <div className="row">
        <h1>{name}</h1>
        <form action={logout}><button>{w.logout}</button></form>
      </div>
      {!canEdit && <p className="muted">{w.viewerNote}</p>}
      <p className="sub">{w.headline(usd(creditLeft), usd(paidMonth), cap === undefined ? '' : w.capPart(usd(cap)))}</p>

      <h2>{w.creditHeader}</h2>
      {credits.length === 0 && <p className="muted">{w.noAccounts}</p>}
      {credits.map((s) => <AccountCard key={s.row.id} s={s} rank={rankOf.get(s.row.id)} canEdit={canEdit} w={w} />)}

      <h2>{w.paidHeader}</h2>
      {paid.length === 0 && <p className="bad">{w.noPaid}</p>}
      {paid.map((s) => <AccountCard key={s.row.id} s={s} canEdit={canEdit} w={w} />)}

      <h2>{w.byProjectHeader}</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>{w.thProject}</th><th>{w.thWhere}</th><th>{w.thRequests}</th><th>{w.thAmount}</th></tr></thead>
          <tbody>
            {data.byClient.map((r, i) => (
              <tr key={i}><td>{r.name ?? '-'}</td><td>{r.pool === 'credit' ? w.poolCredit : r.pool === 'paid' ? w.poolPaid : w.poolNone}</td><td>{r.requests}</td><td>{usd(r.cost)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>{w.recentHeader}</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>{w.thTime}</th><th>{w.thProject}</th><th>{w.thAccount}</th><th>{w.thModel}</th><th>{w.thTokens}</th><th>{w.thAmount}</th><th>{w.thResult}</th></tr></thead>
          <tbody>
            {data.recent.map((r, i) => (
              <tr key={i}>
                <td>{when(r.at)}</td><td>{String(r.client ?? '-')}</td><td>{String(r.account ?? '-')}</td><td>{String(r.model ?? '-')}</td>
                <td>{String(r.input_tokens)}/{String(r.output_tokens)}</td><td>{usd(Number(r.cost_usd))}</td>
                <td>{String(r.status)}{r.note ? ` ${String(r.note)}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>{w.projectKeysHeader}</h2>
      {data.clients.map((c) => (
        canEdit ? (
        <form key={c.id} action={clientAction} className="card row">
          <input type="hidden" name="id" value={c.id} />
          <span>{c.name} <span className="muted">{c.key_hint}</span> {!c.paid_fallback && <span className="tag warn">{w.creditOnlyTag}</span>}</span>
          <span className="actions">
            <button name="op" value={c.paid_fallback ? 'credit-only' : 'allow-paid'}>{c.paid_fallback ? w.toCreditOnly : w.allowPaid}</button>
            <button name="op" value={c.enabled ? 'disable' : 'enable'}>{c.enabled ? w.block : w.unblock}</button>
          </span>
        </form>
        ) : (
          <div key={c.id} className="card row">
            <span>{c.name} {!c.paid_fallback && <span className="tag warn">{w.creditOnlyTag}</span>} {!c.enabled && <span className="tag muted">{w.blockedTag}</span>}</span>
          </div>
        )
      ))}
      {canEdit && <NewClientForm w={fw} />}

      {canEdit && (
        <>
      <h2>{w.registerHeader}</h2>
      <div className="card">
        <ol>
          <li>{w.step1}</li>
          <li><strong>{w.step2}</strong></li>
          <li>{w.step3}</li>
        </ol>
        <p className="muted">{w.connectHint(host)}</p>
      </div>
      <AddAccountForm w={fw} />
        </>
      )}
    </main>
  );
}
