#!/usr/bin/env bash
# CI package entry point. Allocation and recovery stay in the shared RDF CLI.
set +x
set -euo pipefail
umask 077
mode="${1:-run}"
: "${RDF_TOOL_DIR:?set RDF_TOOL_DIR}"
export RDF_CLI_SCRIPT="$RDF_TOOL_DIR/rdf.sh"
[[ -f "$RDF_CLI_SCRIPT" ]] || export RDF_CLI_SCRIPT="$RDF_TOOL_DIR/../../scripts/rdf.sh"
export RDF_RUNNER_SCRIPT="$RDF_TOOL_DIR/run-tests.sh"
token_variable="${RDF_TOKEN_VARIABLE:-RDF_TOKEN}"
[[ "$token_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || exit 2
export RDF_TOKEN="${!token_variable:-}"
[[ "$token_variable" == RDF_TOKEN ]] || unset "$token_variable"
export RDF_TOKEN_VARIABLE=RDF_TOKEN
if [[ "$mode" == run ]]; then : "${RDF_TOKEN:?set the configured API token variable}"; fi
case "$mode" in
  recover) export RDF_ENV_SCRIPT=; exec bash "$RDF_TOOL_DIR/managed-cleanup.sh" ;;
  run) ;;
  *) echo 'Unsupported CI operation' >&2; exit 2 ;;
esac
: "${RDF_TEST_SCRIPT:?set RDF_TEST_SCRIPT}"
: "${RDF_ARTIFACT_DIR:?set RDF_ARTIFACT_DIR}"

for name in "$RDF_TEST_SCRIPT" "${RDF_PREPARE_SCRIPT:-}" "${RDF_ENV_SCRIPT:-}"; do
  [ -z "$name" ] || [[ "$name" != /* && "$name" != *'\'* && "/$name/" != *'/../'* && -f "$name" ]] || exit 2
done
[ -z "${RDF_ENV_SCRIPT:-}" ] || source "$RDF_ENV_SCRIPT"
export RDF_ENV_SCRIPT=
mkdir -p -- "$RDF_ARTIFACT_DIR"
[[ ! -e "$RDF_ARTIFACT_DIR/session.json" && ! -e "$RDF_ARTIFACT_DIR/session.json.lock" ]] || { echo 'Saved request must be released before another run' >&2; exit 2; }
if [ -n "${RDF_PREPARE_SCRIPT:-}" ]; then
  env -u RDF_TOKEN -u "$token_variable" bash "$RDF_PREPARE_SCRIPT"
fi
release_timeout=${RDF_RELEASE_TIMEOUT_SECONDS:-180}
[[ "$release_timeout" =~ ^[1-9][0-9]{0,4}$ && "$release_timeout" -le 86400 ]] || exit 2
pid=''
finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$pid" ]] && jobs -pr | grep -Fxq "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    local deadline=$((SECONDS + $release_timeout + 40))
    while jobs -pr | grep -Fxq "$pid" && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 0.5; done
    if jobs -pr | grep -Fxq "$pid"; then kill -KILL "$pid" 2>/dev/null || true; [[ "$status" -ne 0 ]] || status=1; fi
    wait "$pid" 2>/dev/null || true
  fi
  if ! bash "$RDF_TOOL_DIR/managed-cleanup.sh"; then [[ "$status" -ne 0 ]] || status=1; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash "$RDF_TOOL_DIR/managed-runtime.sh" &
pid=$!
status=0
wait "$pid" || status=$?
release_timeout=${RDF_RELEASE_TIMEOUT_SECONDS:-180}
[[ "$release_timeout" =~ ^[1-9][0-9]{0,4}$ && "$release_timeout" -le 86400 ]] || exit 2
pid=''
exit "$status"
