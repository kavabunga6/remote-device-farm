# Legacy NVIDIA image adapter

This adapter adds a private headless NVIDIA Xorg display to a compatible image with `/android/sdk/launch-emulator.sh`. It is a legacy recipe, not a recommended default base image. Compatibility with the current runtime matrix is **Not tested**; see [verification status](../../docs/verification.md#not-tested).

For new installations, use the [SDK image builder](../emulator/README.md). GPU mode is selected when launching a session; profiles use one image reference.

## Build

Choose an approved, compatible base image explicitly and pin it by digest:

```sh
BASE_IMAGE='registry.example.com/emulator@sha256:DIGEST'
docker build --build-arg EMULATOR_BASE_IMAGE="$BASE_IMAGE" \
  -t rdf-gpu-emulator:custom deploy/gpu-emulator
```

Replace the example reference with the validated base. There is no default base image. Adding GPU support does not validate ADB authentication or key injection; the resulting image must pass the [runtime checks](../../docs/release-checklist.md#команды-реальной-проверки) before a profile is enabled.

## Host requirements

The host needs `/dev/kvm`, an NVIDIA driver and NVIDIA Container Toolkit. The agent requests `compute,graphics,utility,display` driver capabilities. If Xorg modules are not injected by the toolkit, configure `AGENT_NVIDIA_XORG_MODULE_DIR` with the host's actual module directory. The agent validates it and mounts the modules read-only for GPU sessions.

The adapter uses a container-local display, X11 authorization cookie and pseudo terminal. It does not mount the host desktop or publish an X11 TCP port. Older compatible Debian bases require legacy library compatibility packages; these bases need their own maintenance and security review.

## Profile and verification

Set the profile's `image` to the resulting image tag or digest and include its repository in `AGENT_ALLOWED_IMAGE_PREFIXES`. Configure slot CPU/RAM limits for the complete emulator container. Start a session with NVIDIA enabled and confirm Android boot, input, the actual renderer, authentication and cleanup.

A successful `nvidia-smi` result alone does not confirm Android GPU rendering. Check `dumpsys SurfaceFlinger` and the emulator/Xorg logs inside the session container. Never publish ADB, gRPC or console ports directly.

[NVIDIA driver capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html#driver-capabilities) · [Agent configuration](../../docs/deployment/agent.md)
