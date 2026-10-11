# CI packages

The packages use the shared [CLI](../scripts/rdf.sh) for queue allocation, ADB connection, lease renewal and confirmed release.

| Package | Entry point | Guide |
| --- | --- | --- |
| GitLab CI Component | [templates/device-farm.yml](../templates/device-farm.yml) | [GitLab component](../docs/ci/gitlab-component.md) |
| Jenkins Shared Library | [vars/deviceFarm.groovy](../vars/deviceFarm.groovy) | [Jenkins library](../docs/ci/jenkins-library.md) |
| Gradle plugin | [integrations/gradle](gradle/) | [Gradle](../docs/ci/gradle.md) |

Tests run on the CI runner. Use a separate ADB environment for each concurrent job. API tokens belong in CI secrets; the test process receives the device address without the API token.

Local contract tests use simulated API and ADB responses. Live GitLab/Jenkins acceptance and Android Gradle Plugin instrumentation remain **Not tested**. Packages are available from source; external catalogs and the Gradle Plugin Portal have no published release.

## Maintainer checks

Use Node.js 24, JDK 17+, Bash, jq and GNU timeout:

```bash
node scripts/sync-ci-resources.mjs --check
node scripts/check-integrations.mjs
integrations/gradle/gradlew -p integrations/gradle check
```

After changing the CLI or shared runner, regenerate Jenkins resources with `node scripts/sync-ci-resources.mjs`. Update the immutable source revision and SHA256 values in the GitLab component to match the committed scripts. The Gradle JAR includes the scripts during `processResources`; it does not download executable code at runtime.
