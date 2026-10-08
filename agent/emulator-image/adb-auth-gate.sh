#!/usr/bin/env bash
# Publish a transport only after the guest requests an ADB signature. No key is
# sent by this probe. Keep all pre-auth traffic on the emulator's loopback port.
set -Eeuo pipefail

fail() { echo "rdf-emulator: ADB authentication gate: $*" >&2; exit 64; }

probe() {
  local port=$1 header token command arg0 arg1 length checksum magic sum=0 byte
  # A refused connection means Android has not started adbd yet.
  { exec 3<>"/dev/tcp/127.0.0.1/$port"; } 2>/dev/null || return 75
  # CNXN(version=0x01000000, maxdata=4096, payload="host::\0"). This
  # version requires the checksum, so validate both the header and AUTH token.
  printf '\103\116\130\116\000\000\000\001\000\020\000\000\007\000\000\000\062\002\000\000\274\261\247\261host::\000' >&3
  read -r -a header <<<"$(dd bs=1 count=24 <&3 2>/dev/null | od -An -v -tu1 | tr '\n' ' ')"
  (( ${#header[@]} == 0 )) && return 75
  (( ${#header[@]} == 24 )) || fail 'truncated ADB response header'
  le32() { local i=$1; REPLY=$((header[i] | header[i+1]<<8 | header[i+2]<<16 | header[i+3]<<24)); }
  le32 0; command=$REPLY; le32 4; arg0=$REPLY; le32 8; arg1=$REPLY
  le32 12; length=$REPLY; le32 16; checksum=$REPLY; le32 20; magic=$REPLY
  (( magic == (command ^ 0xffffffff) )) || fail 'invalid ADB response magic'
  (( command != 0x4e584e43 )) || fail 'adbd accepted a connection without authentication; ro.adb.secure=1 is required'
  (( command == 0x48545541 && arg0 == 1 && arg1 == 0 && length == 20 )) || fail 'expected an ADB AUTH token challenge'
  read -r -a token <<<"$(dd bs=1 count=20 <&3 2>/dev/null | od -An -v -tu1 | tr '\n' ' ')"
  (( ${#token[@]} == 20 )) || fail 'truncated ADB AUTH token'
  for byte in "${token[@]}"; do sum=$((sum + byte)); done
  (( checksum == sum )) || fail 'invalid ADB AUTH token checksum'
}

if [[ "${1:-}" == --probe ]]; then probe "$2"; exit $?; fi

port=${1:-}; seconds=${2:-}
[[ "$port" =~ ^[0-9]+$ && "$seconds" =~ ^[0-9]+$ ]] || fail 'expected internal port and timeout'
(( port >= 1 && port <= 65535 && seconds >= 1 && seconds <= 3600 )) || fail 'invalid port or timeout'
[[ "${3:-}" == -- && $# -ge 4 ]] || fail 'expected the transport command after --'
shift 3

probe_pid=
stop_requested=0
cleanup() {
  trap - EXIT TERM INT
  if [[ -n "$probe_pid" ]]; then
    # GNU timeout owns a separate process group (without --foreground). Signal
    # that group explicitly: killing its leader alone can leave a command
    # substitution's dd/od/tr holding the TCP socket and inherited output pipes.
    # The PID fallback covers termination before timeout establishes its group.
    kill -TERM -- "-$probe_pid" 2>/dev/null || kill -TERM "$probe_pid" 2>/dev/null || true
    for ((attempt=0; attempt<10; attempt++)); do
      kill -0 -- "-$probe_pid" 2>/dev/null || break
      sleep 0.02
    done
    kill -KILL -- "-$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
  fi
}
request_stop() {
  stop_requested=1
  # A signal may arrive between spawning timeout and assigning $!. In that
  # window defer exit until the PID is recorded, so cleanup cannot lose it.
  [[ -z "$probe_pid" ]] || exit 143
}
trap cleanup EXIT
trap request_stop TERM INT

deadline=$((SECONDS + seconds))
while (( SECONDS < deadline )); do
  (( stop_requested == 0 )) || exit 143
  remaining=$((deadline - SECONDS)); (( remaining <= 3 )) || remaining=3
  timeout --signal=TERM --kill-after=1s "${remaining}s" "$BASH" "$0" --probe "$port" & probe_pid=$!
  (( stop_requested == 0 )) || exit 143
  status=0; wait "$probe_pid" || status=$?
  probe_pid=
  if (( status == 0 )); then
    trap 'exit 143' TERM INT
    (( stop_requested == 0 )) || exit 143
    echo 'rdf-emulator: ADB authentication challenge verified; opening management transport'
    trap - EXIT
    exec "$@"
  fi
  case "$status" in
    75|124) ;; # adbd not ready or not yet responding; retry within the deadline
    *) exit "$status" ;; # an insecure or malformed peer is never retried
  esac
  sleep 0.1
done
(( stop_requested == 0 )) || exit 143
fail "timed out after ${seconds}s waiting for an authenticated adbd; management ADB remains closed"
