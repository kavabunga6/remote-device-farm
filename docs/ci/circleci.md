# CircleCI Orb

[CI integrations](README.md) · [Worker requirements](native-packages.md)

`integrations/circleci/orb.yml` is a packed Orb with an embedded runtime, reusable command and test job. It includes an always-running recovery step and native JUnit/artifact upload steps.

## Use an inline Orb

No Orb Registry release is published. Import the packed YAML as an inline Orb in the application's configuration, or publish it under an organization-owned namespace after acceptance testing. `circleci orb validate integrations/circleci/orb.yml` validates it against CircleCI.

An inline configuration can be generated without copying its embedded runtime manually:

```bash
npm ci --prefix integrations
node scripts/package-native-ci.mjs circleci
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {parse,stringify}=createRequire(new URL('./integrations/package.json',import.meta.url))('yaml');
const config={
  version:2.1,
  orbs:{rdf:parse(fs.readFileSync('integrations/circleci/orb.yml','utf8'))},
  jobs:{android:{docker:[{image:'registry.example.com/android-ci:1.0.0'}],steps:[
    'checkout',
    {'rdf/run-tests':{
      url:'https://farm.example.com',profile:'android-30',
      'adb-key-id':'33333333-3333-4333-8333-333333333333',
      'adb-key-file':'/run/ci-secrets/adbkey',
      'prepare-script':'ci/build.sh','test-script':'ci/android-tests.sh'
    }}
  ]}},
  workflows:{tests:{jobs:[{android:{context:'android-tests'}}]}}
};
fs.writeFileSync('circleci-config.yml',stringify(config));
NODE
```

Provision Android/Node tools on the Linux executor before `rdf/run-tests`. The `android-tests` context supplies protected `RDF_TOKEN`. Provision the private key as a protected file and initialize a job-owned ADB home. The generated configuration is a starting point; use an executor suitable for the project.

The `rdf/test` job also accepts an executor parameter and `before-tests` steps. Different concurrent jobs require separate workspaces. Recovery uses `rdf-artifacts/ci-state.json` and does not allocate another device.

**Verification:** YAML, embedded resource consistency, artifact steps and the shared runtime tested locally. CircleCI validation, live context handling, JUnit upload and cancellation are **Not tested**.
