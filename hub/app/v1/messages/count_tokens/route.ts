import { prodDeps } from '@/lib/deps';
import { handleFree } from '@/lib/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handleFree(req, '/v1/messages/count_tokens', await prodDeps());
}
