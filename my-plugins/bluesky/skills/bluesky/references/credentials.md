# Bluesky credentials per surface

Write commands (`post`, `delete`) need credentials. `read`, `profile`, and `feed` never touch them. `search` tries two public hosts first. If both refuse, it falls back to an authenticated search, which looks up the password the same way a write does: `BSKY_APP_PASSWORD`, else `op` (which may ask Craig for Touch ID).

## How the tool finds them

1. **Handle.** `BSKY_HANDLE` if set, else `craig.rungie.com`.
2. **Password.** `BSKY_APP_PASSWORD` if set.
3. **1Password.** If there is no password variable and `op` is on PATH, the tool runs `op read "$BSKY_OP_REF"`. `BSKY_OP_REF` defaults to Craig's app-password item in his Private vault.
4. **Error.** Otherwise the tool stops with a message that says how to set `BSKY_APP_PASSWORD`.

Rules:
- Use an app password, never the account password. Craig creates one at bsky.app, Settings, Privacy and security, App passwords. Leave direct-message access off, because the tool doesn't use DMs.
- Give each surface its own app password, so Craig can revoke one without breaking the others.
- Never print, echo, log, or write the password to a file, and never commit it. The repo is public.
- If the password isn't available, tell Craig what is missing. Don't search the keychain, dotfiles, or other projects for it.

## Local Mac: CLI and the Desktop Code tab

Nothing to set. `op` reads the password, and 1Password may ask Craig to unlock it with Touch ID.

If `op read` fails inside a sandboxed shell (the 1Password app socket is blocked), report that. The retry goes through the normal permission prompt. Don't work around it.

To use a different item, set `BSKY_OP_REF=op://<vault>/<item>/<field>`.

## Cloud sessions (claude.ai/code)

There is no `op` here, so use an environment variable. Node 22 and bun are already installed.

1. At claude.ai/code, open the environment's settings and go to **Environment variables**.
2. Add `BSKY_APP_PASSWORD=<app password>` in `.env` format, one per line. Quote the value if it contains `#`. Save.
3. Anyone who can use the environment can read its variables, so use Craig's own environment, not a shared one.
4. Don't use a network secret. Those are attached to request headers, but Bluesky login sends the password in the JSON body.
5. If the environment restricts network access, allow `bsky.social`, `*.host.bsky.network` (Craig's PDS), `public.api.bsky.app`, `api.bsky.app`, and `cdn.bsky.app`.

Repo `settings.json` plugins are not installed in cloud sessions. To get this plugin there, the environment's setup script (Bash, runs as root before Claude starts, must exit 0) can try the commands below. Both steps are untested on cloud sessions: whether `claude` is on PATH during setup, whether github.com is reachable, and whether the installed plugin then loads.

```sh
claude plugin marketplace add hughescr/claude-code-config || true
claude plugin install bluesky@craigs-claude-plugins || true
```

## Cowork

No documented way exists to give Cowork sessions an environment variable or secret. Cowork also doesn't prompt for plugin settings. Its sandbox can't reach the Mac's `op`. Whether node or bun exists there is unknown, so check with `command -v node bun`.

Posting from Cowork is unsupported for now. Fallbacks, best first:
1. Draft the post and its alt text, and Craig posts it from the app, or from a local CLI session.
2. Craig pastes an app password into the session for one use. It then sits in the transcript, so he should revoke that app password afterwards.

## claude.ai chat and phone

There is no shell, so there is no posting. Read with web fetch (see [public-xrpc.md](public-xrpc.md)). Give Craig the final text and alt text to paste into the app.
