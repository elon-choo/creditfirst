# CreditFirst hub

A small Next.js app you deploy to **your own** Vercel account, with your own Postgres (Neon). Your apps call it
instead of `api.anthropic.com`. For every request it uses the API credit that comes with your Claude Max/Ultra plans
first (the account whose credit renews soonest goes first, because unused credit expires), and uses your paid
Anthropic API key only when the credit cannot take the request.

One owner per install. Register only accounts and keys you own. Not affiliated with Anthropic.

Deploy it with `node scripts/hub-deploy.mjs --name <hub-name>` from the repo root (see the top of that file).

## How spending is kept safe

- Before a request is sent, the hub sets aside a deliberately high worst-case cost on the chosen credit
  account. A request is sent to a credit account only if `spent + open set-asides + this worst case ≤ credit − $3`.
  The real cost replaces the set-aside when the reply ends. Uncertain outcomes (lost connection, cut-off stream)
  are charged at the worst case; a set-aside that is never recorded is charged in full after 30 minutes.
- When Anthropic answers "credit balance too low", the account is treated as used up for the cycle and
  re-checked after a pause.
- Optional `HUB_PAID_MONTHLY_CAP_USD` limits the paid key with a hard bound instead of the guess: every byte of the
  serialized request (property names included, base64 payloads excluded) counts as one prompt token, each image as
  10,000 tokens, plus all allowed output; requests the hub cannot bound at all are refused (see `paid-cap-unbounded`).

### Why the credit organization must have no card

Each Max/Ultra account's API credit lands in a Console organization. If that organization has **no card, no prepaid
balance and no auto-reload**, Anthropic refuses requests when the credit is gone instead of charging you. That
refusal is the last safety net behind the hub's own accounting. If a card were attached, a miscount or usage
outside the hub would turn into real charges on an account the hub treats as free.

### Why credit and paid keys must be different organizations

The hub counts an organization's money once. A paid key from a credit organization would mean the "free" credit
account can be charged (it has a card), and a credit account inside the paid organization would spend money the
hub believes is free. So registration needs the organization id from Anthropic's key test (`anthropic-organization-id`):
without it the hub answers **400** and stores nothing; if the organization is already registered (as either kind,
including a deleted account of the other kind) it answers **409**.

## Environment

| Name | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Neon). Tables are created on first use. |
| `HUB_ENC_KEY` | yes | 32 random bytes, base64. Encrypts stored API keys (AES-256-GCM). Losing it means re-entering every key. |
| `HUB_ADMIN_TOKEN` | yes | At least 24 characters. Admin API bearer token and `/admin` password. |
| `CRON_SECRET` | yes | At least 16 characters. Vercel Cron sends it to `/api/cron/report`. |
| `HUB_VIEWER_TOKEN` | no | At least 16 characters. A read-only `/admin` password. |
| `HUB_TIMEZONE` | no | IANA zone (default `UTC`) for billing days, calendar months and shown times. Set it to where your Max/Ultra plans are billed, e.g. `Asia/Seoul`, `America/Los_Angeles`. |
| `HUB_LANG` | no | `en` (default) or `ko`: admin page, alerts, daily report. |
| `HUB_NAME` | no | Display name (default `CreditFirst`). |
| `HUB_PAID_MONTHLY_CAP_USD` | no | Most the paid keys may spend per calendar month (in `HUB_TIMEZONE`). Unset = no cap. An unreadable value blocks paid use. With a cap, the paid key only takes requests whose cost can be bounded (see `paid-cap-unbounded`). |
| `SLACK_BOT_TOKEN` + `HUB_ALERT_SLACK_CHANNEL` | no | Alerts and the daily report by Slack bot (`chat.postMessage`). |
| `HUB_ALERT_WEBHOOK_URL` | no | `https://` URL that receives `POST {"text": "…"}` (Slack incoming webhook; for Discord add `/slack` to the webhook URL). Can be combined with Slack. |
| `ANTHROPIC_UPSTREAM_URL` | no | Override `https://api.anthropic.com` (testing). |

## Endpoints

| | Auth | |
|---|---|---|
| `POST /v1/messages` | project key | Messages API, streaming and not. Response headers `x-hub-pool` (`credit`/`paid`/`none`) and `x-hub-account`. |
| `POST /v1/messages/count_tokens`, `GET /v1/models` | project key | Free endpoints, passed through. |
| `GET /api/health` | none | `{ok, db, encKey, adminToken, accounts: {credit, paid}}`; 503 when not ok. No secrets. |
| `GET /api/admin/accounts` | admin | Accounts with status, cycle, spent, usable credit (no keys). |
| `POST /api/admin/accounts` | admin | `{label, kind: "credit"\|"paid", apiKey, monthlyCreditUsd, renewalDay}` → `{id, keyHint, orgId}`. 400 / 409 as above. |
| `PATCH /api/admin/accounts` | admin | `{id, apiKey?, label?, monthlyCreditUsd?, renewalDay?, enabled?}`; a new key must be from the same organization. |
| `POST /api/admin/clients` | admin | `{name, paidFallback?}` → `{id, name, key}`. The `cf_…` key is shown once; only its hash is stored. |
| `POST /api/admin/alert-test` | admin | Sends one test alert. |
| `GET /api/cron/report` | cron secret or admin | Daily report (Vercel Cron, 00:00 UTC). `?dry=1` returns the text. |
| `/admin` | admin or viewer password | Web dashboard. |

Project key: `x-api-key: cf_…` or `Authorization: Bearer cf_…`. In an app using the Anthropic SDK set
`ANTHROPIC_BASE_URL=https://<your-hub>` and `ANTHROPIC_API_KEY=cf_…`.

Hub answers your app should know:

- `402 billing_error` + `x-hub-error: credit-unavailable`: a **credit-only** project (`paidFallback: false`) found
  no credit. The app can resend the request through its own paid route. SDKs do not retry 402.
- `402 billing_error` + `x-hub-error: paid-cap-reached`: the credit could not take the request and the paid key
  would pass `HUB_PAID_MONTHLY_CAP_USD` (this month's paid spend + paid requests in flight + this request's worst case).
- `402 billing_error` + `x-hub-error: paid-cap-unbounded`: the credit could not take the request, a paid cap is set,
  and the request uses something whose cost the hub cannot bound in advance, so it is not sent to the paid key.
  Bounded means: a known model, only client-side tools (custom tools, `bash`, `text_editor`, `computer`, `memory`),
  plain text and images. Not bounded: server tools (`web_fetch`, `web_search`, code execution, advisor, …),
  `mcp_servers`, `container`, PDFs, documents by URL or file id, fallbacks to an unknown model or default routing.
  Credit accounts still serve such requests (the credit organization has no card, so Anthropic stops at zero).
- `x-hub-error: all-accounts-failed`: every account failed; Anthropic's last answer is passed back.

Alerts (throttled): paid key used (per project, 30 min), credit-only project turned away (30 min), nothing could
serve a request (10 min), paid cap reached (60 min), account problems (empty balance, rejected key).

## Limits

- **Request body ≤ 4.5 MB** (Vercel function limit). Apps sending large base64 images or PDFs should call
  Anthropic directly.
- **Function duration**: `/v1/messages` sets `maxDuration = 300` s, which every Vercel plan accepts. On Pro or
  Enterprise you can raise it to 800 in `app/v1/messages/route.ts`. A longer generation is cut off and charged at
  its worst case; use streaming for long replies, or call Anthropic directly.
- **Not supported**: Message Batches API, Files API, and other endpoints not listed above. Call Anthropic
  directly for those.
- Amounts are the hub's own metering from the usage Anthropic reports; they can differ slightly from invoices.

## Development

```
NODE_ENV=development npm install --ignore-scripts --include=dev
NODE_ENV=test ./node_modules/.bin/vitest run      # PGlite in-memory Postgres; no network, no API calls
./node_modules/.bin/tsc --noEmit
NODE_ENV=production ./node_modules/.bin/next build
```
