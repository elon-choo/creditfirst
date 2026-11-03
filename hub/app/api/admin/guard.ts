import { isAdminToken } from '@/lib/secrets';

export function adminOnly(req: Request): Response | null {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  return isAdminToken(token) ? null : Response.json({ error: 'admin token required' }, { status: 401 });
}
