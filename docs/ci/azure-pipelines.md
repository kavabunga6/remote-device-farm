# Azure Pipelines task

[CI integrations](README.md) · [Worker requirements](native-packages.md)

The extension supplies `RemoteDeviceFarm@0` with a Node.js 24 handler and post-job recovery. The VSIX contains the runtime; the task does not download scripts during a build.

## Package and install

```bash
npm ci --prefix integrations/azure-pipelines --ignore-scripts
RDF_AZURE_PUBLISHER=your-publisher node scripts/package-native-ci.mjs azure
```

The VSIX is written to `integrations/azure-pipelines/build/distributions/`. Use an organization-owned publisher and upload/install the extension through the organization's extension management process. The default publisher name is a packaging placeholder. No Marketplace listing is published.

## Pipeline

Use Azure agent 4.265.1+ on a Linux worker with Android tools and a pre-initialized, job-owned ADB home. Store the token as a secret pipeline variable; use **Secure Files** for the private key and optional trusted TLS bundle.

```yaml
pool:
  name: AndroidLinux
jobs:
  - job: AndroidTests
    timeoutInMinutes: 60
    cancelTimeoutInMinutes: 5
    steps:
      - checkout: self
      - task: DownloadSecureFile@1
        name: adbkey
        inputs:
          secureFile: ci-adbkey
      - task: RemoteDeviceFarm@0
        name: device
        inputs:
          url: https://farm.example.com
          profile: android-30
          adbKeyId: 33333333-3333-4333-8333-333333333333
          adbKeyFile: $(adbkey.secureFilePath)
          prepareScript: ci/build.sh
          testScript: ci/android-tests.sh
        env:
          RDF_TOKEN: $(RDF_TOKEN)
      - task: PublishTestResults@2
        condition: always()
        inputs:
          testResultsFormat: JUnit
          testResultsFiles: rdf-artifacts/**/junit/**/*.xml
          failTaskOnFailedTests: true
      - task: PublishPipelineArtifact@1
        condition: always()
        inputs:
          targetPath: $(Build.SourcesDirectory)/rdf-artifacts
          artifact: device-results
```

The task stores recovery state under a variable keyed by its task instance, so repeated task instances have separate directories. The post-job handler receives the task's secret environment and retries the saved request.

**Verification:** VSIX packaging with the official `tfx` tool, self-contained entry points and input/state contracts tested locally. Organization installation, live secret-file lifecycle, JUnit and cancellation are **Not tested**.
