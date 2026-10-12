# Bitbucket Pipelines Pipe

[CI integrations](README.md) · [Worker requirements](native-packages.md)

The Docker Pipe bundles Node.js, JDK 17, ADB and the shared runtime. It connects to a remote device and requires no Docker socket, privileged mode or local emulator. Application-specific SDK/test tools are installed by the project's preparation script.

## Build the Pipe image

```bash
node scripts/package-native-ci.mjs bitbucket
docker build -t registry.example.com/remote-device-farm-pipe:0.1.0 \
  integrations/bitbucket-pipe/build/context
docker push registry.example.com/remote-device-farm-pipe:0.1.0
```

Replace the registry address with an organization-owned registry. Pin the deployed Pipe image by digest after building. No public Pipe image is published.

## Pipeline

Store `RDF_TOKEN`, `RDF_ADB_KEY_BASE64` and optional `RDF_CA_BASE64` as secured variables. The key must match the public UUID. The Pipe decodes secrets into its own temporary home outside checkout/artifacts and removes them on exit.

```yaml
pipelines:
  custom:
    android-tests:
      - step:
          name: Android tests
          max-time: 60
          script:
            - pipe: docker://registry.example.com/remote-device-farm-pipe:0.1.0
              variables: &device
                RDF_URL: https://farm.example.com
                RDF_PROFILE: android-30
                RDF_ADB_KEY_ID: 33333333-3333-4333-8333-333333333333
                RDF_TOKEN: $RDF_TOKEN
                RDF_ADB_KEY_BASE64: $RDF_ADB_KEY_BASE64
                RDF_PREPARE_SCRIPT: ci/build.sh
                RDF_TEST_SCRIPT: ci/android-tests.sh
          after-script:
            - pipe: docker://registry.example.com/remote-device-farm-pipe:0.1.0
              variables:
                <<: *device
                RDF_OPERATION: recover
          artifacts:
            upload:
              - name: device-results
                type: shared
                paths: ["rdf-artifacts/**"]
                capture-on: always
              - name: device-tests
                type: test-reports
                paths: ["rdf-artifacts/**/junit/**/*.xml"]
```

The default operation is `run`. `recover` uses the original checkout's `ci-state.json` and the same account. Supply the trusted certificate again for recovery if a private CA is used. The test result remains nonzero when tests or cleanup fail; `after-script` does not replace that result.

Fresh JUnit files are copied into `rdf-artifacts/RUN_UUID/junit/`; the example maps that path to native test-report artifacts. Configure artifact visibility and retention for application data.

**Verification:** build context, metadata and shared runtime checked locally. Docker image execution, registry pull, actual Pipe invocation and cancellation in Bitbucket are **Not tested**.
