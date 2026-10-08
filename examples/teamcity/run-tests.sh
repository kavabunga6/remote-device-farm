#!/usr/bin/env bash
# Copy to ci/teamcity-tests.sh; execute from the application repository root.
set +x
set -euo pipefail
: "${RDF_URL:?set env.RDF_URL in TeamCity}"
: "${RDF_TOKEN:?set the Password parameter env.RDF_TOKEN in TeamCity}"
: "${RDF_PROFILE:?set env.RDF_PROFILE in TeamCity}"
: "${RDF_ADB_KEY_ID:?set env.RDF_ADB_KEY_ID in TeamCity}"
: "${RDF_CI_BUILD_ID:?map env.RDF_CI_BUILD_ID to TeamCity system.teamcity.build.id}"
[[ "$RDF_CI_BUILD_ID" =~ ^[0-9]+$ ]] || { echo 'RDF_CI_BUILD_ID must be numeric' >&2; exit 2; }

export RDF_ARTIFACT_DIR="$PWD/rdf-artifacts/$RDF_CI_BUILD_ID"
export RDF_STATE_FILE="$RDF_ARTIFACT_DIR/session.json"
export RDF_LABEL="teamcity-$RDF_CI_BUILD_ID"
export RDF_START_TIMEOUT_SECONDS="${RDF_START_TIMEOUT_SECONDS:-900}"
export RDF_CONNECT_TIMEOUT_SECONDS="${RDF_CONNECT_TIMEOUT_SECONDS:-60}"
export RDF_RELEASE_TIMEOUT_SECONDS="${RDF_RELEASE_TIMEOUT_SECONDS:-180}"

for tool in adb curl jq timeout java tee; do command -v "$tool" >/dev/null; done
if [ -e "$RDF_STATE_FILE" ] || [ -d "$RDF_STATE_FILE.lock" ]; then
  echo "Saved RDF state exists: $RDF_STATE_FILE; release it before retrying this build" >&2
  exit 1
fi
mkdir -p "$RDF_ARTIFACT_DIR"
# Build before acquiring a device; clean removes reports from an earlier build.
env -u RDF_TOKEN ./gradlew clean assembleDebug assembleDebugAndroidTest --no-daemon 2>&1 | tee "$RDF_ARTIFACT_DIR/build.log"
bash ci/rdf.sh run -- bash ci/android-tests.sh 2>&1 | tee "$RDF_ARTIFACT_DIR/rdf-run.log"
