import { after } from 'next/server';
import { hubName } from '@/lib/config';
import { prodDeps } from '@/lib/deps';
import { t } from '@/lib/i18n';
import { adminOnly } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_DESTINATION = 'No alert destination is set (SLACK_BOT_TOKEN + HUB_ALERT_SLACK_CHANNEL, or HUB_ALERT_WEBHOOK_URL)';

/**
 * Sends one test message through the same destinations the alerts use (Slack and/or webhook).
 * `?defer=1` answers first and sends after the reply is finished, the way the request path does.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const { notify } = await prodDeps();
  if (!notify) return Response.json({ error: NO_DESTINATION }, { status: 500 });
  const text = t().alertTest(hubName());
  if (new URL(req.url).searchParams.get('defer') === '1') {
    after(() => notify(`${text} ${t().alertTestDeferred}`).catch((e) => console.error('alert test failed', String(e).slice(0, 200))));
    return Response.json({ ok: true, deferred: true });
  }
  try {
    await notify(text);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 200) }, { status: 502 });
  }
}
