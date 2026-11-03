import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  childEnv, configDir, deploy, lockEnvFiles, ensureSecrets, isPostgresUrl, main, parseArgs, parseEnvNames, pickProductionUrl, redact, saveHubUrl, SECRET_NAMES, UsageError,
} from '../hub-deploy.mjs';

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-deploy-'));
  process.env.CREDITFIRST_CONFIG_HOME = path.join(dir, 'creditfirst');
  return dir;
}

test('parses arguments and rejects bad ones', () => {
  assert.deepEqual(parseArgs(['--name', 'my-hub', '--scope', 'team-x', '--timezone', 'Asia/Seoul', '--lang', 'ko', '--dry-run']), {
    databaseUrlFromClipboard: false, dryRun: true, help: false, name: 'my-hub', scope: 'team-x', timezone: 'Asia/Seoul', lang: 'ko',
  });
  assert.equal(parseArgs(['--name=hub1', '--database-url-from-clipboard']).databaseUrlFromClipboard, true);
  for (const bad of [[], ['--name', 'My_Hub'], ['--name', '../x'], ['--name', 'ok', '--lang', 'fr'], ['--name', 'ok', '--timezone', 'Mars/Base'],
    ['--name', 'ok', '--bogus', '1'], ['--name'], ['--name', 'ok', 'extra'], ['--name', 'ok', '--dry-run=yes']]) {
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
  }
});

test('creates secrets once with 0700/0600 and reuses them on re-runs', () => {
  tmpHome();
  const dir = configDir('my-hub');
  const first = ensureSecrets(dir);
  assert.deepEqual(first.created, SECRET_NAMES);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const n of SECRET_NAMES) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600);
  assert.equal(Buffer.from(first.values.HUB_ENC_KEY, 'base64').length, 32);
  assert.ok(first.values.HUB_ADMIN_TOKEN.length >= 24);
  assert.ok(first.values.CRON_SECRET.length >= 16);
  const again = ensureSecrets(dir);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.values, first.values);
  fs.rmSync(path.join(dir, 'CRON_SECRET'));
  const third = ensureSecrets(dir);
  assert.deepEqual(third.created, ['CRON_SECRET']);
  assert.equal(third.values.HUB_ENC_KEY, first.values.HUB_ENC_KEY);
  const f = saveHubUrl(dir, 'https://my-hub.vercel.app/');
  assert.equal(fs.readFileSync(f, 'utf8'), 'https://my-hub.vercel.app\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('redacts secrets, connection strings and keys', () => {
  const s = redact('db postgres://u:pw@h.neon.tech/db?sslmode=require key sk-ant-api03-AAAA cf_abcdefghijkl token=abcdefghijklmnop VALUE123456789', ['VALUE123456789']);
  assert.ok(!s.includes('pw@'));
  assert.ok(!s.includes('AAAA'));
  assert.ok(!s.includes('abcdefghijkl'));
  assert.ok(!s.includes('abcdefghijklmnop'));
  assert.ok(!s.includes('VALUE123456789'));
  assert.ok(isPostgresUrl('postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require'));
  assert.ok(!isPostgresUrl('https://example.com'));
  assert.ok(!isPostgresUrl('postgres://no-at-sign/db'));
});

test('reads env names and the production alias', () => {
  const names = parseEnvNames(' name   value   environments   created\n DATABASE_URL  Encrypted  Production  1d ago\n HUB_ENC_KEY Encrypted Production 1d\n');
  assert.deepEqual([...names], ['DATABASE_URL', 'HUB_ENC_KEY']);
  const insp = JSON.stringify({ alias: ['my-hub-team.vercel.app', 'my-hub.vercel.app', 'my-hub-git-main-team.vercel.app'] });
  assert.equal(pickProductionUrl(insp, 'https://my-hub-abc123.vercel.app', 'my-hub'), 'https://my-hub.vercel.app');
  assert.equal(pickProductionUrl('not json', 'https://my-hub-abc123.vercel.app/', 'my-hub'), 'https://my-hub-abc123.vercel.app');
});

test('--dry-run prints one JSON line and touches nothing', async () => {
  const home = tmpHome();
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    assert.equal(await main(['--name', 'dry-hub', '--dry-run']), 0);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.ok(out.steps.some((s) => s.includes('vercel deploy --prod')));
  assert.equal(fs.existsSync(path.join(home, 'creditfirst', 'dry-hub')), false);
});

test('runs the whole flow against a fake vercel: values only on stdin, never in argv or output', async () => {
  tmpHome();
  const DB = 'postgresql://user:hunter2pass@ep-x.neon.tech/neondb?sslmode=require';
  const calls = [];
  const env = new Set();
  const run = (cmd, args, o) => {
    calls.push({ cmd, args, input: o.input });
    const a = args.join(' ');
    if (a.startsWith('whoami')) return { status: 0, stdout: 'me\n', stderr: '' };
    if (a.startsWith('link')) return { status: 0, stdout: '', stderr: 'Linked\n' };
    if (a.startsWith('env ls')) return { status: 0, stdout: [...env].map((n) => ` ${n}  Encrypted  Production  1m`).join('\n'), stderr: '' };
    if (a.startsWith('env add')) { env.add(args[2]); return { status: 0, stdout: '', stderr: 'Added' }; }
    if (a.startsWith('env rm')) { env.delete(args[2]); return { status: 0, stdout: '', stderr: '' }; }
    if (a.startsWith('deploy')) return { status: 0, stdout: 'https://my-hub-abc123-team.vercel.app\n', stderr: '' };
    if (a.startsWith('inspect')) return { status: 0, stdout: JSON.stringify({ alias: ['my-hub.vercel.app'] }), stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${a}` };
  };
  let polls = 0;
  const authSeen = [];
  const fetchFn = async (url, init) => {
    if (url === 'https://my-hub.vercel.app/api/admin/accounts') {
      const auth = new Headers(init.headers).get('authorization');
      authSeen.push(auth);
      const want = `Bearer ${fs.readFileSync(path.join(configDir('my-hub'), 'HUB_ADMIN_TOKEN'), 'utf8').trim()}`;
      return Response.json([], { status: auth === want ? 200 : 401 });
    }
    assert.equal(url, 'https://my-hub.vercel.app/api/health');
    polls += 1;
    return Response.json({ ok: polls >= 2, db: true, encKey: true, adminToken: true, accounts: { credit: 0, paid: 0 } });
  };
  const opts = parseArgs(['--name', 'my-hub', '--scope', 'team', '--timezone', 'Asia/Seoul', '--database-url-from-clipboard']);
  const result = await deploy(opts, { run, fetchFn, clipboard: () => DB, isTTY: false, sleep: async () => {} });
  assert.deepEqual(result, { ok: true, url: 'https://my-hub.vercel.app', configDir: configDir('my-hub'), project: 'my-hub', database: 'clipboard' });
  const secrets = ensureSecrets(configDir('my-hub')).values;
  const argvText = JSON.stringify(calls.map((c) => c.args));
  for (const v of [DB, ...Object.values(secrets)]) assert.ok(!argvText.includes(v), 'secret in argv');
  assert.ok(calls.every((c) => c.args.includes('--scope') && c.args.includes('team')));
  assert.equal(calls.find((c) => c.args[2] === 'DATABASE_URL').input, DB);
  assert.equal(calls.find((c) => c.args[2] === 'HUB_ENC_KEY' && c.args[1] === 'add').input, secrets.HUB_ENC_KEY);
  assert.equal(calls.find((c) => c.args[2] === 'HUB_TIMEZONE').input, 'Asia/Seoul');
  assert.equal(fs.readFileSync(path.join(configDir('my-hub'), 'HUB_URL'), 'utf8'), 'https://my-hub.vercel.app\n');
  assert.equal(authSeen.length, 1);

  // A re-run reuses everything: no secret is set again, DATABASE_URL is kept.
  calls.length = 0;
  polls = 5;
  const again = await deploy(parseArgs(['--name', 'my-hub', '--scope', 'team']), { run, fetchFn, clipboard: () => { throw new Error('not used'); }, isTTY: false, sleep: async () => {} });
  assert.equal(again.database, 'existing');
  assert.ok(!calls.some((c) => c.args[0] === 'env' && c.args[1] === 'add'));
});

test('stops with a clear step when there is no database and no terminal, and when HUB_ENC_KEY would be replaced', async () => {
  tmpHome();
  const env = new Set();
  const run = (cmd, args, o) => {
    const a = args.join(' ');
    if (a.startsWith('env ls')) return { status: 0, stdout: [...env].map((n) => ` ${n}  Encrypted  Production`).join('\n'), stderr: '' };
    if (a.startsWith('env add')) { env.add(args[2]); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(deploy(parseArgs(['--name', 'h2']), { run, isTTY: false }), (e) => e.step === 'database' && /--database-url-from-clipboard/.test(e.message));
  env.add('DATABASE_URL');
  env.add('HUB_ENC_KEY');
  await assert.rejects(deploy(parseArgs(['--name', 'h3']), { run, isTTY: false }), (e) => e.step === 'secrets' && /HUB_ENC_KEY/.test(e.message));
  await assert.rejects(deploy(parseArgs(['--name', 'h4', '--database-url-from-clipboard']), {
    run: (c, a, o) => (a[0] === 'env' && a[1] === 'ls' ? { status: 0, stdout: '', stderr: '' } : run(c, a, o)), clipboard: () => 'not a url', isTTY: false,
  }), (e) => e.step === 'database' && !/not a url/.test(e.message));
});

test('redaction keeps help text readable and removes real credentials', () => {
  const help = 'copy a Neon connection string (postgres://…) and re-run with --database-url-from-clipboard; the secret files are in ~/.config';
  assert.equal(redact(help), help);
  assert.equal(redact('HUB_ADMIN_TOKEN was missing; token actually authenticates'), 'HUB_ADMIN_TOKEN was missing; token actually authenticates');
  assert.equal(redact('see https://my-hub.vercel.app/api/health'), 'see https://my-hub.vercel.app/api/health');
  assert.equal(redact('url postgresql://neondb_owner:npg_AbC123@ep-x.neon.tech/neondb ok'), 'url postgresql://[redacted] ok');
  assert.equal(redact('token=abcdefghijklmnopqrstu'), 'token=[redacted]');
});

test('child processes get a minimal environment without app or hub secrets', () => {
  const env = childEnv({
    PATH: '/bin', HOME: '/h', VERCEL_TOKEN: 'vt', VERCEL_ORG_ID: 'o', HTTPS_PROXY: 'http://p',
    ANTHROPIC_API_KEY: 'sk-ant-x', DATABASE_URL: 'postgres://u:p@h/d', HUB_ADMIN_TOKEN: 't', OPENAI_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['FORCE_COLOR', 'HOME', 'HTTPS_PROXY', 'NO_COLOR', 'PATH', 'VERCEL_ORG_ID', 'VERCEL_TOKEN']);
});

test('pulled .env files are made owner-only, and the run uses umask 077', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-lock-'));
  fs.mkdirSync(path.join(d, '.vercel'));
  for (const f of ['.env.local', '.env.production.local', path.join('.vercel', '.env.development.local'), 'README.md']) {
    fs.writeFileSync(path.join(d, f), 'X=1\n', { mode: 0o644 });
    fs.chmodSync(path.join(d, f), 0o644);
  }
  assert.equal(lockEnvFiles(d).length, 3);
  for (const f of ['.env.local', '.env.production.local', path.join('.vercel', '.env.development.local')]) assert.equal(fs.statSync(path.join(d, f)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(d, 'README.md')).mode & 0o777, 0o644);

  tmpHome();
  let mode;
  const run = (cmd, args) => {
    if (args[0] === 'link') {
      const f = path.join(d, 'pulled-by-link');
      fs.writeFileSync(f, 'SECRET=1');
      mode = fs.statSync(f).mode & 0o777;
    }
    if (args[0] === 'env' && args[1] === 'ls') return { status: 1, stdout: '', stderr: 'stop here' };
    return { status: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(deploy(parseArgs(['--name', 'umask-hub']), { run, isTTY: false }), (e) => e.step === 'env');
  assert.equal(mode, 0o600);
});

test('a lost local HUB_ENC_KEY or HUB_ADMIN_TOKEN stops every run without creating files', async () => {
  tmpHome();
  const run = (cmd, args) => (args[0] === 'env' && args[1] === 'ls'
    ? { status: 0, stdout: ' DATABASE_URL Encrypted Production\n HUB_ENC_KEY Encrypted Production\n HUB_ADMIN_TOKEN Encrypted Production\n', stderr: '' }
    : { status: 0, stdout: '', stderr: '' });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(deploy(parseArgs(['--name', 'lost-hub']), { run, isTTY: false }),
      (e) => e.step === 'secrets' && /HUB_ENC_KEY and HUB_ADMIN_TOKEN/.test(e.message) && /Nothing was changed/.test(e.message));
    assert.equal(fs.existsSync(configDir('lost-hub')), false);
  }
});

test('does not report ok when the deployed hub rejects the local admin token', async () => {
  tmpHome();
  const dir = configDir('mismatch-hub');
  ensureSecrets(dir);
  const run = (cmd, args) => {
    const a = args.join(' ');
    if (a.startsWith('env ls')) return { status: 0, stdout: ' DATABASE_URL x\n HUB_ENC_KEY x\n HUB_ADMIN_TOKEN x\n CRON_SECRET x\n', stderr: '' };
    if (a.startsWith('deploy')) return { status: 0, stdout: 'https://mismatch-hub-1.vercel.app\n', stderr: '' };
    if (a.startsWith('inspect')) return { status: 0, stdout: JSON.stringify({ alias: ['mismatch-hub.vercel.app'] }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const fetchFn = async (url) => (url.endsWith('/api/health') ? Response.json({ ok: true }) : Response.json({ error: 'admin token required' }, { status: 401 }));
  await assert.rejects(deploy(parseArgs(['--name', 'mismatch-hub']), { run, fetchFn, isTTY: false, sleep: async () => {} }),
    (e) => e.step === 'verify' && /HTTP 401/.test(e.message));
  assert.equal(fs.existsSync(path.join(dir, 'HUB_URL')), false);
});
