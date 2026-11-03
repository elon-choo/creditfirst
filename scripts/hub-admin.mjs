#!/usr/bin/env node
// CreditFirst hub-admin: a thin client for your own hub's admin API. Never prints a key.
//
//   node scripts/hub-admin.mjs status --hub <name> [--url <hub-url>]
//   node scripts/hub-admin.mjs add-project --hub <name> --name <app> [--credit-only]
//        (--dotenv <path> | --key-file <path>) [--url <hub-url>]
//   node scripts/hub-admin.mjs test --dotenv <path> [--hub <name>] [--model <id>]
//        (without a hub: calls ANTHROPIC_BASE_URL from the file, or https://api.anthropic.com)
//
// Admin token and hub URL are read from ~/.config/creditfirst/<name>/ (HUB_ADMIN_TOKEN, HUB_URL).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UsageError, checkUrl, ensureGitignored, hubErrorLine, hubFetch, isTracked, last4, loadHub, openSecretFile, parseArgs, prepareEnvWrite, readEnvFile, redact, writeSecretFile,
} from './put-key.mjs';

const USAGE = `usage:
  hub-admin.mjs status --hub <name> [--url <hub-url>]
  hub-admin.mjs add-project --hub <name> --name <app> [--credit-only] (--dotenv <path> | --key-file <path>) [--url <hub-url>]
  hub-admin.mjs test --dotenv <path> [--hub <name>] [--model <id>] [--url <hub-url>]
      (no --hub: tests the file's ANTHROPIC_API_KEY against ANTHROPIC_BASE_URL or https://api.anthropic.com)`;

export const DEFAULT_TEST_MODEL = 'claude-haiku-4-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com';

function fmtUsd(v) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

function fmtDate(v) {
  if (!v) return '-';
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** Renders rows (arrays of strings) as an aligned plain-text table. */
export function table(head, rows) {
  const all = [head, ...rows].map((r) => r.map((c) => String(c ?? '-')));
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

/** Account list → table text. Only fields the hub returns without secrets; redacted again anyway. */
export function accountsTable(accounts) {
  const rows = (accounts ?? []).map((a) => [
    a.id, a.label, a.kind, a.status ?? (a.enabled === false ? 'off' : '-'),
    a.kind === 'credit' ? (a.renewalDay ?? '-') : '-',
    a.kind === 'credit' ? `${fmtUsd(a.spentUsd)} / ${fmtUsd(a.monthlyCreditUsd)}` : fmtUsd(a.spentUsd),
    a.kind === 'credit' ? fmtUsd(a.usableUsd) : '-',
    fmtDate(a.cycleEnd), a.keyHint ?? '-',
  ]);
  return table(['id', 'label', 'kind', 'status', 'renews', 'spent / credit', 'usable', 'cycle end', 'key'], rows);
}

export function healthLine(h) {
  if (!h || typeof h !== 'object') return 'health: no JSON reply';
  const flag = (v) => (v === true || v === 'ok' ? 'ok' : v === false ? 'MISSING' : String(v ?? '-'));
  const acc = h.accounts ?? {};
  return `health: ${h.ok ? 'ok' : 'NOT OK'}  db=${flag(h.db)}  encKey=${flag(h.encKey)}  adminToken=${flag(h.adminToken)}  accounts: credit=${acc.credit ?? '-'} paid=${acc.paid ?? '-'}`;
}

async function cmdStatus(args, d) {
  const hub = loadHub(args.hub, { url: args.url, env: d.env });
  const secrets = [hub.token];
  d.out(`hub: ${hub.url}`);
  const h = await hubFetch(hub, '/api/health', { auth: false, fetchImpl: d.fetch });
  d.out(redact(h.ok || h.json ? healthLine(h.json) : `health: HTTP ${h.status}`, secrets));
  const a = await hubFetch(hub, '/api/admin/accounts', { fetchImpl: d.fetch });
  if (!a.ok) { d.err(hubErrorLine(a, secrets)); return 1; }
  const list = Array.isArray(a.json) ? a.json : (a.json?.accounts ?? []);
  d.out(list.length ? redact(accountsTable(list), secrets) : 'no accounts registered yet');
  return 0;
}

/** Last resort when a destination fails after the hub already created the one-time key. */
function rescueKey(hub, app, key) {
  const f = path.join(hub.dir, `rescued-${app.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.key`);
  try { return writeSecretFile(f, key); } catch { return null; }
}

async function cmdAddProject(args, d) {
  if (!args.name?.trim()) throw new UsageError('add-project needs --name <app>');
  if (!args['dotenv'] && !args['key-file']) {
    throw new UsageError('add-project needs --dotenv <path> (or --key-file <path>) so the key goes straight to a file and never into the conversation');
  }
  const hub = loadHub(args.hub, { url: args.url, env: d.env });
  // Open every destination BEFORE the hub creates the key: the key is shown once and a retry with the same name is refused.
  let envW = null;
  let keyFd = null;
  let keyPath = null;
  let keyWritten = false;
  const quiet = (fn) => { try { fn(); } catch { /* best effort */ } };
  // Best effort: nothing here may throw, so the rescue below always gets its chance.
  const cleanup = () => {
    if (envW) { const w = envW; envW = null; quiet(() => w.abort()); }
    if (keyFd !== null) { const fd = keyFd; keyFd = null; quiet(() => fs.closeSync(fd)); }
    if (keyPath && !keyWritten) quiet(() => fs.rmSync(keyPath, { force: true }));
  };
  try {
    // keyPath is set only once WE created the file, so cleanup can never delete someone else's file.
    if (args['key-file']) { const p = path.resolve(args['key-file']); keyFd = openSecretFile(p); keyPath = p; }
    if (args['dotenv']) envW = (d.prepareEnvWrite ?? prepareEnvWrite)(args['dotenv']);
  } catch (e) {
    cleanup();
    throw e;
  }
  const body = { name: args.name.trim(), paidFallback: !args['credit-only'] };
  let r;
  try {
    r = await hubFetch(hub, '/api/admin/clients', { method: 'POST', body, fetchImpl: d.fetch });
  } catch (e) {
    cleanup();
    throw e;
  }
  const key = r.ok ? r.json?.key : null;
  if (!r.ok || typeof key !== 'string' || !key) {
    cleanup();
    d.err(r.ok ? 'hub replied without a key' : hubErrorLine(r, [hub.token]));
    return 1;
  }
  // From here on a one-time key exists: any destination that did not complete triggers the rescue FIRST.
  const secrets = [key, hub.token];
  const problems = [];
  let envDone = !envW;
  let envFile = null;
  quiet(() => d.out(redact(`project "${r.json.name ?? body.name}" created: id=${r.json.id ?? '?'} key=${last4(key)} ${args['credit-only'] ? 'credit-only (402 when credit is short)' : 'paid fallback allowed'}`, secrets)));
  if (keyFd !== null) {
    try {
      fs.writeFileSync(keyFd, key);
      fs.fchmodSync(keyFd, 0o600);
      keyWritten = true;
    } catch (e) {
      problems.push(`could not write ${keyPath}: ${e.message}`);
    }
  }
  if (envW) {
    try {
      envFile = envW.commit([['ANTHROPIC_API_KEY', key], ['ANTHROPIC_BASE_URL', hub.url]]).file;
      envW = null;
      envDone = true;
    } catch (e) {
      problems.push(`could not write ${args['dotenv']}: ${e.message}`);
    }
  }
  if (problems.length || (keyPath && !keyWritten) || !envDone) {
    const saved = rescueKey(hub, body.name, key);
    cleanup();
    for (const p of problems) quiet(() => d.err(redact(p, secrets)));
    d.err(saved ? `the key was kept in ${saved} (mode 600) so it is not lost; move it where it belongs, then delete that file`
      : 'the key could not be saved anywhere; disable this project in the hub and create a new one with another name');
    return 1;
  }
  cleanup(); // closes the key file fd
  if (keyWritten) d.out(`key saved (${last4(key)}) to ${keyPath} (mode 600). Delete it after you copy it into your host's env.`);
  if (envFile) {
    d.out(`ANTHROPIC_API_KEY saved (${last4(key)}) and ANTHROPIC_BASE_URL=${hub.url} in ${envFile}`);
    try {
      const gi = ensureGitignored(envFile);
      if (gi) d.out(`added ${path.basename(envFile)} to ${gi}`);
      if (isTracked(envFile)) d.out(`warning: git already tracks ${envFile}; run: git rm --cached "${envFile}"`);
    } catch (e) {
      d.err(`could not update .gitignore: ${e.message}`);
    }
  }
  d.out('The hub keeps only a hash: this key cannot be shown again.');
  return 0;
}

/** Response headers worth showing from a hub reply. */
export function poolInfo(headers) {
  const get = (n) => (typeof headers?.get === 'function' ? headers.get(n) : headers?.[n]) ?? null;
  return { pool: get('x-hub-pool'), account: get('x-hub-account'), error: get('x-hub-error'), cost: get('x-hub-cost-usd') ?? get('x-hub-cost') };
}

/** Describes where the answer came from, from the hub headers and body. */
export function describeOrigin(status, p, body, viaHub) {
  const lines = [];
  const hubMsg = body?.error?.message ?? (typeof body?.error === 'string' ? body.error : null);
  if (p.pool) {
    lines.push(`pool: ${p.pool}${p.account && p.account !== '0' ? ` (account #${p.account}${p.label ? ` "${p.label}"` : ''})` : ''}`);
  } else if (p.error) {
    lines.push('pool: none (the hub answered this request itself)');
  } else if (!viaHub) {
    lines.push('pool: direct to Anthropic (no hub)');
  } else {
    lines.push('pool: (no x-hub-pool header - check that ANTHROPIC_BASE_URL is your hub)');
  }
  if (p.error) {
    // x-hub-error is a reason code (credit-unavailable, paid-cap-reached, all-accounts-failed) or "1" for a generic hub error.
    const code = p.error === '1' ? '' : ` [${p.error}]`;
    lines.push(`hub error${code}: ${hubMsg ?? `HTTP ${status}`}`);
  }
  return lines;
}

async function cmdTest(args, d) {
  if (!args['dotenv']) throw new UsageError('test needs --dotenv <path> (the project .env with ANTHROPIC_API_KEY)');
  const envFile = path.resolve(args['dotenv']);
  const vars = readEnvFile(envFile);
  const key = vars.ANTHROPIC_API_KEY;
  if (!key) { d.err(`no ANTHROPIC_API_KEY in ${envFile}`); return 1; }
  let hub = null;
  if (args.hub) {
    try { hub = loadHub(args.hub, { url: args.url, env: d.env }); } catch (e) { if (e instanceof UsageError) throw e; /* test still works without admin files */ }
  }
  const base = checkUrl(vars.ANTHROPIC_BASE_URL || args.url || hub?.url || ANTHROPIC_URL);
  const viaHub = !/^https:\/\/api\.anthropic\.com$/i.test(base);
  const secrets = [key, hub?.token].filter(Boolean);
  const model = args.model || DEFAULT_TEST_MODEL;
  d.out(`sending one tiny request (${model}, max_tokens 16) to ${base} - a real request billed at a fraction of a cent${viaHub ? ', normally from your credit' : ''}`);
  const res = await d.fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* keep text */ }
  const p = poolInfo(res.headers);
  d.out(`status: ${res.status}`);
  if (hub && p.pool && p.account && p.account !== '0') {
    try {
      const a = await hubFetch(hub, '/api/admin/accounts', { fetchImpl: d.fetch });
      const row = Array.isArray(a.json) ? a.json.find((x) => String(x.id) === String(p.account)) : null;
      if (row) p.label = row.label;
    } catch { /* label is optional */ }
  }
  for (const l of describeOrigin(res.status, p, j, viaHub)) d.out(redact(l, secrets));
  if (j?.model) d.out(`model: ${j.model}`);
  if (j?.usage) d.out(`tokens: in ${j.usage.input_tokens ?? '?'} / out ${j.usage.output_tokens ?? '?'}`);
  if (p.cost) d.out(`cost: ${fmtUsd(p.cost)}`);
  if (res.ok) {
    const reply = Array.isArray(j?.content) ? j.content.map((c) => c.text ?? '').join('').trim() : '';
    d.out(redact(`reply: ${reply.slice(0, 80) || '(empty)'}`, secrets));
    return 0;
  }
  if (!p.error) {
    const msg = j?.error?.message ?? j?.error ?? text.slice(0, 300);
    d.err(redact(`error: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, secrets));
  }
  return 1;
}

export async function main(argv, deps = {}) {
  const d = {
    env: process.env,
    fetch: globalThis.fetch,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    ...deps,
  };
  try {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (args.help || !cmd) { d.out(USAGE); return cmd || args.help ? 0 : 2; }
    if (!args.hub && cmd !== 'test') throw new UsageError('--hub <name> is required');
    if (cmd === 'status') return await cmdStatus(args, d);
    if (cmd === 'add-project') return await cmdAddProject(args, d);
    if (cmd === 'test') return await cmdTest(args, d);
    throw new UsageError(`unknown command: ${cmd}`);
  } catch (e) {
    d.err(`hub-admin: ${redact(e.message)}`);
    if (e instanceof UsageError) { d.err(USAGE); return 2; }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
