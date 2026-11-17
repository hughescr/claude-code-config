#!/bin/sh
# Tests for bin/ts-lsp (the TypeScript language-server launcher), the
# SessionStart check hooks/ts-lsp-check.sh, and their wiring in plugin.json and
# hooks.json. POSIX sh: run it as `sh tests/ts-lsp.test.sh` or `bash tests/ts-lsp.test.sh`.
#
# Every case is a workspace with a package.json (what the project DECLARES,
# which decides) and fake node_modules (package.json versions and executable
# stubs, which only supply the binary), and the launcher runs against it under a
# controlled PATH, so nothing on the real machine leaks in. The resolution table
# runs with and without jq on PATH (the two package.json parsers differ) under
# each shell found (sh, dash, ksh, bash): the whole table under sh and bash, and
# the core subset (every rule, every fallback, every declared-but-not-installed
# kind, both parsers, the monorepo walk, broken and minified files) under the
# others. Needs jq for the JSON checks of the hook and manifests (skipped
# without it).
#
# Speed: every process costs a fork, so the suite spawns as few as it can. All
# workspaces are built once, up front, with the directories made by one mkdir and
# the stubs made executable by one chmod; the launcher runs once per case and
# every field of its output is read in the shell (no sed or grep per check);
# assertions are plain function calls.
#
# TS_LSP_LAUNCHER=/path/to/ts-lsp and TS_LSP_HOOK=/path/to/ts-lsp-check.sh run
# the suite against other copies of the launcher and the hook (to check that the
# suite catches a deliberately broken one); the hook then runs that launcher.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
LAUNCHER=${TS_LSP_LAUNCHER:-$PLUGIN/bin/ts-lsp}
HOOK=${TS_LSP_HOOK:-$PLUGIN/hooks/ts-lsp-check.sh}

# Nothing of the caller's environment may steer the launcher or the shells.
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT BASH_ENV ENV CDPATH STUB_CAT STUB_EXIT POSIXLY_CORRECT 2>/dev/null || true
case $LAUNCHER in /*) ;; *) LAUNCHER=$PWD/$LAUNCHER ;; esac
case $HOOK in /*) ;; *) HOOK=$PWD/$HOOK ;; esac

PASS=0
FAIL=0
SKIP=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
skip() { SKIP=$((SKIP + 1)); echo "skip $1"; }

eq() { # label got want
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', want '$3'"; fi
}
has() { # label haystack needle
  case $2 in *"$3"*) ok "$1" ;; *) bad "$1: '$3' not in '$2'" ;; esac
}
lacks() { # label haystack needle
  case $2 in *"$3"*) bad "$1: '$3' unexpectedly in '$2'" ;; *) ok "$1" ;; esac
}

nl='
'

FIX=$(mktemp -d "${TMPDIR:-/tmp}/ts-lsp-test.XXXXXX") || exit 1
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT
W=$FIX/ws
OUT=$FIX/out
ERR=$FIX/err

HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

SH0=$(command -v sh)

# slurp FILE: SLURP is the file's text without the trailing newline.
slurp() {
  SLURP=
  _sep=
  while IFS= read -r _l || [ -n "$_l" ]; do
    SLURP=$SLURP$_sep$_l
    _sep=$nl
  done <"$1"
}

# ---- controlled PATH --------------------------------------------------------
# BASE holds only what the launcher and the stubs need; jqbin adds jq.

BASE=$FIX/base
mkdir -p "$BASE" "$FIX/jqbin" || exit 1
_links=
for t in sed tr cat sh; do
  p=$(command -v "$t") || {
    echo "test setup: $t not found" >&2
    exit 1
  }
  _links="$_links$p$nl"
done
set -f
IFS=$nl
# shellcheck disable=SC2086
ln -s $_links "$BASE/"
unset IFS
set +f
[ "$HAVE_JQ" = 0 ] || ln -s "$(command -v jq)" "$FIX/jqbin/jq"

# The hook finds the launcher at $CLAUDE_PLUGIN_ROOT/bin/ts-lsp: the plugin
# itself, or a root that points at the alternate launcher.
HOOKROOT=$PLUGIN
if [ -n "${TS_LSP_LAUNCHER:-}" ]; then
  HOOKROOT=$FIX/hookroot
  mkdir -p "$HOOKROOT/bin"
  ln -s "$LAUNCHER" "$HOOKROOT/bin/ts-lsp"
fi

# ---- fixtures ---------------------------------------------------------------
# build_fixtures runs twice. Pass "dirs" only collects directory names (made by
# one mkdir -p afterwards); pass "files" writes the files and collects the stubs
# (made executable by one chmod afterwards). The writes are shell redirections,
# which cost no process.

MODE=dirs
DIRS=
EXECS=
mkd() { [ "$MODE" != dirs ] || DIRS=$DIRS$1$nl; }
xq() { [ "$MODE" != files ] || EXECS=$EXECS$1$nl; }
wf() { # path text
  [ "$MODE" = files ] || return 0
  printf '%s' "$2" >"$1"
}

# A stub executable: --version prints "Version V" and exits E; otherwise it
# echoes what it was run as (and stdin when STUB_CAT is set) and exits STUB_EXIT.
mkstub() { # path version [exit-for---version]
  mkd "${1%/*}"
  # The single quotes are deliberate: the stub's own $-expressions must stay literal.
  # shellcheck disable=SC2016
  wf "$1" '#!/bin/sh
case ${1:-} in --version) echo "Version '"$2"'"; exit '"${3:-0}"' ;; esac
echo "RAN '"${1##*/}"' $*"
[ -z "${STUB_CAT:-}" ] || echo "STDIN $(cat)"
exit ${STUB_EXIT:-0}
'
  xq "$1"
}

# add_ts dir version: node_modules/typescript (package.json, bin/tsc) + .bin/tsc
add_ts() {
  mkd "$1/node_modules/typescript"
  wf "$1/node_modules/typescript/package.json" "{${nl}  \"name\": \"typescript\",${nl}  \"version\": \"$2\"${nl}}${nl}"
  mkstub "$1/node_modules/typescript/bin/tsc" "$2"
  mkstub "$1/node_modules/.bin/tsc" "$2"
}
# add_alias dir NAME version: typescript installed under another name (npm alias)
add_alias() {
  mkd "$1/node_modules/$2"
  wf "$1/node_modules/$2/package.json" "{${nl}  \"name\": \"typescript\",${nl}  \"version\": \"$3\"${nl}}${nl}"
  mkstub "$1/node_modules/$2/bin/tsc" "$3"
}
add_bin() { mkstub "$1/node_modules/.bin/$2" 0; }
add_pkg() { mkd "$1"; wf "$1/package.json" "$2$nl"; }
# decl_ts dir range: package.json declaring typescript at that range (devDependencies)
decl_ts() { add_pkg "$1" "{\"name\":\"x\",\"devDependencies\":{\"typescript\":\"$2\"}}"; }
# nw name: d is the workspace directory of that name
nw() { d=$W/$1; mkd "$d"; }

build_fixtures() {
  mkd "$FIX/brokenroot/bin"
  mkstub "$FIX/g_tsc7/tsc" 7.0.2
  mkstub "$FIX/g_tsc5/tsc" 5.9.3
  mkstub "$FIX/g_tsgo/tsgo" 7.0.0-dev.20260707.2
  mkstub "$FIX/g_tsgo_bad/tsgo" 0 1
  mkstub "$FIX/g_tsrs/tsrs" 7.1.0-beta
  mkstub "$FIX/g_tsls/typescript-language-server" 6.1.0
  mkstub "$FIX/g_all/tsc" 7.0.2
  mkstub "$FIX/g_all/tsgo" 7.0.0
  mkstub "$FIX/g_all/tsrs" 7.1.0-beta
  mkstub "$FIX/g_tsgo_tsrs/tsgo" 7.0.0
  mkstub "$FIX/g_tsgo_tsrs/tsrs" 7.1.0-beta

  # 1. tsrs declared wins, even over a declared typescript 7
  nw tsrs1
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0","typescript":"^7.0.0"}}'
  add_bin "$d" tsrs
  add_ts "$d" 7.0.2
  nw tsrs1b
  add_pkg "$d" '{"peerDependencies":{"tsrs":"0.25.0-ts7.1.0-beta"}}'
  add_bin "$d" tsrs
  add_ts "$d" 7.0.2
  nw tsrs1c
  add_pkg "$d" '{"optionalDependencies":{"tsrs":"0.25.0"}}'
  add_bin "$d" tsrs
  add_ts "$d" 7.0.2
  nw tsrs2
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0","typescript":"^7.0.0"}}'
  add_ts "$d" 7.0.2

  # 2. TypeScript 7 declared (tsc is the Go-native server)
  nw ts7
  decl_ts "$d" 7.0.2
  add_ts "$d" 7.0.2
  nw ts7beta
  decl_ts "$d" "^7.1.0-beta"
  add_ts "$d" 7.1.0-beta
  nw ts7next
  decl_ts "$d" next
  add_ts "$d" 7.0.0-dev.20261115.1
  nw ts7latest
  decl_ts "$d" latest
  add_ts "$d" 7.0.0-dev.20261115.1
  nw ts8
  decl_ts "$d" "^8.0.0"
  add_ts "$d" 8.0.0
  nw ts7deps
  add_pkg "$d" '{"dependencies":{"typescript":"~7.0.1"}}'
  add_ts "$d" 7.0.2
  nw ts7peer
  add_pkg "$d" '{"peerDependencies":{"typescript":">=7"}}'
  add_ts "$d" 7.0.2
  nw ts7opt
  add_pkg "$d" '{"optionalDependencies":{"typescript":"^7"}}'
  add_ts "$d" 7.0.2

  # 2b. declared 7, installed, but no tsc binary -> fallback; .bin/tsc alone is accepted
  nw ts7nobin
  decl_ts "$d" "^7.0.0"
  mkd "$d/node_modules/typescript"
  wf "$d/node_modules/typescript/package.json" "{${nl}  \"name\": \"typescript\",${nl}  \"version\": \"7.0.2\"${nl}}${nl}"
  nw ts7binonly
  decl_ts "$d" "^7.0.0"
  mkd "$d/node_modules/typescript"
  wf "$d/node_modules/typescript/package.json" "{${nl}  \"name\": \"typescript\",${nl}  \"version\": \"7.0.2\"${nl}}${nl}"
  mkstub "$d/node_modules/.bin/tsc" 7.0.2

  # 2c. declared 7, installed version disagrees or is missing
  nw ts7stale
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  nw ts7none
  decl_ts "$d" "^7.0.0"
  nw ts7latest_stale
  decl_ts "$d" latest
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server

  # 2d. ranges with no readable major take the installed version's major
  nw cat7
  decl_ts "$d" "catalog:"
  add_ts "$d" 7.0.2
  nw cat5
  decl_ts "$d" "catalog:"
  add_ts "$d" 5.9.3
  add_bin "$d" typescript-language-server

  # 2e. an npm alias of typescript 7 (the isambard shape)
  nw isambard
  add_pkg "$d" '{
  "name": "isambard",
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "^6.0.3"
  }
}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  add_bin "$d" tsgo
  add_bin "$d" typescript-language-server
  n=0
  for v in "npm:typescript@^7" "npm:typescript@latest" "npm:typescript@next" "npm:typescript" "npm:typescript@7.1.0-beta" "npm:typescript@>=7.0.0"; do
    n=$((n + 1))
    nw "alias_ok$n"
    add_pkg "$d" "{\"devDependencies\":{\"ts7\":\"$v\"}}"
    add_alias "$d" ts7 7.0.2
  done
  nw alias_two
  add_pkg "$d" '{"devDependencies":{"a7":"npm:typescript@7.0.0","b7":"npm:typescript@7.0.2"}}'
  add_alias "$d" b7 7.0.2
  nw alias_notinst
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  nw alias_wrongver
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@^7"}}'
  add_alias "$d" @typescript/native 6.0.3
  nw alias_nobin
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@^7"}}'
  mkd "$d/node_modules/@typescript/native"
  wf "$d/node_modules/@typescript/native/package.json" "{${nl}  \"name\": \"typescript\",${nl}  \"version\": \"7.0.2\"${nl}}${nl}"

  # 3. @typescript/native-preview declared (tsgo)
  nw tsgo1
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  nw tsgo_ts5
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev","typescript":"^5.4.0"}}'
  add_bin "$d" tsgo
  add_ts "$d" 5.9.3
  nw tsgo_ts7
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev","typescript":"^7.0.0"}}'
  add_bin "$d" tsgo
  add_ts "$d" 7.0.2
  nw tsgo2
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'

  # 4. only TypeScript 6 and older declared: typescript-language-server
  nw ts6
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  nw ts4
  decl_ts "$d" "^4.9.5"
  add_ts "$d" 4.9.5
  add_bin "$d" typescript-language-server
  nw ts5path
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  nw alias5
  add_pkg "$d" '{"devDependencies":{"ts5":"npm:typescript@5.9.3"}}'
  add_alias "$d" ts5 5.9.3
  nw alias6plain
  add_pkg "$d" '{"devDependencies":{"typescript":"npm:typescript@6.0.2"}}'
  add_ts "$d" 6.0.2
  nw ts6beta
  add_pkg "$d" '{"devDependencies":{"typescript":"^6.0.3","ts5":"npm:typescript@5.9.3"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" ts5 5.9.3

  # 4b. undeclared binaries in node_modules are never used
  nw stray_tsgo
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsgo
  nw stray_tsrs
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  add_bin "$d" tsrs
  nw stray_tsrs6
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsrs
  nw stray_both
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  add_bin "$d" tsrs
  nw stray_nodecl
  add_pkg "$d" '{"name":"x","dependencies":{"left-pad":"1.0.0"}}'
  add_ts "$d" 7.0.2
  add_bin "$d" tsrs
  add_bin "$d" tsgo

  # 5. fallbacks: the project lacks what its server needs
  nw ts5nolsp
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3

  # 6. declared but nothing installed
  nw decl5
  decl_ts "$d" "^5.4.0"
  nw decl7
  add_pkg "$d" '{"peerDependencies":{"tsrs":"0.25.0-ts7.1.0-beta"}}'
  nw declcat
  add_pkg "$d" '{"devDependencies":{"typescript":"catalog:"}}'
  nw declalias6
  add_pkg "$d" '{"devDependencies":{"typescript":"npm:typescript@6.0.2"}}'
  nw nots
  add_pkg "$d" '{"name":"x","dependencies":{"left-pad":"1.0.0"}}'
  nw nopkg

  # 7. monorepo walk-up: the nearest package.json that declares something decides
  nw mono
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  mkd "$d/packages/app/src"
  add_pkg "$d/packages/app" '{"name":"app"}'
  nw mono_shadow
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  mkd "$d/packages/app/src"
  decl_ts "$d/packages/app" "^5.4.0"
  add_ts "$d/packages/app" 5.9.3
  nw mono_tsls
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  add_bin "$d" typescript-language-server
  decl_ts "$d/packages/app" "^5.4.0"
  add_ts "$d/packages/app" 5.9.3
  nw mono2
  decl_ts "$d" "^7.0.0"
  add_pkg "$d/packages/lib" '{"name":"lib"}'
  nw mono3
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  add_pkg "$d/apps/web" '{"devDependencies":{"@typescript/native-preview":"7.0.0-dev"}}'
  add_bin "$d/apps/web" tsgo
  nw mono4
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  add_pkg "$d/packages/app" '{"name":"app"}'
  nw mono5
  add_pkg "$d" '{"name":"root","workspaces":["packages/*"]}'
  add_ts "$d" 7.0.2
  decl_ts "$d/packages/app" "^7.0.0"
  nw mono6
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  mkd "$d/packages/app"
  wf "$d/packages/app/package.json" '{not json'
  nw mono7
  add_pkg "$d" '{"name":"root"}'
  add_ts "$d" 7.0.2
  add_pkg "$d/packages/app" '{"name":"app"}'

  # 8. broken package.json files
  nw badpkg
  wf "$d/package.json" '{not json'
  nw badpkg_ts7
  wf "$d/package.json" '{not json'
  add_ts "$d" 7.0.2
  nw emptypkg
  wf "$d/package.json" ''
  add_ts "$d" 7.0.2
  nw nullpkg
  add_pkg "$d" 'null'
  nw badnm
  mkd "$d/node_modules/typescript"
  wf "$d/node_modules/typescript/package.json" '{not json'
  decl_ts "$d" "^5.0.0"
  nw nover
  mkd "$d/node_modules/typescript"
  wf "$d/node_modules/typescript/package.json" '{"name":"typescript"}'
  nw minified
  mkd "$d/node_modules/typescript"
  wf "$d/node_modules/typescript/package.json" '{"name":"typescript","version":"7.0.2","bin":{"tsc":"./bin/tsc"}}'
  mkstub "$d/node_modules/typescript/bin/tsc" 7.0.2
  decl_ts "$d" "^7.0.0"
  nw minified_alias
  wf "$d/package.json" '{"name":"x","devDependencies":{"typescript":"^6.0.3","@typescript/native":"npm:typescript@7.0.2"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  nw crlf_alias
  wf "$d/package.json" "{
  \"devDependencies\": {
    \"typescript\": \"^6.0.3\",
    \"@typescript/native\": \"npm:typescript@7.0.2\"
  }
}
"
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2

  # 9. workspace selection
  nw sel_a
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0"}}'
  add_bin "$d" tsrs
  nw sel_b
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2

  # 10. a workspace path with a space and a quote
  d="$W/we\"ird dir"
  mkd "$d"
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  add_pkg "$d/app" '{"name":"app"}'

  # 11. exec behaviour
  nw exec7
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  nw exec_alias
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  add_bin "$d" tsgo
  nw exec_tsgo
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  nw exec_tsrs
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0"}}'
  add_bin "$d" tsrs
  nw exec_tsls
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  nw exec_stray
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsgo

  # The SessionStart hook
  nw hook_ok
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  nw hook_alias
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  nw hook_tsls
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  nw hook_fb
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  nw hook_none
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  nw hook_notinst
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  nw hook_stray
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsgo
  mkd "$W/we\"ird\\dir"
}

MODE=dirs
build_fixtures
set -f
IFS=$nl
# shellcheck disable=SC2086
mkdir -p $DIRS || exit 1
MODE=files
build_fixtures
# shellcheck disable=SC2086
chmod +x $EXECS || exit 1
unset IFS
set +f

# ---- running the launcher ---------------------------------------------------

# run_explain DIR PATH: run the launcher with --explain on DIR under PATH and
# read its fields into o_kind, o_matched, o_want, o_workspace, o_command,
# o_reason and o_hint, with no process but the launcher's own.
run_explain() {
  PATH=$2 "$SH" "$LAUNCHER" --explain --workspace "$1" >"$OUT" 2>"$ERR" </dev/null
  parse_out
}
parse_out() {
  o_kind=''
  o_matched=''
  o_want=''
  o_workspace=''
  o_command=''
  o_reason=''
  o_hint=''
  while IFS= read -r _l || [ -n "$_l" ]; do
    case $_l in
      kind=*) o_kind=${_l#kind=} ;;
      matched=*) o_matched=${_l#matched=} ;;
      want=*) o_want=${_l#want=} ;;
      workspace=*) o_workspace=${_l#workspace=} ;;
      command=*) o_command=${_l#command=} ;;
      reason=*) o_reason=${_l#reason=} ;;
      hint=*) o_hint=${_l#hint=} ;;
    esac
  done <"$OUT"
}

RAN=1
# ex LABEL NAME PATH-SUFFIX KIND MATCHED [WANT]: explain workspace NAME under the
# variant's PATH plus the suffix, then check the fields.
ex() {
  RAN=1
  run_explain "$W/$2" "$PB$3"
  eq "$LBL $1: kind" "$o_kind" "$4"
  eq "$LBL $1: matched" "$o_matched" "$5"
  [ -z "${6:-}" ] || eq "$LBL $1: want" "$o_want" "$6"
}
# exf: like ex, but only when the whole table runs (not the core subset).
exf() {
  if [ "$FULL" = 1 ]; then ex "$@"; else RAN=0; fi
}
# Checks on the last explain; skipped with it.
f_eq() { [ "$RAN" = 0 ] || eq "$LBL $1" "$2" "$3"; }
f_has() { [ "$RAN" = 0 ] || has "$LBL $1" "$2" "$3"; }

# ---- the resolution table, for one shell and one PATH flavour -------------------

suite() { # SHELL PATH-BASE LABEL FULL(1|0) JQ(1|0)
  SH=$1
  PB=$2
  LBL=$3
  FULL=$4
  JQV=$5
  w=$W

  # 1. tsrs declared wins, even over a declared typescript 7
  ex "tsrs declared" tsrs1 "" tsrs-project yes tsrs
  f_eq "tsrs declared: command" "$o_command" "$w/tsrs1/node_modules/.bin/tsrs --lsp --stdio"
  f_has "tsrs declared: reason names package.json and declaration" "$o_reason" "$w/tsrs1/package.json declares tsrs = ^0.25.0"
  exf "tsrs declared in peerDependencies" tsrs1b "" tsrs-project yes tsrs
  exf "tsrs declared in optionalDependencies" tsrs1c "" tsrs-project yes tsrs
  ex "tsrs declared but not installed: no fall-through to typescript 7" tsrs2 "" none no tsrs
  f_has "tsrs declared but not installed: hint" "$o_hint" "install the project's dependencies"
  ex "tsrs declared but not installed: tsrs on PATH" tsrs2 ":$FIX/g_tsrs" tsrs-path no tsrs

  # 2. TypeScript 7 declared (tsc is the Go-native server)
  ex "typescript 7.0.2" ts7 "" tsc7-project yes ts7
  f_eq "typescript 7.0.2: command" "$o_command" "$w/ts7/node_modules/typescript/bin/tsc --lsp --stdio"
  f_has "typescript 7.0.2: reason" "$o_reason" "$w/ts7/package.json declares typescript = 7.0.2; using $w/ts7/node_modules/typescript/bin/tsc"
  exf "typescript ^7.1.0-beta" ts7beta "" tsc7-project yes
  exf "typescript next (dist-tag counts as 7)" ts7next "" tsc7-project yes
  exf "typescript latest (dist-tag counts as 7)" ts7latest "" tsc7-project yes
  exf "typescript 8" ts8 "" tsc7-project yes
  exf "typescript in dependencies" ts7deps "" tsc7-project yes
  exf "typescript in peerDependencies" ts7peer "" tsc7-project yes
  exf "typescript in optionalDependencies" ts7opt "" tsc7-project yes

  # 2b. declared 7, installed, but no tsc binary -> fallback; .bin/tsc alone is accepted
  ex "typescript 7 without a tsc binary" ts7nobin "" none no ts7
  f_has "typescript 7 without a tsc binary: reason" "$o_reason" "has no tsc binary"
  exf "typescript 7, .bin/tsc only" ts7binonly "" tsc7-project yes
  f_eq "typescript 7, .bin/tsc only: command" "$o_command" "$w/ts7binonly/node_modules/.bin/tsc --lsp --stdio"

  # 2c. declared 7, installed version disagrees or is missing
  ex "declared ^7 but typescript 6 installed: no fall-through to classic" ts7stale "" none no ts7
  f_has "declared ^7 but 6 installed: reason" "$o_reason" "not TypeScript 7"
  exf "declared latest (a dist-tag, so 7) but typescript 6 installed: no fall-through to classic" ts7latest_stale "" none no ts7
  exf "declared ^7, node_modules missing" ts7none "" none no ts7
  f_has "declared ^7, node_modules missing: hint" "$o_hint" "install the project's dependencies"
  ex "declared ^7, node_modules missing, tsc 7 on PATH" ts7none ":$FIX/g_tsc7" tsc7-path no ts7

  # 2d. ranges with no readable major take the installed version's major
  exf "catalog: with typescript 7 installed" cat7 "" tsc7-project yes ts7
  ex "catalog: with typescript 5 installed" cat5 "" tsls-project yes classic

  # 2e. an npm alias of typescript 7 (the isambard shape)
  ex "ts ^6 + alias to ts 7 + stray tsgo" isambard ":$FIX/g_tsls:$FIX/g_tsgo" tsc7-project yes ts7
  f_eq "isambard shape: command is the alias's tsc" "$o_command" "$w/isambard/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  f_has "isambard shape: reason names the declaration" "$o_reason" "$w/isambard/package.json declares @typescript/native = npm:typescript@7.0.2; using $w/isambard/node_modules/@typescript/native/bin/tsc"
  f_has "isambard shape: reason mentions the ignored tsgo" "$o_reason" "ignored undeclared tsgo at $w/isambard/node_modules/.bin/tsgo"
  n=0
  for v in "npm:typescript@^7" "npm:typescript@latest" "npm:typescript@next" "npm:typescript" "npm:typescript@7.1.0-beta" "npm:typescript@>=7.0.0"; do
    n=$((n + 1))
    if [ "$n" = 1 ]; then ex "alias $v" "alias_ok$n" "" tsc7-project yes ts7; else exf "alias $v" "alias_ok$n" "" tsc7-project yes ts7; fi
  done
  f_eq "alias, unscoped name: command" "$o_command" "$w/alias_ok6/node_modules/ts7/bin/tsc --lsp --stdio"
  exf "two aliases, only the second installed" alias_two "" tsc7-project yes ts7
  f_eq "two aliases: command is the installed one" "$o_command" "$w/alias_two/node_modules/b7/bin/tsc --lsp --stdio"
  ex "alias to 7 declared but not installed: typescript 6 and tsls do not take over" alias_notinst ":$FIX/g_tsls" none no ts7
  f_has "alias not installed: reason" "$o_reason" "declares @typescript/native = npm:typescript@7.0.2 (TypeScript 7) but @typescript/native is not installed"
  f_has "alias not installed: hint" "$o_hint" "install the project's dependencies"
  ex "alias to 7 declared but not installed: PATH tsc 7" alias_notinst ":$FIX/g_tsc7" tsc7-path no ts7
  exf "alias to 7 declared, 6 installed under it" alias_wrongver "" none no ts7
  exf "alias to 7 installed without a tsc binary" alias_nobin "" none no ts7

  # 3. @typescript/native-preview declared (tsgo)
  ex "native-preview declared" tsgo1 "" tsgo-project yes ts7
  f_eq "native-preview declared: command" "$o_command" "$w/tsgo1/node_modules/.bin/tsgo --lsp --stdio"
  f_has "native-preview declared: reason" "$o_reason" "$w/tsgo1/package.json declares @typescript/native-preview = ^7.0.0-dev; using $w/tsgo1/node_modules/.bin/tsgo"
  exf "native-preview beats typescript 5" tsgo_ts5 "" tsgo-project yes
  exf "typescript 7 beats native-preview" tsgo_ts7 "" tsc7-project yes
  exf "native-preview declared but not installed" tsgo2 "" none no ts7
  ex "native-preview declared but not installed: tsgo on PATH" tsgo2 ":$FIX/g_tsgo" tsgo-path no ts7

  # 4. only TypeScript 6 and older declared: typescript-language-server
  ex "typescript 6 + project tsls" ts6 "" tsls-project yes classic
  f_eq "typescript 6 + project tsls: command" "$o_command" "$w/ts6/node_modules/.bin/typescript-language-server --stdio"
  f_has "typescript 6 + project tsls: reason" "$o_reason" "$w/ts6/package.json declares typescript = ^6.0.3 (installed 6.0.3)"
  exf "typescript 4 + project tsls" ts4 "" tsls-project yes classic
  ex "typescript 5 + tsls on PATH" ts5path ":$FIX/g_tsls" tsls-path yes classic
  f_eq "typescript 5 + tsls on PATH: command" "$o_command" "$FIX/g_tsls/typescript-language-server --stdio"
  exf "project tsls beats PATH tsls" ts6 ":$FIX/g_tsls" tsls-project yes
  ex "alias to typescript 5 only + tsls on PATH" alias5 ":$FIX/g_tsls" tsls-path yes classic
  exf "alias to typescript 5 only, no tsls anywhere" alias5 "" none no classic
  exf "typescript itself an alias to 6 + tsls on PATH" alias6plain ":$FIX/g_tsls" tsls-path yes classic
  exf "typescript 6 + alias to 5: classic" ts6beta ":$FIX/g_tsls" tsls-path yes classic

  # 4b. undeclared binaries in node_modules are never used
  ex "stray tsgo, typescript ^6, no tsls" stray_tsgo "" none no classic
  f_eq "stray tsgo: no command" "$o_command" ""
  f_has "stray tsgo: reason says it was ignored" "$o_reason" "ignored undeclared tsgo at $w/stray_tsgo/node_modules/.bin/tsgo"
  exf "stray tsgo, typescript ^6, tsls on PATH" stray_tsgo ":$FIX/g_tsls" tsls-path yes classic
  ex "stray tsgo, typescript ^6, tsgo on PATH: the PATH one is a fallback" stray_tsgo ":$FIX/g_tsgo" tsgo-path no classic
  f_eq "stray tsgo: the command is the PATH tsgo" "$o_command" "$FIX/g_tsgo/tsgo --lsp --stdio"
  ex "stray tsrs, typescript ^7 declared" stray_tsrs "" tsc7-project yes ts7
  f_has "stray tsrs: reason says it was ignored" "$o_reason" "ignored undeclared tsrs at $w/stray_tsrs/node_modules/.bin/tsrs"
  exf "stray tsrs, typescript ^6, no tsls" stray_tsrs6 "" none no classic
  exf "native-preview declared, stray tsrs ignored" stray_both "" tsgo-project yes ts7
  ex "nothing declared: installed typescript 7, tsrs and tsgo all ignored" stray_nodecl "" none no unknown
  exf "nothing declared, tsc 7 on PATH" stray_nodecl ":$FIX/g_tsc7" tsc7-path no unknown

  # 5. fallbacks: the project lacks what its server needs
  ex "typescript 5, no tsls anywhere, tsc 7 on PATH" ts5nolsp ":$FIX/g_tsc7" tsc7-path no classic
  f_eq "fallback tsc 7: command" "$o_command" "$FIX/g_tsc7/tsc --lsp --stdio"
  f_has "fallback tsc 7: hint names typescript-language-server" "$o_hint" typescript-language-server
  f_has "fallback tsc 7: reason says why" "$o_reason" "declares typescript = ^5.4.0 (installed 5.9.3) but there is no typescript-language-server"
  exf "old tsc on PATH is not a fallback" ts5nolsp ":$FIX/g_tsc5" none no classic
  ex "tsgo on PATH" ts5nolsp ":$FIX/g_tsgo" tsgo-path no
  exf "tsgo that fails --version is skipped" ts5nolsp ":$FIX/g_tsgo_bad" none no
  exf "tsrs on PATH" ts5nolsp ":$FIX/g_tsrs" tsrs-path no
  exf "tsrs before tsgo" ts5nolsp ":$FIX/g_tsgo_tsrs" tsrs-path no
  exf "tsrs + tsc 7 + tsgo on PATH: tsrs wins" ts5nolsp ":$FIX/g_all" tsrs-path no
  ex "tsrs wins even when it is last on PATH" ts5nolsp ":$FIX/g_tsgo:$FIX/g_tsc7:$FIX/g_tsrs" tsrs-path no
  exf "tsrs wins even when tsc 7 is ahead on PATH" ts5nolsp ":$FIX/g_tsc7:$FIX/g_tsrs" tsrs-path no
  exf "tsc 7 + tsgo on PATH: tsc 7 wins even when tsgo is ahead" ts5nolsp ":$FIX/g_tsgo:$FIX/g_tsc7" tsc7-path no
  exf "old tsc ahead on PATH does not hide tsgo" ts5nolsp ":$FIX/g_tsc5:$FIX/g_tsgo" tsgo-path no
  exf "old tsc ahead on PATH does not hide tsrs" ts5nolsp ":$FIX/g_tsc5:$FIX/g_tsrs" tsrs-path no
  ex "nothing anywhere" ts5nolsp "" none no classic
  f_eq "nothing anywhere: command empty" "$o_command" ""
  f_has "nothing anywhere: reason" "$o_reason" "no tsrs, tsc >= 7 or tsgo on PATH either"

  # 6. declared but nothing installed
  ex "declared ^5, no node_modules" decl5 ":$FIX/g_tsc7" tsc7-path no classic
  exf "declared ^5: PATH tsls cannot work without typescript" decl5 ":$FIX/g_tsls" none no classic
  f_has "declared ^5: hint says to install dependencies" "$o_hint" "install the project's dependencies"
  exf "declared tsrs (peerDependencies), nothing installed" decl7 "" none no tsrs
  exf "declared catalog: reference, nothing installed" declcat "" none no classic
  exf "declared npm: alias to 6, nothing installed" declalias6 "" none no classic
  ex "package.json without typescript" nots "" none no unknown
  f_has "package.json without typescript: hint" "$o_hint" "npm install -D typescript@7"
  ex "no package.json, no node_modules" nopkg "" none no unknown
  exf "no package.json, tsc 7 on PATH" nopkg ":$FIX/g_tsc7" tsc7-path no unknown

  # 7. monorepo walk-up: the nearest package.json that declares something decides
  ex "monorepo: root declares and hoists typescript 7" mono/packages/app "" tsc7-project yes ts7
  exf "monorepo: from a subdirectory" mono/packages/app/src "" tsc7-project yes
  f_eq "monorepo: command is the root's tsc" "$o_command" "$w/mono/node_modules/typescript/bin/tsc --lsp --stdio"
  f_has "monorepo: reason names the root package.json" "$o_reason" "$w/mono/package.json declares typescript = ^7.0.0"
  ex "monorepo: the package's own typescript 5 declaration shadows the root's 7" mono_shadow/packages/app "" none no classic
  exf "monorepo: hoisted tsls at the root" mono_tsls/packages/app "" tsls-project yes classic
  exf "monorepo: declared at the root, installed nowhere" mono2/packages/lib "" none no ts7
  exf "monorepo: the package's tsgo beats the root's typescript 5" mono3/apps/web "" tsgo-project yes
  exf "monorepo: root declares an alias to 7, package declares nothing" mono4/packages/app "" tsc7-project yes ts7
  f_eq "monorepo alias: command is the root's alias tsc" "$o_command" "$w/mono4/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  exf "monorepo: the package declares, the root hoists the install" mono5/packages/app "" tsc7-project yes ts7
  f_eq "monorepo hoist: command is the root's tsc" "$o_command" "$w/mono5/node_modules/typescript/bin/tsc --lsp --stdio"
  ex "monorepo: an unparsable package.json in the package defers to the root" mono6/packages/app "" tsc7-project yes
  exf "monorepo: nothing declared anywhere, typescript 7 hoisted: not used" mono7/packages/app "" none no unknown

  # 8. broken package.json files
  ex "unparsable package.json" badpkg ":$FIX/g_tsc7" tsc7-path no unknown
  [ "$JQV" = 0 ] || f_has "unparsable package.json: reason notes it (jq)" "$o_reason" "unparsable"
  exf "unparsable package.json, typescript 7 installed but undeclared" badpkg_ts7 "" none no unknown
  exf "empty package.json" emptypkg "" none no unknown
  exf "package.json that is JSON null" nullpkg "" none no unknown
  ex "unparsable node_modules/typescript/package.json" badnm "" none no classic
  f_has "unparsable node_modules/typescript/package.json: reason notes it" "$o_reason" "unreadable"
  exf "typescript package.json without a version, nothing declared" nover "" none no unknown
  ex "minified installed typescript package.json" minified "" tsc7-project yes
  ex "minified project package.json with an alias" minified_alias "" tsc7-project yes ts7
  f_eq "minified project package.json: alias command" "$o_command" "$w/minified_alias/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  ex "CRLF project package.json with an alias" crlf_alias "" tsc7-project yes ts7

  # 9. workspace selection (the process cwd, CLAUDE_PROJECT_DIR and --workspace)
  cd "$w/sel_a" || return
  CLAUDE_PROJECT_DIR=$w/sel_b PATH=$PB "$SH" "$LAUNCHER" --explain >"$OUT" 2>"$ERR" </dev/null
  parse_out
  eq "$LBL CLAUDE_PROJECT_DIR beats the process cwd" "$o_kind" tsc7-project
  CLAUDE_PROJECT_DIR=$w/sel_b PATH=$PB "$SH" "$LAUNCHER" --workspace "$w/sel_a" --explain >"$OUT" 2>"$ERR" </dev/null
  parse_out
  eq "$LBL --workspace beats CLAUDE_PROJECT_DIR" "$o_kind" tsrs-project
  PATH=$PB "$SH" "$LAUNCHER" --explain >"$OUT" 2>"$ERR" </dev/null
  parse_out
  eq "$LBL cwd is the default workspace" "$o_workspace" "$w/sel_a"
  cd "$FIX" || return

  # 10. a workspace path with a space and a quote
  wd="$w/we\"ird dir"
  run_explain "$wd/app" "$PB"
  eq "$LBL awkward path: kind" "$o_kind" tsc7-project
  eq "$LBL awkward path: command" "$o_command" "$wd/node_modules/typescript/bin/tsc --lsp --stdio"

  # 11. exec behaviour
  xrun "$w/exec7" "$PB" "payload" 1 ""
  eq "$LBL exec: exit code" "$xrc" 0
  has "$LBL exec: runs tsc --lsp --stdio" "$xo" "RAN tsc --lsp --stdio"
  has "$LBL exec: stdin reaches the server" "$xo" "STDIN payload"
  eq "$LBL exec: nothing on stderr for a matched server" "$xe" ""
  xrun "$w/exec7" "$PB" "" "" 7
  eq "$LBL exec: server exit code propagates" "$xrc" 7
  if [ "$FULL" = 1 ]; then
    xrun "$w/exec_alias" "$PB" "" "" ""
    eq "$LBL exec: alias to 7 runs its tsc, not the stray tsgo" "$xo" "RAN tsc --lsp --stdio"
    xrun "$w/exec_tsgo" "$PB" "" "" ""
    has "$LBL exec: tsgo --lsp --stdio" "$xo" "RAN tsgo --lsp --stdio"
    xrun "$w/exec_tsrs" "$PB" "" "" ""
    has "$LBL exec: tsrs --lsp --stdio" "$xo" "RAN tsrs --lsp --stdio"
  fi
  xrun "$w/exec_tsls" "$PB:$FIX/g_tsls" "" "" ""
  eq "$LBL exec: typescript-language-server --stdio (no --lsp)" "$xo" "RAN typescript-language-server --stdio"
  xrun "$w/exec_tsls" "$PB:$FIX/g_tsc7" "" "" ""
  has "$LBL exec: fallback runs the global tsc 7" "$xo" "RAN tsc --lsp --stdio"
  has "$LBL exec: fallback says so on stderr" "$xe" "fallback tsc7-path"
  xrun "$w/exec_tsls" "$PB" "" "" ""
  eq "$LBL exec: no server -> exit 3" "$xrc" 3
  eq "$LBL exec: no server -> nothing on stdout" "$xo" ""
  case $xe in *"$nl"*) bad "$LBL exec: no server -> one stderr line: got '$xe'" ;; '') bad "$LBL exec: no server -> one stderr line: got nothing" ;; *) ok "$LBL exec: no server -> one stderr line" ;; esac
  has "$LBL exec: no server -> message names the fix" "$xe" typescript-language-server
  if [ "$FULL" = 1 ]; then
    xrun "$w/exec_stray" "$PB" "" "" ""
    eq "$LBL exec: a stray undeclared tsgo is not run -> exit 3" "$xrc" 3
    lacks "$LBL exec: a stray undeclared tsgo is not run -> no output" "$xo" "RAN"
  fi

  # 12. argument handling
  PATH=$PB "$SH" "$LAUNCHER" --bogus >"$OUT" 2>&1 </dev/null
  eq "$LBL unknown argument -> exit 2" "$?" 2
  PATH=$PB "$SH" "$LAUNCHER" --workspace "$FIX/does-not-exist" --explain >"$OUT" 2>&1 </dev/null
  eq "$LBL missing workspace -> exit 2" "$?" 2
  PATH=$PB "$SH" "$LAUNCHER" --workspace >"$OUT" 2>&1 </dev/null
  eq "$LBL --workspace without a value -> exit 2" "$?" 2
}

# xrun DIR PATH STDIN STUB_CAT STUB_EXIT: run the launcher for real (no --explain)
# on DIR; xrc, xo (stdout) and xe (stderr) hold the result.
xrun() {
  [ -z "$4" ] || export STUB_CAT="$4"
  [ -z "$5" ] || export STUB_EXIT="$5"
  printf '%s' "$3" | PATH=$2 "$SH" "$LAUNCHER" --workspace "$1" >"$OUT" 2>"$ERR"
  xrc=$?
  unset STUB_CAT STUB_EXIT
  slurp "$OUT"
  xo=$SLURP
  slurp "$ERR"
  xe=$SLURP
}

# ---- run it under every shell and both PATH flavours -------------------------------

SHELLS=
for s in sh dash ksh bash; do
  p=$(command -v "$s" 2>/dev/null) || continue
  case " $SHELLS " in *" $p "*) ;; *) SHELLS="$SHELLS $p" ;; esac
done

for s in $SHELLS; do
  # The whole table under sh (what the hook runs) and bash; the core subset under the rest.
  case ${s##*/} in sh | bash) full=1 ;; *) full=0 ;; esac
  if [ "$full" = 1 ]; then kindtxt="resolution table"; else kindtxt="core resolution table"; fi
  echo "=== $kindtxt under $s, no jq on PATH ==="
  suite "$s" "$BASE" "[${s##*/}, no jq]" "$full" 0
  if [ "$HAVE_JQ" = 1 ]; then
    echo "=== $kindtxt under $s, jq on PATH ==="
    suite "$s" "$BASE:$FIX/jqbin" "[${s##*/}, jq]" "$full" 1
  else
    skip "jq flavour under $s (jq not installed)"
  fi
done

# ---- the SessionStart hook -------------------------------------------------------

echo "=== SessionStart hook ==="
PB=$BASE:$FIX/jqbin
[ "$HAVE_JQ" = 1 ] || PB=$BASE
# run_hook DIR PATH [PLUGIN_ROOT]: HO is the hook's stdout, HE its stderr, hrc its exit code.
run_hook() {
  cd "$1" || return
  printf '%s' '{"hook_event_name":"SessionStart","source":"startup"}' |
    CLAUDE_PLUGIN_ROOT=${3:-$HOOKROOT} PATH=$2 "$SH0" "$HOOK" >"$OUT" 2>"$ERR"
  hrc=$?
  cd "$FIX" || return
  slurp "$OUT"
  HO=$SLURP
  slurp "$ERR"
  HE=$SLURP
}

run_hook "$W/hook_ok" "$PB"
eq "hook: silent when the project-matched server is found (stdout)" "$HO" ""
eq "hook: silent when matched (exit)" "$hrc" 0
eq "hook: silent when matched (stderr)" "$HE" ""
run_hook "$W/hook_alias" "$PB"
eq "hook: silent when an aliased typescript 7 is the project's server" "$HO" ""
run_hook "$W/hook_tsls" "$PB:$FIX/g_tsls"
eq "hook: silent for typescript-language-server on PATH with project typescript" "$HO" ""

run_hook "$W/hook_fb" "$PB:$FIX/g_tsc7"
o=$HO
eq "hook: fallback exits 0" "$hrc" 0
has "hook: fallback names the kind" "$o" tsc7-path
has "hook: fallback names the command" "$o" "$FIX/g_tsc7/tsc --lsp --stdio"
has "hook: fallback says what to install" "$o" "npm install -D typescript-language-server"
has "hook: fallback is a SessionStart hookSpecificOutput" "$o" '"hookEventName":"SessionStart"'
if [ "$HAVE_JQ" = 1 ]; then
  if printf '%s' "$o" | jq -e . >/dev/null 2>&1; then ok "hook: fallback output is valid JSON"; else bad "hook: fallback output is valid JSON"; fi
  eq "hook: systemMessage equals additionalContext" \
    "$(printf '%s' "$o" | jq -r .systemMessage)" "$(printf '%s' "$o" | jq -r .hookSpecificOutput.additionalContext)"
  has "hook: systemMessage reads as a fallback notice" "$(printf '%s' "$o" | jq -r .systemMessage)" "TypeScript LSP is using a fallback"
else
  skip "hook: JSON checks (jq not installed)"
fi

run_hook "$W/hook_none" "$PB"
eq "hook: no server exits 0" "$hrc" 0
has "hook: no server says unavailable" "$HO" "TypeScript LSP unavailable"
has "hook: no server says what to install" "$HO" "typescript-language-server"

run_hook "$W/hook_notinst" "$PB:$FIX/g_tsc7"
eq "hook: declared but not installed exits 0" "$hrc" 0
has "hook: declared but not installed names the declaration" "$HO" "declares @typescript/native = npm:typescript@7.0.2"
has "hook: declared but not installed says to install the dependencies" "$HO" "install the project's dependencies"

run_hook "$W/hook_stray" "$PB"
has "hook: a stray undeclared tsgo is not the server" "$HO" "TypeScript LSP unavailable"

w="$W/we\"ird\\dir"
run_hook "$w" "$PB"
o=$HO
eq "hook: awkward path exits 0" "$hrc" 0
if [ "$HAVE_JQ" = 1 ]; then
  if printf '%s' "$o" | jq -e . >/dev/null 2>&1; then ok "hook: path with quote and backslash stays valid JSON"; else bad "hook: path with quote and backslash stays valid JSON: $o"; fi
  has "hook: the awkward path survives escaping" "$(printf '%s' "$o" | jq -r .systemMessage)" "$w"
fi

# the hook must never fail the session
run_hook "$FIX" "$PB" "$FIX/no-such-plugin-root"
eq "hook: missing launcher -> silent exit 0" "$hrc$HO" "0"
printf '#!/bin/sh\nexit 1\n' >"$FIX/brokenroot/bin/ts-lsp"
run_hook "$FIX" "$PB" "$FIX/brokenroot"
eq "hook: launcher failing -> silent exit 0" "$hrc$HO" "0"
printf '#!/bin/sh\necho garbage\nexit 0\n' >"$FIX/brokenroot/bin/ts-lsp"
run_hook "$FIX" "$PB" "$FIX/brokenroot"
eq "hook: launcher printing garbage -> silent exit 0" "$hrc$HO" "0"
cd "$FIX" || exit 1
CLAUDE_PLUGIN_ROOT=$HOOKROOT PATH=$PB "$SH0" "$HOOK" </dev/null >/dev/null 2>&1
eq "hook: empty stdin and a workspace with nothing -> exit 0" "$?" 0

# ---- wiring -------------------------------------------------------------------

echo "=== wiring ==="
if [ -x "$LAUNCHER" ]; then ok "bin/ts-lsp is executable"; else bad "bin/ts-lsp is executable"; fi
if [ -f "$HOOK" ]; then ok "hooks/ts-lsp-check.sh exists"; else bad "hooks/ts-lsp-check.sh exists"; fi
# The single-quoted ${CLAUDE_PLUGIN_ROOT} in the jq programs is literal on purpose.
# shellcheck disable=SC2016
if [ "$HAVE_JQ" = 1 ]; then
  eq "plugin.json: LSP command is the launcher" \
    "$(jq -r '.lspServers.typescript.command' "$PLUGIN/.claude-plugin/plugin.json")" '${CLAUDE_PLUGIN_ROOT}/bin/ts-lsp'
  eq "plugin.json: LSP command starts with / after expansion (no spaces allowed otherwise)" \
    "$(jq -r '.lspServers.typescript.command | startswith("${CLAUDE_PLUGIN_ROOT}/")' "$PLUGIN/.claude-plugin/plugin.json")" true
  eq "plugin.json: ts, tsx, js, jsx, mts, cts, mjs, cjs mapped" \
    "$(jq -r '.lspServers.typescript.extensionToLanguage | keys | join(",")' "$PLUGIN/.claude-plugin/plugin.json")" \
    ".cjs,.cts,.js,.jsx,.mjs,.mts,.ts,.tsx"
  eq "plugin.json: only documented LSP keys" \
    "$(jq -r '.lspServers.typescript | keys - ["command","args","extensionToLanguage","transport","env","initializationOptions","settings","workspaceFolder","startupTimeout","shutdownTimeout","requestTimeout","restartOnCrash","maxRestarts","diagnostics"] | length' "$PLUGIN/.claude-plugin/plugin.json")" 0
  eq "hooks.json: SessionStart runs the check" \
    "$(jq -r '[.hooks.SessionStart[].hooks[].command] | map(test("ts-lsp-check.sh")) | all' "$PLUGIN/hooks/hooks.json")" true
  eq "hooks.json: the per-file compiler guard is the module, not a PreToolUse hook" \
    "$(jq -r '(.modules == ["./register.ts"]) and ((.hooks.PreToolUse // []) | length == 0)' "$PLUGIN/hooks/hooks.json")" true
else
  skip "manifest checks (jq not installed)"
fi

echo
echo "shells:$SHELLS"
echo "passed=$PASS failed=$FAIL skipped=$SKIP"
[ "$FAIL" -eq 0 ]
