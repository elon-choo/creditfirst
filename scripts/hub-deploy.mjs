#!/usr/bin/env node
// CreditFirst hub-deploy: deploy hub/ to YOUR Vercel account, with its own Postgres and secrets.
//
//   node scripts/hub-deploy.mjs --name <hub-name> [--scope <vercel-team-slug>] [--timezone <IANA>]
//        [--lang en|ko] [--database-url-from-clipboard] [--dry-run]
//
// Steps: vercel whoami → vercel link → stop if the project holds secrets missing locally → secrets in
// ~/.config/creditfirst/<name>/ (dir 0700, files 0600, reused on re-runs) → Postgres (DATABASE_URL already set, or the Neon Marketplace integration in an interactive
// terminal, or a connection string from the clipboard) → production env vars (values on stdin, never argv)
// → vercel deploy --prod → poll /api/health → check the admin token → save HUB_URL.
// Child processes get a minimal environment (no app secrets); everything runs with umask 077.
// Progress goes to stderr; stdout gets ONE final JSON line. Secrets are never printed.
// Node >= 20, node: builtins only.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HUB_DIR = path.resolve(HERE, '..', 'hub');

export const USAGE = `usage: node scripts/hub-deploy.mjs --name <hub-name> [--scope <vercel-team-slug>] [--timezone <IANA>] [--lang en|ko] [--database-url-from-clipboard] [--dry-run]`;

export class UsageError extends Error {}

/** A failed step: the final JSON line names it. */
export class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}

// ---------- arguments ----------

const BOOLEAN = new Set(['database-url-from-clipboard', 'dry-run', 'help']);
const VALUED = new Set(['name', 'scope', 'timezone', 'lang']);

export function parseArgs(argv) {
  const out = { databaseUrlFromClipboard: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOLEAN.has(name)) {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      out[name === 'database-url-from-clipboard' ? 'databaseUrlFromClipboard' : name === 'dry-run' ? 'dryRun' : 'help'] = true;
      continue;
    }
    if (!VALUED.has(name)) throw new UsageError(`unknown option: --${name}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
    out[name] = value;
  }
  if (out.help) return out;
  if (!out.name) throw new UsageError('--name is required');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(out.name)) {
    throw new UsageError('--name must be lowercase letters, digits and dashes (1-63 chars, no leading/trailing dash)');
  }
  if (out.scope !== undefined && !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(out.scope)) throw new UsageError('--scope must be a Vercel team slug');
  if (out.timezone !== undefined && !isTimeZone(out.timezone)) throw new UsageError(`--timezone "${out.timezone}" is not an IANA time zone (e.g. UTC, Asia/Seoul, America/Los_Angeles)`);
  if (out.lang !== undefined && out.lang !== 'en' && out.lang !== 'ko') throw new UsageError('--lang must be en or ko');
  return out;
}

export function isTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// ---------- secrets on disk ----------

export const SECRET_NAMES = ['HUB_ENC_KEY', 'HUB_ADMIN_TOKEN', 'CRON_SECRET'];

/** ~/.config/creditfirst/<name>/ (CREDITFIRST_CONFIG_HOME overrides the parent, as in put-key.mjs). */
export function configDir(name, env = process.env) {
  const base = env.CREDITFIRST_CONFIG_HOME || path.join(os.homedir(), '.config', 'creditfirst');
  return path.join(base, name);
}

function generate(name) {
  // HUB_ENC_KEY: 32 raw bytes, base64 (what the hub decodes). The tokens: 32 bytes, base64url (43 chars).
  return name === 'HUB_ENC_KEY' ? randomBytes(32).toString('base64') : randomBytes(32).toString('base64url');
}

/**
 * Creates the config dir (0700) and any missing secret file (0600). Existing files are never overwritten,
 * so a re-run reuses them. Returns the values and which ones were created just now.
 */
export function ensureSecrets(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const values = {};
  const created = [];
  for (const name of SECRET_NAMES) {
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, generate(name) + '\n', { flag: 'wx', mode: 0o600 });
      created.push(name);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    fs.chmodSync(file, 0o600);
    const v = fs.readFileSync(file, 'utf8').trim();
    if (!v) throw new StepError('secrets', `${file} is empty; delete it to generate a new one`);
    values[name] = v;
  }
  return { values, created };
}

/** Which secret files exist, without reading them (for --dry-run). */
export function secretFilesPresent(dir) {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, fs.existsSync(path.join(dir, n))]));
}

/** Writes HUB_URL (not a secret, but kept beside them; replaced on every deploy). */
export function saveHubUrl(dir, url) {
  const file = path.join(dir, 'HUB_URL');
  fs.writeFileSync(file, url.replace(/\/+$/, '') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

// ---------- redaction ----------

/**
 * Removes known secret values and things that really are secrets: URLs that carry credentials
 * (scheme://user:password@host…), API keys, project keys and `token=…`-style assignments.
 * Plain help text such as "postgres://…" stays readable.
 */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && v.length >= 8) s = s.split(v).join('[redacted]');
  return s
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:"'`]+:[^\s@"'`]+@[^\s"'`]+/gi, '$1://[redacted]')
    .replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, 'sk-ant-[redacted]')
    .replace(/\bcf_[A-Za-z0-9_-]{8,}/g, 'cf_[redacted]')
    .replace(/\b(token|secret|password)(\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.+/=]{12,}/gi, '$1$2[redacted]');
}

export function isPostgresUrl(s) {
  return /^postgres(?:ql)?:\/\/[^\s/@]+(?::[^\s@]*)?@[^\s/]+\/\S*$/.test(s);
}

// ---------- clipboard ----------

export function readClipboard(platform = process.platform, run = spawnSync) {
  const tries = platform === 'darwin' ? [['pbpaste', []]]
    : platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
      : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, args] of tries) {
    const r = run(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
    if (r.status === 0 && typeof r.stdout === 'string') return r.stdout.trim();
  }
  throw new StepError('database', 'could not read the clipboard (pbpaste / wl-paste / xclip / xsel / powershell Get-Clipboard)');
}

// ---------- vercel ----------

function log(msg) { process.stderr.write(`[hub-deploy] ${msg}\n`); }

const CHILD_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'ProgramFiles', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

/**
 * The environment child processes get: what the Vercel CLI (and clipboard tools) need to run and authenticate
 * (VERCEL_* such as VERCEL_TOKEN), and nothing else — no app or hub secrets from the caller's shell.
 */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (CHILD_ENV_NAMES.has(k) || /^VERCEL_/.test(k)) out[k] = v;
  }
  out.NO_COLOR = '1';
  out.FORCE_COLOR = '0';
  return out;
}

/**
 * `vercel link` (and other commands) write pulled env vars such as hub/.env.local. Those can hold DATABASE_URL and
 * other secrets, so every such file is made owner-only right after each Vercel call.
 */
export function lockEnvFiles(dir) {
  const fixed = [];
  for (const d of [dir, path.join(dir, '.vercel')]) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^\.env/.test(n)) continue;
      const f = path.join(d, n);
      try {
        if (!fs.statSync(f).isFile()) continue;
        if ((fs.statSync(f).mode & 0o077) !== 0) { fs.chmodSync(f, 0o600); fixed.push(f); }
      } catch { /* ignore */ }
    }
  }
  return fixed;
}

export function makeVercel({ cwd, scope, secrets, run = spawnSync }) {
  const env = childEnv();
  return function vercel(args, { input, interactive = false, step = 'vercel' } = {}) {
    const full = [...args, ...(scope ? ['--scope', scope] : [])];
    const r = run('vercel', full, {
      cwd, env, encoding: 'utf8', input,
      stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
    lockEnvFiles(cwd);
    if (r.error) throw new StepError(step, r.error.code === 'ENOENT' ? 'vercel CLI not found; install it with: npm i -g vercel' : redact(r.error.message, secrets()));
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

function tail(r, secrets) {
  return redact(`${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-6).join(' | '), secrets).slice(0, 600);
}

/** Names of the production env vars (`vercel env ls production` prints names, never values). */
export function parseEnvNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)\s+/);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Picks the stable production alias (<project>[-<scope>].vercel.app or a custom domain) from `vercel inspect --json`. */
export function pickProductionUrl(inspectJson, deploymentUrl, project) {
  let aliases = [];
  try {
    const j = JSON.parse(inspectJson);
    aliases = [j.alias, j.aliases, j.deployment?.alias].flat().filter((a) => typeof a === 'string');
  } catch { /* fall back below */ }
  const norm = (a) => (a.startsWith('http') ? a : `https://${a}`).replace(/\/+$/, '');
  const urls = aliases.map(norm);
  const exact = urls.find((u) => u === `https://${project}.vercel.app`);
  const own = urls.filter((u) => u.startsWith(`https://${project}`) && u.endsWith('.vercel.app')).sort((a, b) => a.length - b.length)[0];
  return exact || own || urls.sort((a, b) => a.length - b.length)[0] || norm(deploymentUrl);
}

export function plan(opts, dir) {
  return [
    'vercel whoami',
    `vercel link --yes --project ${opts.name}${opts.scope ? ` --scope ${opts.scope}` : ''} (in hub/; pulled .env files are made 0600)`,
    'vercel env ls production: stop if the project has HUB_ENC_KEY/HUB_ADMIN_TOKEN that are missing locally',
    `secrets: reuse or create ${SECRET_NAMES.join(', ')} in ${dir} (dir 0700, files 0600)`,
    opts.databaseUrlFromClipboard
      ? 'database: DATABASE_URL from the clipboard (unless the project already has DATABASE_URL)'
      : 'database: keep DATABASE_URL if set; else `vercel integration add neon` (interactive terminal only; choose the Free plan)',
    `vercel env add <NAME> production (value on stdin): ${[...SECRET_NAMES, 'HUB_TIMEZONE', 'HUB_LANG'].join(', ')}`,
    'vercel deploy --prod --yes',
    'poll <production-url>/api/health until ok, check the local HUB_ADMIN_TOKEN against /api/admin/accounts, then save HUB_URL',
  ];
}

// ---------- main ----------

/**
 * Secrets the deployed hub already holds and that cannot be regenerated without breaking it: HUB_ENC_KEY
 * (stored account keys become unreadable) and HUB_ADMIN_TOKEN (the local copy is how you administer the hub).
 * Returns the names that exist remotely but are missing locally.
 */
export function missingLocalSecrets(dir, remoteNames) {
  return ['HUB_ENC_KEY', 'HUB_ADMIN_TOKEN'].filter((n) => remoteNames.has(n) && !fs.existsSync(path.join(dir, n)));
}

export async function deploy(opts, deps = {}) {
  if (opts.dryRun) return deployInner(opts, deps);
  // Files created by this run or by the Vercel CLI (e.g. hub/.env.local) are owner-only from the start.
  const previous = process.umask(0o077);
  try {
    return await deployInner(opts, deps);
  } finally {
    process.umask(previous);
    lockEnvFiles(HUB_DIR);
  }
}

async function deployInner(opts, { run = spawnSync, fetchFn = fetch, clipboard = readClipboard, isTTY = !!process.stdin.isTTY, healthTimeoutMs = 180_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = configDir(opts.name);
  let secretValues = [];
  const secrets = () => secretValues;

  if (opts.dryRun) {
    return { ok: true, dryRun: true, project: opts.name, configDir: dir, secretFiles: secretFilesPresent(dir), steps: plan(opts, dir) };
  }
  if (!fs.existsSync(path.join(HUB_DIR, 'package.json'))) throw new StepError('hub', `hub/ not found at ${HUB_DIR}`);
  const vercel = makeVercel({ cwd: HUB_DIR, scope: opts.scope, secrets, run });

  log('checking vercel login');
  const who = vercel(['whoami'], { step: 'whoami' });
  if (who.status !== 0) throw new StepError('whoami', 'not logged in to Vercel: run `vercel login` first');

  log(`linking Vercel project ${opts.name}`);
  const link = vercel(['link', '--yes', '--project', opts.name], { step: 'link' });
  if (link.status !== 0) throw new StepError('link', `vercel link failed: ${tail(link, secrets())}`);

  const listEnv = () => {
    const r = vercel(['env', 'ls', 'production'], { step: 'env' });
    if (r.status !== 0) throw new StepError('env', `vercel env ls failed: ${tail(r, secrets())}`);
    return parseEnvNames(`${r.stdout}\n${r.stderr}`);
  };
  const addEnv = (name, value, existing) => {
    if (existing.has(name)) {
      const rm = vercel(['env', 'rm', name, 'production', '--yes'], { step: 'env' });
      if (rm.status !== 0) throw new StepError('env', `could not replace ${name}: ${tail(rm, secrets())}`);
    }
    const r = vercel(['env', 'add', name, 'production'], { input: value, step: 'env' });
    if (r.status !== 0) throw new StepError('env', `could not set ${name}: ${tail(r, secrets())}`);
  };

  let names = listEnv();

  // Check what the deployed project already has BEFORE creating anything locally, so a lost local secret
  // is never silently replaced by a new one that does not match the hub.
  const lost = missingLocalSecrets(dir, names);
  if (lost.length) {
    throw new StepError('secrets', `the Vercel project already has ${lost.join(' and ')} but ${lost.map((n) => path.join(dir, n)).join(' and ')} is missing here. Nothing was changed. Restore the file(s) from your backup and re-run. If you cannot: for HUB_ADMIN_TOKEN, remove it in Vercel (Project → Settings → Environment Variables) and re-run to set a new one; for HUB_ENC_KEY, remove it in Vercel only if you accept re-entering every account key, then re-run.`);
  }
  log(`secrets in ${dir}`);
  const { values, created } = ensureSecrets(dir);
  secretValues = Object.values(values);

  // Database
  let database = 'existing';
  if (!names.has('DATABASE_URL')) {
    if (opts.databaseUrlFromClipboard) {
      log('reading DATABASE_URL from the clipboard (not printed)');
      const url = clipboard();
      if (!isPostgresUrl(url)) throw new StepError('database', 'the clipboard does not hold a postgres:// connection string');
      secretValues.push(url);
      addEnv('DATABASE_URL', url, names);
      database = 'clipboard';
    } else if (isTTY) {
      log('installing the Neon Postgres integration from the Vercel Marketplace.');
      log('>>> When asked for a plan, choose the FREE plan. Connect it to this project for the Production environment. <<<');
      const r = vercel(['integration', 'add', 'neon'], { interactive: true, step: 'database' });
      names = listEnv();
      if (r.status !== 0 || !names.has('DATABASE_URL')) {
        throw new StepError('database', 'the Neon integration did not give this project a DATABASE_URL. Connect the Neon database to the project in the Vercel dashboard (Storage tab), or copy a Neon connection string and re-run with --database-url-from-clipboard');
      }
      database = 'neon-marketplace';
    } else {
      throw new StepError('database', `no DATABASE_URL yet and this is not an interactive terminal. Either run \`vercel integration add neon\` yourself in a terminal inside hub/ (choose the Free plan, connect it to project ${opts.name}), or copy a Neon connection string (postgres://…) and re-run with --database-url-from-clipboard. Re-running is safe.`);
    }
  }

  // Secrets and settings
  for (const name of SECRET_NAMES) {
    if (names.has(name) && !created.includes(name)) continue; // same value as before
    if (names.has(name) && name === 'HUB_ENC_KEY') {
      throw new StepError('secrets', `the Vercel project already has HUB_ENC_KEY but ${path.join(dir, 'HUB_ENC_KEY')} was missing. Replacing it would make stored account keys unreadable. Restore the file (or remove HUB_ENC_KEY from Vercel if no accounts are registered yet) and re-run.`);
    }
    log(`setting ${name}`);
    addEnv(name, values[name], names);
  }
  const settings = { HUB_TIMEZONE: opts.timezone, HUB_LANG: opts.lang };
  for (const [name, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    log(`setting ${name}=${value}`);
    addEnv(name, value, names);
  }

  log('deploying to production (this takes a minute or two)');
  const dep = vercel(['deploy', '--prod', '--yes'], { step: 'deploy' });
  if (dep.status !== 0) throw new StepError('deploy', `vercel deploy failed: ${tail(dep, secrets())}`);
  const deploymentUrl = (dep.stdout.match(/https:\/\/[^\s]+/g) ?? []).pop();
  if (!deploymentUrl) throw new StepError('deploy', 'vercel deploy did not print a deployment URL');
  const insp = vercel(['inspect', deploymentUrl, '--json'], { step: 'deploy' });
  const url = pickProductionUrl(insp.status === 0 ? insp.stdout : '', deploymentUrl, opts.name);

  log(`waiting for ${url}/api/health`);
  const deadline = Date.now() + healthTimeoutMs;
  let last = '';
  for (;;) {
    try {
      const res = await fetchFn(`${url}/api/health`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) last = `HTTP ${res.status} (Vercel Deployment Protection may be on for this URL)`;
      else {
        const body = await res.json().catch(() => null);
        if (body?.ok === true) break;
        last = body ? `health: db=${body.db} encKey=${body.encKey} adminToken=${body.adminToken}` : `HTTP ${res.status}`;
      }
    } catch (e) {
      last = String(e?.message ?? e);
    }
    if (Date.now() > deadline) throw new StepError('health', `${url}/api/health did not report ok: ${redact(last, secrets())}`);
    await sleep(5000);
  }
  // The local admin token must really open the deployed hub, or the setup would report success with unusable secrets.
  let auth;
  try {
    auth = await fetchFn(`${url}/api/admin/accounts`, { headers: { authorization: `Bearer ${values.HUB_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new StepError('verify', `could not reach ${url}/api/admin/accounts: ${redact(String(e?.message ?? e), secrets())}`);
  }
  if (auth.status !== 200) {
    throw new StepError('verify', `the deployed hub did not accept the local HUB_ADMIN_TOKEN (${path.join(dir, 'HUB_ADMIN_TOKEN')}): HTTP ${auth.status}. The local file and the Vercel value differ; restore the matching file, or remove HUB_ADMIN_TOKEN in Vercel and re-run.`);
  }
  saveHubUrl(dir, url);
  return { ok: true, url, configDir: dir, project: opts.name, database };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${USAGE}\n`);
    process.stdout.write(JSON.stringify({ ok: false, step: 'args', error: e.message }) + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const result = await deploy(opts, deps);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (e) {
    const step = e instanceof StepError ? e.step : 'unexpected';
    process.stdout.write(JSON.stringify({ ok: false, step, error: redact(e?.message ?? String(e)) }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}
