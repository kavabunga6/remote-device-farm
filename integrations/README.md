# CI packages

Each platform uses its native reusable format. The packages share the [RDF CLI](../scripts/rdf.sh) for queue allocation, ADB access, lease renewal and confirmed release.

| Platform | Package | Guide |
| --- | --- | --- |
| TeamCity | Server/agent build runner ZIP | [TeamCity](../docs/ci/teamcity.md) |
| GitHub Actions | JavaScript Action with an always-running post hook | [GitHub Actions](../docs/ci/github-actions.md) |
| GitLab CI | CI Component | [GitLab](../docs/ci/gitlab-component.md) |
| Jenkins | Shared Library | [Jenkins](../docs/ci/jenkins-library.md) |
| Azure Pipelines | Task extension VSIX with post-job recovery | [Azure Pipelines](../docs/ci/azure-pipelines.md) |
| CircleCI | Orb with bundled runtime, JUnit and artifact steps | [CircleCI](../docs/ci/circleci.md) |
| Bitbucket Pipelines | Docker Pipe | [Bitbucket](../docs/ci/bitbucket-pipelines.md) |
| Gradle | Plugin and Maven marker | [Gradle](../docs/ci/gradle.md) |

API tokens belong in CI secrets. Tests receive the device address without the service token. Concurrent jobs require separate workspaces and ADB environments. [Worker requirements and recovery](../docs/ci/native-packages.md).

Packages are available from source. CI produces TeamCity and Azure installable archives. No public Marketplace, Orb Registry, Docker image or Gradle Plugin Portal release is published. Controller acceptance is listed in [verification](../docs/ci/README.md); local tests do not establish live controller compatibility.

## Maintainer checks

Node.js 24, JDK 17, Bash, curl, jq, Python 3 and GNU timeout are required:

```bash
npm ci --prefix integrations
npm ci --prefix integrations/azure-pipelines --ignore-scripts
node scripts/sync-ci-resources.mjs --check
node scripts/package-native-ci.mjs circleci --check
node scripts/check-integrations.mjs
integrations/gradle/gradlew -p integrations/gradle check
integrations/gradle/gradlew -p integrations/teamcity check assemble
node scripts/package-native-ci.mjs azure
node scripts/package-native-ci.mjs bitbucket
```

After changing shared scripts, run `node scripts/sync-ci-resources.mjs` and `node scripts/package-native-ci.mjs circleci`. Jenkins resource names remain compatible. Gradle, TeamCity, Azure, the Orb and Pipe bundle the scripts; they do not download mutable executable source at run time. The GitLab component retains its independently pinned source revision and SHA256 values.

Build output is ignored by Git. The GitHub CI package artifact includes ZIP, VSIX, Orb YAML and the Pipe build context. `RDF_AZURE_PUBLISHER` selects an organization-owned publisher during VSIX packaging; it does not upload or publish the extension.
