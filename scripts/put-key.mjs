#!/usr/bin/env node
// CreditFirst put-key: move a secret from the clipboard into a .env file or into your hub,
// without the value ever being printed, logged, or passed to another process.
//
//   node scripts/put-key.mjs env --file <path> --var <NAME> [--clear-clipboard]
//   node scripts/put-key.mjs hub --hub <name> --kind credit|paid --label <label>
//        [--monthly-credit <usd>] [--renewal-day <1-31>] [--url <hub-url>] [--clear-clipboard]
//
// Node >= 20, node: builtins only. Output shows at most the last 4 characters of a secret.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `usage:
  put-key.mjs env --file <path> --var <NAME> [--clear-clipboard]
  put-key.mjs hub --hub <name> --kind credit|paid --label <label> [--monthly-credit <usd>] [--renewal-day <1-31>] [--url <hub-url>] [--clear-clipboard]

Copy the key first (Cmd/Ctrl+C), then run. The value is read from the clipboard and never printed.`;

export class UsageError extends Error {}

// ---------- argument parsing ----------

const FLAGS = new Set(['clear-clipboard', 'credit-only', 'help']);

/** Parses `cmd --a b --flag` into { _: [cmd], a: 'b', flag: true }. Unknown shapes throw UsageError. */
export function parseArgs(argv, booleanFlags = FLAGS) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!name) throw new UsageError(`bad option: ${a}`);
      if (booleanFlags.has(name)) { out[name] = true; continue; }
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      out[name] = value;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------- redaction ----------

/** Shows only the last 4 characters. */
export function last4(value) {
  const v = String(value ?? '');
  return v.length <= 4 ? '…' : `…${v.slice(-4)}`;
}

/** Removes anything that looks like a secret from a string before it is printed. */
export function redact(text, extraSecrets = []) {
  let s = String(text ?? '');
  for (const secret of extraSecrets) if (secret && secret.length >= 8) s = s.split(secret).join('[redacted]');
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, (m) => `sk-ant-[redacted${last4(m)}]`)
    .replace(/\bcf_[A-Za-z0-9_-]{16,}/g, (m) => `cf_[redacted${last4(m)}]`)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, 'postgres://[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
}

// ---------- clipboard ----------

const CHILD_ENV_KEYS = ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT'];

/** The few variables a clipboard tool or git needs; nothing else from this shell reaches a child process. */
export function childEnv(env = process.env) {
  const out = {};
  for (const k of CHILD_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000, env: childEnv() });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? '';
}

/** Reads the clipboard text. CREDITFIRST_TEST_CLIPBOARD_FILE exists only for the test suite. */
export function readClipboard(env = process.env) {
  const testFile = env.CREDITFIRST_TEST_CLIPBOARD_FILE;
  if (testFile) return fs.existsSync(testFile) ? fs.readFileSync(testFile, 'utf8') : '';
  const tries = process.platform === 'darwin' ? [['pbpaste', []]]
    : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
    : [
      ...(env.WAYLAND_DISPLAY ? [['wl-paste', ['--no-newline']]] : []),
      ['xclip', ['-o', '-selection', 'clipboard']],
      ['xsel', ['-b']],
      ['wl-paste', ['--no-newline']],
    ];
  for (const [cmd, args] of tries) {
    const out = run(cmd, args);
    if (out !== null) return out;
  }
  throw new Error('could not read the clipboard (tried pbpaste / wl-paste / xclip / xsel / powershell). Paste the key into the file yourself instead.');
}

/** Empties the clipboard. Best effort; returns true when a clipboard tool accepted it. */
export function clearClipboard(env = process.env) {
  const testFile = env.CREDITFIRST_TEST_CLIPBOARD_FILE;
  if (testFile) { fs.writeFileSync(testFile, ''); return true; }
  const tries = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', "Set-Clipboard -Value ' '"]]]
    : [['wl-copy', ['--clear']], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-c']]];
  for (const [cmd, args] of tries) if (run(cmd, args, '') !== null) return true;
  return false;
}

// ---------- validation ----------

const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const HUB_KEY = /^cf_[A-Za-z0-9_-]{20,}$/;
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

/** What a variable is expected to hold, judged from its name. */
export function expectedKind(varName) {
  return /DATABASE_URL|POSTGRES/i.test(varName) ? 'postgres' : 'key';
}

/** Trims the clipboard text and checks its shape. Never puts the value into the error message. */
export function cleanSecret(raw, kind) {
  let v = String(raw ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  if (!v) throw new Error('the clipboard is empty. Copy the key first, then run this again.');
  if (/\s/.test(v)) throw new Error('the clipboard holds more than one word. Copy only the key, then run this again.');
  if (kind === 'postgres') {
    if (!POSTGRES_URL.test(v)) throw new Error('the clipboard does not look like a Postgres connection string (postgres://…).');
  } else if (kind === 'anthropic') {
    if (!ANTHROPIC_KEY.test(v)) throw new Error('the clipboard does not look like an Anthropic API key (sk-ant-…).');
  } else if (!ANTHROPIC_KEY.test(v) && !HUB_KEY.test(v)) {
    throw new Error('the clipboard does not look like an Anthropic API key (sk-ant-…) or a hub project key (cf_…).');
  }
  return v;
}

// ---------- .env writing ----------

function quoteIfNeeded(value) {
  if (!/[\s#"'`$\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Sets NAME=value in a dotenv file (replacing an existing line), file mode 600, written atomically. */
export function upsertEnv(file, name, value) {
  const w = prepareEnvWrite(file);
  try {
    return w.commit([[name, value]]);
  } catch (e) {
    w.abort();
    throw e;
  }
}

function checkEnvTarget(abs) {
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new Error(`${abs} is a symlink; refusing to write a secret through it`);
  if (st && !st.isFile()) throw new Error(`${abs} is not a regular file`);
  return st;
}

/**
 * Validates a dotenv target and creates its temp file (random name, exclusive, 0600) up front, so a caller can
 * check every destination before creating a one-time secret. commit([[NAME, value], …]) writes through the held
 * temp file and renames it into place; abort() removes the temp file.
 */
export function prepareEnvWrite(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  checkEnvTarget(abs);
  if (fs.existsSync(abs)) fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK);
  // Unpredictable name + exclusive create: nobody can pre-create or symlink the temp file.
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(12).toString('hex')}.tmp`);
  const fd = openSecretFile(tmp);
  let open = true;
  const close = () => { if (open) { open = false; fs.closeSync(fd); } };
  return {
    file: abs,
    commit(pairs) {
      for (const [name] of pairs) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`bad variable name: ${name}`);
      const st = checkEnvTarget(abs);
      const before = st ? fs.readFileSync(abs, 'utf8') : '';
      let next = before === '' ? [] : before.replace(/\r?\n$/, '').split(/\r?\n/);
      let replaced = false;
      for (const [name, value] of pairs) {
        const line = `${name}=${quoteIfNeeded(value)}`;
        const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
        let seen = false;
        const out = [];
        for (const l of next) {
          if (re.test(l)) { if (!seen) out.push(line); seen = true; } else out.push(l);
        }
        if (!seen) out.push(line);
        replaced ||= seen;
        next = out;
      }
      fs.writeFileSync(fd, `${next.join('\n')}\n`);
      fs.fchmodSync(fd, 0o600);
      close();
      fs.renameSync(tmp, abs);
      fs.chmodSync(abs, 0o600);
      return { file: abs, replaced };
    },
    /** Best effort: never throws, so a caller's rescue path always runs. */
    abort() {
      try { if (open) { open = false; fs.closeSync(fd); } } catch { /* ignore */ }
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    },
  };
}

/** Opens a brand-new file (exclusive, mode 600) and returns its fd; refuses an existing path or symlink. */
export function openSecretFile(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    return fs.openSync(abs, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${abs} already exists; choose a new path (it is never overwritten)`);
    throw e;
  }
}

/** Creates a new file (mode 600) and refuses an existing path or symlink, so a secret never lands in someone else's file. */
export function writeSecretFile(file, content) {
  const abs = path.resolve(file);
  const fd = openSecretFile(abs);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return abs;
}

/** Reads a dotenv file into an object (simple KEY=value / quoted values). */
export function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function gitRoot(dir) {
  let d = dir;
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * If the file is inside a git repo and not already ignored, appends it to the nearest
 * .gitignore (closest existing one between the file and the repo root; the root otherwise).
 * Returns the .gitignore path it changed, or null.
 */
export function ensureGitignored(file) {
  const abs = path.resolve(file);
  const root = gitRoot(path.dirname(abs));
  if (!root) return null;
  const check = spawnSync('git', ['check-ignore', '-q', '--', abs], { cwd: root, stdio: 'ignore', env: childEnv() });
  if (check.status === 0) return null; // already ignored
  let dir = path.dirname(abs);
  let target = null;
  for (;;) {
    const g = path.join(dir, '.gitignore');
    if (fs.existsSync(g)) { target = g; break; }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  target ??= path.join(root, '.gitignore');
  const rel = `/${path.relative(path.dirname(target), abs).split(path.sep).join('/')}`;
  const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  fs.writeFileSync(target, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${rel}\n`);
  return target;
}

/** Tells whether a git repo already tracks the file (then .gitignore alone does not protect it). */
export function isTracked(file) {
  const abs = path.resolve(file);
  const root = gitRoot(path.dirname(abs));
  if (!root) return false;
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', abs], { cwd: root, stdio: 'ignore', env: childEnv() });
  return r.status === 0;
}

// ---------- hub config ----------

/** ~/.config/creditfirst/<hub>/ (CREDITFIRST_CONFIG_HOME overrides the parent, used by tests). */
export function hubConfigDir(hub, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(hub ?? '')) throw new UsageError('--hub must be the hub name (letters, digits, dashes)');
  const base = env.CREDITFIRST_CONFIG_HOME || path.join(os.homedir(), '.config', 'creditfirst');
  return path.join(base, hub);
}

/** Loads the hub URL and admin token. Secrets come from files, never from argv. */
export function loadHub(hub, { url, env = process.env } = {}) {
  const dir = hubConfigDir(hub, env);
  const read = (name) => {
    const f = path.join(dir, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  };
  const token = read('HUB_ADMIN_TOKEN');
  const hubUrl = (url || read('HUB_URL')).replace(/\/+$/, '');
  if (!token) throw new Error(`no admin token at ${path.join(dir, 'HUB_ADMIN_TOKEN')} (run hub-deploy first)`);
  if (!hubUrl) throw new Error(`no hub URL: pass --url https://… or save it to ${path.join(dir, 'HUB_URL')}`);
  return { dir, token, url: checkUrl(hubUrl) };
}

/** Credentials only travel over https; plain http is allowed for localhost only. Returns the URL without a trailing slash. */
export function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new UsageError(`not a URL: ${raw}`); }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError(`${raw}: use https:// (http is allowed only for localhost)`);
  if (u.username || u.password) throw new UsageError('the URL must not contain a user name or password');
  return raw.replace(/\/+$/, '');
}

export async function hubFetch(hubCfg, pathname, { method = 'GET', body, fetchImpl = globalThis.fetch, auth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (auth) headers.authorization = `Bearer ${hubCfg.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(`${hubCfg.url}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

export function hubErrorLine(r, secrets) {
  const msg = r.json?.error ?? r.json?.message ?? r.text?.slice(0, 300) ?? '';
  return redact(`hub error ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, secrets);
}

// ---------- commands ----------

async function cmdEnv(args, deps) {
  if (!args.file || !args.var) throw new UsageError('env needs --file <path> and --var <NAME>');
  const value = cleanSecret(deps.readClipboard(deps.env), expectedKind(args.var));
  const { file } = upsertEnv(args.file, args.var, value);
  deps.out(`${args.var} saved (${last4(value)})`);
  const gi = ensureGitignored(file);
  if (gi) deps.out(`added ${path.basename(file)} to ${gi}`);
  if (isTracked(file)) deps.out(`warning: git already tracks ${file}; run: git rm --cached "${file}"`);
  return value;
}

async function cmdHub(args, deps) {
  const kind = args.kind;
  if (kind !== 'credit' && kind !== 'paid') throw new UsageError('--kind must be credit or paid');
  if (!args.label?.trim()) throw new UsageError('--label is required');
  const body = { label: args.label.trim(), kind };
  if (kind === 'credit') {
    const usd = Number(args['monthly-credit']);
    const day = Number(args['renewal-day']);
    if (!(usd > 0)) throw new UsageError('credit accounts need --monthly-credit <usd> (e.g. 100 for Max 5x, 200 for Max 20x)');
    if (!(Number.isInteger(day) && day >= 1 && day <= 31)) throw new UsageError('credit accounts need --renewal-day <1-31>');
    body.monthlyCreditUsd = usd;
    body.renewalDay = day;
  }
  const hub = loadHub(args.hub, { url: args.url, env: deps.env });
  const value = cleanSecret(deps.readClipboard(deps.env), 'anthropic');
  body.apiKey = value;
  const r = await hubFetch(hub, '/api/admin/accounts', { method: 'POST', body, fetchImpl: deps.fetch });
  if (!r.ok) {
    deps.err(hubErrorLine(r, [value, hub.token]));
    const e = new Error('hub refused the key');
    e.quiet = true;
    throw e;
  }
  const j = typeof r.json === 'number' ? { id: r.json } : (r.json ?? {});
  const id = typeof j.id === 'object' && j.id !== null ? j.id.id : j.id;
  const hint = j.keyHint ? redact(String(j.keyHint), [value]) : last4(value);
  const org = j.orgId ? `${String(j.orgId).slice(0, 8)}…` : '(not returned)';
  deps.out(`registered ${kind} account "${body.label}": id=${id ?? '?'} key=${hint} org=${org}`);
  return value;
}

export async function main(argv, deps = {}) {
  const d = {
    env: process.env,
    fetch: globalThis.fetch,
    readClipboard,
    clearClipboard,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    ...deps,
  };
  try {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (args.help || !cmd) { d.out(USAGE); return cmd || args.help ? 0 : 2; }
    if (cmd === 'env') await cmdEnv(args, d);
    else if (cmd === 'hub') await cmdHub(args, d);
    else throw new UsageError(`unknown mode: ${cmd}`);
    if (args['clear-clipboard']) d.out(d.clearClipboard(d.env) ? 'clipboard cleared' : 'could not clear the clipboard; copy something else over it');
    return 0;
  } catch (e) {
    if (!e.quiet) d.err(`put-key: ${redact(e.message)}`);
    if (e instanceof UsageError) d.err(USAGE);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
