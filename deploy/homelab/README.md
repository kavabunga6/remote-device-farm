# Example single-host deployment

This optional Compose example deploys PostgreSQL, the broker, web UI and a Linux agent. The root Compose model is the generic quick start.

All names, IPs and paths here are placeholders. Replace documentation IP `192.0.2.10`, domain `farm.example` and directory `/opt/device-farm` with your own values before use. No credentials, certificates, installed GPU images or measured node settings are included.

## Prepare the target environment

1. Inspect Docker, available CPU/RAM/disk, `/dev/kvm`, occupied ports and existing networks. Set the per-service resource limits required by `compose.yaml` from actual available capacity.
2. Place the repository at `/opt/device-farm/app`. Create protected environment files under `/opt/device-farm/secrets` using the root environment examples. Keep all keys and tokens outside Git.
3. Provision your HTTPS certificate and key. Replace certificate filenames and bind addresses in the example. It publishes HTTPS on port8443 and broker ADB ports15555–15562; verify these ports are available and restrict access to your trusted network.
4. Create data directories for PostgreSQL and APK storage with the required service ownership. The APK store needs UID1000 write access. Create an external `homelab-net` network only if using this example's existing-gateway integration.
5. Validate the effective Compose model with `docker compose --env-file /opt/device-farm/secrets/app.env -f deploy/homelab/compose.yaml config --quiet`. Do not print secret values in logs.

The optional `nginx.example.conf` is a template for an existing gateway. Review domain names, certificate paths, resolver and the `connection_upgrade` map before applying it. Deployment of the farm must not overwrite another service's gateway configuration.

## Agent and emulator isolation

Only `agent-control` mounts the Docker socket. The broker-facing agent operates through its typed Unix socket API. The key importer is for a migration from an existing deployment; prepare its read-only source files and verify the imported identity before switching agents.

Docker28+ is required for the management/egress network split used by network-off mode. Host firewall installation and LAN-isolation verification are separate operator actions; this example does not apply host firewall rules automatically.

## NVIDIA host telemetry (optional)

On a host with a working NVIDIA driver and NVIDIA Container Toolkit configured for Docker, add `compose.nvidia-telemetry.yaml` to expose GPU utilization and video memory readings to the `agent` service. The overlay uses the NVIDIA runtime with the `utility` driver capability for `nvidia-smi` and NVML. It inherits the existing agent user, dropped Linux capabilities and read-only filesystem.

From the repository root, validate and apply both files:

```bash
docker compose --env-file /opt/device-farm/secrets/app.env \
  -f deploy/homelab/compose.yaml -f deploy/homelab/compose.nvidia-telemetry.yaml config --quiet
docker compose --env-file /opt/device-farm/secrets/app.env \
  -f deploy/homelab/compose.yaml -f deploy/homelab/compose.nvidia-telemetry.yaml up -d --no-deps agent
```

To retain this selection across updates, add the following setting to the existing `/opt/device-farm/secrets/app.env`, using your installation paths:

```dotenv
COMPOSE_FILE=/opt/device-farm/app/deploy/homelab/compose.yaml:/opt/device-farm/app/deploy/homelab/compose.nvidia-telemetry.yaml
```

Subsequent `docker compose --env-file /opt/device-farm/secrets/app.env` commands load both files automatically. Update scripts that explicitly pass `-f` must include both files because `-f` overrides `COMPOSE_FILE`. For example, update the agent and verify telemetry as its configured user with:

```bash
docker compose --env-file /opt/device-farm/secrets/app.env up -d --build --no-deps agent
docker compose --env-file /opt/device-farm/secrets/app.env exec -T agent \
  nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
```

The query should return GPU load and memory values; the node card updates after the next agent heartbeat. [NVIDIA driver capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html#driver-capabilities).

## Profiles

The first profile is created by a migration; add more under Administration → Device profiles.

For hardware acceleration, verify the host driver and container runtime, then test that the profile's image actually uses the GPU. The node advertises `cuda` for NVIDIA and/or `gpu` for a compatible DRI device; the farm selects an available backend automatically. GPU support is not a profile setting. GPU acceleration is selected when starting a session; the profile keeps the same image and memory limit. Agent telemetry access is configured separately with the optional overlay above.

For NVIDIA (`cuda`), the farm uses the `nvidia` runtime and requests `compute`, `graphics`, `utility` and `display` driver capabilities. The loaded host driver and an attached GPU must be visible to `agent-control`. For a DRI render device (`gpu`), set `AGENT_DRI_DEVICE=/dev/dri/renderD128` in the agent environment and expose the same host device to `agent-control`; choose the actual render node on your host:

```yaml
services:
  agent-control:
    devices:
      - /dev/kvm:/dev/kvm
      - /dev/dri/renderD128:/dev/dri/renderD128
```

The device must be readable and writable by `agent-control`. The farm then passes that render node to accelerated emulator containers. If both backends are available, NVIDIA is preferred. Profile fields such as `gpuImage`, `gpuMemoryMb` or `gpu.kind` do not select a backend. Allow the profile's image prefix in the agent configuration when an image allowlist is enabled. See the [image and manifest guide](../../docs/guides/images.md#gpu) for launcher contracts.


Before production, define your own backup and restore policy and test upgrades. No machine-specific backup paths or private deployment state are part of this example.
