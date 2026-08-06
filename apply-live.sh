#!/usr/bin/env zsh
# apply-live.sh — one-shot post-merge cleanup for the setup-refresh branch.
#
# Run this AFTER merging setup-refresh into the live checkout at ~/.claude,
# with all other Claude Code sessions stopped. It clears the orphaned runtime
# state that the merge itself cannot touch (plugin marketplace clone, stale
# install records, frozen cache), then prints the manual edits still needed
# in UNTRACKED files and the verification steps for the first fresh session.
#
# Idempotent: every step checks current state first and skips work already
# done, so re-running after a partial pass is safe.
#
# Destructive steps are gated: pass -f/--force to skip the per-step
# interactive confirmation.

set -euo pipefail

CLAUDE_DIR="/Users/craig/.claude"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
MARKETPLACE_DIR="$PLUGINS_DIR/marketplaces/craigs-claude-plugins"
CACHE_DIR="$PLUGINS_DIR/cache/craigs-claude-plugins"
INSTALLED_JSON="$PLUGINS_DIR/installed_plugins.json"
BACKUP_DIR="/tmp/claude"

FORCE=false
case "${1:-}" in
    -f|--force) FORCE=true ;;
    "") ;;
    *) echo "usage: $0 [-f|--force]" >&2; exit 2 ;;
esac

# Ask before a destructive step unless --force was given.
# Usage: confirm "description of what is about to happen"
confirm() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    printf '%s [y/N] ' "$1"
    local answer
    read -r answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

echo "== apply-live: post-merge cleanup for setup-refresh =="
echo

# ---------------------------------------------------------------------------
# (a) Orphaned marketplace clone: the old git-clone-based marketplace under
#     plugins/marketplaces/ is superseded by the directory-source registration
#     in settings.json (extraKnownMarketplaces -> path /Users/craig/.claude).
#     Back it up to /tmp/claude, then delete it.
# ---------------------------------------------------------------------------
if [[ -d "$MARKETPLACE_DIR" ]]; then
    if confirm "Back up and DELETE orphaned marketplace clone $MARKETPLACE_DIR?"; then
        mkdir -p "$BACKUP_DIR"
        backup_tar="$BACKUP_DIR/craigs-claude-plugins-marketplace-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        tar -czf "$backup_tar" -C "$(dirname "$MARKETPLACE_DIR")" "$(basename "$MARKETPLACE_DIR")"
        echo "  backed up to $backup_tar"
        rm -rf "$MARKETPLACE_DIR"
        echo "  deleted $MARKETPLACE_DIR"
    else
        echo "  skipped (not confirmed)"
    fi
else
    echo "  (a) marketplace clone already gone: $MARKETPLACE_DIR"
fi
echo

# ---------------------------------------------------------------------------
# (b) Stale install record + frozen cache: the hugo@craigs-claude-plugins
#     project-scoped install (misc.rungie.com, pinned at 1.0.0 since January)
#     points into the cache copy we are deleting. Remove the entry via jq
#     (write temp, validate, move) and delete the cache dir.
# ---------------------------------------------------------------------------
if jq -e '.plugins["hugo@craigs-claude-plugins"]' "$INSTALLED_JSON" >/dev/null 2>&1; then
    if confirm "Remove stale hugo@craigs-claude-plugins entry from $INSTALLED_JSON?"; then
        tmp_json="$(mktemp "$BACKUP_DIR/installed_plugins.XXXXXX.json" 2>/dev/null || mktemp)"
        jq 'del(.plugins["hugo@craigs-claude-plugins"])' "$INSTALLED_JSON" > "$tmp_json"
        # Validate the rewrite parses before letting it replace the original.
        jq -e . "$tmp_json" >/dev/null
        mv "$tmp_json" "$INSTALLED_JSON"
        echo "  removed entry; $INSTALLED_JSON rewritten"
    else
        echo "  skipped (not confirmed)"
    fi
else
    echo "  (b) installed_plugins.json already clean of hugo@craigs-claude-plugins"
fi

if [[ -d "$CACHE_DIR" ]]; then
    if confirm "DELETE frozen plugin cache $CACHE_DIR?"; then
        rm -rf "$CACHE_DIR"
        echo "  deleted $CACHE_DIR"
    else
        echo "  skipped (not confirmed)"
    fi
else
    echo "  (b) plugin cache already gone: $CACHE_DIR"
fi
echo

# ---------------------------------------------------------------------------
# (c) Manual edits to UNTRACKED files (not merged, so not fixed by the
#     branch). Review and apply by hand — this script prints the proposed
#     replacement content rather than editing blind.
# ---------------------------------------------------------------------------
cat <<'EOF'
== (c) Manual edits still needed (untracked files) ==

1. /Users/craig/.claude/.claude/CLAUDE.md
   The humanizer plugin submodule is gone; only skills/model-selection remains.
   Proposed full replacement content:

---8<---
## Git Submodules

Some skills in this repo are git submodules (currently `skills/model-selection`). Before submodule work, preview updates with `git -C ~/.claude submodule update --remote --dry-run`; drop `--dry-run` to apply, then test and commit. Revert a bad update with `git submodule update --force <submodule-path>` — this re-checks the submodule out to the commit recorded by the superproject, discarding local modifications (plain `--checkout` is just the default update procedure and does not by itself discard local changes; `--force` is what makes it do so).
---8<---

2. /Users/craig/.claude/.claude/settings.local.json
   Drop: the two WebFetch domain rules (shadow settings.json's own allows),
   the malformed "$ANTHROPIC_API_KEY" rule (missing ${...} braces — can never
   match), the two stale bunx rules for /tmp/claude/test-if-settings.json
   (that experiment is over and the bunx launch path is retired), and the
   no-op "outputStyle": "default".
   Proposed full replacement content:

---8<---
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(test:*)",
      "Bash(echo:*)",
      "Bash(chmod:*)"
    ]
  }
}
---8<---

EOF

# ---------------------------------------------------------------------------
# (d) Post-merge verification
# ---------------------------------------------------------------------------
cat <<'EOF'
== (d) Verify ==

1. Start a fresh Claude Code session (via claude-smart.sh).
2. Run /plugin marketplace list — craigs-claude-plugins should appear,
   sourced from the /Users/craig/.claude directory.
3. In ~/code/hughescr/misc.rungie.com, start a session and confirm the hugo
   plugin loads exactly once (no duplicate from the deleted cache install).
EOF
