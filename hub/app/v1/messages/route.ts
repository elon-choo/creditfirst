import { after } from 'next/server';
import { prodDeps } from '@/lib/deps';
import { handleMessages, type ProxyDeps } from '@/lib/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 300 s works on every Vercel plan (Hobby caps it there); Pro/Enterprise can raise this to 800.
export const maxDuration = 300;

export async function POST(req: Request) {
  const deps = await prodDeps();
  // Alerts go out after the reply (or stream) has finished, so Slack can never hold a request up.
  const pending: Promise<unknown>[] = [];
  let defer: ProxyDeps['defer'];
  try {
    after(async () => {
      for (let done = 0; done < pending.length;) {
        const batch = pending.slice(done);
        done = pending.length;
        await Promise.allSettled(batch);
      }
    });
    defer = (work) => { pending.push(work); };
  } catch {
    // Not inside a request scope: alerts are awaited inline instead.
  }
  return handleMessages(req, { ...deps, defer });
}
