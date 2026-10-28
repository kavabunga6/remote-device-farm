#!/usr/bin/env bash
# Remote Device Farm CLI. Requires Bash, curl and jq; connect/run also need adb and GNU timeout (gtimeout on macOS).
#   rdf.sh create             queue a device request; print queue:<id>
#   rdf.sh wait [seconds]     wait for allocation and startup (default 900)
#   rdf.sh connect [seconds]  connect ADB and wait for authorization (default 60)
#   rdf.sh logs [lines]       print logcat (default 200)
#   rdf.sh release [seconds]  wait for confirmed cleanup (default 180)
#   rdf.sh run -- COMMAND...  acquire, connect, run with ANDROID_SERIAL, release
# Set RDF_URL and RDF_TOKEN. Choose the device with RDF_PROFILE (profile id) or by kind with
# RDF_ANDROID, RDF_API, RDF_DEVICE_TYPE, RDF_FORM, RDF_FLAVOR, RDF_ABI. Optional: RDF_HOST, RDF_ADB_KEY_ID,
# RDF_LABEL, RDF_GPU_MODE, RDF_STATE_FILE, RDF_LEASE_TTL_SECONDS, RDF_DISK_GB,
# RDF_SD_CARD_MB, RDF_PRIVILEGED (0/1) and RDF_EMULATOR_PARAMS (unset inherits; empty explicitly clears extra args).
set -euo pipefail
umask 077

fail() { printf 'rdf: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need_timeout() {
  local candidate
  for candidate in timeout gtimeout; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version 2>/dev/null | grep 'GNU coreutils' >/dev/null; then
      TIMEOUT_TOOL="$candidate"
      return 0
    fi
  done
  fail 'GNU timeout is required (install coreutils; macOS gtimeout is supported)'
}
for tool in curl jq; do need "$tool"; done
: "${RDF_URL:?set RDF_URL, for example https://farm.example.com}"
: "${RDF_TOKEN:?set RDF_TOKEN to a personal API token}"
BASE="${RDF_URL%/}"
MODE="${1:-}"
STATE_FILE="${RDF_STATE_FILE:-.rdf-session}"
AUTO_STATE=0
BODY_FILE=''
LOCK_DIR=''
LOCKED=0
MANAGED=0
HEARTBEAT_PID=''
COMMAND_PID=''
CODE=0
API_DEADLINE=0
TIMEOUT_TOOL=''
STATE='{}'

seconds() {
  [[ "$2" =~ ^[1-9][0-9]*$ ]] && [ "${#2}" -le 5 ] && [ "$2" -ge 1 ] && [ "$2" -le 86400 ] || fail "$1 must be 1-86400 seconds"
}
uuid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; }
POLL="${RDF_POLL_SECONDS:-2}"
HTTP_TIMEOUT="${RDF_HTTP_TIMEOUT_SECONDS:-60}"
seconds RDF_POLL_SECONDS "$POLL"
seconds RDF_HTTP_TIMEOUT_SECONDS "$HTTP_TIMEOUT"

poll() {
  local delay="$POLL" remaining
  if [ "$API_DEADLINE" -gt 0 ]; then
    remaining=$((API_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || return 0
    [ "$delay" -le "$remaining" ] || delay="$remaining"
  fi
  sleep "$delay"
}

api() {
  local method="$1" path="$2" data="${3:-}" key="${4:-}" limit="$HTTP_TIMEOUT" remaining
  if [ "$API_DEADLINE" -gt 0 ]; then
    remaining=$((API_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || { printf 'rdf: operation deadline exceeded; recovery state retained in %s\n' "$STATE_FILE" >&2; return 1; }
    [ "$remaining" -ge "$limit" ] || limit="$remaining"
  fi
  # Read the secret header from stdin so it is not exposed in curl's process arguments.
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' --connect-timeout "$limit" --max-time "$limit" -X "$method" -H @-)
  [ -z "$data" ] || args+=(-H 'Content-Type: application/json' --data "$data")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  CODE=0
  CODE="$(curl "${args[@]}" "$BASE$path" <<<"Authorization: Bearer $RDF_TOKEN")" || { printf 'rdf: request to %s failed; recovery state is kept in %s\n' "$BASE" "$STATE_FILE" >&2; return 1; }
}
expect() {
  case "$CODE" in 2??) return 0 ;; esac
  printf 'rdf: HTTP %s: %s\n' "$CODE" "$(jq -r '.error.message // .message // "request failed"' "$BODY_FILE" 2>/dev/null || echo 'invalid response')" >&2
  return 1
}
field() { jq -r "$1 // empty" <<<"$STATE"; }
load_state() {
  STATE='{}'
  if [ -s "$STATE_FILE" ]; then
    local raw; raw="$(cat "$STATE_FILE")"
    if uuid "$raw"; then STATE="$(jq -n --arg id "$raw" '{sessionId:$id}')"
    else STATE="$(jq -e 'select(type=="object")' <<<"$raw")" || fail "invalid state file: $STATE_FILE"; fi
  fi
  local saved_url; saved_url="$(field .url)"
  [ -z "$saved_url" ] || [ "$saved_url" = "$BASE" ] || fail "state belongs to another RDF_URL; choose a different RDF_STATE_FILE"
  if [ -n "${RDF_SESSION:-}" ]; then
    uuid "$RDF_SESSION" || fail 'invalid RDF_SESSION'
    local saved; saved="$(field .sessionId)"
    [ -z "$saved" ] || [ "$saved" = "$RDF_SESSION" ] || fail 'RDF_SESSION differs from the saved session; choose a different RDF_STATE_FILE'
    [ -z "$(field .queueId)" ] || [ "$saved" = "$RDF_SESSION" ] || fail 'state file belongs to a queued request'
    STATE="$(jq --arg id "$RDF_SESSION" '.sessionId=$id' <<<"$STATE")"
  fi
}
save_state() {
  local temporary; temporary="$(mktemp "${STATE_FILE}.tmp.XXXXXX")" || return 1
  printf '%s\n' "$STATE" >"$temporary"
  mv -f -- "$temporary" "$STATE_FILE"
}
lock() {
  mkdir -- "$LOCK_DIR" 2>/dev/null || fail "state is locked: $LOCK_DIR. Use a unique RDF_STATE_FILE per job; remove a stale lock only after checking its process has stopped."
  LOCKED=1
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
}

# The request and idempotency key are saved before POST. Replaying an uncertain POST cannot rent twice.
recover_request() {
  [ -z "$(field .queueId)" ] || return 0
  local key payload; key="$(field .requestKey)"; payload="$(field .request)"
  [ -n "$key" ] && [ -n "$payload" ] || return 0
  api POST /api/queue "$payload" "$key" || return 1
  expect || return 1
  local id; id="$(jq -r '.id // empty' "$BODY_FILE")"
  uuid "$id" || fail 'queue returned an invalid id; recovery state is retained'
  STATE="$(jq --arg id "$id" '.queueId=$id' <<<"$STATE")"
  save_state
}
cmd_create() {
  [ -z "${RDF_SESSION:-}" ] || fail 'unset RDF_SESSION before creating a request'
  [ "$STATE" = '{}' ] || fail "an existing request is saved in $STATE_FILE; wait or release it first"
  local lease="${RDF_LEASE_TTL_SECONDS:-}" gpu="${RDF_GPU_MODE:-}" adb_key="${RDF_ADB_KEY_ID:-}"
  [ -z "$adb_key" ] || uuid "$adb_key" || fail 'RDF_ADB_KEY_ID must be a key UUID from your account'
  [ -z "$gpu" ] || [[ "$gpu" = software || "$gpu" = nvidia ]] || fail 'RDF_GPU_MODE must be software or nvidia'
  if [ -n "$lease" ]; then seconds RDF_LEASE_TTL_SECONDS "$lease"; [ "$lease" -ge 30 ] && [ "$lease" -le 3600 ] || fail 'lease must be 30-3600 seconds'; fi
  local disk="${RDF_DISK_GB-}" sd_card="${RDF_SD_CARD_MB-}" params="${RDF_EMULATOR_PARAMS-}"
  if [ "${RDF_DISK_GB+x}" = x ]; then
    [[ "$disk" =~ ^[1-9][0-9]*$ ]] && [ "${#disk}" -le 3 ] && [ "$disk" -ge 2 ] && [ "$disk" -le 128 ] || fail 'RDF_DISK_GB must be an integer from 2 to 128 GiB'
  fi
  if [ "${RDF_SD_CARD_MB+x}" = x ]; then
    [[ "$sd_card" =~ ^(0|[1-9][0-9]*)$ ]] && [ "${#sd_card}" -le 5 ] && { [ "$sd_card" = 0 ] || { [ "$sd_card" -ge 128 ] && [ "$sd_card" -le 32768 ]; }; } || fail 'RDF_SD_CARD_MB must be 0 (disabled) or an integer from 128 to 32768 MiB'
  fi
  [ "${#params}" -le 500 ] || fail 'RDF_EMULATOR_PARAMS must be at most 500 characters'
  local privileged="${RDF_PRIVILEGED-}"
  if [ "${RDF_PRIVILEGED+x}" = x ]; then
    [[ "$privileged" = 0 || "$privileged" = 1 ]] || fail 'RDF_PRIVILEGED must be 0 or 1'
  fi
  local payload key launch
  launch="$(jq -n --arg disk "$disk" --arg sd "$sd_card" --arg params "$params" \
    --arg diskSet "${RDF_DISK_GB+x}" --arg sdSet "${RDF_SD_CARD_MB+x}" --arg paramsSet "${RDF_EMULATOR_PARAMS+x}" --arg privileged "$privileged" --arg privilegedSet "${RDF_PRIVILEGED+x}" '
    (if $diskSet=="x" then {diskGb:($disk|tonumber)} else {} end)
    + (if $sdSet=="x" then {sdCardMb:($sd|tonumber)} else {} end)
    + (if $paramsSet=="x" then {emulatorParams:$params} else {} end)
    + (if $privilegedSet=="x" then {privileged:($privileged=="1")} else {} end)')"
  # Without RDF_PROFILE the server picks a profile by kind: RDF_ANDROID=14 RDF_DEVICE_TYPE=tv RDF_FLAVOR=google_play.
  local selector
  selector="$(jq -n --arg android "${RDF_ANDROID:-}" --arg api "${RDF_API:-}" --arg type "${RDF_DEVICE_TYPE:-}" --arg form "${RDF_FORM:-}" --arg flavor "${RDF_FLAVOR:-}" --arg abi "${RDF_ABI:-}" '
    (if $android=="" then {} else {android:$android} end) + (if $api=="" then {} else {api:($api|tonumber)} end)
    + (if $type=="" then {} else {deviceType:$type} end) + (if $form=="" then {} else {form:$form} end)
    + (if $flavor=="" then {} else {flavor:$flavor} end) + (if $abi=="" then {} else {abi:$abi} end)')"
  [[ -n "${RDF_PROFILE:-}" && "$selector" != '{}' ]] && fail 'set RDF_PROFILE or the RDF_ANDROID/RDF_DEVICE_TYPE/... selector, not both'
  payload="$(jq -n --arg profile "${RDF_PROFILE:-}" --argjson selector "$selector" --arg host "${RDF_HOST:-}" --arg runLabel "${RDF_LABEL:-}" --arg key "$adb_key" --arg gpu "$gpu" --arg lease "$lease" --argjson launch "$launch" '
    (if $profile!="" then {profileId:$profile} elif $selector!={} then {profile:$selector} else {profileId:"android-30"} end)
    + (if $host=="" then {} else {hostId:$host} end)
    + (if $runLabel=="" then {} else {label:$runLabel} end)
    + (if $key=="" then {} else {adbKeyId:$key} end)
    + (if $gpu=="" then {} else {gpuMode:$gpu} end)
    + (if $launch=={} then {} else {launchOptions:$launch} end)
    + (if $lease=="" then {} else {leaseTtlSeconds:($lease|tonumber)} end)')"
  key="rdf-$(date +%s)-$$-$RANDOM-$RANDOM"
  STATE="$(jq -n --arg url "$BASE" --arg key "$key" --argjson request "$payload" '{version:2,url:$url,requestKey:$key,request:$request}')"
  save_state
  recover_request || fail "creation is unconfirmed. Use wait or release with RDF_STATE_FILE=$STATE_FILE; do not create another request"
  printf 'queue:%s\n' "$(field .queueId)"
}

start_heartbeat() {
  [ "$MANAGED" = 1 ] && [ -z "$HEARTBEAT_PID" ] || return 0
  local id; id="$(field .sessionId)"; uuid "$id" || return 0
  local parent=$$ interval="${RDF_KEEPALIVE_SECONDS:-30}" ttl="${RDF_LEASE_TTL_SECONDS:-120}"
  seconds RDF_KEEPALIVE_SECONDS "$interval"
  [ "$interval" -lt "$ttl" ] || fail 'keepalive interval must be shorter than lease'
  # Job control gives the heartbeat and its curl children a group on Linux and Git Bash.
  set -m
  (
    set +m
    trap - EXIT INT TERM
    BODY_FILE="$(mktemp)"
    sleeper=''
    trap '[ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true; rm -f -- "$BODY_FILE"' EXIT
    trap 'exit 0' INT TERM
    API_DEADLINE=0
    HTTP_TIMEOUT=$((ttl / 3))
    while true; do
      kill -0 "$parent" 2>/dev/null || exit 0
      sleep "$interval" & sleeper=$!
      wait "$sleeper" || exit 0
      sleeper=''
      kill -0 "$parent" 2>/dev/null || exit 0
      if ! api POST "/api/sessions/$id/keepalive" '{}' || ! expect; then
        printf 'rdf: lease renewal failed; stopping the managed command\n' >&2
        kill -TERM "$parent" 2>/dev/null || true
        exit 1
      fi
    done
  ) &
  HEARTBEAT_PID=$!
  set +m
}
cmd_wait() {
  local limit="${1:-900}" state id queue
  seconds timeout "$limit"; API_DEADLINE=$((SECONDS + limit))
  recover_request || return 1
  queue="$(field .queueId)"
  while [ "$SECONDS" -lt "$API_DEADLINE" ]; do
    if [ -n "$queue" ]; then
      api GET "/api/queue/$queue" || return 1; expect || return 1
      state="$(jq -r '.state // empty' "$BODY_FILE")"
      case "$state" in
        cancelled|expired) fail "request $queue is $state" ;;
        waiting) poll; continue ;;
        assigning|assigned) ;;
        *) fail "unknown queue state: $state" ;;
      esac
      id="$(jq -r '.sessionId // empty' "$BODY_FILE")"
      if ! uuid "$id"; then fail "queue has no active session (startup may have failed); check the session history"; fi
      STATE="$(jq --arg id "$id" '.sessionId=$id' <<<"$STATE")"; save_state
    else id="$(field .sessionId)"; state=assigned; fi
    uuid "$id" || fail "no session: run create first"
    api GET "/api/sessions/$id" || return 1
    if [ "$CODE" = 404 ] && [ "$state" = assigning ]; then poll; continue; fi
    expect || return 1
    start_heartbeat
    state="$(jq -r '.session.state // empty' "$BODY_FILE")"
    case "$state" in
      running) API_DEADLINE=0; printf 'session %s is running\n' "$id"; return 0 ;;
      starting) poll ;;
      *) fail "session ended in state $state" ;;
    esac
  done
  fail "startup timed out after ${limit}s; request retained in $STATE_FILE"
}
active_id() {
  local id; id="$(field .sessionId)"; uuid "$id" || fail 'no allocated session: run wait first'; printf '%s' "$id"
}
cmd_connect() {
  need adb; need_timeout
  local limit="${1:-60}" id host port address remaining output
  seconds timeout "$limit"; API_DEADLINE=$((SECONDS + limit))
  id="$(active_id)"
  api POST "/api/sessions/$id/adb-port-access" '{}' || return 1; expect || return 1
  host="$(jq -r '.host // .access.host // empty' "$BODY_FILE")"; port="$(jq -r '.port // .access.port // empty' "$BODY_FILE")"
  [[ "$host" =~ ^[a-zA-Z0-9.:_-]+$ ]] && [[ "$port" =~ ^[0-9]+$ ]] || fail 'broker returned no valid ADB address'
  address="$host:$port"
  STATE="$(jq --arg address "$address" '.adbAddress=$address' <<<"$STATE")"; save_state
  remaining=$((API_DEADLINE - SECONDS)); [ "$remaining" -gt 0 ] || fail 'ADB connection timed out'
  output="$("$TIMEOUT_TOOL" "${remaining}s" adb connect "$address" 2>&1)" || { printf '%s\n' "$output" >&2; fail 'ADB connect failed or timed out'; }
  printf '%s\n' "$output" >&2
  while [ "$SECONDS" -lt "$API_DEADLINE" ]; do
    remaining=$((API_DEADLINE - SECONDS))
    if output="$("$TIMEOUT_TOOL" "${remaining}s" adb -s "$address" get-state 2>/dev/null)" && [ "${output//$'\r'/}" = device ]; then
      API_DEADLINE=0; printf '%s\n' "$address"; return 0
    fi
    poll
  done
  fail 'ADB authorization timed out. The local private key must match RDF_ADB_KEY_ID (or your account default key).'
}
cmd_logs() {
  local lines="${1:-200}" id; seconds lines "$lines"; [ "$lines" -le 5000 ] || fail 'lines must be 1-5000'
  id="$(active_id)"; api GET "/api/sessions/$id/logcat?lines=$lines" || return 1; expect || return 1
  jq -r '.entries[] | "\(.ts) \(.level)/\(.tag): \(.message)"' "$BODY_FILE"
}
cmd_release() {
  local limit="${1:-180}" queue id state=assigning confirmed=0
  seconds timeout "$limit"; API_DEADLINE=$((SECONDS + limit))
  recover_request || return 1
  queue="$(field .queueId)"; id="$(field .sessionId)"
  if [ -n "$queue" ]; then
    api DELETE "/api/queue/$queue" || return 1
    if [ "$CODE" != 409 ]; then expect || return 1; fi
    while [ "$SECONDS" -lt "$API_DEADLINE" ]; do
      api GET "/api/queue/$queue" || return 1; expect || return 1
      state="$(jq -r '.state // empty' "$BODY_FILE")"
      case "$state" in
        cancelled|expired) id=''; break ;;
        assigned)
          id="$(jq -r '.sessionId // empty' "$BODY_FILE")"
          uuid "$id" || fail 'assigned request has no session id; cleanup cannot be confirmed'
          break ;;
        assigning) poll ;;
        *) fail "queue cancellation is unconfirmed (state: $state)" ;;
      esac
    done
    [ "$state" != assigning ] || fail 'allocation is still in progress; recovery state retained'
    STATE="$(jq --arg id "$id" '.sessionId=$id' <<<"$STATE")"; save_state
  fi
  if [ -n "$id" ]; then
    uuid "$id" || fail 'invalid saved session id'
    # A failed DELETE may still have reached the server. Never discard state until GET confirms removal.
    if api DELETE "/api/sessions/$id"; then
      case "$CODE" in 2??|404|502|503|504) ;; *) expect || return 1 ;; esac
    fi
    while [ "$SECONDS" -lt "$API_DEADLINE" ]; do
      if api GET "/api/sessions/$id"; then
        if [ "$CODE" = 404 ]; then confirmed=1; break; fi
        case "$CODE" in 2??|502|503|504) ;; *) expect || return 1 ;; esac
      fi
      poll
    done
    [ "$confirmed" = 1 ] || fail "cleanup not confirmed within ${limit}s; slot may still be reserved. Keep $STATE_FILE and retry release"
  fi
  rm -f -- "$STATE_FILE"
  STATE='{}'; API_DEADLINE=0
  printf 'request released; cleanup confirmed\n'
}

stop_group() {
  local pid="$1" attempt
  [ -n "$pid" ] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for attempt in 1 2 3 4 5; do
    kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
finish() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  # Both jobs have private process groups; bound shutdown even with a stuck curl.
  stop_group "$COMMAND_PID"
  stop_group "$HEARTBEAT_PID"
  if [ "$MANAGED" = 1 ] && [ -s "$STATE_FILE" ]; then
    (load_state; cmd_release "${RDF_RELEASE_TIMEOUT_SECONDS:-180}") || cleanup_status=$?
    if [ "$cleanup_status" -ne 0 ]; then
      printf 'rdf: cleanup pending. Retry release with RDF_STATE_FILE=%s\n' "$STATE_FILE" >&2
      [ "$status" -ne 0 ] || status="$cleanup_status"
    fi
  fi
  [ -z "$BODY_FILE" ] || rm -f -- "$BODY_FILE"
  # Keep persisted requests for recovery; discard only our unused empty file.
  if [ "$AUTO_STATE" = 1 ] && [ ! -s "$STATE_FILE" ]; then rm -f -- "$STATE_FILE"; fi
  if [ "$LOCKED" = 1 ]; then rm -f -- "$LOCK_DIR/pid"; rmdir -- "$LOCK_DIR"; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Allocate temporary files only after validation and cleanup are installed.
BODY_FILE="$(mktemp)"
if [ "$MODE" = run ] && [ -z "${RDF_STATE_FILE:-}" ]; then
  STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/rdf-session.XXXXXX")"
  AUTO_STATE=1
  printf 'rdf: recovery state: %s\n' "$STATE_FILE" >&2
fi
LOCK_DIR="${STATE_FILE}.lock"
# logs only reads an atomically written state file and may run inside managed run.
[ "$MODE" = logs ] || lock
load_state
case "$MODE" in
  create) cmd_create ;;
  wait) cmd_wait "${2:-900}" ;;
  connect) cmd_connect "${2:-60}" ;;
  logs) cmd_logs "${2:-200}" ;;
  release) cmd_release "${2:-180}" ;;
  run)
    shift; [ "${1:-}" != -- ] || shift
    [ "$#" -gt 0 ] || fail 'usage: rdf.sh run -- COMMAND [ARGUMENTS...]'
    need adb; need_timeout
    [ -z "${RDF_SESSION:-}" ] || fail 'run creates its own session; unset RDF_SESSION'
    [ "$STATE" = '{}' ] || fail "run needs an unused RDF_STATE_FILE; release the saved request first"
    # Validate every managed deadline before allocating anything. In particular,
    # an invalid release timeout must not prevent cleanup after the test command.
    seconds RDF_START_TIMEOUT_SECONDS "${RDF_START_TIMEOUT_SECONDS:-900}"
    seconds RDF_CONNECT_TIMEOUT_SECONDS "${RDF_CONNECT_TIMEOUT_SECONDS:-60}"
    seconds RDF_RELEASE_TIMEOUT_SECONDS "${RDF_RELEASE_TIMEOUT_SECONDS:-180}"
    seconds RDF_KEEPALIVE_SECONDS "${RDF_KEEPALIVE_SECONDS:-30}"
    seconds RDF_LEASE_TTL_SECONDS "${RDF_LEASE_TTL_SECONDS:-120}"
    [ "${RDF_KEEPALIVE_SECONDS:-30}" -lt "${RDF_LEASE_TTL_SECONDS:-120}" ] || fail 'keepalive interval must be shorter than lease'
    MANAGED=1
    export RDF_LEASE_TTL_SECONDS="${RDF_LEASE_TTL_SECONDS:-120}"
    cmd_create >&2
    cmd_wait "${RDF_START_TIMEOUT_SECONDS:-900}" >&2
    cmd_connect "${RDF_CONNECT_TIMEOUT_SECONDS:-60}" >/dev/null
    export RDF_SESSION="$(field .sessionId)" ANDROID_SERIAL="$(field .adbAddress)" RDF_STATE_FILE="$STATE_FILE"
    set -m
    "$@" & COMMAND_PID=$!
    set +m
    result=0; wait "$COMMAND_PID" || result=$?
    exit "$result"
    ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
