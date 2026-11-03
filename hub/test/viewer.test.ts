import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSessionValue, isAdminSession, isAdminToken, isViewerSession, isViewerToken, viewerSessionValue } from '@/lib/secrets';

const ADMIN = 'admin-token-0123456789-abcdef';
const VIEWER = 'viewer-token-0123456789';

describe('read-only viewer password', () => {
  const saved = { a: process.env.HUB_ADMIN_TOKEN, v: process.env.HUB_VIEWER_TOKEN };
  beforeEach(() => { process.env.HUB_ADMIN_TOKEN = ADMIN; process.env.HUB_VIEWER_TOKEN = VIEWER; });
  afterEach(() => {
    if (saved.a === undefined) delete process.env.HUB_ADMIN_TOKEN; else process.env.HUB_ADMIN_TOKEN = saved.a;
    if (saved.v === undefined) delete process.env.HUB_VIEWER_TOKEN; else process.env.HUB_VIEWER_TOKEN = saved.v;
  });

  it('each password opens only its own session', () => {
    expect(isViewerToken(VIEWER)).toBe(true);
    expect(isAdminToken(VIEWER)).toBe(false);
    expect(isViewerToken(ADMIN)).toBe(false);
    expect(isViewerSession(viewerSessionValue())).toBe(true);
    expect(isAdminSession(viewerSessionValue())).toBe(false);
    expect(isViewerSession(adminSessionValue())).toBe(false);
  });

  it('is off when HUB_VIEWER_TOKEN is missing or short, and expired or forged cookies fail', () => {
    const cookie = viewerSessionValue()!;
    process.env.HUB_VIEWER_TOKEN = 'short';
    expect(isViewerToken('short')).toBe(false);
    expect(viewerSessionValue()).toBeUndefined();
    expect(isViewerSession(cookie)).toBe(false);
    delete process.env.HUB_VIEWER_TOKEN;
    expect(isViewerSession(cookie)).toBe(false);
    process.env.HUB_VIEWER_TOKEN = VIEWER;
    expect(isViewerSession(cookie, Date.now() + 8 * 24 * 3600 * 1000)).toBe(false);
    const [exp] = cookie.split('.');
    expect(isViewerSession(`${exp}.deadbeef`)).toBe(false);
  });
});
