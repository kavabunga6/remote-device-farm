# Third-party components

The Apache-2.0 license covers this project's source. Dependencies, fonts,
container bases, Android tools and system images retain their own licenses.
Lockfiles pin JavaScript dependencies; inspect each installed package's
`LICENSE`/`NOTICE` and preserve required notices when distributing a bundle.

| Component | License / source |
| --- | --- |
| React, Express, ws, multer, pg and most JS utilities | See installed package metadata and notices |
| bundletool, downloaded with a pinned SHA256 | [Apache-2.0](https://github.com/google/bundletool/blob/master/LICENSE); preserve the bundled dependency notices |
| scrcpy server, downloaded with a pinned SHA256 | [Apache-2.0](https://github.com/Genymobile/scrcpy/blob/master/LICENSE) |
| HQarroum Docker Android adapter (legacy, optional) | [MIT, copyright Halim Qarroum](https://github.com/HQarroum/docker-android/blob/master/LICENSE) |
| Onest and JetBrains Mono fonts | SIL Open Font License 1.1; license files in the Fontsource packages |
| Node.js, nginx, PostgreSQL, Distribution, Ubuntu/Debian/Alpine packages | Their upstream and package-specific licenses; keep base image notices |
| Android command-line tools, emulator and SDK system images | [Android SDK terms](https://developer.android.com/studio/terms), plus package-specific terms and open-source notices |

## Android downloads and image publication

The image builder downloads Google's tools and the selected SDK package at
installation/build time. Its Dockerfile invokes `sdkmanager --licenses`
automatically. **Review and accept the applicable SDK/package terms before
using the builder**, with authority to accept them for your organization.
Automation is not a license grant from this project.

Google's SDK agreement distinguishes open-source components from other SDK
components and restricts redistribution of the latter. Do not assume that an
AOSP package label, a Docker image or this project's Apache license permits
publishing every bundled file. Google APIs and Play Store images also contain
components with their own terms. Keep builds in an access-controlled registry;
review the exact package terms before sharing outside your organization or
publishing container images. Source-repository publication does not require
publishing SDK-containing images.

The upstream Google Android 11 starter is referenced by digest, not copied
into this repository. Users download it from Google's registry. That reference
does not relicense its contents. No endorsement or trademark rights are claimed.

[Versioned npm license inventory](docs/security/dependency-licenses.json) is generated
from the lockfiles (`node scripts/license-inventory.mjs`) and checked in CI.
It records declared licenses, not a compatibility or redistribution certification.
Font and bundled React licenses are served at `/licenses/`; the agent includes
scrcpy attribution, and server, agent and registry images carry project notices.

## CI packages

Native CI adapters contain project code and the shared Bash CLI. The TeamCity
SDK is a compile/test dependency supplied by the installed TeamCity runtime;
it is not bundled in the plugin ZIP. YAML and Microsoft tfx are packaging/check
dependencies, recorded in the integration lockfiles, and are not shipped in
the Action or Azure task. The Pipe retains the Node/Debian base notices and
installed package copyright files, including ADB and OpenJDK. It does not
bundle Android system images or Google SDK downloads.

## MCP package

The optional MCP adapter uses the official Model Context Protocol TypeScript SDK
and Zod, both declared under MIT. Their production dependency licenses are included
in the versioned npm inventory. Installed dependencies retain their own license files.
The adapter contains no model weights or Android system images.
