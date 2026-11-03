/**
 * Postgres access. Production uses the Neon database attached to the Vercel
 * project (DATABASE_URL); tests pass in an in-memory PGlite with the same shape.
 */

import { Pool } from '@neondatabase/serverless';

export interface Q {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Q {
  tx<R>(fn: (q: Q) => Promise<R>): Promise<R>;
}

export const SCHEMA = `
create table if not exists accounts (
  id serial primary key,
  label text not null,
  kind text not null check (kind in ('credit', 'paid')),
  api_key_enc text not null,
  key_hint text not null,
  monthly_credit_usd double precision not null default 0,
  renewal_day int check (renewal_day between 1 and 31),
  safety_margin_usd double precision not null default 3,
  priority int not null default 0,
  enabled boolean not null default true,
  cooldown_until timestamptz,
  exhausted_cycle text,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists clients (
  id serial primary key,
  name text not null unique,
  key_hash text not null unique,
  key_hint text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists reservations (
  id bigserial primary key,
  account_id int not null,
  cycle_start text not null,
  amount_usd double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists reservations_account on reservations (account_id, cycle_start);
create table if not exists usage_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  client_id int,
  account_id int,
  pool text not null,
  cycle_start text,
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  web_searches int not null default 0,
  cost_usd double precision not null default 0,
  status int not null,
  stream boolean not null default false,
  duration_ms int,
  note text
);
create index if not exists usage_account_cycle on usage_log (account_id, cycle_start);
create index if not exists usage_at on usage_log (at);
alter table accounts add column if not exists key_fingerprint text;
alter table accounts add column if not exists org_id text;
create unique index if not exists accounts_key_fingerprint on accounts (key_fingerprint);
create unique index if not exists accounts_org_id on accounts (org_id);
alter table accounts add column if not exists deleted boolean not null default false;
alter table usage_log add column if not exists request_key text;
create unique index if not exists usage_request_key on usage_log (request_key);
alter table clients add column if not exists paid_fallback boolean not null default true;
create table if not exists alert_state (
  key text primary key,
  last_sent timestamptz,
  last_ok boolean,
  last_error text
);
`;

let pool: Pool | undefined;
let prodDb: Db | undefined;

export function getDb(): Db {
  if (prodDb) return prodDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  pool = new Pool({ connectionString: url, max: 5 });
  const p = pool;
  prodDb = {
    query: (text, params) => p.query(text, params) as never,
    async tx(fn) {
      const c = await p.connect();
      try {
        await c.query('begin');
        const r = await fn({ query: (text, params) => c.query(text, params) as never });
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
  return prodDb;
}

const ready = new WeakMap<object, Promise<void>>();

/** Creates the tables once per process; safe to call on every request. */
export function ensureSchema(db: Db): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = (async () => {
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
    })();
    p.catch(() => ready.delete(db));
    ready.set(db, p);
  }
  return p;
}
