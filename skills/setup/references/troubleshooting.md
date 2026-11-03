# Troubleshooting

## Console / credit

| Symptom | Likely cause | What to do |
|---|---|---|
| `/create/credits` shows only a purchase form | Max subscription under 7 days old, or a different account is signed in | Click nothing. Check the signed-in account (top-right / Settings). Wait until the evening of day 7 and reload. |
| Stuck on "Connecting…" ("연결 중") | The screen often does not advance even on success | Reload, or open `/settings/billing` and look for the credit balance. Do not click the offer twice in a row without checking. |
| Google login asks for SMS identity check | Google security check | Use "Continue with email" and the magic link, or let the human complete the check. |
| hCaptcha / verification | Normal | The human solves it. Never try to bypass it. |
| Credit balance does not show after linking | Linked to another org, or linking failed | Check which org is selected in the Console. Retry from `/create/credits` on the intended org. **(Exact recovery path unverified.)** |
| Billing page shows a card or auto-reload on the credit org | The org can charge when credit ends | The human removes the card / turns off auto-reload, or uses a fresh Individual org for the credit. |

## put-key.mjs

| Message | Fix |
|---|---|
| `the clipboard is empty` | Copy the key again (copy button in the Console), then rerun. |
| `does not look like an Anthropic API key` | Something else is in the clipboard (or only part of the key). Copy again. |
| `more than one word` | Copy only the key, not the surrounding text. |
| `could not read the clipboard` | Linux: install `wl-clipboard`, `xclip`, or `xsel`. Or use the manual paste path. |
| `no admin token at …` | Hub not deployed yet with this name, or a different `--hub` name. |
| `no hub URL` | Pass `--url https://…` or save it to `~/.config/creditfirst/<hub>/HUB_URL`. |
| `hub error 400 … rejected the key` | Key revoked/typo, or Anthropic returned no organization id. Create a new key. |
| `hub error 409` | That org is already registered, or a paid key shares an org with a credit account. Use a key from a different org. |
| `hub error 401` | Admin token file does not match the deployed hub's `HUB_ADMIN_TOKEN`. |

## hub-admin.mjs test

| Result | Meaning / fix |
|---|---|
| `status: 200`, `pool: credit (account #n …)` | Working as intended. |
| `pool: paid` | No credit account could take it: credit used up, accounts cooling down after rate limits, or no credit account registered. Run `status` and look at `usable` and `status`. |
| `402` + `hub error [credit-unavailable]` | Credit-only project and no credit available. Expected behavior; the app should fall back on its own path. |
| `402` + `hub error [paid-cap-reached]` | `HUB_PAID_MONTHLY_CAP_USD` reached this month. |
| `401` | Wrong project key in the env file, or the project key was disabled. Create a new one with `add-project`. |
| `404` / HTML reply | Wrong `ANTHROPIC_BASE_URL` (should be the hub root, no `/v1`). |
| `pool: (no x-hub-pool header - check that ANTHROPIC_BASE_URL is your hub)` | The reply carried no hub headers. Check `ANTHROPIC_BASE_URL` (hub root, `https://`, no `/v1`). |
| `pool: none (the hub answered this request itself)` + `hub error: …` | The hub refused before reaching Anthropic; the text after `hub error` is the hub's reason (for example "no account can take this request": every credit account is used up, cooling down, or rejected its key). Run `status`. |
| `pool: direct to Anthropic (no hub)` | Test without a hub: the key went straight to Anthropic. Expected for the 1-account setup. |
| `use https://` | Keys are only sent over https (plain http only for localhost). Fix the URL. |
| `413` or connection reset on big inputs | Vercel's 4.5 MB request limit. Call Anthropic directly for those requests. |
| Model not accepted | The hub only meters models it has prices for. Use a current model id, or update the hub's price table. |

## Hub numbers vs. the billing page

The hub's "spent" and "usable" are its own estimates. Usage outside the hub (same key used elsewhere,
Console workbench) is invisible to it. If the billing page shows less credit than the hub thinks, the hub
may route a request to an account that then refuses it; the hub moves to the next account. Keep each
credit key used only by the hub.

## Lost secrets

- Lost `HUB_ADMIN_TOKEN`: it is also in the Vercel project env; the human can view it in the Vercel
  dashboard and restore the file.
- Lost `HUB_ENC_KEY` (both copies): stored account keys can no longer be decrypted. Generate a new hub
  secret set (redeploy) and register every account key again.
