import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { accountsTable, healthLine, main, poolInfo } from '../hub-admin.mjs';
import { prepareEnvWrite, readEnvFile } from '../put-key.mjs';

const TOKEN = 'admintoken-0123456789abcdef';
const PROJECT_KEY = `cf_${'k'.repeat(36)}LAST`;
const URL = 'https://my-hub.example.com';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hubadmin-')); }

function setup() {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'myhub'));
  fs.writeFileSync(path.join(home, 'myhub', 'HUB_ADMIN_TOKEN'), TOKEN);
  fs.writeFileSync(path.join(home, 'myhub', 'HUB_URL'), URL);
  return { CREDITFIRST_CONFIG_HOME: home };
}

function cap() {
  const lines = [];
  return { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), text: () => lines.join('\n') };
}

/** Routes by "METHOD path" to canned replies; records every call. */
function router(routes, calls = []) {
  const f = async (u, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new globalThis.URL(u).pathname}`;
    calls.push({ key, url: u, init });
    const r = routes[key];
    if (!r) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  f.calls = calls;
  return f;
}

const ACCOUNTS = [
  { id: 1, label: 'Max 20x', kind: 'credit', keyHint: 'sk-ant-api03-…AAAA', status: 'ok', monthlyCreditUsd: 200, renewalDay: 19, cycleEnd: '2026-11-19T00:00:00Z', spentUsd: 12.5, reservedUsd: 0, usableUsd: 184.5 },
  { id: 2, label: 'company paid', kind: 'paid', keyHint: 'sk-ant-api03-…BBBB', status: 'ok', monthlyCreditUsd: null, renewalDay: null, spentUsd: 0, usableUsd: null },
];

test('status prints health and a key-free account table', async () => {
  const c = cap();
  const fetch = router({
    'GET /api/health': { json: { ok: true, db: true, encKey: true, adminToken: true, accounts: { credit: 1, paid: 1 } } },
    'GET /api/admin/accounts': { json: ACCOUNTS },
  });
  assert.equal(await main(['status', '--hub', 'myhub'], { env: setup(), fetch, out: c.out, err: c.err }), 0, c.text());
  const t = c.text();
  assert.match(t, /health: ok {2}db=ok/);
  assert.match(t, /Max 20x\s+credit\s+ok\s+19\s+\$12\.50 \/ \$200\.00\s+\$184\.50\s+2026-11-19/);
  assert.match(t, /company paid\s+paid/);
  assert.ok(!t.includes(TOKEN));
  assert.equal(fetch.calls[0].init.headers.authorization, undefined, 'health needs no auth');
  assert.equal(fetch.calls[1].init.headers.authorization, `Bearer ${TOKEN}`);
});

test('status reports a 401 from the hub', async () => {
  const c = cap();
  const fetch = router({ 'GET /api/health': { json: { ok: true } }, 'GET /api/admin/accounts': { status: 401, json: { error: 'admin token required' } } });
  assert.equal(await main(['status', '--hub', 'myhub'], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  assert.match(c.text(), /hub error 401: admin token required/);
});

test('add-project writes key + base URL to the env file and never prints the key', async () => {
  const c = cap();
  const dir = tmp();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OTHER=1\nANTHROPIC_API_KEY=sk-ant-old\n');
  const fetch = router({ 'POST /api/admin/clients': { json: { id: 7, name: 'landing', key: PROJECT_KEY } } });
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'landing', '--credit-only', '--dotenv', envFile], { env: setup(), fetch, out: c.out, err: c.err }), 0, c.text());
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { name: 'landing', paidFallback: false });
  const vars = readEnvFile(envFile);
  assert.equal(vars.ANTHROPIC_API_KEY, PROJECT_KEY);
  assert.equal(vars.ANTHROPIC_BASE_URL, URL);
  assert.equal(vars.OTHER, '1');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.ok(!c.text().includes(PROJECT_KEY));
  assert.match(c.text(), /…LAST/);
  assert.match(c.text(), /credit-only/);
});

test('add-project defaults to paid fallback and supports --key-file', async () => {
  const c = cap();
  const keyFile = path.join(tmp(), 'k');
  const fetch = router({ 'POST /api/admin/clients': { json: { id: 8, name: 'bot', key: PROJECT_KEY } } });
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--key-file', keyFile], { env: setup(), fetch, out: c.out, err: c.err }), 0, c.text());
  assert.equal(JSON.parse(fetch.calls[0].init.body).paidFallback, true);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), PROJECT_KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!c.text().includes(PROJECT_KEY));
});

test('add-project refuses to run without a destination file', async () => {
  const c = cap();
  const fetch = router({});
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'x'], { env: setup(), fetch, out: c.out, err: c.err }), 2);
  assert.equal(fetch.calls.length, 0, 'no key is created when it has nowhere to go');
});

test('test sends one haiku request with the project key and shows the pool and account label', async () => {
  const c = cap();
  const envFile = path.join(tmp(), '.env');
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${PROJECT_KEY}\nANTHROPIC_BASE_URL=${URL}/\n`);
  const fetch = router({
    'POST /v1/messages': { json: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 14, output_tokens: 2 } }, headers: { 'x-hub-pool': 'credit', 'x-hub-account': '1' } },
    'GET /api/admin/accounts': { json: ACCOUNTS },
  });
  assert.equal(await main(['test', '--hub', 'myhub', '--dotenv', envFile], { env: setup(), fetch, out: c.out, err: c.err }), 0, c.text());
  const call = fetch.calls[0];
  assert.equal(call.url, `${URL}/v1/messages`);
  assert.equal(call.init.headers['x-api-key'], PROJECT_KEY);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.max_tokens, 16);
  const t = c.text();
  assert.match(t, /status: 200/);
  assert.match(t, /pool: credit \(account #1 "Max 20x"\)/);
  assert.match(t, /model: claude-haiku-4-5/);
  assert.match(t, /tokens: in 14 \/ out 2/);
  assert.ok(!t.includes(PROJECT_KEY));
});

test('test explains a credit-only 402', async () => {
  const c = cap();
  const envFile = path.join(tmp(), '.env');
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${PROJECT_KEY}\n`);
  const fetch = router({
    'POST /v1/messages': { status: 402, json: { type: 'error', error: { type: 'billing_error', message: 'no credit account can take this request' } }, headers: { 'x-hub-pool': 'none', 'x-hub-error': 'credit-unavailable' } },
  });
  assert.equal(await main(['test', '--hub', 'myhub', '--dotenv', envFile], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  assert.match(c.text(), /status: 402/);
  assert.match(c.text(), /hub error \[credit-unavailable\]: no credit account can take this request/);
  assert.match(c.text(), /pool: none/);
});

test('arg parsing: missing --hub, unknown command, bad hub name', async () => {
  const c = cap();
  assert.equal(await main(['status'], { env: setup(), fetch: router({}), out: c.out, err: c.err }), 2);
  assert.equal(await main(['frob', '--hub', 'myhub'], { env: setup(), fetch: router({}), out: c.out, err: c.err }), 2);
  assert.equal(await main(['status', '--hub', 'a/b'], { env: setup(), fetch: router({}), out: c.out, err: c.err }), 2);
  assert.equal(await main([], { out: c.out, err: c.err }), 2);
});

test('helpers: table, health line, pool headers', () => {
  assert.match(accountsTable([]), /^id\s+label/);
  assert.match(healthLine({ ok: false, db: false }), /NOT OK {2}db=MISSING/);
  assert.deepEqual(poolInfo(new Headers({ 'x-hub-pool': 'paid', 'x-hub-account': '2' })), { pool: 'paid', account: '2', error: null, cost: null });
});

test('test reports a generic hub error (x-hub-error: 1) as coming from the hub, with its message', async () => {
  const c = cap();
  const envFile = path.join(tmp(), '.env');
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${PROJECT_KEY}\nANTHROPIC_BASE_URL=${URL}\n`);
  const fetch = router({
    'POST /v1/messages': { status: 503, json: { type: 'error', error: { type: 'overloaded_error', message: 'no account can take this request' } }, headers: { 'x-hub-error': '1' } },
  });
  assert.equal(await main(['test', '--hub', 'myhub', '--dotenv', envFile], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  const t = c.text();
  assert.match(t, /pool: none \(the hub answered this request itself\)/);
  assert.match(t, /hub error: no account can take this request/);
  assert.ok(!t.includes('did not go through'));
  assert.ok(!/hub error: 1\b/.test(t));
});

test('test without --hub calls Anthropic directly using the key from the file', async () => {
  const c = cap();
  const envFile = path.join(tmp(), '.env');
  const direct = `sk-ant-api03-${'d'.repeat(60)}ZZZZ`;
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${direct}\n`);
  const fetch = router({ 'POST /v1/messages': { json: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 14, output_tokens: 1 } } } });
  assert.equal(await main(['test', '--dotenv', envFile], { env: {}, fetch, out: c.out, err: c.err }), 0, c.text());
  assert.equal(fetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(fetch.calls[0].init.redirect, 'error');
  assert.match(c.text(), /pool: direct to Anthropic \(no hub\)/);
  assert.ok(!c.text().includes(direct));
});

test('test refuses a non-https base URL (http only for localhost)', async () => {
  const c = cap();
  const envFile = path.join(tmp(), '.env');
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${PROJECT_KEY}\nANTHROPIC_BASE_URL=http://evil.example.com\n`);
  const fetch = router({});
  assert.equal(await main(['test', '--dotenv', envFile], { env: {}, fetch, out: c.out, err: c.err }), 2);
  assert.equal(fetch.calls.length, 0, 'the key is never sent over plain http');
  fs.writeFileSync(envFile, `ANTHROPIC_API_KEY=${PROJECT_KEY}\nANTHROPIC_BASE_URL=http://localhost:3000\n`);
  const ok = router({ 'POST /v1/messages': { json: { content: [] }, headers: { 'x-hub-pool': 'credit', 'x-hub-account': '1' } } });
  assert.equal(await main(['test', '--dotenv', envFile], { env: {}, fetch: ok, out: c.out, err: c.err }), 0);
});

test('add-project checks destinations before creating the one-time key (existing --key-file: no POST)', async () => {
  const c = cap();
  const keyFile = path.join(tmp(), 'k');
  fs.writeFileSync(keyFile, 'someone else');
  const fetch = router({ 'POST /api/admin/clients': { json: { id: 8, name: 'bot', key: PROJECT_KEY } } });
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--key-file', keyFile], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  assert.equal(fetch.calls.length, 0, 'the project must not be created when the key has nowhere to go');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'someone else');
  assert.match(c.text(), /already exists/);
});

test('add-project: symlinked --dotenv is refused before the POST, and the --key-file opened first is removed', async () => {
  const c = cap();
  const dir = tmp();
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, path.join(dir, '.env'));
  const keyFile = path.join(dir, 'k');
  const fetch = router({ 'POST /api/admin/clients': { json: { id: 8, name: 'bot', key: PROJECT_KEY } } });
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--key-file', keyFile, '--dotenv', path.join(dir, '.env')], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  assert.equal(fetch.calls.length, 0);
  assert.ok(!fs.existsSync(keyFile));
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', 'target']);
});

test('add-project: hub refusal (409) removes the prepared empty files', async () => {
  const c = cap();
  const dir = tmp();
  const keyFile = path.join(dir, 'k');
  const fetch = router({ 'POST /api/admin/clients': { status: 409, json: { error: 'name already used' } } });
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--key-file', keyFile, '--dotenv', path.join(dir, '.env')], { env: setup(), fetch, out: c.out, err: c.err }), 1);
  assert.match(c.text(), /hub error 409: name already used/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('add-project: if a destination breaks after the POST, the key is rescued into the config folder', async () => {
  const c = cap();
  const dir = tmp();
  const envFile = path.join(dir, '.env');
  const env = setup();
  const fetch = async (u, init) => {
    // Simulate the target turning into a symlink between the check and the write.
    fs.writeFileSync(path.join(dir, 'other'), 'x');
    fs.symlinkSync(path.join(dir, 'other'), envFile);
    return new Response(JSON.stringify({ id: 9, name: 'bot', key: PROJECT_KEY }), { status: 200 });
  };
  assert.equal(await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--dotenv', envFile], { env, fetch, out: c.out, err: c.err }), 1);
  const rescued = fs.readdirSync(path.join(env.CREDITFIRST_CONFIG_HOME, 'myhub')).filter((f) => f.startsWith('rescued-bot-'));
  assert.equal(rescued.length, 1);
  const rf = path.join(env.CREDITFIRST_CONFIG_HOME, 'myhub', rescued[0]);
  assert.equal(fs.readFileSync(rf, 'utf8'), PROJECT_KEY);
  assert.equal(fs.statSync(rf).mode & 0o777, 0o600);
  assert.ok(!c.text().includes(PROJECT_KEY));
  assert.equal(fs.readFileSync(path.join(dir, 'other'), 'utf8'), 'x');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
});

test('hub admin calls use https and redirect: error', async () => {
  const c = cap();
  const env = setup();
  fs.writeFileSync(path.join(env.CREDITFIRST_CONFIG_HOME, 'myhub', 'HUB_URL'), 'http://my-hub.example.com');
  const fetch = router({});
  assert.equal(await main(['status', '--hub', 'myhub'], { env, fetch, out: c.out, err: c.err }), 2);
  assert.equal(fetch.calls.length, 0);
  const ok = router({ 'GET /api/health': { json: { ok: true } }, 'GET /api/admin/accounts': { json: [] } });
  assert.equal(await main(['status', '--hub', 'myhub'], { env: setup(), fetch: ok, out: c.out, err: c.err }), 0);
  assert.ok(ok.calls.every((x) => x.init.redirect === 'error'));
});

test('add-project fault injection: commit and abort both throw after a successful POST -> key still rescued', async () => {
  const c = cap();
  const dir = tmp();
  const env = setup();
  const keyFile = path.join(dir, 'k');
  let aborts = 0;
  const faulty = (file) => {
    const real = prepareEnvWrite(file);
    return {
      file: real.file,
      commit() { throw new Error('disk full'); },
      abort() { aborts++; real.abort(); throw new Error('unlink failed'); },
    };
  };
  const fetch = router({ 'POST /api/admin/clients': { json: { id: 11, name: 'bot', key: PROJECT_KEY } } });
  const code = await main(['add-project', '--hub', 'myhub', '--name', 'bot', '--dotenv', path.join(dir, '.env'), '--key-file', keyFile],
    { env, fetch, out: c.out, err: c.err, prepareEnvWrite: faulty });
  assert.equal(code, 1);
  assert.equal(fetch.calls.length, 1);
  const cfg = path.join(env.CREDITFIRST_CONFIG_HOME, 'myhub');
  const rescued = fs.readdirSync(cfg).filter((f) => f.startsWith('rescued-bot-'));
  assert.equal(rescued.length, 1, 'exactly one rescue write');
  assert.equal(fs.readFileSync(path.join(cfg, rescued[0]), 'utf8'), PROJECT_KEY);
  assert.equal(aborts, 1, 'abort was attempted and its throw was swallowed');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), PROJECT_KEY, 'the key file that did succeed is kept');
  assert.match(c.text(), /could not write .*disk full/);
  assert.match(c.text(), /kept in .*rescued-bot-/);
  assert.ok(!c.text().includes(PROJECT_KEY));
});
