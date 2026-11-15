#!/bin/sh
# Tests for bin/ts-lsp (the TypeScript language-server launcher), the
# SessionStart check hooks/ts-lsp-check.sh, and their wiring in plugin.json and
# hooks.json. POSIX sh: run it as `sh tests/ts-lsp.test.sh` or `bash tests/ts-lsp.test.sh`.
#
# Every case builds a temp workspace with a package.json (what the project
# DECLARES, which decides) and fake node_modules (package.json versions and
# executable stubs, which only supply the binary), and runs the launcher under a
# controlled PATH (env -i), so nothing on the real machine leaks in. The
# resolution table runs under each shell found (sh, dash, ksh, bash), with and
# without jq on PATH. Needs jq for the JSON checks of the hook and manifests
# (skipped without it).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
LAUNCHER=$PLUGIN/bin/ts-lsp
HOOK=$PLUGIN/hooks/ts-lsp-check.sh

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

FIX=$(mktemp -d "${TMPDIR:-/tmp}/ts-lsp-test.XXXXXX") || exit 1
FIX=$(cd "$FIX" && pwd -P)
trap 'rm -rf "$FIX"' EXIT

ENVBIN=$(command -v env)
HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

# ---- controlled PATH --------------------------------------------------------

BASE=$FIX/base
mkdir -p "$BASE" "$FIX/jqbin"
for t in sed head tr cat sh; do
  p=$(command -v "$t") || {
    echo "test setup: $t not found" >&2
    exit 1
  }
  ln -s "$p" "$BASE/$t"
done
[ "$HAVE_JQ" = 0 ] || ln -s "$(command -v jq)" "$FIX/jqbin/jq"

# A stub executable: --version prints "Version V" and exits E; otherwise it
# echoes what it was run as (and stdin when STUB_CAT is set) and exits STUB_EXIT.
mkstub() { # path version [exit-for---version]
  mkdir -p "$(dirname "$1")"
  _n=$(basename "$1")
  # The single quotes are deliberate: the stub's own $-expressions must stay literal.
  # shellcheck disable=SC2016
  {
    printf '#!/bin/sh\n'
    printf 'case ${1:-} in --version) echo "Version %s"; exit %s ;; esac\n' "$2" "${3:-0}"
    printf 'echo "RAN %s $*"\n' "$_n"
    printf '[ -z "${STUB_CAT:-}" ] || echo "STDIN $(cat)"\n'
    printf 'exit ${STUB_EXIT:-0}\n'
  } >"$1"
  chmod +x "$1"
}

mkstub "$FIX/g_tsc7/tsc" 7.0.2
mkstub "$FIX/g_tsc5/tsc" 5.9.3
mkstub "$FIX/g_tsgo/tsgo" 7.0.0-dev.20260707.2
mkstub "$FIX/g_tsgo_bad/tsgo" 0 1
mkstub "$FIX/g_tsrs/tsrs" 7.1.0-beta
mkstub "$FIX/g_tsls/typescript-language-server" 6.1.0
mkdir -p "$FIX/g_all" "$FIX/g_tsgo_tsrs"
mkstub "$FIX/g_all/tsc" 7.0.2
mkstub "$FIX/g_all/tsgo" 7.0.0
mkstub "$FIX/g_all/tsrs" 7.1.0-beta
mkstub "$FIX/g_tsgo_tsrs/tsgo" 7.0.0
mkstub "$FIX/g_tsgo_tsrs/tsrs" 7.1.0-beta

# ---- fixtures ---------------------------------------------------------------

newws() { # name -> path of a fresh workspace dir
  rm -rf "${FIX:?}/$1"
  mkdir -p "$FIX/$1"
  printf '%s' "$FIX/$1"
}
# add_ts dir version: node_modules/typescript (package.json, bin/tsc) + .bin/tsc
add_ts() {
  mkdir -p "$1/node_modules/typescript"
  printf '{\n  "name": "typescript",\n  "version": "%s"\n}\n' "$2" >"$1/node_modules/typescript/package.json"
  mkstub "$1/node_modules/typescript/bin/tsc" "$2"
  mkstub "$1/node_modules/.bin/tsc" "$2"
}
# add_alias dir NAME version: typescript installed under another name (npm alias)
add_alias() {
  mkdir -p "$1/node_modules/$2"
  printf '{\n  "name": "typescript",\n  "version": "%s"\n}\n' "$3" >"$1/node_modules/$2/package.json"
  mkstub "$1/node_modules/$2/bin/tsc" "$3"
}
add_bin() { mkstub "$1/node_modules/.bin/$2" 0; }
add_pkg() { printf '%s\n' "$2" >"$1/package.json"; }
# decl_ts dir range: package.json declaring typescript at that range (devDependencies)
decl_ts() { add_pkg "$1" "{\"name\":\"x\",\"devDependencies\":{\"typescript\":\"$2\"}}"; }

# explain DIR PATH [SHELL]: run the launcher with --explain in DIR under PATH.
explain() {
  (cd "$1" && "$ENVBIN" -i PATH="$2" HOME="$FIX" "${3:-$SH}" "$LAUNCHER" --explain)
}
getf() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }

# expect LABEL DIR PATH KIND MATCHED [WANT]: explain, then check the fields.
expect() {
  out=$(explain "$2" "$3")
  eq "$LBL $1: kind" "$(getf kind)" "$4"
  eq "$LBL $1: matched" "$(getf matched)" "$5"
  [ -z "${6:-}" ] || eq "$LBL $1: want" "$(getf want)" "$6"
}

# ---- the resolution table, for one shell and one PATH flavour -------------------

suite() { # SHELL PATH-BASE LABEL
  SH=$1
  PB=$2
  LBL=$3

  # 1. tsrs declared wins, even over a declared typescript 7
  d=$(newws tsrs1)
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0","typescript":"^7.0.0"}}'
  add_bin "$d" tsrs
  add_ts "$d" 7.0.2
  expect "tsrs declared" "$d" "$PB" tsrs-project yes tsrs
  out=$(explain "$d" "$PB")
  eq "$LBL tsrs declared: command" "$(getf command)" "$d/node_modules/.bin/tsrs --lsp --stdio"
  has "$LBL tsrs declared: reason names package.json and declaration" "$(getf reason)" "$d/package.json declares tsrs = ^0.25.0"
  add_pkg "$d" '{"peerDependencies":{"tsrs":"0.25.0-ts7.1.0-beta"}}'
  expect "tsrs declared in peerDependencies" "$d" "$PB" tsrs-project yes tsrs
  add_pkg "$d" '{"optionalDependencies":{"tsrs":"0.25.0"}}'
  expect "tsrs declared in optionalDependencies" "$d" "$PB" tsrs-project yes tsrs
  d=$(newws tsrs2)
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0","typescript":"^7.0.0"}}'
  add_ts "$d" 7.0.2
  expect "tsrs declared but not installed: no fall-through to typescript 7" "$d" "$PB" none no tsrs
  out=$(explain "$d" "$PB")
  has "$LBL tsrs declared but not installed: hint" "$(getf hint)" "install the project's dependencies"
  expect "tsrs declared but not installed: tsrs on PATH" "$d" "$PB:$FIX/g_tsrs" tsrs-path no tsrs

  # 2. TypeScript 7 declared (tsc is the Go-native server)
  d=$(newws ts7)
  decl_ts "$d" 7.0.2
  add_ts "$d" 7.0.2
  expect "typescript 7.0.2" "$d" "$PB" tsc7-project yes ts7
  out=$(explain "$d" "$PB")
  eq "$LBL typescript 7.0.2: command" "$(getf command)" "$d/node_modules/typescript/bin/tsc --lsp --stdio"
  has "$LBL typescript 7.0.2: reason" "$(getf reason)" "$d/package.json declares typescript = 7.0.2; using $d/node_modules/typescript/bin/tsc"
  decl_ts "$d" "^7.1.0-beta"
  add_ts "$d" 7.1.0-beta
  expect "typescript ^7.1.0-beta" "$d" "$PB" tsc7-project yes
  decl_ts "$d" next
  add_ts "$d" 7.0.0-dev.20261115.1
  expect "typescript next (dist-tag counts as 7)" "$d" "$PB" tsc7-project yes
  decl_ts "$d" latest
  expect "typescript latest (dist-tag counts as 7)" "$d" "$PB" tsc7-project yes
  decl_ts "$d" "^8.0.0"
  add_ts "$d" 8.0.0
  expect "typescript 8" "$d" "$PB" tsc7-project yes
  add_pkg "$d" '{"dependencies":{"typescript":"~7.0.1"}}'
  add_ts "$d" 7.0.2
  expect "typescript in dependencies" "$d" "$PB" tsc7-project yes
  add_pkg "$d" '{"peerDependencies":{"typescript":">=7"}}'
  expect "typescript in peerDependencies" "$d" "$PB" tsc7-project yes
  add_pkg "$d" '{"optionalDependencies":{"typescript":"^7"}}'
  expect "typescript in optionalDependencies" "$d" "$PB" tsc7-project yes

  # 2b. declared 7, installed, but no tsc binary -> fallback; .bin/tsc alone is accepted
  d=$(newws ts7nobin)
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  rm -f "$d/node_modules/.bin/tsc" "$d/node_modules/typescript/bin/tsc"
  expect "typescript 7 without a tsc binary" "$d" "$PB" none no ts7
  out=$(explain "$d" "$PB")
  has "$LBL typescript 7 without a tsc binary: reason" "$(getf reason)" "has no tsc binary"
  mkstub "$d/node_modules/.bin/tsc" 7.0.2
  expect "typescript 7, .bin/tsc only" "$d" "$PB" tsc7-project yes
  out=$(explain "$d" "$PB")
  eq "$LBL typescript 7, .bin/tsc only: command" "$(getf command)" "$d/node_modules/.bin/tsc --lsp --stdio"

  # 2c. declared 7, installed version disagrees or is missing
  d=$(newws ts7stale)
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  expect "declared ^7 but typescript 6 installed: no fall-through to classic" "$d" "$PB" none no ts7
  out=$(explain "$d" "$PB")
  has "$LBL declared ^7 but 6 installed: reason" "$(getf reason)" "not TypeScript 7"
  d=$(newws ts7none)
  decl_ts "$d" "^7.0.0"
  expect "declared ^7, node_modules missing" "$d" "$PB" none no ts7
  out=$(explain "$d" "$PB")
  has "$LBL declared ^7, node_modules missing: hint" "$(getf hint)" "install the project's dependencies"
  expect "declared ^7, node_modules missing, tsc 7 on PATH" "$d" "$PB:$FIX/g_tsc7" tsc7-path no ts7

  # 2d. ranges with no readable major take the installed version's major
  d=$(newws cat7)
  decl_ts "$d" "catalog:"
  add_ts "$d" 7.0.2
  expect "catalog: with typescript 7 installed" "$d" "$PB" tsc7-project yes ts7
  d=$(newws cat5)
  decl_ts "$d" "catalog:"
  add_ts "$d" 5.9.3
  add_bin "$d" typescript-language-server
  expect "catalog: with typescript 5 installed" "$d" "$PB" tsls-project yes classic

  # 2e. an npm alias of typescript 7 (the isambard shape)
  d=$(newws isambard)
  printf '{\n  "name": "isambard",\n  "devDependencies": {\n    "@typescript/native": "npm:typescript@7.0.2",\n    "typescript": "^6.0.3"\n  }\n}\n' >"$d/package.json"
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  add_bin "$d" tsgo
  add_bin "$d" typescript-language-server
  expect "ts ^6 + alias to ts 7 + stray tsgo" "$d" "$PB:$FIX/g_tsls:$FIX/g_tsgo" tsc7-project yes ts7
  out=$(explain "$d" "$PB:$FIX/g_tsls:$FIX/g_tsgo")
  eq "$LBL isambard shape: command is the alias's tsc" "$(getf command)" "$d/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  has "$LBL isambard shape: reason names the declaration" "$(getf reason)" "$d/package.json declares @typescript/native = npm:typescript@7.0.2; using $d/node_modules/@typescript/native/bin/tsc"
  has "$LBL isambard shape: reason mentions the ignored tsgo" "$(getf reason)" "ignored undeclared tsgo at $d/node_modules/.bin/tsgo"
  d=$(newws alias_ok)
  n=0
  for v in "npm:typescript@^7" "npm:typescript@latest" "npm:typescript@next" "npm:typescript" "npm:typescript@7.1.0-beta" "npm:typescript@>=7.0.0"; do
    n=$((n + 1))
    d=$(newws "alias_ok$n")
    add_pkg "$d" "{\"devDependencies\":{\"ts7\":\"$v\"}}"
    add_alias "$d" ts7 7.0.2
    expect "alias $v" "$d" "$PB" tsc7-project yes ts7
  done
  out=$(explain "$d" "$PB")
  eq "$LBL alias, unscoped name: command" "$(getf command)" "$d/node_modules/ts7/bin/tsc --lsp --stdio"
  d=$(newws alias_two)
  add_pkg "$d" '{"devDependencies":{"a7":"npm:typescript@7.0.0","b7":"npm:typescript@7.0.2"}}'
  add_alias "$d" b7 7.0.2
  expect "two aliases, only the second installed" "$d" "$PB" tsc7-project yes ts7
  out=$(explain "$d" "$PB")
  eq "$LBL two aliases: command is the installed one" "$(getf command)" "$d/node_modules/b7/bin/tsc --lsp --stdio"
  d=$(newws alias_notinst)
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  expect "alias to 7 declared but not installed: typescript 6 and tsls do not take over" "$d" "$PB:$FIX/g_tsls" none no ts7
  out=$(explain "$d" "$PB:$FIX/g_tsls")
  has "$LBL alias not installed: reason" "$(getf reason)" "declares @typescript/native = npm:typescript@7.0.2 (TypeScript 7) but @typescript/native is not installed"
  has "$LBL alias not installed: hint" "$(getf hint)" "install the project's dependencies"
  expect "alias to 7 declared but not installed: PATH tsc 7" "$d" "$PB:$FIX/g_tsc7" tsc7-path no ts7
  d=$(newws alias_wrongver)
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@^7"}}'
  add_alias "$d" @typescript/native 6.0.3
  expect "alias to 7 declared, 6 installed under it" "$d" "$PB" none no ts7
  d=$(newws alias_nobin)
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@^7"}}'
  add_alias "$d" @typescript/native 7.0.2
  rm -f "$d/node_modules/@typescript/native/bin/tsc"
  expect "alias to 7 installed without a tsc binary" "$d" "$PB" none no ts7

  # 3. @typescript/native-preview declared (tsgo)
  d=$(newws tsgo1)
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  expect "native-preview declared" "$d" "$PB" tsgo-project yes ts7
  out=$(explain "$d" "$PB")
  eq "$LBL native-preview declared: command" "$(getf command)" "$d/node_modules/.bin/tsgo --lsp --stdio"
  has "$LBL native-preview declared: reason" "$(getf reason)" "$d/package.json declares @typescript/native-preview = ^7.0.0-dev; using $d/node_modules/.bin/tsgo"
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev","typescript":"^5.4.0"}}'
  add_ts "$d" 5.9.3
  expect "native-preview beats typescript 5" "$d" "$PB" tsgo-project yes
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev","typescript":"^7.0.0"}}'
  add_ts "$d" 7.0.2
  expect "typescript 7 beats native-preview" "$d" "$PB" tsc7-project yes
  d=$(newws tsgo2)
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  expect "native-preview declared but not installed" "$d" "$PB" none no ts7
  expect "native-preview declared but not installed: tsgo on PATH" "$d" "$PB:$FIX/g_tsgo" tsgo-path no ts7

  # 4. only TypeScript 6 and older declared: typescript-language-server
  d=$(newws ts6)
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" typescript-language-server
  expect "typescript 6 + project tsls" "$d" "$PB" tsls-project yes classic
  out=$(explain "$d" "$PB")
  eq "$LBL typescript 6 + project tsls: command" "$(getf command)" "$d/node_modules/.bin/typescript-language-server --stdio"
  has "$LBL typescript 6 + project tsls: reason" "$(getf reason)" "$d/package.json declares typescript = ^6.0.3 (installed 6.0.3)"
  d=$(newws ts4)
  decl_ts "$d" "^4.9.5"
  add_ts "$d" 4.9.5
  add_bin "$d" typescript-language-server
  expect "typescript 4 + project tsls" "$d" "$PB" tsls-project yes classic
  d=$(newws ts5path)
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  expect "typescript 5 + tsls on PATH" "$d" "$PB:$FIX/g_tsls" tsls-path yes classic
  out=$(explain "$d" "$PB:$FIX/g_tsls")
  eq "$LBL typescript 5 + tsls on PATH: command" "$(getf command)" "$FIX/g_tsls/typescript-language-server --stdio"
  expect "project tsls beats PATH tsls" "$FIX/ts6" "$PB:$FIX/g_tsls" tsls-project yes
  d=$(newws alias5)
  add_pkg "$d" '{"devDependencies":{"ts5":"npm:typescript@5.9.3"}}'
  add_alias "$d" ts5 5.9.3
  expect "alias to typescript 5 only + tsls on PATH" "$d" "$PB:$FIX/g_tsls" tsls-path yes classic
  expect "alias to typescript 5 only, no tsls anywhere" "$d" "$PB" none no classic
  d=$(newws alias6plain)
  add_pkg "$d" '{"devDependencies":{"typescript":"npm:typescript@6.0.2"}}'
  add_ts "$d" 6.0.2
  expect "typescript itself an alias to 6 + tsls on PATH" "$d" "$PB:$FIX/g_tsls" tsls-path yes classic
  d=$(newws ts6beta)
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_pkg "$d" '{"devDependencies":{"typescript":"^6.0.3","ts5":"npm:typescript@5.9.3"}}'
  add_alias "$d" ts5 5.9.3
  expect "typescript 6 + alias to 5: classic" "$d" "$PB:$FIX/g_tsls" tsls-path yes classic

  # 4b. undeclared binaries in node_modules are never used
  d=$(newws stray_tsgo)
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsgo
  expect "stray tsgo, typescript ^6, no tsls" "$d" "$PB" none no classic
  out=$(explain "$d" "$PB")
  eq "$LBL stray tsgo: no command" "$(getf command)" ""
  has "$LBL stray tsgo: reason says it was ignored" "$(getf reason)" "ignored undeclared tsgo at $d/node_modules/.bin/tsgo"
  expect "stray tsgo, typescript ^6, tsls on PATH" "$d" "$PB:$FIX/g_tsls" tsls-path yes classic
  expect "stray tsgo, typescript ^6, tsgo on PATH: the PATH one is a fallback" "$d" "$PB:$FIX/g_tsgo" tsgo-path no classic
  out=$(explain "$d" "$PB:$FIX/g_tsgo")
  eq "$LBL stray tsgo: the command is the PATH tsgo" "$(getf command)" "$FIX/g_tsgo/tsgo --lsp --stdio"
  d=$(newws stray_tsrs)
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  add_bin "$d" tsrs
  expect "stray tsrs, typescript ^7 declared" "$d" "$PB" tsc7-project yes ts7
  out=$(explain "$d" "$PB")
  has "$LBL stray tsrs: reason says it was ignored" "$(getf reason)" "ignored undeclared tsrs at $d/node_modules/.bin/tsrs"
  d=$(newws stray_tsrs6)
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsrs
  expect "stray tsrs, typescript ^6, no tsls" "$d" "$PB" none no classic
  d=$(newws stray_both)
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  add_bin "$d" tsrs
  expect "native-preview declared, stray tsrs ignored" "$d" "$PB" tsgo-project yes ts7
  d=$(newws stray_nodecl)
  add_pkg "$d" '{"name":"x","dependencies":{"left-pad":"1.0.0"}}'
  add_ts "$d" 7.0.2
  add_bin "$d" tsrs
  add_bin "$d" tsgo
  expect "nothing declared: installed typescript 7, tsrs and tsgo all ignored" "$d" "$PB" none no unknown
  expect "nothing declared, tsc 7 on PATH" "$d" "$PB:$FIX/g_tsc7" tsc7-path no unknown

  # 5. fallbacks: the project lacks what its server needs
  d=$(newws ts5nolsp)
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  expect "typescript 5, no tsls anywhere, tsc 7 on PATH" "$d" "$PB:$FIX/g_tsc7" tsc7-path no classic
  out=$(explain "$d" "$PB:$FIX/g_tsc7")
  eq "$LBL fallback tsc 7: command" "$(getf command)" "$FIX/g_tsc7/tsc --lsp --stdio"
  has "$LBL fallback tsc 7: hint names typescript-language-server" "$(getf hint)" typescript-language-server
  has "$LBL fallback tsc 7: reason says why" "$(getf reason)" "declares typescript = ^5.4.0 (installed 5.9.3) but there is no typescript-language-server"
  expect "old tsc on PATH is not a fallback" "$d" "$PB:$FIX/g_tsc5" none no classic
  expect "tsgo on PATH" "$d" "$PB:$FIX/g_tsgo" tsgo-path no
  expect "tsgo that fails --version is skipped" "$d" "$PB:$FIX/g_tsgo_bad" none no
  expect "tsrs on PATH" "$d" "$PB:$FIX/g_tsrs" tsrs-path no
  expect "tsrs before tsgo" "$d" "$PB:$FIX/g_tsgo_tsrs" tsrs-path no
  expect "tsrs + tsc 7 + tsgo on PATH: tsrs wins" "$d" "$PB:$FIX/g_all" tsrs-path no
  expect "tsrs wins even when it is last on PATH" "$d" "$PB:$FIX/g_tsgo:$FIX/g_tsc7:$FIX/g_tsrs" tsrs-path no
  expect "tsrs wins even when tsc 7 is ahead on PATH" "$d" "$PB:$FIX/g_tsc7:$FIX/g_tsrs" tsrs-path no
  expect "tsc 7 + tsgo on PATH: tsc 7 wins even when tsgo is ahead" "$d" "$PB:$FIX/g_tsgo:$FIX/g_tsc7" tsc7-path no
  expect "old tsc ahead on PATH does not hide tsgo" "$d" "$PB:$FIX/g_tsc5:$FIX/g_tsgo" tsgo-path no
  expect "old tsc ahead on PATH does not hide tsrs" "$d" "$PB:$FIX/g_tsc5:$FIX/g_tsrs" tsrs-path no
  expect "nothing anywhere" "$d" "$PB" none no classic
  out=$(explain "$d" "$PB")
  eq "$LBL nothing anywhere: command empty" "$(getf command)" ""
  has "$LBL nothing anywhere: reason" "$(getf reason)" "no tsrs, tsc >= 7 or tsgo on PATH either"

  # 6. declared but nothing installed
  d=$(newws decl5)
  decl_ts "$d" "^5.4.0"
  expect "declared ^5, no node_modules" "$d" "$PB:$FIX/g_tsc7" tsc7-path no classic
  expect "declared ^5: PATH tsls cannot work without typescript" "$d" "$PB:$FIX/g_tsls" none no classic
  out=$(explain "$d" "$PB")
  has "$LBL declared ^5: hint says to install dependencies" "$(getf hint)" "install the project's dependencies"
  d=$(newws decl7)
  add_pkg "$d" '{"peerDependencies":{"tsrs":"0.25.0-ts7.1.0-beta"}}'
  expect "declared tsrs (peerDependencies), nothing installed" "$d" "$PB" none no tsrs
  add_pkg "$d" '{"devDependencies":{"typescript":"catalog:"}}'
  expect "declared catalog: reference, nothing installed" "$d" "$PB" none no classic
  add_pkg "$d" '{"devDependencies":{"typescript":"npm:typescript@6.0.2"}}'
  expect "declared npm: alias to 6, nothing installed" "$d" "$PB" none no classic
  add_pkg "$d" '{"name":"x","dependencies":{"left-pad":"1.0.0"}}'
  expect "package.json without typescript" "$d" "$PB" none no unknown
  out=$(explain "$d" "$PB")
  has "$LBL package.json without typescript: hint" "$(getf hint)" "npm install -D typescript@7"
  d=$(newws nopkg)
  expect "no package.json, no node_modules" "$d" "$PB" none no unknown
  expect "no package.json, tsc 7 on PATH" "$d" "$PB:$FIX/g_tsc7" tsc7-path no unknown

  # 7. monorepo walk-up: the nearest package.json that declares something decides
  r=$(newws mono)
  decl_ts "$r" "^7.0.0"
  add_ts "$r" 7.0.2
  mkdir -p "$r/packages/app/src"
  add_pkg "$r/packages/app" '{"name":"app"}'
  expect "monorepo: root declares and hoists typescript 7" "$r/packages/app" "$PB" tsc7-project yes ts7
  out=$(explain "$r/packages/app/src" "$PB")
  eq "$LBL monorepo: from a subdirectory" "$(getf kind)" tsc7-project
  eq "$LBL monorepo: command is the root's tsc" "$(getf command)" "$r/node_modules/typescript/bin/tsc --lsp --stdio"
  has "$LBL monorepo: reason names the root package.json" "$(getf reason)" "$r/package.json declares typescript = ^7.0.0"
  decl_ts "$r/packages/app" "^5.4.0"
  add_ts "$r/packages/app" 5.9.3
  expect "monorepo: the package's own typescript 5 declaration shadows the root's 7" "$r/packages/app" "$PB" none no classic
  add_bin "$r" typescript-language-server
  expect "monorepo: hoisted tsls at the root" "$r/packages/app" "$PB" tsls-project yes classic
  r=$(newws mono2)
  decl_ts "$r" "^7.0.0"
  mkdir -p "$r/packages/lib"
  add_pkg "$r/packages/lib" '{"name":"lib"}'
  expect "monorepo: declared at the root, installed nowhere" "$r/packages/lib" "$PB" none no ts7
  r=$(newws mono3)
  decl_ts "$r" "^5.4.0"
  add_ts "$r" 5.9.3
  mkdir -p "$r/apps/web"
  add_pkg "$r/apps/web" '{"devDependencies":{"@typescript/native-preview":"7.0.0-dev"}}'
  add_bin "$r/apps/web" tsgo
  expect "monorepo: the package's tsgo beats the root's typescript 5" "$r/apps/web" "$PB" tsgo-project yes
  r=$(newws mono4)
  add_pkg "$r" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$r" 6.0.3
  add_alias "$r" @typescript/native 7.0.2
  mkdir -p "$r/packages/app"
  add_pkg "$r/packages/app" '{"name":"app"}'
  expect "monorepo: root declares an alias to 7, package declares nothing" "$r/packages/app" "$PB" tsc7-project yes ts7
  out=$(explain "$r/packages/app" "$PB")
  eq "$LBL monorepo alias: command is the root's alias tsc" "$(getf command)" "$r/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  r=$(newws mono5)
  add_pkg "$r" '{"name":"root","workspaces":["packages/*"]}'
  add_ts "$r" 7.0.2
  mkdir -p "$r/packages/app"
  decl_ts "$r/packages/app" "^7.0.0"
  expect "monorepo: the package declares, the root hoists the install" "$r/packages/app" "$PB" tsc7-project yes ts7
  out=$(explain "$r/packages/app" "$PB")
  eq "$LBL monorepo hoist: command is the root's tsc" "$(getf command)" "$r/node_modules/typescript/bin/tsc --lsp --stdio"
  r=$(newws mono6)
  decl_ts "$r" "^7.0.0"
  add_ts "$r" 7.0.2
  mkdir -p "$r/packages/app"
  printf '{not json' >"$r/packages/app/package.json"
  expect "monorepo: an unparsable package.json in the package defers to the root" "$r/packages/app" "$PB" tsc7-project yes
  r=$(newws mono7)
  add_pkg "$r" '{"name":"root"}'
  add_ts "$r" 7.0.2
  mkdir -p "$r/packages/app"
  add_pkg "$r/packages/app" '{"name":"app"}'
  expect "monorepo: nothing declared anywhere, typescript 7 hoisted: not used" "$r/packages/app" "$PB" none no unknown

  # 8. broken package.json files
  d=$(newws badpkg)
  printf '{not json' >"$d/package.json"
  expect "unparsable package.json" "$d" "$PB:$FIX/g_tsc7" tsc7-path no unknown
  if [ "$PB" != "$BASE" ]; then
    out=$(explain "$d" "$PB:$FIX/g_tsc7")
    has "$LBL unparsable package.json: reason notes it (jq)" "$(getf reason)" "unparsable"
  fi
  add_ts "$d" 7.0.2
  expect "unparsable package.json, typescript 7 installed but undeclared" "$d" "$PB" none no unknown
  : >"$d/package.json"
  expect "empty package.json" "$d" "$PB" none no unknown
  d=$(newws nullpkg)
  add_pkg "$d" 'null'
  expect "package.json that is JSON null" "$d" "$PB" none no unknown
  d=$(newws badnm)
  mkdir -p "$d/node_modules/typescript"
  printf '{not json' >"$d/node_modules/typescript/package.json"
  decl_ts "$d" "^5.0.0"
  expect "unparsable node_modules/typescript/package.json" "$d" "$PB" none no classic
  out=$(explain "$d" "$PB")
  has "$LBL unparsable node_modules/typescript/package.json: reason notes it" "$(getf reason)" "unreadable"
  d=$(newws nover)
  mkdir -p "$d/node_modules/typescript"
  printf '{"name":"typescript"}' >"$d/node_modules/typescript/package.json"
  expect "typescript package.json without a version, nothing declared" "$d" "$PB" none no unknown
  d=$(newws minified)
  mkdir -p "$d/node_modules/typescript"
  printf '{"name":"typescript","version":"7.0.2","bin":{"tsc":"./bin/tsc"}}' >"$d/node_modules/typescript/package.json"
  mkstub "$d/node_modules/typescript/bin/tsc" 7.0.2
  decl_ts "$d" "^7.0.0"
  expect "minified installed typescript package.json" "$d" "$PB" tsc7-project yes
  d=$(newws minified_alias)
  printf '%s' '{"name":"x","devDependencies":{"typescript":"^6.0.3","@typescript/native":"npm:typescript@7.0.2"}}' >"$d/package.json"
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  expect "minified project package.json with an alias" "$d" "$PB" tsc7-project yes ts7
  out=$(explain "$d" "$PB")
  eq "$LBL minified project package.json: alias command" "$(getf command)" "$d/node_modules/@typescript/native/bin/tsc --lsp --stdio"
  d=$(newws crlf_alias)
  printf '{\r\n  "devDependencies": {\r\n    "typescript": "^6.0.3",\r\n    "@typescript/native": "npm:typescript@7.0.2"\r\n  }\r\n}\r\n' >"$d/package.json"
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  expect "CRLF project package.json with an alias" "$d" "$PB" tsc7-project yes ts7

  # 9. workspace selection
  d=$(newws sel_a)
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0"}}'
  add_bin "$d" tsrs
  e=$(newws sel_b)
  decl_ts "$e" "^7.0.0"
  add_ts "$e" 7.0.2
  out=$(cd "$d" && "$ENVBIN" -i PATH="$PB" CLAUDE_PROJECT_DIR="$e" "$SH" "$LAUNCHER" --explain)
  eq "$LBL CLAUDE_PROJECT_DIR beats the process cwd" "$(getf kind)" tsc7-project
  out=$(cd "$d" && "$ENVBIN" -i PATH="$PB" CLAUDE_PROJECT_DIR="$e" "$SH" "$LAUNCHER" --workspace "$d" --explain)
  eq "$LBL --workspace beats CLAUDE_PROJECT_DIR" "$(getf kind)" tsrs-project
  out=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" --explain)
  eq "$LBL cwd is the default workspace" "$(getf workspace)" "$d"

  # 10. a workspace path with a space and a quote
  w="$FIX/we\"ird dir"
  rm -rf "$w"
  mkdir -p "$w/app"
  decl_ts "$w" "^7.0.0"
  add_ts "$w" 7.0.2
  add_pkg "$w/app" '{"name":"app"}'
  out=$(explain "$w/app" "$PB")
  eq "$LBL awkward path: kind" "$(getf kind)" tsc7-project
  eq "$LBL awkward path: command" "$(getf command)" "$w/node_modules/typescript/bin/tsc --lsp --stdio"

  # 11. exec behaviour
  d=$(newws exec7)
  decl_ts "$d" "^7.0.0"
  add_ts "$d" 7.0.2
  o=$(cd "$d" && printf 'payload' | "$ENVBIN" -i PATH="$PB" STUB_CAT=1 "$SH" "$LAUNCHER" 2>"$FIX/err")
  rc=$?
  eq "$LBL exec: exit code" "$rc" 0
  has "$LBL exec: runs tsc --lsp --stdio" "$o" "RAN tsc --lsp --stdio"
  has "$LBL exec: stdin reaches the server" "$o" "STDIN payload"
  eq "$LBL exec: nothing on stderr for a matched server" "$(cat "$FIX/err")" ""
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" STUB_EXIT=7 "$SH" "$LAUNCHER" 2>/dev/null)
  rc=$?
  eq "$LBL exec: server exit code propagates" "$rc" 7
  d=$(newws exec_alias)
  add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
  add_ts "$d" 6.0.3
  add_alias "$d" @typescript/native 7.0.2
  add_bin "$d" tsgo
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" 2>/dev/null)
  eq "$LBL exec: alias to 7 runs its tsc, not the stray tsgo" "$o" "RAN tsc --lsp --stdio"
  d=$(newws exec_tsgo)
  add_pkg "$d" '{"devDependencies":{"@typescript/native-preview":"^7.0.0-dev"}}'
  add_bin "$d" tsgo
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" 2>/dev/null)
  has "$LBL exec: tsgo --lsp --stdio" "$o" "RAN tsgo --lsp --stdio"
  d=$(newws exec_tsrs)
  add_pkg "$d" '{"devDependencies":{"tsrs":"^0.25.0"}}'
  add_bin "$d" tsrs
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" 2>/dev/null)
  has "$LBL exec: tsrs --lsp --stdio" "$o" "RAN tsrs --lsp --stdio"
  d=$(newws exec_tsls)
  decl_ts "$d" "^5.4.0"
  add_ts "$d" 5.9.3
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB:$FIX/g_tsls" "$SH" "$LAUNCHER" 2>/dev/null)
  eq "$LBL exec: typescript-language-server --stdio (no --lsp)" "$o" "RAN typescript-language-server --stdio"
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB:$FIX/g_tsc7" "$SH" "$LAUNCHER" 2>"$FIX/err")
  has "$LBL exec: fallback runs the global tsc 7" "$o" "RAN tsc --lsp --stdio"
  has "$LBL exec: fallback says so on stderr" "$(cat "$FIX/err")" "fallback tsc7-path"
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" 2>"$FIX/err")
  rc=$?
  eq "$LBL exec: no server -> exit 3" "$rc" 3
  eq "$LBL exec: no server -> nothing on stdout" "$o" ""
  eq "$LBL exec: no server -> one stderr line" "$(wc -l <"$FIX/err" | tr -d ' ')" 1
  has "$LBL exec: no server -> message names the fix" "$(cat "$FIX/err")" typescript-language-server
  d=$(newws exec_stray)
  decl_ts "$d" "^6.0.3"
  add_ts "$d" 6.0.3
  add_bin "$d" tsgo
  o=$(cd "$d" && "$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" 2>/dev/null)
  rc=$?
  eq "$LBL exec: a stray undeclared tsgo is not run -> exit 3" "$rc" 3
  lacks "$LBL exec: a stray undeclared tsgo is not run -> no output" "$o" "RAN"

  # 12. argument handling
  o=$("$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" --bogus 2>&1)
  rc=$?
  eq "$LBL unknown argument -> exit 2" "$rc" 2
  o=$("$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" --workspace "$FIX/does-not-exist" --explain 2>&1)
  rc=$?
  eq "$LBL missing workspace -> exit 2" "$rc" 2
  o=$("$ENVBIN" -i PATH="$PB" "$SH" "$LAUNCHER" --workspace 2>&1)
  rc=$?
  eq "$LBL --workspace without a value -> exit 2" "$rc" 2
}

# ---- run it under every shell and both PATH flavours -------------------------------

SHELLS=
for s in sh dash ksh bash; do
  p=$(command -v "$s" 2>/dev/null) || continue
  case " $SHELLS " in *" $p "*) ;; *) SHELLS="$SHELLS $p" ;; esac
done

for s in $SHELLS; do
  echo "=== resolution table under $s, no jq on PATH ==="
  suite "$s" "$BASE" "[$(basename "$s"), no jq]"
  if [ "$HAVE_JQ" = 1 ]; then
    echo "=== resolution table under $s, jq on PATH ==="
    suite "$s" "$BASE:$FIX/jqbin" "[$(basename "$s"), jq]"
  else
    skip "jq flavour under $s (jq not installed)"
  fi
done

# ---- the SessionStart hook -------------------------------------------------------

echo "=== SessionStart hook ==="
PB=$BASE:$FIX/jqbin
[ "$HAVE_JQ" = 1 ] || PB=$BASE
# run_hook DIR PATH [PLUGIN_ROOT]: print the hook's stdout; its exit code goes to $FIX/hrc (hrc).
run_hook() {
  _o=$(cd "$1" && printf '{"hook_event_name":"SessionStart","source":"startup"}' |
    "$ENVBIN" -i PATH="$2" CLAUDE_PLUGIN_ROOT="${3:-$PLUGIN}" "$(command -v sh)" "$HOOK" 2>"$FIX/err"
    echo $? >"$FIX/hrc")
  printf '%s' "$_o"
}
hrc() { cat "$FIX/hrc"; }

d=$(newws hook_ok)
decl_ts "$d" "^7.0.0"
add_ts "$d" 7.0.2
o=$(run_hook "$d" "$PB")
eq "hook: silent when the project-matched server is found (stdout)" "$o" ""
eq "hook: silent when matched (exit)" "$(hrc)" 0
eq "hook: silent when matched (stderr)" "$(cat "$FIX/err")" ""
d=$(newws hook_alias)
add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
add_ts "$d" 6.0.3
add_alias "$d" @typescript/native 7.0.2
o=$(run_hook "$d" "$PB")
eq "hook: silent when an aliased typescript 7 is the project's server" "$o" ""
d=$(newws hook_tsls)
decl_ts "$d" "^5.4.0"
add_ts "$d" 5.9.3
o=$(run_hook "$d" "$PB:$FIX/g_tsls")
eq "hook: silent for typescript-language-server on PATH with project typescript" "$o" ""

d=$(newws hook_fb)
decl_ts "$d" "^5.4.0"
add_ts "$d" 5.9.3
o=$(run_hook "$d" "$PB:$FIX/g_tsc7")
eq "hook: fallback exits 0" "$(hrc)" 0
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

d=$(newws hook_none)
decl_ts "$d" "^5.4.0"
add_ts "$d" 5.9.3
o=$(run_hook "$d" "$PB")
eq "hook: no server exits 0" "$(hrc)" 0
has "hook: no server says unavailable" "$o" "TypeScript LSP unavailable"
has "hook: no server says what to install" "$o" "typescript-language-server"

d=$(newws hook_notinst)
add_pkg "$d" '{"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"^6.0.3"}}'
o=$(run_hook "$d" "$PB:$FIX/g_tsc7")
eq "hook: declared but not installed exits 0" "$(hrc)" 0
has "hook: declared but not installed names the declaration" "$o" "declares @typescript/native = npm:typescript@7.0.2"
has "hook: declared but not installed says to install the dependencies" "$o" "install the project's dependencies"

d=$(newws hook_stray)
decl_ts "$d" "^6.0.3"
add_ts "$d" 6.0.3
add_bin "$d" tsgo
o=$(run_hook "$d" "$PB")
has "hook: a stray undeclared tsgo is not the server" "$o" "TypeScript LSP unavailable"

w="$FIX/we\"ird\\dir"
rm -rf "$w"
mkdir -p "$w"
o=$(run_hook "$w" "$PB")
eq "hook: awkward path exits 0" "$(hrc)" 0
if [ "$HAVE_JQ" = 1 ]; then
  if printf '%s' "$o" | jq -e . >/dev/null 2>&1; then ok "hook: path with quote and backslash stays valid JSON"; else bad "hook: path with quote and backslash stays valid JSON: $o"; fi
  has "hook: the awkward path survives escaping" "$(printf '%s' "$o" | jq -r .systemMessage)" "$w"
fi

# the hook must never fail the session
o=$(run_hook "$FIX" "$PB" "$FIX/no-such-plugin-root")
eq "hook: missing launcher -> silent exit 0" "$(hrc)$o" "0"
mkdir -p "$FIX/brokenroot/bin"
printf '#!/bin/sh\nexit 1\n' >"$FIX/brokenroot/bin/ts-lsp"
o=$(run_hook "$FIX" "$PB" "$FIX/brokenroot")
eq "hook: launcher failing -> silent exit 0" "$(hrc)$o" "0"
printf '#!/bin/sh\necho garbage\nexit 0\n' >"$FIX/brokenroot/bin/ts-lsp"
o=$(run_hook "$FIX" "$PB" "$FIX/brokenroot")
eq "hook: launcher printing garbage -> silent exit 0" "$(hrc)$o" "0"
o=$(cd "$FIX" && "$ENVBIN" -i PATH="$PB" CLAUDE_PLUGIN_ROOT="$PLUGIN" "$(command -v sh)" "$HOOK" </dev/null 2>/dev/null)
eq "hook: empty stdin and a workspace with nothing -> exit 0" "$?" 0

# ---- wiring -------------------------------------------------------------------

echo "=== wiring ==="
[ -x "$LAUNCHER" ] && ok "bin/ts-lsp is executable" || bad "bin/ts-lsp is executable"
[ -f "$HOOK" ] && ok "hooks/ts-lsp-check.sh exists" || bad "hooks/ts-lsp-check.sh exists"
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
  eq "hooks.json: the existing PreToolUse hook is kept" \
    "$(jq -r '.hooks.PreToolUse[0].hooks[0].command | test("block-tsc-with-files.sh")' "$PLUGIN/hooks/hooks.json")" true
else
  skip "manifest checks (jq not installed)"
fi

echo
echo "shells:$SHELLS"
echo "passed=$PASS failed=$FAIL skipped=$SKIP"
[ "$FAIL" -eq 0 ]
