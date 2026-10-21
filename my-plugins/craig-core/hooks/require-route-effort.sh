#!/bin/sh
# craig-core: PreToolUse hook (matcher Agent) enforcing the CLAUDE.md routing
# rule for route agents.
#
# Route agents pin only their model; they set no effort, so an Agent call
# without "effort" silently inherits the parent session's effort. This hook
# denies, for any route agent:
#   - a call with no "effort" (absent, null or empty), and
#   - a call that passes "model" (the agent file pins it).
# Every other Agent call (capability-specific agents such as
# craig-core:project-steward, built-in agents, fork) is allowed untouched.
#
# ROUTES must match the routing table in instructions/COMMON-CLAUDE.md.
# tests/require-route-effort.test.sh covers this script.
#
# POSIX sh plus jq. Unparseable input means no opinion (allow). A missing jq
# is reported on stderr with exit 1, which Claude Code shows but does not
# block on.

set -u
LC_ALL=C
export LC_ALL

ROUTES='["craig-core:opus","craig-core:sonnet","craig-core:haiku","craig-core:fable","gpt-sol","gpt-astra","gpt-luna","deepseek-flash","deepseek-v4-pro"]'

input=$(cat 2>/dev/null || true)

if ! command -v jq >/dev/null 2>&1; then
  echo "require-route-effort: jq not found; Agent effort rule not enforced" >&2
  exit 1
fi

# jq prints the deny JSON, or nothing to allow. A parse failure allows.
printf '%s' "$input" | jq -c --argjson routes "$ROUTES" '
  def present: . != null and . != "";
  select((.tool_name // "Agent") == "Agent" or .tool_name == "Task")
  | (.tool_input // {}) as $in
  | ($in.subagent_type // "") as $type
  | select(($type | type) == "string" and ($routes | index([$type])) != null)
  | [
      (if ($in.effort | present) then empty else
        "no effort: route agents pin only the model, so a call without effort inherits the parent session effort" end),
      (if ($in.model | present) then
        "model passed: route agents pin their model in the agent file" else empty end)
    ] as $problems
  | select($problems | length > 0)
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: (
          "Agent call to route agent \"" + $type + "\" denied (" + ($problems | join("; ")) + "). "
          + "Fix: call it as {\"subagent_type\": \"" + $type + "\", \"effort\": \"<effort>\", ...} with the effort from the CLAUDE.md routing table row for this route, and no \"model\"."
        )
      }
    }
' 2>/dev/null || true
exit 0
