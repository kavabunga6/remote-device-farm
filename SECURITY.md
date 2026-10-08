# Security policy

## Reporting a vulnerability

**Do not report exploitable vulnerabilities or credentials in public issues.**
Use GitHub's private [Report a vulnerability](https://github.com/kavabunga6/remote-device-farm/security/advisories/new)
channel when enabled. If it is unavailable, ask the maintainer to establish a
private reporting channel using a public issue containing no vulnerability
details. No response-time guarantee or bug bounty is offered.

Include the affected commit/version, a minimal reproduction, impact and
sanitized logs. Do not test against deployments you do not own or have permission
to assess. If a credential was exposed, revoke it before sending a report.

## Supported versions

The project is an alpha. Security fixes target the current `main` branch;
there are no maintained older release branches. Upgrade to a tested revision
and follow the migration/backup instructions. See the
[verification status](docs/verification.md) for verification
limits. Source tests and audit fixes are not a penetration-test certification.


## Access boundaries

The server checks session ownership and permissions for REST APIs, screen/control WebSockets and ADB access. Shared screen links require login, have limited capabilities, and can be revoked or expired. They do not grant ADB access.

The ADB broker authenticates the selected session key before opening the device connection. Device ADB ports are not published directly. Ordinary ADB traffic is not encrypted after authentication; expose the broker only on a trusted network or through a VPN. Android shell grants broad access within the selected guest.

## Images, agents and hosts

Administrators approve image sources and profiles. Session users cannot supply Docker mounts, entrypoints or privilege flags. Emulator containers have resource limits, dropped capabilities and isolated management networks. Docker socket access is reserved for agent-control; the network-facing agent has no Docker socket or KVM access. Control operations and requests are validated, but agent credentials and IPC remain trusted components.

Docker access is a host-level privilege. Compromise of agent-control, Docker or the host can compromise its devices. Android Emulator/QEMU, KVM, GPU drivers and trusted images require updates and review. Containers do not replace separate VMs when running hostile workloads.

Image tags, a successful Android boot and vendor provenance do not confirm ADB authentication or cleanup. An image must pass the [runtime requirements](docs/guides/images.md#готовые-сторонние-образы) before its profile is enabled. Bundled starter profiles without runtime approval remain disabled.

Physical-device rental requires a trusted full reset/reprovisioning procedure validated for every supported model. Failed or interrupted cleanup keeps a device unavailable. Reuse on actual physical devices and deployment-specific host/LAN isolation remain unverified; see [verification status](docs/verification.md#not-tested). These scenarios must be validated before enabling them for untrusted tenants.
