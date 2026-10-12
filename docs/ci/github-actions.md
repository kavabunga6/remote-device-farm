# GitHub Actions

[CI integrations](README.md) · [Worker requirements](native-packages.md)

The repository root is a JavaScript Action. It bundles the shared lifecycle scripts and records the run directory before allocating a device. Its `post` hook runs with `always()` and retries pending release.

## Workflow

Use a prepared Linux runner with an isolated ADB environment. Store the API token as `RDF_TOKEN` and provide the matching private key as a protected file. The example assumes `/run/ci-secrets/adbkey` was provisioned outside the repository.

```yaml
name: Android tests
on: [workflow_dispatch]
permissions:
  contents: read
jobs:
  android:
    runs-on: [self-hosted, linux, android]
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - name: Device tests
        id: device
        uses: kavabunga6/remote-device-farm@REPLACE_WITH_COMMIT_SHA
        with:
          url: https://farm.example.com
          profile: android-30
          adb-key-id: 33333333-3333-4333-8333-333333333333
          adb-key-file: /run/ci-secrets/adbkey
          prepare-script: ci/build.sh
          test-script: ci/android-tests.sh
        env:
          RDF_TOKEN: ${{ secrets.RDF_TOKEN }}
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        if: always()
        with:
          name: android-device-results
          path: rdf-artifacts/
          retention-days: 7
```

Pin the Action to a reviewed full commit SHA. Hosted runners also need Android tools, private-key provisioning and a job-owned ADB home. Configure cancellation grace and artifact access for application data.

The `artifacts-directory` output identifies the UUID run directory. Upload the parent directory with `always()`; this preserves pending recovery evidence even when tests fail. JUnit XML is included as an artifact; a separate test-report renderer can be configured by the application.

**Verification:** native entry points, input/state/output mapping, CLI execution, failures and post recovery tested locally with modeled API/ADB. A live workflow using the Action and cancellation on a GitHub runner are **Not tested**.
