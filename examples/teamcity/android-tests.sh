#!/usr/bin/env bash
# Copy to ci/android-tests.sh in the Android application repository.
set +x
set -euo pipefail
: "${ANDROID_SERIAL:?run this script through ci/rdf.sh run}"
: "${RDF_ARTIFACT_DIR:?set a build-specific artifact directory}"
mkdir -p "$RDF_ARTIFACT_DIR"

collect_logs() {
  local result=$?
  trap - EXIT
  bash ci/rdf.sh logs 2000 > "$RDF_ARTIFACT_DIR/logcat.txt" \
    2> "$RDF_ARTIFACT_DIR/logcat-errors.txt" || true
  exit "$result"
}
trap collect_logs EXIT

# Leave time for log collection and the CLI's confirmed release before the CI timeout.
env -u RDF_TOKEN timeout --signal=TERM --kill-after=30s 20m \
  ./gradlew connectedDebugAndroidTest --no-daemon
