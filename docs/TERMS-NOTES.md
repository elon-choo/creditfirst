# Terms notes

CreditFirst is not affiliated with, endorsed by, or supported by Anthropic. This page is not legal advice
and does not quote Anthropic's terms. **Re-read the current terms yourself before using CreditFirst**, and
again when Anthropic updates them.

- Anthropic Consumer Terms (apply to Claude.ai / Max plans): https://www.anthropic.com/legal/consumer-terms
- Anthropic Commercial Terms (apply to the API / Console): https://www.anthropic.com/legal/commercial-terms
- Anthropic Usage Policy: https://www.anthropic.com/legal/aup
- Any credit or promotion terms shown on the Console when you link the Max credit - read them on screen.

(Links are placeholders we believe are correct as of 2026-11; if one moves, find it from anthropic.com/legal.)

## How CreditFirst is designed to be used

1. **Your own accounts only.** One installation belongs to one person or one company, using Max accounts
   that person or company owns and pays for. Our understanding is that promotional credit is tied to the
   account that received it and is not transferable. CreditFirst therefore has no feature for pooling
   accounts across people, and we do not recommend adding employees' personally paid accounts to a company
   hub. If you are unsure, read the terms or ask Anthropic.
2. **Your own app's features vs. reselling API access.** Running your own product's features through your
   hub (your app calls Claude on behalf of your users) is ordinary API use. Selling or giving others access
   to your hub URL and project keys - so they call the API themselves - is reselling API access, which
   generally needs Anthropic's permission. Don't.
3. **API keys only.** CreditFirst uses Console API keys. It never uses claude.ai session cookies,
   subscription OAuth tokens, or the Claude apps as an API, and you should not modify it to do so.
4. **No hosted service.** Each user deploys their own hub on their own infrastructure. We do not hold
   anyone's keys. The MIT license cannot stop someone from building a hosted service with this code; we do
   not endorse it.
5. **Billing safety is yours.** Keep the credit organization without a card, prepaid balance, or
   auto-reload if you want requests to be refused (not charged) when credit ends. The hub's cost numbers
   are estimates; the Console billing page is the source of truth.
6. **Hosting terms are yours too.** Vercel's Hobby (free) plan is for personal, non-commercial use; a hub
   that serves a business or commercial service needs a paid plan such as Vercel Pro. Check
   https://vercel.com/pricing and Vercel's current terms. Neon's free plan has its own limits.
7. **Name and trademarks.** "Claude" and "Anthropic" are Anthropic's trademarks. CreditFirst is an
   independent project compatible with the Anthropic Messages API.
