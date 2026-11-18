#!/bin/sh
# craig-core: SessionEnd hook that removes empty session-env directories.
#
# Claude Code makes one directory per session under
# ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/session-env and never removes them. This hook
# removes only empty directories, each with rmdir:
#   1. ${base}/<session_id>, the ending session's own directory, when session_id is a
#      strict UUID;
#   2. every other direct child of ${base} whose name is a strict UUID, is empty, is not
#      the sessionId of a <config dir>/sessions/*.json record (a running session), and
#      was not modified in the last 60 minutes (a session may still be starting up).
# rmdir refuses a directory that holds anything, so a directory that holds a file
# survives. Symlinks are never followed or removed, and *.key files are never read.
#
# Step 2 is skipped when jq is absent, the sessions directory is missing, it holds no
# *.json records, or the keep-list comes out empty. Step 1 still runs.
#
# Never fails the session: no stdout, exit 0 in every case.
# tests/clean-session-env.test.sh covers this script.
#
# POSIX sh. jq reads session_id, and the session records in step 2, when installed;
# sed reads session_id otherwise.

set -u
LC_ALL=C
export LC_ALL

# Read stdin first, even when the base directory is missing, so Claude Code
# never writes into a pipe this hook has closed.
input=$(cat 2>/dev/null || true)

config_dir=${CLAUDE_CONFIG_DIR:-}
if [ -z "$config_dir" ]; then
  [ -n "${HOME:-}" ] || exit 0
  config_dir=$HOME/.claude
fi
base=$config_dir/session-env

[ -d "$base" ] || exit 0

# A strict UUID: 36 characters, hex digits and dashes, and exactly five dash-separated
# groups of 8, 4, 4, 4 and 12 hex digits. Anything else ("../x", "a/b", "-1111111-...",
# a trailing slash, a space) is refused.
is_uuid() {
  case "$1" in
    *[!0-9a-fA-F-]* | "") return 1 ;;
  esac
  [ "${#1}" -eq 36 ] || return 1
  (
    IFS=-
    set -f
    # Splitting on '-' is the point here; set -f stops globbing.
    # shellcheck disable=SC2086
    set -- $1
    [ $# -eq 5 ] && [ "${#1}" -eq 8 ] && [ "${#2}" -eq 4 ] && [ "${#3}" -eq 4 ] &&
      [ "${#4}" -eq 4 ] && [ "${#5}" -eq 12 ]
  )
}

if command -v jq >/dev/null 2>&1; then
  have_jq=1
  session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
else
  have_jq=0
  session_id=$(printf '%s' "$input" |
    sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi

if is_uuid "${session_id:-}"; then
  rmdir "$base/$session_id" 2>/dev/null
fi

# Step 2 needs jq to read the session records. Fail closed: skip it unless jq is
# installed, the sessions directory exists, and the keep-list is not empty.
[ "$have_jq" -eq 1 ] || exit 0
sessions=$config_dir/sessions
[ -d "$sessions" ] || exit 0

# Keep-list: the sessionId of every sessions/*.json record. awk writes each file behind a
# separator byte, reading it with getline so that an unreadable file is skipped rather
# than aborting the run. jq then parses each separated chunk on its own, so a malformed
# file protects nothing and does not hide the files after it. Both run once over every
# file (find batches them). The keep-list is built before the directory changes.
keep=$(find "$sessions" -maxdepth 1 -type f -name '*.json' \
  -exec awk 'BEGIN { for (i = 1; i < ARGC; i++) { printf "\036"; while ((getline line < ARGV[i]) > 0) print line; close(ARGV[i]) } }' {} + 2>/dev/null |
  jq -Rrs 'split("\u001e") | .[] | (try fromjson catch empty) | (.sessionId? // empty) | select(type == "string" and length > 0)' 2>/dev/null)

[ -n "$keep" ] || exit 0

# Sweep. find lists the empty direct children of base, relative to base. awk keeps only
# strict UUIDs that are not in the keep-list (compared lower-cased), and xargs passes those
# bare names to one batched rmdir. The names are hex and dashes only, so none needs quoting
# and none can start with an option or contain a slash.
unset CDPATH
cd "$base" >/dev/null 2>&1 || exit 0
find . -mindepth 1 -maxdepth 1 -type d -empty -mmin +60 2>/dev/null |
  KEEP="$keep" awk '
    function uuid(s,   g) {
      if (length(s) != 36 || s !~ /^[0-9a-fA-F-]+$/) return 0
      return split(s, g, "-") == 5 && length(g[1]) == 8 && length(g[2]) == 4 &&
        length(g[3]) == 4 && length(g[4]) == 4 && length(g[5]) == 12
    }
    BEGIN {
      n = split(ENVIRON["KEEP"], k, "\n")
      for (i = 1; i <= n; i++) if (k[i] != "") keep[tolower(k[i])] = 1
    }
    {
      name = substr($0, 3)
      if (uuid(name) && !(tolower(name) in keep)) print name
    }' |
  xargs -r rmdir 2>/dev/null

exit 0
