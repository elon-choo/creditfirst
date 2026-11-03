import { prodDeps } from '@/lib/deps';
import { handleFree } from '@/lib/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { search } = new URL(req.url);
  return handleFree(req, `/v1/models${search}`, await prodDeps());
}
