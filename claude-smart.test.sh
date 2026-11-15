#!/usr/bin/env zsh
# Tests for claude-smart.sh project detection, using CLAUDE_SMART_DRY_RUN=1.
# Builds fixture trees under a mktemp directory; HOME is left as is, so the plugin
# directories resolve to ~/.claude/my-plugins and assertions use their basenames.
# Detection looks at the current directory only; subdirectory markers must not count.

set -uo pipefail

SCRIPT="${0:A:h}/claude-smart.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claude-smart-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

pass=0
fail=0

# fixture NAME: fresh empty directory; sets FX to its path
fixture() {
    FX="$ROOT/$1"
    mkdir -p "$FX"
}

# touchp PATH...: create files (and parent directories) relative to FX
touchp() {
    local p
    for p in "$@"; do
        mkdir -p "$FX/${p:h}"
        : > "$FX/$p"
    done
}

# expect LABEL EXPECTED_SPACE_SEPARATED_BASENAMES: run in FX, compare plugin basenames
expect() {
    local label="$1" expected="$2" out got line
    local -a names
    out="$(cd "$FX" && CLAUDE_SMART_DRY_RUN=1 zsh "$SCRIPT" 2>&1)"
    names=()
    for line in "${(@f)out}"; do
        [[ -n "$line" ]] && names+=("${line:t}")
    done
    got="${(j: :)names}"
    if [[ "$got" == "$expected" ]]; then
        print "ok   - $label"
        pass=$((pass + 1))
    else
        print "FAIL - $label: expected [$expected] got [$got]"
        print -r -- "       raw output: $out"
        fail=$((fail + 1))
    fi
}

fixture empty
expect "1. empty dir prints nothing" ""

fixture cargo-here
touchp Cargo.toml
expect "2. ./Cargo.toml -> generic-dev" "generic-dev"

fixture cargo-sub
touchp sub/Cargo.toml
expect "3a. only ./sub/Cargo.toml -> nothing (no subdirectory scan)" ""

fixture go-two
touchp a/b/go.mod
expect "3b. only ./a/b/go.mod -> nothing" ""

fixture js-sub
mkdir -p "$FX/web"
echo '{"devDependencies":{"typescript":"^5.0.0"}}' > "$FX/web/package.json"
touchp web/tsconfig.json
expect "3c. only ./web/package.json and ./web/tsconfig.json -> nothing" ""

fixture xcode-sub
mkdir -p "$FX/sub/App.xcodeproj"
expect "3d. only ./sub/App.xcodeproj/ -> nothing" ""

fixture js
echo '{"name":"x"}' > "$FX/package.json"
expect "4a. ./package.json without typescript -> generic-dev javascript" "generic-dev javascript"

fixture js-tsconfig
echo '{"name":"x"}' > "$FX/package.json"
touchp tsconfig.json
expect "4b. ./package.json + ./tsconfig.json -> generic-dev javascript typescript" \
    "generic-dev javascript typescript"

fixture ts-dep
echo '{"devDependencies":{"typescript":"^5.0.0"}}' > "$FX/package.json"
expect "4c. ./package.json with typescript devDependency -> generic-dev javascript typescript" \
    "generic-dev javascript typescript"

fixture ts-dep-runtime
echo '{"dependencies":{"typescript":"^5.0.0"}}' > "$FX/package.json"
expect "4d. ./package.json with typescript dependency -> generic-dev javascript typescript" \
    "generic-dev javascript typescript"

fixture js-bad-json
echo '{not json' > "$FX/package.json"
expect "4e. unparsable ./package.json -> generic-dev javascript (no typescript, no failure)" \
    "generic-dev javascript"

fixture tsconfig-only
touchp tsconfig.json
expect "4f. only ./tsconfig.json -> generic-dev typescript" "generic-dev typescript"

fixture xcode
mkdir -p "$FX/App.xcodeproj"
expect "5. ./App.xcodeproj/ directory -> generic-dev" "generic-dev"

fixture xcode-file
touchp App.xcodeproj
expect "5b. a regular file named App.xcodeproj -> nothing" ""

fixture makefile
touchp Makefile
expect "6. only ./Makefile -> nothing" ""

fixture mixin-dup
touchp Cargo.toml
print "generic-dev" > "$FX/.claude-mixins"
expect "7. generic-dev mixin + ./Cargo.toml -> generic-dev exactly once" "generic-dev"

fixture mixin-parent
touchp sub/Cargo.toml
print "generic-dev" > "$FX/.claude-mixins"
expect "8. .claude-mixins with generic-dev + ./sub/Cargo.toml -> generic-dev exactly once" "generic-dev"

fixture mixin-comment
touchp sub/Cargo.toml
print -l "# Code lives in ./sub (Rust); load the coding plugin when claude starts here." "generic-dev" \
    > "$FX/.claude-mixins"
expect "9. .claude-mixins with a comment line and generic-dev -> generic-dev" "generic-dev"

fixture "with space"
touchp Cargo.toml
expect "10. directory names containing spaces work" "generic-dev"

fixture other-markers
touchp pyproject.toml
expect "11a. pyproject.toml -> generic-dev" "generic-dev"
for marker in go.mod Package.swift CMakeLists.txt compile_commands.json deno.json bunfig.toml; do
    fixture "marker-$marker"
    touchp "$marker"
    expect "11b. $marker -> generic-dev" "generic-dev"
done

print
print "passed: $pass  failed: $fail"
(( fail == 0 ))
