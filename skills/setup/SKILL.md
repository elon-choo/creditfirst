---
name: setup
description: Claude Max plans (shown as "Ultra" on claude.ai since early November 2026) include a monthly API credit that can be used in the Claude Console (platform.claude.com) to create real Anthropic API keys. This skill walks the user through linking that credit, creating the key, putting it into .env without exposing it, and - with several Max/Ultra accounts or a paid service key - deploying their own hub that spends credit first and the paid key only when credit is short. Use whenever someone wants an API key from a Max or Ultra plan or asks about Max/Ultra API credit, e.g. "/creditfirst:setup", "Max 크레딧으로 API 키 만들어줘", "Ultra 크레딧으로 API 키 만들어줘", "울트라 크레딧으로 API 키 만들어줘", "API 키 만들기", "클로드 API 키 발급", "Max 구독 API 크레딧", "맥스 플랜으로 API 쓰기", "울트라 플랜으로 API 쓰기", "Ultra 구독 API 크레딧", "크레딧 허브 만들어줘", "API 키 받아서 .env에 넣어줘", "Anthropic API key from Max plan", "API key from my Ultra plan", "use my Max or Ultra credit for my app", "set up my Claude API credits", or adding an account/app to a CreditFirst hub.
---

# CreditFirst setup

You (Claude) are the setup wizard. The human owns the accounts; you guide, drive the browser when a
browser tool exists, run the scripts, and verify. Talk in the user's language (Korean if they write
Korean) and in plain words: many users are not developers.

`CF` = the plugin root: two directories above this skill's base directory (the "Base directory for this
skill" line). Resolve it to an absolute path once. Scripts: `$CF/scripts/put-key.mjs`,
`$CF/scripts/hub-admin.mjs`, `$CF/scripts/hub-deploy.mjs` (Node 20+).

**Say this first:** "I'll read short guides and run small scripts from the CreditFirst plugin. Claude Code
may ask you to allow them - please allow. The scripts never show your key." If a reference read is still
refused, continue with what is in this file (it has the essentials) and say which detail you could not check.

**Commands you show:** always the absolute plugin path and the absolute target path. If something must be
filled in, say exactly what (e.g. "replace `my-hub` with the hub name you chose").

## Rules you never break

- Only accounts the installer owns (or their company owns and pays for). No pooling with friends, no
  selling or sharing credit or hub access. If the user describes that, say plainly CreditFirst is not for
  it and point to `docs/TERMS-NOTES.md`.
- Console API keys only. Never use claude.ai cookies, session tokens, or subscription OAuth tokens as an API.
- In the browser never click: buy credits ("크레딧 구매"), add card / payment method, "skip for now"
  ("지금은 건너뛰기"), or anything that adds a balance or auto-reload. The human logs in and solves any
  CAPTCHA or verification.
- Never print a key, token, or database URL; never put one in a command line or a file you show.
- The credit org must have no card, no prepaid balance, no auto-reload (the human confirms on screen).
  The credit key and the paid key must be in different organizations.
- No paid API call without saying so first (the final test is one tiny request, a fraction of a cent).
- Offer the RISKY key path only as option 3 in the list; do not suggest it again unless the human asks.

## Step 1 - Questions, then the decision

Ask together: (1) "How many Claude Max/Ultra accounts do you (or your company) own and pay for? 1 / several"
(2) "Does a deployed app already use a paid Claude API key? yes / no" (3) "Which project folder should use the key?"

Name: claude.ai has shown the Max plan as **"Ultra"** since early November 2026. Treat Max and Ultra as the same
plan for CreditFirst and use whichever word the user uses; tier names below (5x/20x) are the ones we observed
under the Max name. Max/Ultra plans include a monthly API credit for the Console (observed: US$100 on Max 5x, US$200 on Max 20x; the
screen is the truth). It pays only for API calls and expires each cycle. Explain at first use:
**Console** = Anthropic's site for API keys and API billing (platform.claude.com - not claude.ai).
**Organization (조직)** = a separate wallet inside the Console; the credit goes into its own wallet with no
card, so when it runs out requests stop instead of charging.

| Max/Ultra accounts | Paid service key | Path |
|---|---|---|
| 1 | no | **A - no hub**: credit key into the project's `.env`. About 10 minutes. |
| several, or any | any, or yes | **B - own hub**: credit first (nearest renewal first), paid key only when credit is short. About 30-60 minutes. |

Costs, said honestly: the credit itself is part of Max/Ultra (no extra cost). Path A costs nothing more. Path B
needs a free Neon Postgres ($0 on the Free plan) and Vercel: the Hobby plan is free but for personal,
non-commercial use - a hub serving a business/commercial service needs Vercel Pro (see
https://vercel.com/pricing and check the current terms). Paid fallback spends the user's existing paid
key's money; suggest a monthly cap (`HUB_PAID_MONTHLY_CAP_USD`, Path B step B6).

## Step 2 - Link the Max/Ultra credit (once per Max/Ultra account)

Guide with exact screens: `references/console-credit-guide.md`. Essentials (Korean labels as observed;
English labels **unverified**):

1. The Max/Ultra subscription must be at least 7 days old (it opened on the evening of day 7 for us). Before
   that `/create/credits` shows only a purchase form: click nothing, wait.
2. The human signs in to https://platform.claude.com with the same account as the Max/Ultra plan.
3. If asked to create an organization, choose "개인" (Individual). This is the credit org.
4. Open https://platform.claude.com/create/credits → "연결하고 US$200 받기" ("Link and get US$200"; amount
   follows the plan) → "카드 없이 계속하기" ("Continue without card"). If it stays on "연결 중"
   ("Connecting…"), wait ~10 s and reload, or open the billing page - it is often already linked.
5. https://platform.claude.com/settings/billing - the human confirms aloud: credit balance
   ("크레딧 잔액") shows; **no card, no prepaid balance, no auto-reload**. Note the credit expiry date
   (its day of month = renewal day) and the amount.

Browser: use any browser tool this session has (Claude in Chrome, a Playwright MCP, …); snapshot before each
click and click only labels you have read. Without a browser tool, give the URL and exact button names one
step at a time and wait for "done".

## Step 3 - Key handoff: explain before any key exists; the human picks

Say it in roughly these words (details: `references/key-safety.md`):

1. **Safest (recommended)** - "You paste the key yourself; I never see it."
   - Path A: "Paste it into `<absolute path>/.env` as the line `ANTHROPIC_API_KEY=<key>`." Then check only
     that the line exists: `grep -c '^ANTHROPIC_API_KEY=sk-ant-' <file>` - never `cat` it.
   - Path B: "Paste it into your hub's own page: open `<hub-url>/admin`, log in with the admin password,
     fill **Register an account / 계정 등록**." (form fields in Step B4).
2. **Easy, still safe** - "Copy the key and tell me 'copied'. A small script moves it from the clipboard
   into the file (or your hub) without showing it; you'll see only the last 4 characters."
3. **Risky (only if the human insists after this warning)** - "If I read or receive the key (from the
   screen or your message), it is saved in Claude Code's conversation log on this computer
   (`~/.claude/projects/…/*.jsonl`) and may be synced wherever that log goes. Treat it as exposed and
   replace it later (new key in the Console, delete this one)." Only after they insist: write the key with
   a tool that does not echo it, then `chmod 600 <file>`, make sure the file is git-ignored, never repeat the
   key, and remind them to rotate.

If a key was pasted into the chat unasked: say it is now in the log; use it only if they want; recommend rotating.

## Step 4 - Create the key (only when it has somewhere to go)

https://platform.claude.com/settings/keys → "키 생성" ("Create key") → if asked, "API 키로 계속하기"
("Continue with API key"). You may fill the name (e.g. `creditfirst`) and keep the defaults (expiry: the
human's choice; scope: default workspace). **The human clicks the final create button, the copy button,
and "완료" (Done) themselves.** From the create click until the human says the dialog is closed, take **no
snapshot, screenshot, or page-text read** of that tab (it would copy the key into the log). The key is
shown once. Then run the handoff they chose.

## Path A - no hub (1 account, no paid key)

1. Step 2 → Step 3 (choice) → Step 4.
2. Option 2: `node "$CF/scripts/put-key.mjs" env --file "<absolute project path>/.env" --var ANTHROPIC_API_KEY --clear-clipboard`
   (it sets mode 600 and adds the file to `.gitignore`).
3. Explain: "When the credit runs out, requests fail instead of charging (no card on this org). Check the
   balance on the billing page; it refills on your renewal day."
4. Test (say first: one tiny real request, a fraction of a cent from the credit):
   `node "$CF/scripts/hub-admin.mjs" test --dotenv "<absolute project path>/.env"` - no `--hub`: it calls
   Anthropic directly with the key from the file. SDK examples: `references/connect-app.md`.

## Path B - own hub (deploy first, then keys)

Details: `references/hub-deploy.md`.

- **B1 Link credit on every account first:** Step 2 for each Max/Ultra account. Do **not** create keys yet.
- **B2 Prerequisites:** `node --version` (20+), `npm --version`. Vercel CLI: if `vercel --version` fails,
  the human runs `npm i -g vercel`; then `vercel whoami` (if not logged in, the human runs `vercel login`
  in their terminal; in Claude Code they can type `! vercel login`). Database: the easiest is Vercel's Neon
  integration, which hub-deploy starts in an interactive terminal (choose the Free plan) - no connection
  string to copy. Alternative: the human creates a free Neon project at https://neon.tech, copies the
  connection string (never into the chat), and you add `--database-url-from-clipboard`.
- **B3 Deploy:** pick a hub name (lowercase letters, digits, dashes, e.g. `jane-credit-hub`). Run
  `node "$CF/scripts/hub-deploy.mjs" --name jane-credit-hub --dry-run`, then without `--dry-run`
  (add `--database-url-from-clipboard`, `--scope <team-slug>`, `--timezone Asia/Seoul`, `--lang ko` as
  needed; the Neon integration needs an interactive terminal: `! node "<CF>/scripts/hub-deploy.mjs" …`).
  The last stdout line is JSON `{"ok":true,"url",…}`. Secrets: `~/.config/creditfirst/<hub>/` - never read
  them. Then `node "$CF/scripts/hub-admin.mjs" status --hub jane-credit-hub` must show `health: ok`.
- **B4 Per credit account - Step 3 (choice once), Step 4, then register right away:**
  - Option 1 (admin page): `<hub-url>/admin`, password ("Password" / "비밀번호") = the admin token. The
    human opens it themselves, not you: in their own terminal (outside Claude Code)
    `cat ~/.config/creditfirst/<hub>/HUB_ADMIN_TOKEN` or `pbcopy < ~/.config/creditfirst/<hub>/HUB_ADMIN_TOKEN`
    (macOS), or `open ~/.config/creditfirst/<hub>` and open the file in a text editor. Form
    "Register an account" / "계정 등록": Name / 이름, Kind / 종류 = "Max/Ultra plan API credit" / "구독 제공 크레딧",
    Monthly credit (USD) / 월 제공 크레딧(달러), Renewal day of month / 매달 갱신일(결제일), API key / API 키 →
    "Register" / "등록". Then confirm with `hub-admin.mjs status`.
  - Option 2: `node "$CF/scripts/put-key.mjs" hub --hub <hub> --kind credit --label "Max 20x (me)" --monthly-credit 200 --renewal-day 19 --clear-clipboard`
    (replace label, amount, day with this account's values).
  - The hub refuses a second key from the same org (409) and a key with no org id (400).
- **B5 Paid key (if any):** must be from a **different** org than every credit account. Same options; kind
  "Paid API (used last)" / "유료 API(마지막에 사용)", or
  `put-key.mjs hub --hub <hub> --kind paid --label "service paid key" --clear-clipboard`.
- **B6 Paid cap (recommended with a paid key):** in the hub folder, `cd "$CF/hub"`, run
  `vercel env add HUB_PAID_MONTHLY_CAP_USD production` (it prompts for the amount, e.g. `20`), then
  `vercel deploy --prod`. Or set it in the Vercel dashboard (Project → Settings → Environment Variables) and redeploy.
- **B7 One project key per app:**
  `node "$CF/scripts/hub-admin.mjs" add-project --hub <hub> --name <app> --dotenv "<absolute app path>/.env" [--credit-only]`
  writes `ANTHROPIC_API_KEY` (`cf_…`) and `ANTHROPIC_BASE_URL`. `--credit-only` for apps with their own
  paid path (they get 402 instead of paid fallback). Apps hosted on Vercel or elsewhere: `--key-file` and
  `references/connect-app.md`.
- **B8 Test** (say first: one tiny real request, a fraction of a cent, normally from credit):
  `node "$CF/scripts/hub-admin.mjs" test --hub <hub> --dotenv "<absolute app path>/.env"` - report status,
  pool (`credit` + account label, or `paid`), model, tokens. Problems: `references/troubleshooting.md`.

## Finish

Summarize in the user's language: what was created (orgs, keys by last 4 only, hub url, project names),
where secrets live (`.env` files, `~/.config/creditfirst/<hub>/`, Vercel env), the test result with the
pool, what happens when credit runs out, costs that apply (Vercel plan, paid cap), and next steps (another
app: B7; another account: Step 2 then B4; check: `hub-admin.mjs status`). If the RISKY path was used,
repeat the rotate reminder.

References: `references/console-credit-guide.md`, `references/key-safety.md`, `references/hub-deploy.md`,
`references/connect-app.md`, `references/troubleshooting.md`, and `docs/TERMS-NOTES.md` in the plugin root.
