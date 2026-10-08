#!/usr/bin/env bash
# Executed only in a disposable, isolated validation container. Uses this
# image's official SDK tools, with two private ADB servers and fresh keys.
set -Eeuo pipefail
umask 077
work=$(mktemp -d /tmp/rdf-image-check.XXXXXX)
launcher_pid=; farm_pid=; stranger_pid=
cleanup() {
  trap - EXIT TERM INT
  for pid in "$launcher_pid" "$farm_pid" "$stranger_pid"; do
    [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 143' TERM INT
fail() {
  echo "ERROR | image.validation: $*" >&2
  [[ ! -f "$work/emulator.log" ]] || tail -n 80 "$work/emulator.log" >&2
  exit 64
}
adb_bin=/opt/android/platform-tools/adb
[[ -x "$adb_bin" && -x /usr/local/bin/rdf-emulator ]] || fail 'image does not implement the farm emulator contract'
for role in farm stranger; do
  mkdir -p "$work/$role/.android"
  env HOME="$work/$role" ANDROID_USER_HOME="$work/$role/.android" "$adb_bin" keygen "$work/$role/.android/adbkey" >/dev/null
  env HOME="$work/$role" ANDROID_USER_HOME="$work/$role/.android" ADB_VENDOR_KEYS="$work/$role/.android/adbkey" \
    ADB_MDNS_AUTO_CONNECT=0 ADB_LOCAL_TRANSPORT_MAX_PORT=0 \
    "$adb_bin" -L "localfilesystem:$work/$role/server.sock" --one-device "rdf-image-check-$role" server nodaemon >"$work/$role/server.log" 2>&1 &
  if [[ "$role" == farm ]]; then farm_pid=$!; else stranger_pid=$!; fi
  for ((n=0;n<100;n++)); do [[ ! -S "$work/$role/server.sock" ]] || break; sleep .05; done
  [[ -S "$work/$role/server.sock" ]] || fail 'isolated ADB server did not start'
done
adb_call() {
  local role=$1; shift
  env HOME="$work/$role" ANDROID_USER_HOME="$work/$role/.android" ADB_VENDOR_KEYS="$work/$role/.android/adbkey" \
    ADB_MDNS_AUTO_CONNECT=0 ADB_LOCAL_TRANSPORT_MAX_PORT=0 \
    timeout --kill-after=1s 5s "$adb_bin" -L "localfilesystem:$work/$role/server.sock" "$@"
}
export ADBKEY_PUB; ADBKEY_PUB=$(cat "$work/farm/.android/adbkey.pub")
/usr/local/bin/rdf-emulator >"$work/emulator.log" 2>&1 & launcher_pid=$!
address=$(ip -4 -o addr show dev eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n 1)
[[ -n "$address" ]] || fail 'isolated management address is missing'
transport="$address:5555"
began=$SECONDS; ready=0
while (( SECONDS-began < 600 )); do
  kill -0 "$launcher_pid" 2>/dev/null || fail 'emulator stopped before Android finished booting'
  adb_call farm connect "$transport" >/dev/null 2>&1 || true
  boot=$(adb_call farm -s "$transport" shell getprop sys.boot_completed 2>/dev/null || true)
  if [[ "${boot//$'\r'/}" == 1 ]]; then ready=1; break; fi
  sleep 2
done
(( ready == 1 )) || fail 'Android did not finish booting within 10 minutes'
secure=$(adb_call farm -s "$transport" shell getprop ro.adb.secure)
[[ "${secure//$'\r'/}" == 1 ]] || fail 'ro.adb.secure must be 1'
# Test the exposed transport independently of the launcher's internal gate.
timeout --kill-after=1s 5s /usr/local/bin/rdf-adb-auth-gate --probe 5557 || fail 'management ADB does not require authentication'
present=$(adb_call farm -s "$transport" shell cat /sys/devices/system/cpu/present)
expected=0; (( RDF_CORES == 1 )) || expected="0-$((RDF_CORES-1))"
[[ "${present//$'\r'/}" == "$expected" ]] || fail 'guest CPU allocation differs from the requested cores'
meminfo=$(adb_call farm -s "$transport" shell cat /proc/meminfo)
[[ "$meminfo" =~ MemTotal:[[:space:]]+([0-9]+) ]] || fail 'Android MemTotal is unavailable'
memory_kb=${BASH_REMATCH[1]}; requested_kb=$((RDF_RAM_MB*1024))
(( memory_kb >= requested_kb*8/10 && memory_kb <= requested_kb )) || fail 'guest memory allocation differs from the requested RAM'
renderer=$(adb_call farm -s "$transport" shell dumpsys SurfaceFlinger | grep 'GLES:' | head -n 1) || fail 'Android renderer information is unavailable'
case "${RDF_GPU:-off}" in
  off) grep -qi swiftshader <<<"$renderer" || fail 'software renderer is not SwiftShader' ;;
  nvidia) grep -qi NVIDIA <<<"$renderer" || fail 'NVIDIA renderer is not active'; ! grep -Eqi 'swiftshader|llvmpipe|softpipe' <<<"$renderer" || fail 'GPU fell back to software' ;;
  dri) grep -Eqi 'Intel|AMD|Radeon|NVIDIA|Mali|Adreno|Vivante|VideoCore' <<<"$renderer" || fail 'hardware renderer is not active'; ! grep -Eqi 'swiftshader|llvmpipe|softpipe' <<<"$renderer" || fail 'GPU fell back to software' ;;
esac
if [[ -n "${RDF_SCREEN:-}" ]]; then
  size=$(adb_call farm -s "$transport" shell wm size)
  grep -Fq "Physical size: $RDF_SCREEN" <<<"$size" || fail 'Android screen size differs from the generated profile'
fi
features=$(adb_call farm -s "$transport" shell pm list features)
case "${RDF_DEVICE:-phone}" in
  tv) grep -Eq 'android.hardware.type.television|android.software.leanback' <<<"$features" || fail 'system image is not Android TV' ;;
  automotive) grep -q 'android.hardware.type.automotive' <<<"$features" || fail 'system image is not Android Automotive' ;;
  wear) grep -q 'android.hardware.type.watch' <<<"$features" || fail 'system image is not Wear OS' ;;
esac
# The SDK must not launch its own host adb, generate a different identity, or
# ask the user to approve that identity. Check before our deliberate bad-key test.
[[ ! -f /android-home/.android/adbkey ]] || fail 'internal SDK adb generated an untrusted private key'
foreground=$(adb_call farm -s "$transport" shell dumpsys activity activities)
! grep -Eq '(mResumedActivity|topResumedActivity).*UsbDebuggingActivity' <<<"$foreground" || fail 'USB debugging confirmation is visible at startup'
adb_call stranger connect "$transport" >/dev/null 2>&1 || true
unauthorized=0
for ((n=0;n<20;n++)); do
  devices=$(adb_call stranger devices)
  if grep -Eq "^${transport//./\\.}[[:space:]]+device([[:space:]]|$)" <<<"$devices"; then fail 'untrusted ADB key received device access'; fi
  if grep -Eq "^${transport//./\\.}[[:space:]]+unauthorized([[:space:]]|$)" <<<"$devices"; then unauthorized=1; break; fi
  sleep .5
done
(( unauthorized == 1 )) || fail 'untrusted ADB client did not report unauthorized'
printf 'RDF_VALIDATION {"version":1,"bootCompleted":true,"adbSecure":true,"adbPromptFree":true,"unauthorizedAdb":true,"rendererVerified":true,"deviceVerified":true,"resourcesVerified":true,"bootSeconds":%s}\n' "$((SECONDS-began))"
