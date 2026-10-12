#!/usr/bin/env bash
# Reconcile a managed CI run after its shell has stopped.
set +x
set -euo pipefail
umask 077
: "${RDF_ARTIFACT_DIR:?set RDF_ARTIFACT_DIR}"
[ -d "$RDF_ARTIFACT_DIR" ] || exit 0
export RDF_ARTIFACT_DIR="$(cd -P -- "$RDF_ARTIFACT_DIR" && pwd)"
export RDF_STATE_FILE="$RDF_ARTIFACT_DIR/session.json"
finish() {
  local status=$?
  trap - EXIT INT TERM
  if [ -f "$RDF_ARTIFACT_DIR/adb-owner.json" ]; then
    if ! env -u RDF_TOKEN python3 - "$RDF_ARTIFACT_DIR" <<'PY'
import json,os,pathlib,re,signal,stat,sys,time
artifacts=pathlib.Path(sys.argv[1]).resolve()
owner=json.loads((artifacts/'adb-owner.json').read_text())
root=pathlib.Path(owner['directory'])
if not root.is_absolute() or not re.fullmatch(r'rdf-adb\.[A-Za-z0-9]{8}',root.name):
    raise RuntimeError('Invalid private ADB directory')
report={'pid':owner.get('pid',0),'port':owner.get('port',0),'serverExited':False,'privateKeyRemoved':False}
def owned(pid):
    try:
        p=pathlib.Path('/proc')/str(pid)
        if (p/'stat').read_text().split(') ',1)[1].startswith('Z'):return False
        if (p/'comm').read_text().strip()!='adb':return False
        variables=dict(v.split(b'=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
        return variables.get(b'ANDROID_USER_HOME')==str(root/'.android').encode() and variables.get(b'ADB_VENDOR_KEYS')==str(root/'.android/adbkey').encode()
    except (OSError,ValueError):return False
if root.exists() or root.is_symlink():
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700 or root.resolve()!=root:
        raise RuntimeError('Private ADB directory ownership cannot be verified')
    marker=root/'.rdf-owner'
    if marker.is_symlink() or not marker.is_file() or marker.read_text()!=str(artifacts):
        raise RuntimeError('Private ADB ownership marker does not match')
    android=root/'.android'
    if android.is_symlink() or not android.is_dir():
        raise RuntimeError('Invalid private Android directory')
    pids=[int(p.name) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and owned(int(p.name))]
    for pid in pids:
        if owned(pid):
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
    deadline=time.monotonic()+5
    while any(owned(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(0.1)
    for pid in pids:
        if owned(pid):
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
    deadline=time.monotonic()+2
    while any(owned(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(0.1)
    if any(owned(pid) for pid in pids):raise RuntimeError('Private ADB server did not stop')
    for name in ['adbkey','adbkey.pub']:
        f=android/name
        if f.is_symlink() or (f.exists() and not f.is_file()):raise RuntimeError('Invalid private ADB file')
        f.unlink(missing_ok=True)
    android.rmdir();marker.unlink();root.rmdir()
report.update(serverExited=True,privateKeyRemoved=True)
temporary=artifacts/'adb-runtime.json.tmp'
temporary.write_text(json.dumps(report));temporary.replace(artifacts/'adb-runtime.json')
PY
    then
      echo 'Private ADB cleanup failed; retain ownership evidence' >&2
      [[ "$status" -ne 0 ]] || status=1
    fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ -z "${RDF_ENV_SCRIPT:-}" ] || source "$RDF_ENV_SCRIPT"
[ -z "${RDF_CA_FILE:-}" ] || export CURL_CA_BUNDLE="$RDF_CA_FILE"
if [ -e "$RDF_STATE_FILE.lock" ]; then
  [[ -d "$RDF_STATE_FILE.lock" && ! -L "$RDF_STATE_FILE.lock" && -f "$RDF_STATE_FILE.lock/pid" && ! -L "$RDF_STATE_FILE.lock/pid" ]] || exit 2
  pid="$(cat "$RDF_STATE_FILE.lock/pid")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || exit 2
  for attempt in {1..30}; do
    kill -0 "$pid" 2>/dev/null || break
    [[ "$(ps -o stat= -p "$pid" 2>/dev/null || true)" != Z* ]] || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null && [[ "$(ps -o stat= -p "$pid" 2>/dev/null || true)" != Z* ]]; then
    echo 'Saved request is still owned by a running process; recovery state retained' >&2; exit 2
  fi
  # Only the PID file of this run's confirmed stale lock is removed.
  rm -f -- "$RDF_STATE_FILE.lock/pid"
  rmdir -- "$RDF_STATE_FILE.lock"
fi
if [ -e "$RDF_STATE_FILE" ]; then
  [[ -f "$RDF_STATE_FILE" && ! -L "$RDF_STATE_FILE" ]] || exit 2
  bash "${RDF_CLI_SCRIPT:?set RDF_CLI_SCRIPT}" release "${RDF_RELEASE_TIMEOUT_SECONDS:-180}" >> "$RDF_ARTIFACT_DIR/farm.log" 2>&1
fi
if [ -f "$RDF_ARTIFACT_DIR/farm.log" ]; then
  released=false
  if grep -qx 'request released; cleanup confirmed' "$RDF_ARTIFACT_DIR/farm.log" && [[ ! -e "$RDF_STATE_FILE" && ! -e "$RDF_STATE_FILE.lock" ]]; then released=true; fi
  code=1
  if [ -s "$RDF_ARTIFACT_DIR/farm-result.json" ]; then code="$(jq -er '.cliExitCode | select(type=="number")' "$RDF_ARTIFACT_DIR/farm-result.json")"; fi
  jq -n --argjson code "$code" --argjson released "$released" '{cliExitCode:$code,releaseConfirmed:$released}' > "$RDF_ARTIFACT_DIR/farm-result.json.tmp"
  mv -- "$RDF_ARTIFACT_DIR/farm-result.json.tmp" "$RDF_ARTIFACT_DIR/farm-result.json"
  [[ "$released" == true ]] || { echo 'Device release remains unconfirmed' >&2; exit 1; }
fi
