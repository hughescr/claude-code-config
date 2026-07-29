#!/bin/sh
# scripts/est-lib.sh — shared resolution logic for every estimator shell entry point.
#
# Sourced, never executed. Exists because launchd and hook processes both run with a
# minimal PATH that does NOT include /opt/homebrew/bin or ~/.bun/bin, so "bun" and
# "est" cannot be assumed to resolve. Everything below is POSIX sh.
#
# After sourcing, use:
#   est_run <verb> [args...]   -> runs the est CLI whichever way it is available
#   $EST_HOME                  -> /Users/craig/.claude/estimator (override with EST_HOME)

EST_HOME="${EST_HOME:-$HOME/.claude/estimator}"
export EST_HOME

# --- locate bun -------------------------------------------------------------
# Order: an explicit EST_BUN, then PATH, then the two locations bun actually
# installs to on this machine. Fails loudly rather than silently doing nothing.
est_find_bun() {
  # ${VAR:-} everywhere: these are sourced by scripts running under `set -u`.
  if [ -n "${EST_BUN:-}" ] && [ -x "${EST_BUN:-}" ]; then
    printf '%s\n' "$EST_BUN"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# --- run the CLI ------------------------------------------------------------
# Prefers a real `est` on PATH (once package.json declares a bin and `bun link`
# has been run); otherwise invokes src/cli.ts directly, which is exactly
# equivalent and needs no install step.
est_run() {
  if command -v est >/dev/null 2>&1; then
    est "$@"
    return $?
  fi
  _est_bun="$(est_find_bun)" || {
    echo "est: cannot find bun (tried \$EST_BUN, PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin)" >&2
    return 127
  }
  "$_est_bun" run "$EST_HOME/src/cli.ts" "$@"
}

# Run a script under $EST_HOME/scripts with bun.
est_bun_script() {
  _script="$1"
  shift
  _est_bun="$(est_find_bun)" || {
    echo "est: cannot find bun" >&2
    return 127
  }
  "$_est_bun" run "$EST_HOME/scripts/$_script" "$@"
}
