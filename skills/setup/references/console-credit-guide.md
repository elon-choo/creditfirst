# Console credit guide (Max/Ultra credit -> Console org -> API key)

Source: what the maintainers saw while linking several Max/Ultra accounts in October 2026, with a Korean
Console UI. Anthropic changes these screens; **the screen in front of you wins over this file.** Items
marked **(unverified)** were not observed directly - read the screen and adapt, never guess-click.

English labels below are translations of the Korean labels we saw and are **(unverified)** unless noted.

## Before you start

- Plan name: claude.ai has shown the Max plan as "Ultra" since early November 2026. Same steps; screens
  observed under the Max name, so labels mentioning "Max" may now say "Ultra" **(unverified on the new name)**.
- One Max/Ultra account at a time. Each Max/Ultra account gets its own credit org and its own key.
- Wait until the Max/Ultra subscription is **at least 7 days old**. Observed: eligibility opened on the evening of
  day 7 (not at midnight). Before that, the credit page shows only a purchase form - do not buy, just wait
  and check again later.
- Amount observed: US$200 on Max 20x; the plan notes say US$100 on Max 5x **(5x amount unverified by us)**.
- The human does every login: password, Google account choice, email magic link, SMS, CAPTCHA (hCaptcha
  appeared on claude.ai email login). You may open pages and read them.
- Login tips observed:
  - "Continue with Google" on the Console sometimes triggered a Google identity check by SMS. "Continue
    with email" + the magic link in that account's inbox avoided it.
  - Linking appeared to work best when claude.ai in the same browser was signed in to the same Max/Ultra account
    **(observed once, cause unverified)**.

## 1. Sign in and create the credit org

1. Open https://platform.claude.com and have the human sign in with the **same account as the Max/Ultra plan**.
2. If the Console asks what kind of organization to create (URL under `/create`), choose
   **Individual** ("개인"). This org becomes the credit org. If the account already has an org with a card
   or a balance, create a new Individual org for the credit instead **(the exact menu for adding a second
   org is unverified)**.

## 2. Link the Max/Ultra credit

1. Open https://platform.claude.com/create/credits
2. What you may see:
   - **Offer shown** - a button like "연결하고 US$200 받기" ("Link and get US$200", English unverified;
     the amount follows the plan). Click it.
   - **Only a purchase form** (amount field, "크레딧 구매" / Buy credits) - not eligible yet (under 7 days,
     or wrong account signed in). Click nothing. Check who is signed in, then wait.
   - **Login page** - the session ended; the human signs in again.
3. After the offer button, a choice appears. Click **"카드 없이 계속하기"** ("Continue without card").
4. **Never click** "크레딧 구매" (Buy credits), "지금은 건너뛰기" (Skip for now), add card / payment method,
   or auto-reload. "Skip for now" was seen next to the offer; we never tested what it does and you must not.
5. A "연결 중" ("Connecting…") screen may never advance even when linking succeeded. Wait ~10 seconds,
   then reload, or open the billing page and look for the credit balance.

Alternative route observed earlier: claude.ai -> Settings -> Billing (https://claude.ai/settings/billing)
showed an "조직 연결" ("Connect organization") button whose dialog names the Console org to link. Read the
org name in the dialog and only confirm when it is the intended credit org **(this route was used before
the Console offer page existed for us; current availability unverified)**.

## 3. Confirm the credit org is safe (the human confirms, you do not assume)

Open https://platform.claude.com/settings/billing and ask the human to confirm, out loud:

- [ ] the credit balance shows the Max/Ultra credit ("크레딧 잔액" / Credit balance)
- [ ] **no card / payment method** is on this org
- [ ] **no prepaid balance** they bought
- [ ] **auto-reload is off**

Why: inside one org, Anthropic uses the Max/Ultra credit and then whatever paid balance exists. With no card and
no balance, the API refuses requests when credit ends instead of charging. The hub cannot see payment
methods through the API, so this human check is the only guard.

Write down the **credit expiry date** shown there. Its day of month is the `--renewal-day` for the hub
(the hub assumes the credit renews on that day every month). Note the plan amount for `--monthly-credit`.

## 4. Create the API key

Create a key only when it has somewhere to go: on the no-hub path right after section 3; on the hub path
only after the hub is deployed and healthy (SKILL.md Path B), then register it immediately.

1. Open https://platform.claude.com/settings/keys and click **"키 생성"** ("Create key") to open the dialog.
2. If a choice appears, pick **"API 키로 계속하기"** ("Continue with API key").
3. The dialog we saw had:
   - **Name** (placeholder `my-secret-key`) - use something like `creditfirst`.
   - **Linked account** ("연결된 계정") - default was a user-linked key; legacy key and service account
     were also offered. We kept the default and those keys worked with the hub. **(Service-account keys not
     tested.)**
   - **Expiry** ("만료") - we chose "never" ("안 함"). If the human prefers an expiry, set a reminder to
     replace the key before it dies (the hub stops using a dead key).
   - **Scope** ("범위") - default workspace ("기본 워크스페이스").
4. **The handoff choice (SKILL.md step 3) must be made before this click.** The human clicks the final
   create button themselves. The full key is then shown **once**. From that click until the human says the
   dialog is closed, Claude takes **no snapshot, screenshot, or page-text read** of the tab - a browser
   tool's after-click snapshot would copy the key into the conversation log. The human copies the key
   (copy button), the chosen handoff runs (paste themselves, or put-key from the clipboard), then the human
   clicks "완료" (Done) and says so. Only then may Claude look at the tab again.

## 5. The paid org (only if the user has a paid service key)

- The paid key must come from a **different** organization than every credit org (for example the org
  they already use for their service, with a card). The hub tests each key, reads the organization id, and
  refuses to register a paid key whose org matches a credit org (and the reverse).
- Do not add the Max/Ultra credit to the paid org, and do not add a card to the credit org.

## Checking the balance later

https://platform.claude.com/settings/billing on the credit org. The hub's own numbers are estimates from
its metering; the billing page is the truth. Credit used outside the hub (another app with the same key,
the Console workbench) is invisible to the hub.
