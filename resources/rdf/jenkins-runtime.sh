#!/usr/bin/env bash
# CI runtime: protected TLS/ADB inputs, managed tests and recovery evidence.
set +x
set -euo pipefail
umask 077
[ -z "${RDF_ENV_SCRIPT:-}" ] || source "$RDF_ENV_SCRIPT"
: "${RDF_ARTIFACT_DIR:?set RDF_ARTIFACT_DIR}"
: "${RDF_RUNNER_SCRIPT:?set RDF_RUNNER_SCRIPT}"
: "${RDF_TEST_SCRIPT:?set RDF_TEST_SCRIPT}"
for tool in bash curl jq adb timeout tee; do command -v "$tool" >/dev/null; done
case "${RDF_GPU_MODE:-}" in ''|software|nvidia) ;; *) echo 'Invalid RDF_GPU_MODE' >&2; exit 2 ;; esac
release_timeout=${RDF_RELEASE_TIMEOUT_SECONDS:-180}
[[ "$release_timeout" =~ ^[1-9][0-9]{0,4}$ ]] && [[ "$release_timeout" -le 86400 ]] || { echo 'Invalid release timeout' >&2; exit 2; }
mkdir -p -- "$RDF_ARTIFACT_DIR"
export RDF_ARTIFACT_DIR="$(cd -P -- "$RDF_ARTIFACT_DIR" && pwd)"
export RDF_STATE_FILE="$RDF_ARTIFACT_DIR/session.json"
[[ ! -e "$RDF_STATE_FILE" && ! -e "$RDF_STATE_FILE.lock" && ! -e "$RDF_ARTIFACT_DIR/farm-result.json" ]] || exit 2
if [ -n "${RDF_CA_FILE:-}" ]; then
  [[ -r "$RDF_CA_FILE" && -s "$RDF_CA_FILE" ]] || exit 2
  export CURL_CA_BUNDLE="$RDF_CA_FILE"
fi
private_dir=''
adb_pid=''
runner_pid=''
cleanup() {
  local status=$? deadline server_exited=true key_removed=true
  trap - EXIT INT TERM
  if [[ -n "$runner_pid" ]] && jobs -pr | grep -Fxq "$runner_pid"; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    deadline=$((SECONDS + $release_timeout + 30))
    while jobs -pr | grep -Fxq "$runner_pid" && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 0.5; done
    if jobs -pr | grep -Fxq "$runner_pid"; then
      kill -KILL "$runner_pid" 2>/dev/null || true
      echo 'Managed test shutdown timed out; retain recovery state' >&2
      [[ "$status" -ne 0 ]] || status=1
    fi
    wait "$runner_pid" 2>/dev/null || true
    record_result "$status" || true
  fi
  if [[ -n "$adb_pid" ]]; then
    # Signal only our foreground child, never a shared ADB server or socket.
    if jobs -pr | grep -Fxq "$adb_pid"; then kill -TERM "$adb_pid" 2>/dev/null || true; fi
    deadline=$((SECONDS + 5))
    while jobs -pr | grep -Fxq "$adb_pid" && [[ "$SECONDS" -lt "$deadline" ]]; do sleep 0.2; done
    if jobs -pr | grep -Fxq "$adb_pid"; then kill -KILL "$adb_pid" 2>/dev/null || true; fi
    wait "$adb_pid" 2>/dev/null || true
    if jobs -pr | grep -Fxq "$adb_pid"; then server_exited=false; fi
  fi
  if [[ -n "$private_dir" ]]; then
    rm -f -- "$private_dir/.android/adbkey" "$private_dir/.android/adbkey.pub" "$private_dir/.rdf-owner"
    rmdir -- "$private_dir/.android" "$private_dir" 2>/dev/null || key_removed=false
    jq -n --argjson pid "${adb_pid:-0}" --argjson port "${adb_port:-0}" \
      --argjson exited "$server_exited" --argjson removed "$key_removed" \
      '{pid:$pid,port:$port,serverExited:$exited,privateKeyRemoved:$removed}' > "$RDF_ARTIFACT_DIR/adb-runtime.json"
  fi
  [[ "$server_exited" == true && "$key_removed" == true ]] || { [[ "$status" -ne 0 ]] || status=1; }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "${RDF_ADB_KEY_FILE:-}" ]; then
  command -v python3 >/dev/null
  [[ -r "$RDF_ADB_KEY_FILE" && -s "$RDF_ADB_KEY_FILE" ]]
  [[ -r "${HOME:?}/.android/adbkey" && -s "$HOME/.android/adbkey" ]] || {
    echo 'An existing ADB user key is required; the runtime never creates a shared key' >&2; exit 2;
  }
  temp_root="$(cd -P -- "${TMPDIR:-/tmp}" && pwd)"
  case "$temp_root/" in "$RDF_ARTIFACT_DIR/"*) echo 'Private ADB files must stay outside artifacts' >&2; exit 2 ;; esac
  private_dir="$(mktemp -d "$temp_root/rdf-adb.XXXXXXXX")"
  printf '%s' "$RDF_ARTIFACT_DIR" > "$private_dir/.rdf-owner"
  jq -n --arg directory "$private_dir" '{directory:$directory,pid:0,port:0}' > "$RDF_ARTIFACT_DIR/adb-owner.json"
  export ANDROID_USER_HOME="$private_dir/.android"
  mkdir -p -- "$ANDROID_USER_HOME"
  install -m 0600 -- "$RDF_ADB_KEY_FILE" "$ANDROID_USER_HOME/adbkey"
  export ADB_VENDOR_KEYS="$ANDROID_USER_HOME/adbkey" ADB_MDNS_AUTO_CONNECT=0
  env -u RDF_TOKEN adb pubkey "$ADB_VENDOR_KEYS" > "$ANDROID_USER_HOME/adbkey.pub"
  adb_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  export ANDROID_ADB_SERVER_PORT="$adb_port" ADB_SERVER_SOCKET="tcp:127.0.0.1:$adb_port"
  env -u RDF_TOKEN adb -L "tcp:localhost:$adb_port" nodaemon server > "$RDF_ARTIFACT_DIR/adb-server.log" 2>&1 &
  adb_pid=$!
  jq -n --arg directory "$private_dir" --argjson pid "$adb_pid" --argjson port "$adb_port" \
    '{directory:$directory,pid:$pid,port:$port}' > "$RDF_ARTIFACT_DIR/adb-owner.json.tmp"
  mv -- "$RDF_ARTIFACT_DIR/adb-owner.json.tmp" "$RDF_ARTIFACT_DIR/adb-owner.json"
  server_ready=0
  for attempt in {1..30}; do
    sleep 0.2
    jobs -pr | grep -Fxq "$adb_pid" || { echo 'Private ADB server exited during startup' >&2; exit 2; }
    if python3 -c 'import os,socket; s=socket.create_connection(("127.0.0.1",int(os.environ["ANDROID_ADB_SERVER_PORT"])),timeout=1); s.close()' >/dev/null 2>&1; then
      jobs -pr | grep -Fxq "$adb_pid" || exit 2
      server_ready=1; break
    fi
  done
  [[ "$server_ready" == 1 ]] || { echo 'Private ADB server did not become ready' >&2; exit 2; }
fi
record_result() {
  local code="$1" released=false
  if grep -qx 'request released; cleanup confirmed' "$RDF_ARTIFACT_DIR/farm.log" && [[ ! -e "$RDF_STATE_FILE" && ! -e "$RDF_STATE_FILE.lock" ]]; then released=true; fi
  jq -n --argjson code "$code" --argjson released "$released" '{cliExitCode:$code,releaseConfirmed:$released}' > "$RDF_ARTIFACT_DIR/farm-result.json"
  [[ "$released" == true ]]
}
bash "$RDF_RUNNER_SCRIPT" -- bash "$RDF_TEST_SCRIPT" > "$RDF_ARTIFACT_DIR/farm.log" 2>&1 &
runner_pid=$!
status=0
wait "$runner_pid" || status=$?
runner_pid=''
cat "$RDF_ARTIFACT_DIR/farm.log"
if ! record_result "$status"; then [[ "$status" -ne 0 ]] || status=1; fi
exit "$status"
