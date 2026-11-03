import { ensureSchema, getDb } from '@/lib/db';
import { healthReport } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No auth, no secrets: `{ ok, db, encKey, adminToken, accounts: { credit, paid } }`; 503 when not ok. */
export async function GET() {
  const report = await healthReport(async () => {
    const db = getDb();
    await ensureSchema(db);
    return db;
  });
  return Response.json(report, { status: report.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
