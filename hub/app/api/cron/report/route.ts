import { raiseResult } from '@/lib/alerts';
import { prodDeps } from '@/lib/deps';
import { buildReport } from '@/lib/report';
import { isAdminToken, isCronSecret } from '@/lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The daily usage report. Vercel Cron calls this once a day (vercel.json, 00:00 UTC); the admin token can call it
 * too, any time. A scheduled call is sent at most once per 20 hours (Vercel may call a job twice), and a
 * failed send can be retried. `?dry=1` returns the text without sending it.
 */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const viaAdmin = isAdminToken(bearer);
  if (!viaAdmin && !isCronSecret(bearer)) return Response.json({ error: 'not allowed' }, { status: 401 });
  const { db, notify } = await prodDeps();
  const text = await buildReport(db, new Date());
  if (new URL(req.url).searchParams.get('dry') === '1') return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!notify) return Response.json({ error: 'No alert destination is set (SLACK_BOT_TOKEN + HUB_ALERT_SLACK_CHANNEL, or HUB_ALERT_WEBHOOK_URL)' }, { status: 500 });
  if (viaAdmin) {
    await notify(text);
    return Response.json({ ok: true, chars: text.length });
  }
  const result = await raiseResult({ db, notify }, 'daily-report', 20 * 60, async () => text);
  if (result === 'failed') return Response.json({ error: 'the report could not be delivered' }, { status: 502 });
  if (result === 'quiet') return Response.json({ ok: true, skipped: 'already sent in the last 20 hours' });
  return Response.json({ ok: true, chars: text.length });
}
