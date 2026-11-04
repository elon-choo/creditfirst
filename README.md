# CreditFirst

**Use the API credit that comes with your own Claude Max/Ultra plan first. Your paid API key only when credit runs short.**

- A Claude Code plugin: say "set up my Max/Ultra API credit" and Claude walks you through the Console, creates the key, and puts it in your app safely.
- With several Max/Ultra accounts or a paid service key, it deploys **your own** small hub (your Vercel, your database) that spends credit first, nearest renewal first.
- Open source (MIT). **Not affiliated with Anthropic.**

[한국어 README](README.ko.md)

**Easy guide (Korean): https://elon-choo.github.io/creditfirst/**

> Since early November 2026 claude.ai shows the Max plan as **Ultra**. CreditFirst treats them as the same plan; say either word.

## Who it is for

- You pay for a Claude Max/Ultra plan and want its monthly API credit to power your own scripts or apps.
- You (or your company) own several Max/Ultra accounts and want one endpoint that uses them in the right order.
- You run a service on a paid Anthropic API key and want credit to be used before paid money.

Not for: pooling credit with other people, selling API access, or using claude.ai logins as an API. See [Terms notes](docs/TERMS-NOTES.md).

## Install (two commands in Claude Code)

```
/plugin marketplace add elon-choo/creditfirst
/plugin install creditfirst@creditfirst
```

## Before you start

- Claude Code.
- Node 20 or newer - check with `node --version` (install from https://nodejs.org if missing).
- A Claude Max/Ultra plan that is at least 7 days old (the API credit offer appears after 7 days).
- Hub path only (several accounts, or a paid service key):
  - a Vercel account, the CLI (`npm i -g vercel`), and `vercel login`;
  - a free Neon Postgres - `hub-deploy` can add it through Vercel's Neon integration, or you paste a Neon
    connection string via the clipboard.

## Costs and time

| | Cost | Time |
|---|---|---|
| Max/Ultra API credit | Included in your Max/Ultra plan | - |
| No-hub setup (1 account, no paid key) | Nothing extra | ~10 min |
| Hub setup | Neon Free: $0. Vercel Hobby is free **for personal, non-commercial use only**; a hub serving a business or commercial service needs Vercel Pro - see https://vercel.com/pricing and check the current terms. | ~30-60 min |
| Paid fallback | Spends your existing paid key's money when credit is short. Set a monthly cap with `HUB_PAID_MONTHLY_CAP_USD`. | - |
| Connection test | One tiny request, a fraction of a cent, normally from credit | seconds |

## First run

Say to Claude Code, in any language:

> Set up my Max/Ultra credit API key

(or `Max/Ultra 크레딧으로 API 키 만들어줘`, or run `/creditfirst:setup`). Claude asks two questions - how many Max/Ultra accounts you own, and whether a deployed service already uses a paid API key - then guides you step by step (it also asks which project folder should use the key). You do the logins; Claude never clicks purchase, add-card, or skip buttons. With a browser tool (e.g. Claude in Chrome) Claude can open the Console pages with you; without one it tells you each address and button name.

Claude Code may ask permission to read the plugin's guides and run its small scripts. Please allow them; the scripts never show your key.

## What gets built

| Max/Ultra accounts | Paid service key | Result |
|---|---|---|
| 1 | no | (~10 min) No hub. The credit key goes into your project's `.env`. When credit ends, the API refuses (no card on that org) until it renews. |
| several | any | (~30-60 min) Your own hub: credit accounts first (nearest renewal first), paid key only when credit is short. |
| any | yes | Same hub. Apps that must never spend paid money get a credit-only key (they get a 402 and use their own path). |

Apps switch with two env vars: `ANTHROPIC_BASE_URL` (your hub) and `ANTHROPIC_API_KEY` (a per-app hub key).

## Security model

- **Where keys go:** your project's `.env` (mode 600, added to `.gitignore`), your hub's database (encrypted with `HUB_ENC_KEY`), and hub secrets in `~/.config/creditfirst/<hub>/` (folder 700, files 600) plus your Vercel env. Nothing goes to us; there is no hosted service.
- **Why manual paste is safest:** everything Claude reads is saved in Claude Code's conversation log (`~/.claude/projects/…/*.jsonl`). If you paste the key yourself - into `.env`, or on the hub path into your hub's own `/admin` page - Claude never sees it.
- **Easy and still safe:** copy the key, and Claude runs `scripts/put-key.mjs`, which reads the clipboard and writes the file without printing the value (only the last 4 characters appear).
- **Only if you insist:** Claude can read the key itself, after warning you it will be in the log. Rotate that key later.
- Scripts never put a secret in command-line arguments or print it; outputs are redacted.

## Limits

- Hub on Vercel: request bodies over 4.5 MB are rejected; long requests are bounded by your Vercel plan.
- Supported: Messages, count tokens, models. Not supported: Batch, Files, other APIs.
- The hub's remaining-credit numbers are estimates; the Console billing page is the truth.
- Console screens change. The guide marks steps we could not confirm as unverified.
- v0.1: Vercel + Postgres (Neon) only. No Docker or local-only mode yet.

## Repository

```
.claude-plugin/          plugin + marketplace manifests
skills/setup/            the setup flow and reference guides
scripts/put-key.mjs      clipboard -> .env or hub, never prints the value
scripts/hub-admin.mjs    status, add-project, connection test
scripts/hub-deploy.mjs   deploy the hub to your Vercel
hub/                     the hub (Next.js)
docs/TERMS-NOTES.md      terms notes - read before use
```

Tests: `node --test scripts/test/` (scripts) and the hub's own tests in `hub/`.

## License

MIT - see [LICENSE](LICENSE). "Claude" and "Anthropic" are trademarks of Anthropic, PBC.
