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

This plugin reaches cloud sessions through Craig's claude.ai account (marketplace `hughescr/claude-code-config`, synced), so no setup script is needed.

## Claude app (desktop, web, phone)

Chat and Cowork are one Claude app, running in an Anthropic cloud workspace. It loads this plugin's skills, but there is no supported way to give it `BSKY_APP_PASSWORD`: it has no environment variables, and plugin settings are not prompted. It also cannot reach the Mac's `op`. So the skill is read-only here.

- **Read:** use the tool if `node` or `bun` is available (`command -v node bun`). Otherwise, use public XRPC web fetches (see [public-xrpc.md](public-xrpc.md)).
- **Post:** don't try. Draft the post and its alt text, and hand them to Craig to post from Claude Code or the Bluesky app.
