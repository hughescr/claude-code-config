# Bluesky tool

A self-contained ESM CLI, with TypeScript source and Bun tests. Run the committed
`scripts/bsky.mjs` with **Node 22+** or Bun; users do not need dependencies or Bun.
The plugin's skills supply the reading/posting workflow; this README describes the tool.

## Commands

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" --help
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" profile craig.rungie.com --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" feed craig.rungie.com --limit 20 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" read 'https://bsky.app/profile/craig.rungie.com/post/POST_KEY' --depth 6 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" search 'query' --limit 20 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" post --text 'Draft' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bsky.mjs" delete 'at://did:plc:ACCOUNT/app.bsky.feed.post/POST_KEY' --json
```

Reads use `https://public.api.bsky.app` without credentials. `read` accepts a
bsky.app post URL or post AT-URI (handle or DID), and returns `post` plus `thread`
with parents/replies and all embeds. Image views retain their fields and add
`url` alongside `alt`. `profile`/`feed` accept handles or DIDs. Search tries
`public.api.bsky.app`, then `api.bsky.app` (the first host returns 403 for
searchPosts; the second answers without a login), then authenticates if both
refuse, resolving the password as writes do (`BSKY_APP_PASSWORD`, else `op`, which
may prompt 1Password).
Output is JSON by default, even without `--json`; errors go to stderr, exit 1.
Depth is 0–1000 (default 6); limit is 1–100 (default 20). Pagination cursors from
AppView are preserved, but this CLI does not fetch additional pages automatically.

## Preview, approve, then confirm

`post` and `delete` **never mutate without `--confirm CODE`**. First show the
complete preview to the human and obtain explicit approval. Re-run the same
arguments with the returned `confirmationCode`. Changed text, facets, actor,
image bytes/alt, reply/quote references, thread entries, or deletion record
invalidate that code. The tool checks the authenticated DID against the preview.
A code is a content-binding safeguard, not a substitute for human consent and
not a one-use receipt: repeating an approved command can create another post.

Post options: `--text T`, repeated `--image PATH --alt A` (paired by order,
maximum four images), `--reply-to URL_OR_URI`, `--quote URL_OR_URI`, or
`--thread-file FILE`. Every image needs non-blank alt text; PNG/JPEG/WebP files
are checked by signature and limited to 1 MB. Each post must be at most 300
graphemes. Link and mention facets use the Bluesky SDK, with UTF-8 offsets and
batched unique-handle resolution. Unresolvable mentions refuse the preview.

Thread files are JSON arrays of strings or `{ "text": "...", "images":
[{ "path": "image.png", "alt": "Description" }] }` objects, 1–100 entries.
`--thread-file` excludes `--text`/`--image`/`--alt`; reply/quote options apply to
the first entry. Split long drafts explicitly; nothing is truncated or split
silently. Image paths resolve from the process working directory, including
paths in thread files. Later entries reply to the previous entry and retain
the original root when extending an existing thread.

The preview is the exact **semantic payload plan**, including image SHA-256,
size/MIME/alt, resolved strong references, and symbolic `$thread:N` references.
Upload blob IDs, timestamps, and references to newly created thread posts cannot
exist until execution; only those fields are materialized afterward. No upload
or login occurs for post previews. Deletion previews require login to fetch the
account's authoritative repository record, refuse other authors, and bind the
record CID; deletion uses `swapRecord` against concurrent edits.

Thread writes are sequential, with no blind retries or automatic rollback.
Failure reports `succeeded` strong references, 1-based `failedIndex`, and
`uncertain` (true if the failing record request was attempted), and exits 1.
Inspect the account/repository before recovery: a lost response may hide a
successful write. Uploads can leave unreferenced blobs after failure.

## Credentials and runtime surfaces

Handle: `BSKY_HANDLE`, default `craig.rungie.com`. Password resolution: non-empty
`BSKY_APP_PASSWORD`, else executable `op` on PATH and `op read "$BSKY_OP_REF"`,
else an actionable error. The default reference is
`op://Private/ev3yijxphjzfz6lm5ziuqaj5c4/App Passwords/claude-posting-key`.
Use an **app password**, never the main account password. Passwords and op stderr
are never logged or stored; no credential file or session cache is used.

- **Local CLI / Desktop Code:** export the env var in the shell/runtime, or use
  a signed-in 1Password CLI. Don't put a secret in command arguments or the repo.
- **Cloud Code:** claude.ai/code → environment settings → **Environment variables**;
  enter `BSKY_APP_PASSWORD=...` in `.env` format (quote values containing `#`).
  Use a private environment: others using the environment can read its values.
  Network secrets inject headers, not the JSON password required by createSession.
  Allow public.api.bsky.app and api.bsky.app for reads and bsky.social plus the account's PDS for
  authentication/writes. The plugin arrives via Craig's claude.ai account sync.
- **Claude app (desktop, web, phone):** chat and Cowork are one app, running in an
  Anthropic cloud workspace. It cannot be given `BSKY_APP_PASSWORD` (no environment
  variables; plugin settings are not prompted) and cannot reach the Mac's `op`, so it
  is read-only. Read with the tool if `node` or `bun` is available
  (`command -v node bun`), else with public endpoints. Posting means drafting the text
  and alt text for Craig to post from Claude Code or the Bluesky app.

Restricted runtimes may require proxy configuration. Here direct Node fetch
was blocked by the sandbox; `NODE_USE_ENV_PROXY=1 node ...` worked on Node 26.10.
Use it on Node versions supporting environment-proxy routing, or use the
runtime's documented network configuration. `/sandbox` manages CLI restrictions.

## Development and checks

Use Bun **1.4.2** (`packageManager`) for byte-identical builds. Direct dependencies
and transitive overrides are pinned in package.json; there is no lockfile.

```sh
bun install --no-save --ignore-scripts
bun test
bun run typecheck
bun run build
bun run check:bundle
node scripts/bsky.mjs --help
```

The freshness check builds in memory and compares bytes without changing the
committed bundle. Strict typechecking also enables unused-symbol, return-path,
and switch-fallthrough checks. Tests inject API, credential, and file fakes:
**never real op, passwords, or write endpoints**. Only public reads are smoke-tested
against the real service. Based on Isambard's RichText/posting logic, without its
allowlist, Discord approvals, SST secrets, or health registry coupling. Bundles
include the Bluesky SDK and its dependencies; third-party license notices are
retained in the generated file.
