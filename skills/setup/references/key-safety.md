# Key safety

## Where a key can end up

| Path | Key seen by Claude? | In the conversation log? | Notes |
|---|---|---|---|
| Human pastes into `.env` | no | no | Safest. Claude checks only that the line exists. |
| Human pastes into the hub `/admin` form ("Register an account" / "계정 등록") | no | no | Safest on the hub path. Human reads the admin token from `~/.config/creditfirst/<hub>/HUB_ADMIN_TOKEN` themselves. |
| `put-key.mjs` from clipboard | no | no | Script prints only `…last4`. Value is not in argv or child env. |
| Claude reads screen / chat message | yes | **yes** | Rotate later. |

Claude Code saves every conversation turn, including tool output and messages, to
`~/.claude/projects/<project>/<session>.jsonl`. Anything Claude reads or receives lands there and can be
copied by backups, sync tools, or shared transcripts. That is why the default is that Claude never sees
the key.

## Safe ways to check without seeing

- Line exists: `grep -c '^ANTHROPIC_API_KEY=' .env` (prints a count, not the value).
- Shape: `grep -c '^ANTHROPIC_API_KEY=sk-ant-' .env` or `=cf_` for a hub project key.
- Last 4 only: `sed -n 's/^ANTHROPIC_API_KEY=.*\(....\)$/…\1/p' .env`
- Never `cat .env`, `echo $ANTHROPIC_API_KEY`, `env`, `printenv`, or `vercel env pull` to stdout.

## put-key.mjs

```
node "$CF/scripts/put-key.mjs" env --file <path>/.env --var ANTHROPIC_API_KEY [--clear-clipboard]
node "$CF/scripts/put-key.mjs" env --file <path>/.env --var DATABASE_URL     # expects postgres://…
node "$CF/scripts/put-key.mjs" hub --hub <name> --kind credit|paid --label <label> \
     [--monthly-credit <usd>] [--renewal-day <1-31>] [--url <hub-url>] [--clear-clipboard]
```

- Reads the clipboard (pbpaste / wl-paste / xclip / xsel / PowerShell Get-Clipboard), trims spaces and
  quotes, refuses anything that is not one word shaped like `sk-ant-…`, `cf_…`, or (for `*DATABASE_URL*`)
  `postgres://…`. Errors never repeat the clipboard content.
- `env`: replaces or appends `NAME=value`, file mode 600, and if the file is inside a git repo and not
  ignored, appends it to the nearest `.gitignore`. Warns if git already tracks the file (then run
  `git rm --cached <file>` - and treat the key as leaked if it was ever pushed).
- `hub`: POSTs to `<hub>/api/admin/accounts` with the admin token from
  `~/.config/creditfirst/<hub>/HUB_ADMIN_TOKEN` and prints the new id, key hint, and org id prefix, or the
  hub's error (secrets redacted).
- `--clear-clipboard` empties the clipboard after success (best effort on Windows/Linux).
- File safety: the `.env` is rewritten through a new temp file with a random name (exclusive create, mode
  600) and renamed into place; a symlinked `.env` is refused. `hub-admin.mjs --key-file` creates a brand-new
  600 file and refuses a path that already exists. Clipboard tools and git run with a minimal environment
  (PATH, HOME, locale, display variables), so other secrets in your shell are not handed to them.
- Hub URLs must be `https://` (plain `http://` only for localhost), and requests carrying a key or the admin
  token do not follow redirects.

Linux needs one of `wl-paste` (Wayland), `xclip`, or `xsel`. Windows uses PowerShell. **(Only macOS
`pbpaste` was exercised by the maintainers; the others are untested.)**

## The RISKY path, done carefully

Only after the human insists, having heard the warning:

1. Read the key from the screen or their message.
2. Write it with a tool that does not echo it (for example the editor tool writing the file), not
   `echo key >> .env` in a shell line you show.
3. Set the file to owner-only and keep it out of git: `chmod 600 <file>`, and make sure it is listed in
   `.gitignore` (`git check-ignore -q <file>` succeeds); add it if not.
4. Do not repeat it in your reply.
5. End with: "This key is in the conversation log. When convenient, create a new key in the Console,
   replace it (same steps), and delete the old one."

## Rotating a key

1. Console -> Keys -> create a new key in the same org.
2. Put it in place: for a `.env`, `put-key.mjs env …` again (it replaces the line). For a hub account, the
   hub API accepts `PATCH /api/admin/accounts {id, apiKey}` for a key from the **same** org; registering it
   with `put-key.mjs hub` would be refused as a duplicate org. Have the human paste it into the hub's
   `/admin` page **(whether the v0.1 admin page has a replace-key form is unverified)**.
3. Delete the old key in the Console.

## Hub secrets

`hub-deploy.mjs` writes `HUB_ADMIN_TOKEN`, `HUB_ENC_KEY`, `CRON_SECRET` to `~/.config/creditfirst/<hub>/`
(folder 700, files 600) and to Vercel env. Back that folder up somewhere private: losing `HUB_ENC_KEY`
means re-registering every account key. If you suspect a leak: delete the affected Console keys, create new
ones, re-register them, and create new project keys.
