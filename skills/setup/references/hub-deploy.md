# Deploying your own hub

The hub is a small Next.js app (`hub/` in this plugin) that you deploy to **your own** Vercel account with
**your own** Postgres. It speaks the Anthropic Messages API, so apps only change two env vars.

## What it does per request

1. Checks the project key (`cf_…`), one per app, so usage is split by app.
2. Reserves a worst-case cost estimate for the request (so parallel requests do not overspend a credit
   account). It is an estimate, not a guarantee.
3. Picks the credit account whose renewal is nearest and that has enough credit left for the reservation;
   on rate limits or server errors it tries the next one.
4. If no credit account can take it: a normal project goes to the paid key (and you get an alert); a
   credit-only project gets a `402` with `x-hub-error: credit-unavailable`.
5. Settles the real cost from the usage Anthropic reports.

Supported endpoints: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`. Not
supported: Batch, Files, and other APIs.

## Prerequisites (the human does the logins)

- Node 20+ (`node --version`) and npm (`npm --version`).
- Vercel account and CLI: if `vercel --version` fails, `npm i -g vercel`; then the human runs
  `vercel login` (in Claude Code: `! vercel login`). Check with `vercel whoami`. If they use a team, note the
  team slug for `--scope`.
- Vercel plan: Hobby is free but for personal, non-commercial use. A hub that serves a business or
  commercial service needs Vercel Pro. Check https://vercel.com/pricing and Vercel's current terms.
- A Postgres database, two ways:
  1. **Easiest - Vercel's Neon integration.** If the project has no `DATABASE_URL`, `hub-deploy.mjs` runs
     `vercel integration add neon` for you, but only in an interactive terminal (in Claude Code:
     `! node "<CF>/scripts/hub-deploy.mjs" --name <hub-name>`). Choose the Free plan. No connection
     string to copy.
  2. **Connection string.** The human creates a free project at https://neon.tech and copies the
     connection string (`postgresql://…?sslmode=require`). Keep it in the clipboard (never in chat) and add
     `--database-url-from-clipboard`.

## Deploy

Run `node "$CF/scripts/hub-deploy.mjs" --help` first; that script is the source of truth for flags. Expected:

```
node "$CF/scripts/hub-deploy.mjs" --name <hub-name> [--database-url-from-clipboard] \
     [--scope <vercel-team>] [--timezone <IANA, e.g. Asia/Seoul>] [--lang en|ko] [--dry-run]
```

- `--name`: lowercase letters, digits, dashes. Also the folder name under `~/.config/creditfirst/`.
- The final stdout line is JSON: `{"ok":true,"url":"https://…","configDir":"…","project":"…"}`.
- It generates `HUB_ADMIN_TOKEN`, `HUB_ENC_KEY`, `CRON_SECRET`, saves them to
  `~/.config/creditfirst/<hub-name>/` (folder 700, files 600) and to the Vercel project env.
- It also saves `HUB_URL` there. If that file is missing, save the url (not a secret):
  `printf '%s\n' "https://…" > ~/.config/creditfirst/<hub-name>/HUB_URL`
- The Vercel link (`.vercel/`) lives in the plugin's `hub/` folder. A plugin update may replace that folder;
  re-running `hub-deploy.mjs` with the same `--name` re-links and reuses the saved secrets
  **(behavior across plugin updates unverified)**.
- Tell the human to back up that folder privately (password manager). Losing `HUB_ENC_KEY` means every
  account key must be registered again.

Check: `node "$CF/scripts/hub-admin.mjs" status --hub <hub-name>` -> `health: ok  db=ok  encKey=ok  adminToken=ok`.

## Register accounts (only now create each key)

Create each account's Console key only after the hub is up (`status` says `health: ok`), then register it
right away - the key is shown once.

**Safest - the human pastes it into the hub's admin page.** Open `https://<hub>/admin`, log in with the
admin password ("Password" / "비밀번호") = the admin token. The human opens the token themselves, not Claude:
in their own terminal `cat ~/.config/creditfirst/<hub-name>/HUB_ADMIN_TOKEN` (or `pbcopy < …` on macOS), or
`open ~/.config/creditfirst/<hub-name>` and open the file. Fill the form "Register an account" / "계정 등록":

| English | 한국어 |
|---|---|
| Name | 이름 |
| Kind: "Max/Ultra plan API credit" or "Paid API (used last)" | 종류: "구독 제공 크레딧" 또는 "유료 API(마지막에 사용)" |
| Monthly credit (USD) | 월 제공 크레딧(달러) |
| Renewal day of month | 매달 갱신일(결제일) |
| API key (from the Console organization connected to that account) | API 키 (그 계정에 연결한 Console 조직에서 만든 키) |
| button "Register" | 버튼 "등록" |

(Labels from `hub/lib/i18n.ts`; the page language follows `HUB_LANG`.)

**Easy, still safe - clipboard helper**, with that account's key copied:

```
node "$CF/scripts/put-key.mjs" hub --hub <hub-name> --kind credit --label "Max 20x (me)" \
     --monthly-credit 200 --renewal-day 19 --clear-clipboard
```

Paid key (different org), optional:

```
node "$CF/scripts/put-key.mjs" hub --hub <hub-name> --kind paid --label "service paid key" --clear-clipboard
```

The hub tests each key against Anthropic (a free model-list call), requires the organization id, and
answers `400` if no org id comes back, `409` if that org is already registered or a credit/paid org
collides.

## Optional env (set in Vercel -> Project -> Settings -> Environment Variables, then redeploy)

| Variable | Meaning |
|---|---|
| `HUB_PAID_MONTHLY_CAP_USD` | Stop paid fallback once this month's paid spend would pass this amount (402 `paid-cap-reached`). Recommended whenever a paid key is registered. |
| `HUB_ALERT_WEBHOOK_URL` | Generic webhook (Slack/Discord incoming webhook) for alerts: paid fallback used, credit-only refusals, failures. |
| `SLACK_BOT_TOKEN` + `HUB_ALERT_SLACK_CHANNEL` | Alerts via a Slack bot instead. |
| `HUB_VIEWER_TOKEN` | Read-only password for the `/admin` page. |
| `HUB_TIMEZONE`, `HUB_LANG`, `HUB_NAME` | Display time zone (default UTC), `en`/`ko`, display name. |

Never paste secret values into chat; the human enters them in the Vercel dashboard, or run the CLI from the
hub folder (it is linked to the hub's Vercel project). Example, a US$20 monthly paid cap:

```sh
cd "<CF>/hub"                                   # replace <CF> with the plugin root path
vercel env add HUB_PAID_MONTHLY_CAP_USD production   # it prompts for the value: type 20
vercel deploy --prod                            # env changes apply after a redeploy
```

(`hub-deploy.mjs` has no cap flag in v0.1.)

## Vercel limits to know

- Request bodies over 4.5 MB (large PDFs/images) are rejected by Vercel - keep those apps on a direct key.
- Long requests are bounded by the plan's function duration limit (the hub sets `maxDuration` 800 s; the
  Hobby plan allows less). **(Exact current plan limits unverified; check Vercel's docs.)**
- The daily report cron runs at 00:00 UTC; on the Hobby plan cron timing is approximate.

## Admin page

`https://<hub>/admin` - log in with the admin token (or viewer token). Shows accounts, project keys,
recent usage. The human reads the token themselves (see "Register accounts"); Claude never prints it.
