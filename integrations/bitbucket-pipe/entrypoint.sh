#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
: "${BITBUCKET_CLONE_DIR:?Bitbucket checkout is required}"
cd -- "$BITBUCKET_CLONE_DIR"
export RDF_TOOL_DIRECTORY=/opt/rdf/common
mode="${RDF_OPERATION:-run}"
if [[ "$mode" != run && "$mode" != recover ]]; then echo 'Unsupported pipe operation' >&2; exit 2; fi
private="$(mktemp -d /tmp/rdf-pipe.XXXXXXXX)"
pid=''
finish(){
  local code=$? deadline
  trap - EXIT INT TERM
  if [[ -n "$pid" ]] && jobs -pr | grep -Fxq "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    deadline=$((SECONDS + ${RDF_RELEASE_TIMEOUT_SECONDS:-180} + 45))
    while jobs -pr | grep -Fxq "$pid" && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 0.5; done
    if jobs -pr | grep -Fxq "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  fi
  if [[ "$mode" == run ]]; then node /opt/rdf/node/cli.cjs recover || { [[ "$code" -ne 0 ]] || code=1; }; fi
  rm -f -- "$private/adbkey" "$private/ca.pem" "$private/.android/adbkey"; rmdir -- "$private/.android" "$private" 2>/dev/null || true; exit "$code"; }
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export HOME="$private"
mkdir -p -- "$HOME/.android"
if [[ -n "${RDF_ADB_KEY_BASE64:-}" ]]; then
  printf '%s' "$RDF_ADB_KEY_BASE64" | base64 --decode > "$private/adbkey"
  unset RDF_ADB_KEY_BASE64
  export RDF_ADB_KEY_FILE="$private/adbkey"
fi
if [[ -n "${RDF_ADB_KEY_FILE:-}" ]]; then install -m 0600 -- "$RDF_ADB_KEY_FILE" "$HOME/.android/adbkey"; fi
if [[ -n "${RDF_CA_BASE64:-}" ]]; then
  printf '%s' "$RDF_CA_BASE64" | base64 --decode > "$private/ca.pem"
  unset RDF_CA_BASE64
  export RDF_CA_FILE="$private/ca.pem"
fi
if [[ "$mode" == run && -z "${RDF_ADB_KEY_FILE:-}" ]]; then echo 'A protected private ADB key is required' >&2; exit 2; fi
status=0
node /opt/rdf/node/cli.cjs "$mode" &
pid=$!
wait "$pid" || status=$?
pid=''
exit "$status"
