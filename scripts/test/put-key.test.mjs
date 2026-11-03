import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv, cleanSecret, main, parseArgs, readEnvFile, redact, upsertEnv, writeSecretFile } from '../put-key.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'put-key.mjs');
const FAKE_KEY = `sk-ant-api03-${'A'.repeat(80)}WXYZ`;
const FAKE_HUB_KEY = `cf_${'b'.repeat(36)}9876`;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-putkey-')); }

function runCli(args, { clip, cwd, env = {} } = {}) {
  const dir = tmp();
  const clipFile = path.join(dir, 'clipboard.txt');
  if (clip !== undefined) fs.writeFileSync(clipFile, clip);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd ?? dir, encoding: 'utf8',
    env: { ...process.env, CREDITFIRST_TEST_CLIPBOARD_FILE: clipFile, CREDITFIRST_CONFIG_HOME: path.join(dir, 'cfg'), ...env },
  });
  return { ...r, clipFile };
}

function captured() {
  const lines = [];
  return { lines, out: (s) => lines.push(`OUT ${s}`), err: (s) => lines.push(`ERR ${s}`), text: () => lines.join('\n') };
}

test('env mode writes the clipboard key, mode 600, prints only last 4', () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  const r = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: `  ${FAKE_KEY}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ANTHROPIC_API_KEY saved \(…WXYZ\)$/m);
  assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY));
  assert.ok(!r.stdout.includes('AAAAAAAA'));
  assert.equal(readEnvFile(file).ANTHROPIC_API_KEY, FAKE_KEY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('env mode replaces an existing line and keeps the others', () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'FOO=1\nexport ANTHROPIC_API_KEY=old\nBAR=2\n');
  const r = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: FAKE_HUB_KEY });
  assert.equal(r.status, 0, r.stderr);
  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body, `FOO=1\nANTHROPIC_API_KEY=${FAKE_HUB_KEY}\nBAR=2\n`);
});

test('env mode rejects clipboard text that is not a key, without echoing it', () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  const r = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: 'hello my secret words' });
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes('secret words'));
  assert.ok(!fs.existsSync(file));
  const r2 = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: 'notakey' });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /does not look like/);
  const r3 = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: '' });
  assert.match(r3.stderr, /empty/);
});

test('DATABASE_URL expects a postgres URL and is never printed', () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  const url = 'postgresql://user:p4ss@ep-x.neon.tech/db?sslmode=require';
  const r = runCli(['env', '--file', file, '--var', 'DATABASE_URL'], { clip: url });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('p4ss'));
  assert.equal(readEnvFile(file).DATABASE_URL, url);
  const bad = runCli(['env', '--file', file, '--var', 'DATABASE_URL'], { clip: FAKE_KEY });
  assert.equal(bad.status, 1);
});

test('env mode adds the file to .gitignore inside a git repo, once', () => {
  const repo = tmp();
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  fs.mkdirSync(path.join(repo, 'app'));
  const file = path.join(repo, 'app', '.env.local');
  const r = runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
  const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(gi, /^\/app\/\.env\.local$/m);
  runCli(['env', '--file', file, '--var', 'OTHER_KEY'], { clip: FAKE_KEY });
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), gi, 'already ignored: no second line');
});

test('env mode uses the nearest existing .gitignore and leaves ignored files alone', () => {
  const repo = tmp();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'web'));
  fs.writeFileSync(path.join(repo, 'web', '.gitignore'), 'node_modules');
  const file = path.join(repo, 'web', '.env');
  runCli(['env', '--file', file, '--var', 'ANTHROPIC_API_KEY'], { clip: FAKE_KEY });
  assert.equal(fs.readFileSync(path.join(repo, 'web', '.gitignore'), 'utf8'), 'node_modules\n/.env\n');
  assert.ok(!fs.existsSync(path.join(repo, '.gitignore')));
});

test('--clear-clipboard empties the clipboard after success', () => {
  const dir = tmp();
  const r = runCli(['env', '--file', path.join(dir, '.env'), '--var', 'ANTHROPIC_API_KEY', '--clear-clipboard'], { clip: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(r.clipFile, 'utf8'), '');
  assert.match(r.stdout, /clipboard cleared/);
});

test('usage errors exit 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['env', '--file']).status, 2);
  assert.equal(runCli(['nope']).status, 2);
});

test('parseArgs handles = and boolean flags', () => {
  assert.deepEqual(parseArgs(['hub', '--kind=credit', '--label', 'Max A', '--clear-clipboard']),
    { _: ['hub'], kind: 'credit', label: 'Max A', 'clear-clipboard': true });
});

test('cleanSecret strips quotes and whitespace', () => {
  assert.equal(cleanSecret(`"${FAKE_KEY}"\n`, 'anthropic'), FAKE_KEY);
  assert.throws(() => cleanSecret(FAKE_HUB_KEY, 'anthropic'));
});

test('redact hides keys, tokens and database URLs', () => {
  const s = redact(`a ${FAKE_KEY} b ${FAKE_HUB_KEY} Bearer abcdefghijklmnop postgres://u:p@h/d tok123456789`, ['tok123456789']);
  assert.ok(!s.includes(FAKE_KEY) && !s.includes(FAKE_HUB_KEY) && !s.includes('abcdefghijklmnop') && !s.includes('u:p@h') && !s.includes('tok123456789'));
  assert.match(s, /…WXYZ/);
});

test('upsertEnv quotes values with spaces or #', () => {
  const file = path.join(tmp(), '.env');
  upsertEnv(file, 'X', 'a b#c');
  assert.equal(readEnvFile(file).X, 'a b#c');
});

// ---------- hub mode (fetch mocked; no network) ----------

function hubSetup({ url = 'https://my-hub.example.com' } = {}) {
  const home = tmp();
  const dir = path.join(home, 'myhub');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'HUB_ADMIN_TOKEN'), 'admintoken-0123456789abcdef');
  if (url) fs.writeFileSync(path.join(dir, 'HUB_URL'), `${url}\n`);
  return { CREDITFIRST_CONFIG_HOME: home };
}

function mockFetch(status, json, calls) {
  return async (u, init) => {
    calls.push({ url: u, init });
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('hub mode posts the key with the admin token and prints id, hint, org prefix', async () => {
  const env = hubSetup();
  const calls = [];
  const c = captured();
  const code = await main(['hub', '--hub', 'myhub', '--kind', 'credit', '--label', 'Max 20x', '--monthly-credit', '200', '--renewal-day', '19'], {
    env, readClipboard: () => FAKE_KEY, fetch: mockFetch(200, { id: 3, keyHint: 'sk-ant-api03-…WXYZ', orgId: '0a1b2c3d-aaaa-bbbb-cccc-000000000000' }, calls), out: c.out, err: c.err,
  });
  assert.equal(code, 0, c.text());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://my-hub.example.com/api/admin/accounts');
  assert.equal(calls[0].init.headers.authorization, 'Bearer admintoken-0123456789abcdef');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { label: 'Max 20x', kind: 'credit', monthlyCreditUsd: 200, renewalDay: 19, apiKey: FAKE_KEY });
  assert.match(c.text(), /id=3 key=sk-ant-api03-…WXYZ org=0a1b2c3d…/);
  assert.ok(!c.text().includes(FAKE_KEY) && !c.text().includes('admintoken'));
});

test('hub mode shows the hub error (409) without leaking the key', async () => {
  const env = hubSetup();
  const c = captured();
  const code = await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'company'], {
    env, readClipboard: () => FAKE_KEY, fetch: mockFetch(409, { error: `same organization as a credit account (${FAKE_KEY})` }, []), out: c.out, err: c.err,
  });
  assert.equal(code, 1);
  assert.match(c.text(), /hub error 409: same organization/);
  assert.ok(!c.text().includes(FAKE_KEY));
});

test('hub mode: credit needs monthly credit and renewal day; paid does not', async () => {
  const env = hubSetup();
  const c = captured();
  assert.equal(await main(['hub', '--hub', 'myhub', '--kind', 'credit', '--label', 'x'], { env, readClipboard: () => FAKE_KEY, fetch: mockFetch(200, {}, []), out: c.out, err: c.err }), 2);
  const calls = [];
  assert.equal(await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'x'], { env, readClipboard: () => FAKE_KEY, fetch: mockFetch(200, { id: 9 }, calls), out: c.out, err: c.err }), 0);
  assert.equal(JSON.parse(calls[0].init.body).monthlyCreditUsd, undefined);
});

test('hub mode refuses a hub project key and a missing URL', async () => {
  const c = captured();
  assert.equal(await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'x'], { env: hubSetup(), readClipboard: () => FAKE_HUB_KEY, fetch: mockFetch(200, {}, []), out: c.out, err: c.err }), 1);
  assert.equal(await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'x'], { env: hubSetup({ url: '' }), readClipboard: () => FAKE_KEY, fetch: mockFetch(200, {}, []), out: c.out, err: c.err }), 1);
  assert.match(c.text(), /no hub URL/);
  assert.equal(await main(['hub', '--hub', '../etc', '--kind', 'paid', '--label', 'x'], { env: hubSetup(), readClipboard: () => FAKE_KEY, out: c.out, err: c.err }), 2);
});

test('upsertEnv refuses a symlinked .env and leaves the link target untouched', () => {
  const dir = tmp();
  const target = path.join(dir, 'elsewhere.txt');
  fs.writeFileSync(target, 'x');
  const link = path.join(dir, '.env');
  fs.symlinkSync(target, link);
  assert.throws(() => upsertEnv(link, 'ANTHROPIC_API_KEY', FAKE_KEY), /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
});

test('upsertEnv tightens a pre-existing 0666 file to 0600 and leaves no temp files', () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=1\n', { mode: 0o666 });
  fs.chmodSync(file, 0o666);
  upsertEnv(file, 'ANTHROPIC_API_KEY', FAKE_KEY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
});

test('writeSecretFile creates exclusively with mode 600 and refuses existing paths and symlinks', () => {
  const dir = tmp();
  const f = path.join(dir, 'key');
  writeSecretFile(f, 'v');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.throws(() => writeSecretFile(f, 'w'), /already exists/);
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.join(dir, 'nowhere'), link);
  assert.throws(() => writeSecretFile(link, 'w'), /already exists/);
  assert.ok(!fs.existsSync(path.join(dir, 'nowhere')));
});

test('child processes get only a minimal environment', () => {
  const e = childEnv({ PATH: '/bin', HOME: '/h', LANG: 'C', ANTHROPIC_API_KEY: 'x', BRIDGE_AUTH_TOKEN: 'y', DISPLAY: ':0' });
  assert.deepEqual(e, { PATH: '/bin', HOME: '/h', LANG: 'C', DISPLAY: ':0' });
});

test('hub mode refuses a plain-http hub URL and sends nothing', async () => {
  const c = captured();
  const calls = [];
  const code = await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'x', '--url', 'http://my-hub.example.com'], {
    env: hubSetup(), readClipboard: () => FAKE_KEY, fetch: mockFetch(200, { id: 1 }, calls), out: c.out, err: c.err,
  });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test('hub mode posts with redirect: error', async () => {
  const calls = [];
  const c = captured();
  await main(['hub', '--hub', 'myhub', '--kind', 'paid', '--label', 'x'], { env: hubSetup(), readClipboard: () => FAKE_KEY, fetch: mockFetch(200, { id: 1 }, calls), out: c.out, err: c.err });
  assert.equal(calls[0].init.redirect, 'error');
});
