/**
 * Key handling: account API keys are stored encrypted (AES-256-GCM with
 * HUB_ENC_KEY); project keys are stored only as SHA-256 hashes; the admin
 * session cookie is an HMAC of HUB_ADMIN_TOKEN.
 */

import { ADMIN_TOKEN_MIN } from './config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** True when HUB_ENC_KEY is set and decodes to 32 bytes. */
export function encKeyValid(): boolean {
  try { encKey(); return true; } catch { return false; }
}

function encKey(): Buffer {
  const raw = process.env.HUB_ENC_KEY;
  if (!raw) throw new Error('HUB_ENC_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('HUB_ENC_KEY must be 32 bytes, base64');
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(stored: string): string {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1') throw new Error('unknown key format');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newClientKey(): string {
  return `cf_${randomBytes(30).toString('base64url')}`;
}

export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminTokenValid(): boolean {
  const token = process.env.HUB_ADMIN_TOKEN;
  return !!token && token.length >= ADMIN_TOKEN_MIN;
}

/** Admin sessions last 7 days; changing HUB_ADMIN_TOKEN ends every session at once. */
export const SESSION_SECONDS = 7 * 24 * 3600;

function sessionMac(token: string, expires: number): string {
  return createHmac('sha256', token).update(`creditfirst-hub-admin-v1:${expires}`).digest('hex');
}

export function adminSessionValue(now = Date.now()): string | undefined {
  const token = process.env.HUB_ADMIN_TOKEN;
  if (!token || token.length < ADMIN_TOKEN_MIN) return undefined;
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${sessionMac(token, expires)}`;
}

export function isAdminToken(candidate: string | undefined | null): boolean {
  const token = process.env.HUB_ADMIN_TOKEN;
  return !!token && token.length >= ADMIN_TOKEN_MIN && !!candidate && safeEqual(candidate, token);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` to the scheduled paths. */
export function isCronSecret(candidate: string | undefined | null): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && secret.length >= 16 && !!candidate && safeEqual(candidate, secret);
}

export function isAdminSession(cookie: string | undefined, now = Date.now()): boolean {
  const token = process.env.HUB_ADMIN_TOKEN;
  if (!token || token.length < ADMIN_TOKEN_MIN || !cookie) return false;
  const [exp, mac] = cookie.split('.');
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires * 1000 < now || !mac) return false;
  return safeEqual(mac, sessionMac(token, expires));
}

/**
 * A second, read-only password: whoever logs in with HUB_VIEWER_TOKEN can look at the dashboard but
 * not change anything. Its cookie is separate from the admin one and signed with a different key and label,
 * so it never passes isAdminSession.
 */
function viewerMac(token: string, expires: number): string {
  return createHmac('sha256', token).update(`creditfirst-hub-viewer-v1:${expires}`).digest('hex');
}

export function viewerSessionValue(now = Date.now()): string | undefined {
  const token = process.env.HUB_VIEWER_TOKEN;
  if (!token || token.length < 16) return undefined;
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${viewerMac(token, expires)}`;
}

export function isViewerToken(candidate: string | undefined | null): boolean {
  const token = process.env.HUB_VIEWER_TOKEN;
  return !!token && token.length >= 16 && !!candidate && safeEqual(candidate, token);
}

export function isViewerSession(cookie: string | undefined, now = Date.now()): boolean {
  const token = process.env.HUB_VIEWER_TOKEN;
  if (!token || token.length < 16 || !cookie) return false;
  const [exp, mac] = cookie.split('.');
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires * 1000 < now || !mac) return false;
  return safeEqual(mac, viewerMac(token, expires));
}
