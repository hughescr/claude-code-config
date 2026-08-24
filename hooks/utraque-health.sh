#!/usr/bin/env bash
# SessionStart hook: reports the state of the local utraque proxy, which is what
# the gpt-* agent routes ride on.
#
# Fail-soft is the whole design. This hook must never block, slow, or break a
# session, so: stdin is drained under a read timeout, the curl is capped at 2
# seconds, every failure path exits 0, and nothing is printed unless there is
# something worth saying.
#
# When it says nothing (and does not even probe):
#   - ANTHROPIC_BASE_URL unset -> the integration is not turned on, so a stopped
#     proxy breaks nothing and needs no warning. Not probing is deliberate: it
#     keeps the rollback in UTRAQUE-SETTINGS-DELTA.md honest (removing that one
#     variable really does silence this hook) and it stops the probe from
#     re-activating a launchd-held daemon after the integration is backed out.
#     Set UTRAQUE_HEALTH_URL to probe anyway, which is how you test this hook.
# When it warns:
#   - proxy unreachable AND ANTHROPIC_BASE_URL set -> every request in this
#     session will fail, so print how to start it or how to back out.
# When it reports:
#   - proxy reachable -> one line of state, so a stale Codex credential or an
#     unloaded catalog is visible before a gpt-* route fails on it.
#
# Note: /healthz never contacts either upstream and is exempt from
# UTRAQUE_LOCAL_TOKEN, so this needs no credential. Under launchd, launchd holds
# the socket, so this request is also what activates the daemon for the session.
#
# Deliberately NOT `set -e`: a non-zero curl is an expected outcome here, not a
# reason to abort.
set -uo pipefail

REPO="${UTRAQUE_REPO:-/Users/craig/code/hughescr/utraque}"

# Whether the client is actually routed through a gateway. This is the only
# thing that decides whether an unreachable proxy is a problem or a non-event.
WIRED=0
[[ -n "${ANTHROPIC_BASE_URL:-}" ]] && WIRED=1

# Nothing to say and nothing to probe unless the client is wired to a gateway or
# a probe target was named explicitly. Exit before the stdin drain and before
# the network call, so the untouched case costs nothing at all.
if [[ "$WIRED" -eq 0 && -z "${UTRAQUE_HEALTH_URL:-}" ]]; then
  exit 0
fi

# Drain the hook payload so the harness never sees a broken pipe. Bounded by a
# read timeout, so a pipe that stays open cannot hold up a session start. The
# payload is not used: proxy health is global, not per-project.
while IFS= read -r -t 1 _; do :; done 2>/dev/null

BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:8317}"
BASE="${BASE%/}"
URL="${UTRAQUE_HEALTH_URL:-${BASE}/healthz}"

emit() {
  # $1 = the context text. jq builds the JSON so quoting and newlines are safe.
  jq -n --arg c "$1" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}' \
    2>/dev/null || true
  exit 0
}

command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# `--` so a hostile or mistyped UTRAQUE_HEALTH_URL cannot be read as a curl
# option.
BODY="$(curl -sf --max-time 2 --connect-timeout 1 -- "$URL" 2>/dev/null)" || BODY=""

if [[ -z "$BODY" ]]; then
  # Not reachable. Only ever reached when WIRED, or when a probe URL was named.
  if [[ "$WIRED" -eq 1 ]]; then
    STAKES="but ANTHROPIC_BASE_URL is set to ${ANTHROPIC_BASE_URL}, so every model request this session will fail until it is running — Claude routes included, not just the gpt-* ones."
  else
    STAKES="which UTRAQUE_HEALTH_URL asked this hook to probe. ANTHROPIC_BASE_URL is not set, so nothing is routed through it and no request this session depends on it."
  fi
  emit "utraque is not answering at ${URL} within 2s, ${STAKES} (If you installed the launchd agent moments ago, the first probe can time out while the daemon starts; re-check with curl before acting.)

Start it in the foreground:
  cd ${REPO} && go build -o bin/utraque ./cmd/utraque && ./bin/utraque &

Or install the launchd agent, which holds the socket, starts utraque on the first connection, and re-activates it after an idle hour:
  cd ${REPO}
  go build -o bin/utraque ./cmd/utraque
  openssl rand -hex 16 > ~/.utraque-token && chmod 600 ~/.utraque-token
  deploy/install.sh --local-token-file ~/.utraque-token
  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.hughescr.utraque.plist

Or back out entirely: if ANTHROPIC_BASE_URL names utraque, remove it from ~/.claude/settings.json to return to direct Anthropic routing. See ~/.claude/UTRAQUE-SETTINGS-DELTA.md."
fi

# Reachable. Summarise using the documented /healthz field names. The identity
# gate matters: something else listening on this port would otherwise be
# described confidently as a healthy utraque. status, version and uptime_s are
# the three fields /healthz always carries and can never have overridden, so
# requiring all three is the cheapest proof that this is really utraque.
#
# The body is piped in rather than passed as a here-string on purpose: bash
# spools a here-string through a temp file, so under a sandbox or a read-only
# TMPDIR the jq call fails and a perfectly healthy proxy gets reported as an
# impostor. A pipe needs no temp file.
SUMMARY="$(jq -er --arg url "$URL" --arg repo "$REPO" '
  def quota:
    if ((.codex_quota.reported // false) | not) then "quota not yet reported"
    else
      [ (.codex_quota.primary.used_percent // empty),
        (.codex_quota.secondary.used_percent // empty) ]
      | if length == 0 then "quota reported, no percentages"
        else "quota " + ((max) | tostring) + "% used in its busiest window"
        end
    end;
  def expiry:
    if ((.codex_auth.expires_in_s | type) == "number")
    then " (token expires in \(.codex_auth.expires_in_s)s)" else "" end;
  def advice:
    ((if ((.codex_auth.status // "") != "ok")
      then [" Run `codex login` (see " + $repo + ") to refresh the Codex credential; gpt-* routes will fail until it is ok. The `codex` relay agent shares that credential, so it will not work around this either."]
      else [] end)
     + (if ((.codex_catalog.state // "") | IN("failed","unavailable"))
        then [" The model catalog is " + .codex_catalog.state + (if .codex_catalog.last_error then " (" + (.codex_catalog.last_error|tostring) + ")" else "" end) + "; routing is falling back to the compiled-in seed list."]
        elif ((.codex_catalog.state // "") == "empty")
        then [" The catalog fetch SUCCEEDED and Codex listed no models at all, which is not a fetch failure: check the Codex subscription rather than the network. gpt-* routes will not resolve."]
        else [] end)) | add // "";
  if (.status? != "ok")
     or ((.version? | type) != "string")
     or ((.uptime_s? | type) != "number")
  then empty
  else
    "utraque " + .version + " is up at " + $url
    + ". Codex auth: " + (.codex_auth.status // "unknown") + expiry
    + ". Catalog: " + (.codex_catalog.state // "unknown")
    + " with " + ((.codex_catalog.models // 0) | tostring) + " models"
    + ". Codex transport: " + (.transport.kind // "unknown")
    + ". " + quota + "."
    + advice
  end
' < <(printf '%s' "$BODY") 2>/dev/null)" || SUMMARY=""

if [[ -z "$SUMMARY" ]]; then
  emit "Something is answering ${URL} but its response is not utraque's /healthz JSON, so the gpt-* routes probably will not work and this port may belong to another process. First 200 bytes: ${BODY:0:200}"
fi

if [[ "$WIRED" -eq 0 ]]; then
  SUMMARY="${SUMMARY} ANTHROPIC_BASE_URL is not set in this session, so nothing is routed through it yet and the gpt-* routes will fail; see ~/.claude/UTRAQUE-SETTINGS-DELTA.md."
fi

emit "$SUMMARY"
