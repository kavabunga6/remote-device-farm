#!/bin/sh
# Legacy manual maintenance tool, NOT an approved rental wipe command: restores a USB Android phone to a recorded clean baseline, without a factory reset.
#
#   reset-android.sh <serial>            reset to the baseline (this is what the agent calls)
#   reset-android.sh capture <serial>    record the baseline from a freshly prepared, known-clean phone
#
# Why not a factory reset: a reset drops adb authorization and leaves the phone in the setup wizard, so every rental
# would need hands-on work. Instead this script undoes everything a user can change from the shell and the UI, and
# REFUSES (exit 1, the agent quarantines the phone) when something cannot be undone from adb:
#   - a Google/other account was added           - a screen lock was set
#   - a SIM is inserted (SMS and APN data cannot be cleared safely)
#   - the Android build changed since the baseline (capture again)
# Requirements: Android 11+, adb authorized for this host, no SIM, no screen lock, no accounts you do not want removed.
# Exit codes: 0 clean and verified; 1 not clean or error; 2 no usable baseline.
set -u

ADB="${RDF_ADB:-adb}"
STATE_ROOT="${AGENT_STATE_DIR:-${HOME:-/tmp}/.android/rdf-state}/baselines"
BOOT_TIMEOUT="${RDF_BOOT_TIMEOUT:-240}"
REBOOT_PAUSE="${RDF_REBOOT_PAUSE:-8}"

die() { echo "reset-android: $*" >&2; exit 1; }
log() { echo "reset-android: $*" >&2; }

case "${1:-}" in
  capture) MODE=capture; SERIAL="${2:-}" ;;
  *) MODE=reset; SERIAL="${1:-}" ;;
esac
# The serial comes from the USB device itself: no leading dash, no shell metacharacters.
case "$SERIAL" in ''|-*|*[!A-Za-z0-9._:-]*) die "invalid serial" ;; esac
[ "${#SERIAL}" -le 64 ] || die "invalid serial"
BASE="$STATE_ROOT/$SERIAL"
WORK="$(mktemp -d)" || die "cannot create a work directory"
trap 'rm -rf "$WORK"' EXIT

a() { "$ADB" -s "$SERIAL" "$@"; }
# Device shell command given as ONE string; output without CRs; the device exit status is preserved.
d() { _o=$(a shell "$1"); _s=$?; printf '%s\n' "$_o" | tr -d '\r'; return $_s; }
# Sorted non-empty lines of a device command; fails if the command itself fails.
lines() { _o=$(d "$1") || return 1; printf '%s\n' "$_o" | grep . | LC_ALL=C sort; return 0; }
# Single-quote a value for the device shell.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
valid_name() { case "$1" in ''|*[!A-Za-z0-9_.:@-]*) return 1 ;; esac; }

wait_boot() {
  timeout 180 "$ADB" -s "$SERIAL" wait-for-device || die "device did not come back (is adb authorized?)"
  _i=0
  while [ "$(d 'getprop sys.boot_completed' 2>/dev/null)" != 1 ]; do
    _i=$((_i + 2))
    [ "$_i" -le "$BOOT_TIMEOUT" ] || die "device did not finish booting"
    sleep 2
  done
}

reboot_device() { a reboot || die "reboot failed"; sleep "$REBOOT_PAUSE"; wait_boot; }

# Everything that can differ between a clean and a used phone, as files in $1.
snapshot() {
  _dir=$1; mkdir -p "$_dir" || return 1
  for _ns in global secure system; do lines "settings list $_ns" > "$_dir/settings_$_ns" || { log "cannot list $_ns settings"; return 1; }; done
  lines 'pm list packages' | grep '^package:' > "$_dir/packages"
  lines 'pm list packages -d' | grep '^package:' > "$_dir/packages_disabled"
  lines 'pm list packages -3' | grep '^package:' > "$_dir/packages_user"
  _u=$(d 'pm list users') || return 1
  printf '%s\n' "$_u" | sed -n 's/.*UserInfo{\([0-9][0-9]*\):.*/\1/p' | LC_ALL=C sort > "$_dir/users"
  lines 'cmd wifi list-networks' > "$_dir/wifi" || { log "saved Wi-Fi networks cannot be listed (Android 11+ required)"; return 1; }
  _acc=$(d 'dumpsys account') || return 1
  printf '%s\n' "$_acc" | sed -n 's/^ *Accounts: \([0-9][0-9]*\).*/\1/p' | head -1 > "$_dir/accounts"
  [ -s "$_dir/accounts" ] || { log "cannot read the account count"; return 1; }
  d 'getprop ro.build.fingerprint' > "$_dir/fingerprint" || return 1
  d 'ls -A /sdcard' | grep . | LC_ALL=C sort > "$_dir/sdcard"
  return 0
}

# Conditions no baseline restore can fix. Returns non-zero with a reason on stderr.
check_hard_limits() {
  [ "$(d 'locksettings get-disabled' | tail -1)" = true ] || { log "a screen lock is set or cannot be read; it hides data and cannot be removed without the PIN"; return 1; }
  _sim=$(d 'getprop gsm.sim.state' | tr ',' ' ')
  for _t in $_sim; do
    case "$_t" in ABSENT|NOT_READY|UNKNOWN) ;; *) log "a SIM card is present ($_t); SMS and APN data cannot be cleared safely"; return 1 ;; esac
  done
  for _p in persist.adb.tcp.port service.adb.tcp.port; do
    _v=$(d "getprop $_p" | tail -1)
    case "$_v" in ''|-1|0) ;; *) log "adb over TCP is enabled ($_p=$_v)"; return 1 ;; esac
  done
  return 0
}

if [ "$MODE" = capture ]; then
  wait_boot
  check_hard_limits || exit 1
  [ -z "$(d 'ls -A /data/local/tmp' | grep .)" ] || die "/data/local/tmp must be empty when capturing the baseline"
  [ -z "$(d 'ls -A /sdcard' | grep -vx Android | grep .)" ] || die "/sdcard must contain only Android/ when capturing the baseline"
  snapshot "$WORK/first" || die "snapshot failed"
  log "rebooting once to learn which settings change on their own"
  reboot_device
  snapshot "$WORK/second" || die "snapshot failed"
  # Settings whose value differs between two boots of an untouched phone (boot counters, timestamps) are ignored.
  : > "$WORK/ignore"
  for _ns in global secure system; do
    comm -3 "$WORK/first/settings_$_ns" "$WORK/second/settings_$_ns" | sed 's/^[[:space:]]*//; s/=.*//' | LC_ALL=C sort -u | sed "s/^/$_ns /" >> "$WORK/ignore"
  done
  mkdir -p "$STATE_ROOT" || die "cannot create $STATE_ROOT"
  rm -rf "$BASE.new"
  mkdir -p "$BASE.new" && cp "$WORK/second"/* "$BASE.new/" && cp "$WORK/ignore" "$BASE.new/ignore" || die "cannot store the baseline"
  rm -rf "$BASE"; mv "$BASE.new" "$BASE" || die "cannot store the baseline"
  log "baseline stored in $BASE"
  exit 0
fi

# ---- reset ---------------------------------------------------------------------------------------------------------
[ -s "$BASE/fingerprint" ] && [ -s "$BASE/packages" ] || { log "no baseline for $SERIAL: run '$0 capture $SERIAL' on a clean phone"; exit 2; }
wait_boot
[ "$(d 'getprop ro.build.fingerprint')" = "$(cat "$BASE/fingerprint")" ] || { log "Android build changed since the baseline; capture it again"; exit 2; }
check_hard_limits || exit 1

ignored() { grep -qxF "$1 $2" "$BASE/ignore" 2>/dev/null; }

# 1. Remove what the user installed, then reboot: this stops every process the user started from the shell or apps.
snapshot "$WORK/cur" || die "snapshot failed"
for _p in $(comm -13 "$BASE/packages" "$WORK/cur/packages" | sed 's/^package://'); do
  valid_name "$_p" || die "unexpected package name on the device"
  d "pm uninstall $_p" >/dev/null || log "could not uninstall $_p (will be re-checked)"
done
a forward --remove-all >/dev/null 2>&1; a reverse --remove-all >/dev/null 2>&1
reboot_device

# 2. Settings: delete added keys, restore changed or removed ones.
for _ns in global secure system; do
  lines "settings list $_ns" > "$WORK/now_$_ns" || die "cannot list $_ns settings"
  sed 's/=.*//' "$BASE/settings_$_ns" | LC_ALL=C sort -u > "$WORK/bk_$_ns"
  sed 's/=.*//' "$WORK/now_$_ns" | LC_ALL=C sort -u > "$WORK/ck_$_ns"
  for _k in $(comm -13 "$WORK/bk_$_ns" "$WORK/ck_$_ns"); do
    ignored "$_ns" "$_k" && continue
    valid_name "$_k" || die "unexpected $_ns setting name on the device"
    d "settings delete $_ns $_k" >/dev/null || die "cannot delete $_ns setting $_k"
  done
  comm -23 "$BASE/settings_$_ns" "$WORK/now_$_ns" | while IFS= read -r _line; do
    case "$_line" in *=*) ;; *) continue ;; esac
    _k=${_line%%=*}; _v=${_line#*=}
    ignored "$_ns" "$_k" && continue
    valid_name "$_k" || exit 3
    d "settings put $_ns $_k $(sq "$_v")" >/dev/null || exit 4
  done
  _rc=$?; [ "$_rc" -eq 0 ] || die "cannot restore $_ns settings (status $_rc)"
done

# 3. Packages: put back removed ones, restore enabled/disabled state, reset permissions and app ops.
snapshot "$WORK/cur" || die "snapshot failed"
for _p in $(comm -23 "$BASE/packages" "$WORK/cur/packages" | sed 's/^package://'); do
  valid_name "$_p" || die "unexpected package name in the baseline"
  d "pm install-existing --user 0 $_p" >/dev/null || die "cannot restore package $_p"
done
for _p in $(comm -13 "$BASE/packages" "$WORK/cur/packages" | sed 's/^package://'); do
  valid_name "$_p" || die "unexpected package name on the device"
  d "pm uninstall $_p" >/dev/null || die "cannot remove package $_p"
done
for _p in $(comm -13 "$BASE/packages_disabled" "$WORK/cur/packages_disabled" | sed 's/^package://'); do
  valid_name "$_p" && d "pm enable $_p" >/dev/null
done
for _p in $(comm -23 "$BASE/packages_disabled" "$WORK/cur/packages_disabled" | sed 's/^package://'); do
  valid_name "$_p" && d "pm disable-user --user 0 $_p" >/dev/null
done
d 'pm reset-permissions' >/dev/null 2>&1; d 'appops reset --user 0' >/dev/null 2>&1

# 4. App data: clear everything except the few packages the phone cannot run without or whose data holds
#    configuration the farm needs (settings and telephony providers, system UI, the shell).
SKIP='^(android|com\.android\.shell|com\.android\.systemui|com\.android\.providers\.settings|com\.android\.providers\.telephony|com\.android\.phone|com\.android\.server\.telecom)$'
lines 'pm list packages' | sed 's/^package://' | grep -Ev "$SKIP" | while IFS= read -r _p; do
  valid_name "$_p" || continue
  d "pm clear $_p" >/dev/null 2>&1
done

# 5. Files: shared storage (everything but Android/, whose app folders are emptied), /data/local/tmp, hidden files too.
d "find /sdcard -mindepth 1 -maxdepth 1 ! -name Android -exec rm -rf {} +" >/dev/null || die "cannot clean /sdcard"
d "rm -rf /sdcard/Android/data/* /sdcard/Android/media/* /sdcard/Android/obb/*" >/dev/null 2>&1
d "find /data/local/tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +" >/dev/null || die "cannot clean /data/local/tmp"

# 6. Saved Wi-Fi networks added by the user; secondary users.
lines 'cmd wifi list-networks' > "$WORK/wifi_now" || die "cannot list Wi-Fi networks"
comm -13 "$BASE/wifi" "$WORK/wifi_now" | while IFS= read -r _line; do
  _id=$(printf '%s' "$_line" | awk '{print $1}')
  case "$_id" in ''|*[!0-9]*) continue ;; esac
  d "cmd wifi forget-network $_id" >/dev/null || exit 1
done
[ $? -eq 0 ] || die "cannot forget a saved Wi-Fi network"
_u=$(d 'pm list users') || die "cannot list users"
for _id in $(printf '%s\n' "$_u" | sed -n 's/.*UserInfo{\([0-9][0-9]*\):.*/\1/p' | LC_ALL=C sort | comm -13 "$BASE/users" -); do
  d "pm remove-user $_id" >/dev/null || die "cannot remove user $_id"
done

d 'input keyevent 3' >/dev/null 2>&1; d 'logcat -b all -c' >/dev/null 2>&1

# 7. Verify: the phone must now match the baseline, nothing is assumed.
check_hard_limits || exit 1
snapshot "$WORK/final" || die "final snapshot failed"
[ "$(cat "$WORK/final/accounts")" = "$(cat "$BASE/accounts")" ] || die "$(cat "$WORK/final/accounts") account(s) on the device, baseline has $(cat "$BASE/accounts"); remove them by hand"
for _f in packages packages_disabled packages_user users wifi sdcard; do
  cmp -s "$BASE/$_f" "$WORK/final/$_f" || die "verification failed: $_f differs from the baseline"
done
for _ns in global secure system; do
  while IFS= read -r _line; do
    case "$_line" in *=*) ;; *) continue ;; esac
    ignored "$_ns" "${_line%%=*}" || printf '%s\n' "$_line"
  done < "$WORK/final/settings_$_ns" > "$WORK/f_$_ns"
  while IFS= read -r _line; do
    case "$_line" in *=*) ;; *) continue ;; esac
    ignored "$_ns" "${_line%%=*}" || printf '%s\n' "$_line"
  done < "$BASE/settings_$_ns" > "$WORK/b_$_ns"
  cmp -s "$WORK/b_$_ns" "$WORK/f_$_ns" || die "verification failed: $_ns settings differ from the baseline"
done
[ -z "$(d 'ls -A /data/local/tmp' | grep .)" ] || die "verification failed: /data/local/tmp is not empty"
log "phone $SERIAL restored to its baseline"
exit 0
