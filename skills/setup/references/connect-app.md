# Connecting an app

Two env vars. Without a hub, only `ANTHROPIC_API_KEY` (the credit-org key, `sk-ant-…`). With a hub:

```
ANTHROPIC_BASE_URL=https://<your-hub>.vercel.app
ANTHROPIC_API_KEY=cf_…            # project key from hub-admin add-project
```

The official Anthropic SDKs read both variables automatically, so most apps need no code change. Do not
add `/v1` to the base URL; the SDK appends `/v1/messages`.

## TypeScript / JavaScript

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
// or explicitly:
// const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL });

const msg = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## Python

```python
import anthropic

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
msg = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
)
```

## Checking that it works (no key on any command line)

```sh
node "$CF/scripts/hub-admin.mjs" test --dotenv <app>/.env                 # no hub: calls Anthropic (or the file's ANTHROPIC_BASE_URL)
node "$CF/scripts/hub-admin.mjs" test --hub <hub> --dotenv <app>/.env     # hub: also names the credit account that served it
```

The script reads the key from the file itself and prints the status, the pool (`x-hub-pool: credit|paid|none`,
`x-hub-account: <id>`), model and tokens - never the key. Do not test with `curl -H "x-api-key: …"` or by
exporting the whole `.env` into your shell: that puts the key into process arguments and your transcript.

## Vercel-hosted app: switch env without printing the key

```sh
KF="$HOME/.config/creditfirst/<hub>/project-<app>-$(date +%Y%m%d%H%M%S).key"   # new path; the script refuses an existing one
node "$CF/scripts/hub-admin.mjs" add-project --hub <hub> --name <app> --key-file "$KF" [--credit-only]
cd <app>
vercel env rm ANTHROPIC_API_KEY production -y          # if it exists (old direct key)
vercel env add ANTHROPIC_API_KEY production < "$KF"
printf '%s' "https://<hub>.vercel.app" | vercel env add ANTHROPIC_BASE_URL production
rm "$KF"
vercel deploy --prod                                   # env changes need a redeploy
```

The key file is created new with mode 600 inside your private `~/.config/creditfirst/<hub>/` folder (not a
shared `/tmp` path that someone else could pre-create).
Repeat for `preview` / `development` if those environments call Claude too. Keep the old direct key in
the Console until the new deploy is verified, then delete it if no longer needed.
**(Reading the value from stdin is how the Vercel CLI behaved for the maintainers; check `vercel env add
--help` on your version.)**

## Credit-only projects (402 handling)

Create with `--credit-only` when the app has its own paid path (for example a production service that must
never spend the hub's paid key). When no credit account can take a request, the hub answers:

- HTTP `402`, body `{"type":"error","error":{"type":"billing_error",…}}`
- header `x-hub-error: credit-unavailable`, `x-hub-pool: none`

The app should then retry on its own path, for example:

```ts
import Anthropic from '@anthropic-ai/sdk';

const hub = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL });
const direct = new Anthropic({ apiKey: process.env.ANTHROPIC_DIRECT_API_KEY, baseURL: 'https://api.anthropic.com' });

export async function create(params: Anthropic.MessageCreateParamsNonStreaming) {
  try {
    return await hub.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status === 402) return direct.messages.create(params);
    throw e;
  }
}
```

```python
import os, anthropic

hub = anthropic.Anthropic()
direct = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_DIRECT_API_KEY"], base_url="https://api.anthropic.com")

def create(**params):
    try:
        return hub.messages.create(**params)
    except anthropic.APIStatusError as e:
        if e.status_code == 402:
            return direct.messages.create(**params)
        raise
```

Without a hub (1 account, credit-org key directly): when credit runs out, Anthropic refuses requests
(this org has no card), typically with a billing/credit error **(exact status code and message from
Anthropic unverified)**. Show a friendly message or switch to another key yourself.

## Not covered

- Claude Code itself: do not point your own interactive Claude Code at the hub; it is meant for your apps'
  API calls. **(Whether the Max/Ultra API credit may be consumed by Claude Code is unverified; we don't recommend it.)**
- Batch and Files APIs, and request bodies over 4.5 MB (Vercel limit) - call Anthropic directly for those.
