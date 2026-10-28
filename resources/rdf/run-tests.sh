#!/usr/bin/env bash
# Shared CI test runner. The RDF CLI owns the queue, lease and confirmed release.
set +x
set -euo pipefail
umask 077

fail() { printf 'rdf integration: %s\n' "$*" >&2; exit 2; }
seconds() { [[ "$2" =~ ^[1-9][0-9]*$ ]] && [ "${#2}" -le 5 ] && [ "$2" -le 86400 ] || fail "$1 must be 1-86400 seconds"; }
: "${RDF_ARTIFACT_DIR:?set a unique RDF_ARTIFACT_DIR}"
TEST_TIMEOUT="${RDF_TEST_TIMEOUT_SECONDS:-1200}"
seconds RDF_TEST_TIMEOUT_SECONDS "$TEST_TIMEOUT"
TOKEN_VARIABLE="${RDF_TOKEN_VARIABLE:-RDF_TOKEN}"
[[ "$TOKEN_VARIABLE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail 'invalid token variable name'

if [ "${1:-}" = --managed ]; then
  shift
  [ "$#" -gt 0 ] || fail 'no test command'
  : "${ANDROID_SERIAL:?the RDF CLI must connect the device first}"
  collect() {
    local result=$?
    trap - EXIT INT TERM
    timeout --signal=TERM --kill-after=2s 10s env -u RDF_TOKEN -u "$TOKEN_VARIABLE" adb -s "$ANDROID_SERIAL" logcat -d -t 2000 \
      > "$RDF_ARTIFACT_DIR/logcat.txt" 2> "$RDF_ARTIFACT_DIR/logcat-errors.txt" || true
    if ! timeout --signal=TERM --kill-after=2s 10s env -u RDF_TOKEN -u "$TOKEN_VARIABLE" adb -s "$ANDROID_SERIAL" exec-out screencap -p \
      > "$RDF_ARTIFACT_DIR/screenshot.png" 2> "$RDF_ARTIFACT_DIR/screenshot-errors.txt"; then
      rm -f -- "$RDF_ARTIFACT_DIR/screenshot.png"
    fi
    exit "$result"
  }
  trap collect EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set +e
  env -u RDF_TOKEN -u "$TOKEN_VARIABLE" timeout --signal=TERM --kill-after=30s "${TEST_TIMEOUT}s" "$@" \
    2>&1 | tee "$RDF_ARTIFACT_DIR/test.log"
  result=( "${PIPESTATUS[@]}" )
  set -e
  [ "${result[0]}" -eq 0 ] || exit "${result[0]}"
  exit "${result[1]}"
fi

[ "${1:-}" != -- ] || shift
[ "$#" -gt 0 ] || fail 'usage: run-tests.sh -- COMMAND [ARGUMENTS...]'
CLI="${RDF_CLI_SCRIPT:-$(dirname "$0")/rdf.sh}"
[ -f "$CLI" ] || fail 'RDF CLI file is missing'
for tool in bash curl jq adb timeout tee; do command -v "$tool" >/dev/null || fail "$tool is required"; done
timeout --version | grep 'GNU coreutils' >/dev/null || fail 'GNU timeout is required'
mkdir -p -- "$RDF_ARTIFACT_DIR"
RDF_ARTIFACT_DIR="$(cd "$RDF_ARTIFACT_DIR" && pwd)"
export RDF_ARTIFACT_DIR
export RDF_STATE_FILE="${RDF_STATE_FILE:-$RDF_ARTIFACT_DIR/session.json}"
if [ -e "$RDF_STATE_FILE" ] || [ -d "$RDF_STATE_FILE.lock" ]; then
  fail "saved state exists: $RDF_STATE_FILE; release it before starting another test"
fi
CLI="$(cd "$(dirname "$CLI")" && pwd)/$(basename "$CLI")"
RUNNER="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
exec bash "$CLI" run -- bash "$RUNNER" --managed "$@"
