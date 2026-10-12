# CI worker requirements

[CI integrations](README.md)

Tests execute on the CI worker. The service supplies a device and an ADB endpoint; it does not execute the project's Gradle, Maestro or Appium commands.

## Worker and credentials

Use a Linux worker with Bash, curl, jq, GNU timeout, Python 3, ADB and Node.js 24 for the Orb/Pipe. GitHub and Azure provide their Action/task Node handler. TeamCity requires 2024.12+ and JDK 17 for building the plugin. Install the application SDK, JDK and test tools before allocating a device.

Configure:

| Option | Purpose |
| --- | --- |
| `url`, `profile`, `adbKeyId` | Reachable HTTPS URL, enabled profile ID and public ADB key UUID |
| `testScript` | Relative Bash script, default `ci/android-tests.sh` |
| `prepareScript` | Optional build script, executed before device allocation |
| `environmentScript` | Optional SDK/tool environment script |
| `tokenVariable` | Name of a protected environment variable, default `RDF_TOKEN` |
| `adbKeyFile` | Protected private key matching the selected public key |
| `caFile` | Optional trusted PEM certificate bundle |
| `artifactsDirectory` | Relative output parent; each run gets a UUID directory |
| `startTimeoutSeconds`, `testTimeoutSeconds` | Defaults 900/1200; valid range 1–86400 seconds |
| `junitReport` | Relative XML glob; fresh matching reports are collected after tests |

Action/Orb names use kebab-case. Azure and TeamCity use camelCase. The Pipe uses `RDF_*` variables.

For a supplied private key, the runtime starts an owned ADB server on a separate loopback port and stores its private files outside artifacts. A pre-existing `$HOME/.android/adbkey` is required to avoid ADB creating shared keys. Initialize it only in a job-owned worker home; never overwrite another worker's key. The Pipe creates its own temporary home. Without `adbKeyFile`, use an already isolated and correctly configured ADB environment.

Store private keys and certificates in CI secret files. Never include private keys in a repository, artifact path or cache. Only trusted application scripts may run with CI credentials. The test and preparation commands have the configured API token removed; unrelated CI credentials remain subject to the CI provider's access policy.

`RDF_RELEASE_TIMEOUT_SECONDS` defaults to 180. Configure enough job cancellation grace for release and final cleanup. Hard termination or worker loss can prevent a post hook from executing; server lease expiration requests device cleanup. The slot remains unavailable until cleanup is confirmed.

## Project scripts

```bash
# ci/build.sh
set -euo pipefail
./gradlew assembleDebug assembleDebugAndroidTest --no-daemon
```

```bash
# ci/android-tests.sh
set -euo pipefail
: "${ANDROID_SERIAL:?device is not connected}"
./gradlew connectedDebugAndroidTest --no-daemon
```

Use the correct tasks for the application. `ANDROID_SERIAL` and the private ADB socket/port are supplied to tests. Additional device settings use the [CLI environment variables](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска).

## Artifacts and recovery

Run directories contain test/farm logs, Logcat, a screenshot, fresh JUnit XML, `farm-result.json` and ADB cleanup status. They can contain application data; restrict CI artifact access and retention. A pending `session.json` is recovery evidence. It is not a new allocation.

Normal completion and failure perform cleanup. GitHub, Azure and TeamCity also have controller finalization; CircleCI uses an always-running step and Bitbucket supports `after-script` recovery. These hooks preserve test failure and retry release for the original account. Fresh secret-file paths may be supplied to Pipe recovery.

For Orb/Pipe recovery, keep the original workspace and output parent, restore the same account token and TLS trust, and run the package's recovery step. Do not reuse a workspace with a pending request. For manual CLI recovery:

```bash
export RDF_STATE_FILE="$PWD/rdf-artifacts/RUN_UUID/session.json"
bash scripts/rdf.sh release 180
```

Keep recovery evidence until device and private ADB cleanup are confirmed. [Recovery details](../api/README.md#если-запрос-или-освобождение-прервались).
