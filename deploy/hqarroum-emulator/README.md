# HQarroum Android emulator adapter

This recipe wraps the SDK and system image already installed in [HQarroum/docker-android](https://github.com/HQarroum/docker-android). It keeps the farm's existing DockerClient contract. It does not download another Android image at startup or modify existing profiles.

The default base is the inspected API 33 image:

```text
halimqarroum/docker-android@sha256:0804f0c30234db0fb711910c569f13312bc3cfa354cb66c8e0db6a4e66edfb95
```

> **Warning: upstream ADB authentication.** Prebuilt emulator images may disable key checks or ignore supplied keys. This adapter replaces the upstream launcher and enables authentication; each resulting image still requires a runtime check with trusted and untrusted clients before profiles are enabled. [Image security requirements](../../docs/guides/images.md#готовые-сторонние-образы).

## Build

Use Docker Buildx/BuildKit for these large images. On the tested Docker 29 node, the legacy builder spent many minutes on metadata and layer commits; BuildKit avoids those repeated steps. `--load` makes the result available to the local agent.

```sh
docker buildx build --load -t rdf-hqarroum-emulator:api-33 deploy/hqarroum-emulator
```

For another installed Android 12L or newer x86/x86_64 upstream image, supply its inspected digest. Android 12 (API 31) is restricted to the exact digest in `policy-api31.json`; a different API 31 base requires its own verified, unchanged policy input and manifest:

```sh
docker buildx build --load \
  --build-arg EMULATOR_BASE_IMAGE=halimqarroum/docker-android@sha256:YOUR_VERIFIED_DIGEST \
  -t rdf-hqarroum-emulator:api-OTHER deploy/hqarroum-emulator
```

Build prepares an AVD from the base image's `PACKAGE_PATH`, `ABI`, and `DEVICE_ID` and a ramdisk with mandatory ADB authentication; it does not fetch SDK packages. Gzip and legacy/framed LZ4 newc ramdisks are supported. Concatenated generic/vendor archives retain their entries and archive boundaries. Unknown or truncated ramdisk archive formats stop the build. Each new session container starts with fresh AVD data. The adapter uses the same container after an agent reconnect, preserving session data. Do not mount shared writable AVD data between sessions.

## Additional catalogue

`images.json` pins the upstream bases and the adapter tags expected by
`scripts/install-hqarroum-profiles.mjs`:

| Android | API | System image | Rendering |
| --- | --- | --- | --- |
| 12 | 31 | Google APIs, x86_64 | Software |
| 12L | 32 | Google APIs, x86_64 | Software |
| 13 | 33 | Google APIs, x86_64 | Software |

Build each row from the repository root on the Linux node:

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
for image in json.loads(Path('deploy/hqarroum-emulator/images.json').read_text()):
    subprocess.run(['docker', 'buildx', 'build', '--load', '--build-arg',
        'EMULATOR_BASE_IMAGE=' + image['upstream'], '-t', image['image'],
        'deploy/hqarroum-emulator'], check=True)
PY
```

After the runtime checks below, copy the installer into the server container
and execute it with its working directory set to `/app`:

```sh
docker cp scripts/install-hqarroum-profiles.mjs remote-device-farm-server-1:/tmp/install-hqarroum-profiles.mjs
docker exec -w /app remote-device-farm-server-1 node /tmp/install-hqarroum-profiles.mjs
docker exec -w /app remote-device-farm-server-1 node /tmp/install-hqarroum-profiles.mjs --apply
```

The first invocation is a read-only preview. `--apply` creates only missing
profiles, enabled for new sessions. It preserves existing settings, disabled
profiles and deletion tombstones. An ID collision with a different image aborts
the transaction. The server's normal profile validator checks every new row.
The installer reads its database connection from the existing server environment.

The images are local to the node. Preload them on **every eligible node** before
enabling profiles, or publish these adapted images in a registry and use their
registry references. The scheduler does not check a node's local image cache.
These profiles have no GPU image; no unverified NVIDIA option is advertised.

## Farm integration

Add `rdf-hqarroum-emulator` to the agent and agent-control image allowlists while retaining existing prefixes. Create a separate profile for this Android version/flavor, using the adapter tag in `image`. For API 33, begin verification with Android 13, Google APIs, x86_64, 4 container CPUs, 4096 MiB container RAM, 2 guest cores, 2048 MiB guest RAM, and a 16 GiB data partition. Node slot limits must accommodate the container limit.

This adapter supports software rendering. Leave `gpuMode` as `software` and `gpuImage` empty until a matching GPU variant has been built and verified. It rejects `-gpu host`; upstream's Xvfb option is not proof of NVIDIA rendering.

| Farm contract | Adapter implementation |
| --- | --- |
| `ADBKEY_PUB` | Requires one valid Android RSA public key; supplies it through `androidboot.qemu.adb.pubkey` before Android boots. Removes inherited runtime keys; no session private key enters the image/container. |
| `EMULATOR_PARAMS` | Parses an argument array without shell evaluation; supports farm RAM, CPU, data size, SD card, network, locale, and screen flags. |
| `AVD_CONFIG` | Replaces allowlisted data/SD settings in a clean AVD configuration. |
| `/android/sdk/emulator/mksdcard` | SDK compatibility symlink; the existing agent SD wrapper runs before the adapter. |
| `/android-home/rdf-sdcard.img` | Per-session SD image; startup preserves it. |
| ADB `5555` | Binds to the container's isolated management interface and forwards to emulator loopback `5557`. |
| gRPC `8554` | Same management interface, forwarded to emulator `8555`; compatible with native touch and audio helpers. Emulator 36.5.11 also binds `8555` on container interfaces, so both ports remain inside isolated session networks. |
| Emulator console | Loopback `5556`, authenticated with a new container-local token; the existing Docker exec console client supports this port. |

The adapter replaces the upstream launcher and validates startup parameters against the emulator contract. It requires ADB authentication, keeps service endpoints private and does not print private keys or the environment. Do not publish ADB/gRPC/console host ports. Run through the agent's isolated networks, dropped capabilities, resource limits and `/dev/kvm` mapping. Runtime approval is required for each resulting image.

The adapter sets `-no-direct-adb` (verified on emulator 36.5.11) to disable the emulator's internal ADB bridge. Its SDK-local ADB helper is guarded: only exact `version`/`--version` queries may invoke the preserved binary. Daemon startup, key generation, and shell commands fail explicitly. The agent remains the ADB client; this prevents emulator-side helpers from generating another key and opening an authorization dialog.

Current emulator versions derive their default boot public key only from a private key. The adapter instead passes the validated session public key directly with `-append-userspace-opt androidboot.qemu.adb.pubkey=...`; no session private key is supplied or generated.

Google APIs userdebug images can default to `ro.adb.secure=0`. The build creates a derived ramdisk using Android init's early property override: `/force_debuggable` plus `/adb_debug.prop` containing only `ro.adb.secure=1`. Startup sets `androidboot.verifiedbootstate=orange` to permit that override on this emulator. This enables authentication before adbd starts. It does not set `ro.debuggable`, enable root, introduce a permissive SELinux policy, or alter the system/vendor images. Android 12 (API 31) init additionally requires a platform-policy file before retaining this property override. `policy-api31.cil.gz` contains the unchanged `/system/etc/selinux/plat_sepolicy.cil` extracted read-only from the exact pinned API 31 image. Its source digest, SDK package, build fingerprint, original file size, and SHA-256 are recorded in `policy-api31.json`; the generated CIL contains no embedded copyright header, and its bytes are preserved verbatim. Build checks the exact `FROM` digest, package, original `source.properties` and ramdisk checksums, and decompressed policy checksum/length before copying it into the derived ramdisk as `/userdebug_plat_sepolicy.cil`. Mismatches stop the build. The resulting provenance is also stored in `/usr/local/lib/rdf-hqarroum/platform-policy.json`. API 32/33 do not need this copy. All other ramdisk records are preserved. An unsupported ramdisk fails the build; there is no unauthenticated fallback.

Authentication must be checked with `getprop ro.adb.secure` and with both the authorized agent key and an unrelated key before enabling each resulting profile. ADB connectivity alone does not prove authentication is enabled. gRPC has no application token and must remain restricted to the agent's isolated container networks; neither `8554` nor `8555` may be published on the host.

## Renderer configuration

The adapter uses the base image's standard renderer configuration. Performance settings are supplied through the profile's supported launch parameters.

Some API 33 bases include a live wallpaper that requires GLSL ES 3.10, while the software renderer provides OpenGL ES 3.0. Validate the bundled apps with the selected graphics mode before enabling a profile.

## Verification

Local parser/key/config checks:

```sh
python3 -m unittest discover -s deploy/hqarroum-emulator -p 'test_*.py'
```

Before enabling a profile, launch a disposable session through agent-control and verify:

- Android version, ABI, `sys.boot_completed=1`, guest RAM/cores, and requested data/SD sizes.
- `ro.adb.secure=1` and SELinux `Enforcing`; agent ADB key connects without a dialog; an unrelated key reaches the emulator but remains `unauthorized` and cannot execute `shell`.
- Scrcpy video/input, gRPC native touch, and emulator console network/geolocation commands.
- Teardown removes the container and both session networks.

A successful image build is not a boot or compatibility verification. Validate every Android base separately. The source repository and its published tags can use different Linux bases; this Dockerfile supports the published Alpine and Debian/Ubuntu layouts.

Primary references: [upstream Dockerfile](https://github.com/HQarroum/docker-android/blob/main/Dockerfile), [upstream launcher](https://github.com/HQarroum/docker-android/blob/main/scripts/start-emulator.sh), [SDK installer](https://github.com/HQarroum/docker-android/blob/main/scripts/install-sdk.sh), [AOSP emulator boot properties](https://android.googlesource.com/platform/external/qemu/+/emu-master-dev/android/android-emu/android/userspace-boot-properties.cpp), [Android 12 first-stage policy requirement](https://android.googlesource.com/platform/system/core/+/refs/tags/android-12.0.0_r1/init/first_stage_init.cpp), [Android 13 first-stage ramdisk override](https://android.googlesource.com/platform/system/core/+/refs/tags/android-13.0.0_r1/init/first_stage_init.cpp), [Android boot property precedence](https://android.googlesource.com/platform/system/core/+/refs/tags/android-13.0.0_r1/init/property_service.cpp), [adbd authentication requirement](https://android.googlesource.com/platform/packages/modules/adb/+/refs/tags/android-13.0.0_r1/daemon/main.cpp).
