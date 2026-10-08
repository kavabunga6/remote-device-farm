# Screenshots

Desktop interface, 1600 × 1000 viewport, English. The mock API supplies demo profiles, sessions, registry references and user roles. The Android display is a demo frame. These screenshots illustrate the interface; runtime verification is listed in [Verification](../verification.md).

## Device session

Screen controls, ADB access and device console.

![Device session, dark theme](device-dark.png)

## Sessions

Running and starting devices.

![Sessions, dark theme](sessions-dark.png)

## Logcat

Log filters, follow/pause control and font size adjustment.

![Logcat, light theme](logcat-light.png)

## Nodes

Slot allocation, resource capacity and agent status.

![Nodes, light theme](nodes-light.png)

## Device profiles

Android and container resource limits, display settings and image references.

![Device profiles, light theme](profiles-light.png)

## Images

Registry versions, linked profiles and cleanup actions.

![Image management, dark theme](images-dark.png)

## Roles and permissions

Section access and action permissions for a custom role.

![Role editor, light theme](roles-light.png)

## Sign-in

Account sign-in and language selection.

![Sign-in, dark theme](login-dark.png)

## Capture

Install frontend dependencies with `npm --prefix frontend ci` and Chrome. Start the mock server in one terminal:

```bash
MOCK_PORT=5198 npm --prefix frontend run dev:mock
```

Run the capture script from the repository root in another terminal:

```bash
MOCK_PORT=5198 node scripts/capture-screenshots.mjs
```

The script accepts only a loopback mock server, disables write requests, checks browser errors and horizontal overflow, and writes [capture metadata](manifest.json). Profile, node and role pages use full-page captures.
