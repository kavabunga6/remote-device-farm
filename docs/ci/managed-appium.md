# Managed Appium

Remote Device Farm can run a separate Appium worker for each active device session. Clients use the service's HTTPS endpoint and a personal API token. The worker listens on loopback inside the I/O agent; no Appium port is published.

The existing [client-side Appium example](appium.md) remains available.

For hybrid apps, use the W3C context APIs to switch between NATIVE_APP and an available WEBVIEW context. JavaScript execution is accepted only after the worker confirms a web context; mobile shell execution remains disabled. browserName can be Chrome or Chromium, and appium:autoWebview is supported. The browser's WebView panel provides page discovery, HTML and JavaScript inspection without an Appium worker.

**Build status:** dependency installation and runtime-source compilation use one pinned lockfile. Upstream development dependencies and tests are not installed or built. Native Android and WebView automation still require live acceptance; a local `/status` response does not validate device automation.

## Agent setup

The optional image uses the Appium and UiAutomator2 versions pinned in examples/appium/package-lock.json. It supports native and debuggable WebView/Chrome automation on Android 8 (API 26) and newer; the device version must be confirmed by the agent. Compatible ChromeDriver versions are downloaded by the pinned UiAutomator2 driver into each worker's temporary directory. This requires outbound access to the upstream ChromeDriver download services; the directory is removed with the worker. Client-supplied executable paths, download URLs, arbitrary mobile scripts and Appium plugins are not provided.

Install an Android SDK on the worker host, accept its licences and include Platform Tools and compatible Build Tools. The agent user must be able to read the directory. The optional image includes JDK 17. SDK tools are mounted read-only; SDK runtime downloads and automatic licence acceptance are disabled. ChromeDriver provisioning is separate from the SDK mount.

Build the base agent from the same source revision:

```bash
docker build -t remote-device-farm-agent:local ./agent
export RDF_ANDROID_SDK_DIR=/srv/android-sdk
docker compose -f compose.yaml -f compose.agent.yaml -f compose.appium.yaml up -d --build agent
```

Use the Compose files and environment files for the target installation. The optional overlay preserves the agent's existing key and control volumes. It sets a 2 GiB agent memory limit and allows two simultaneous Appium workers. Set RDF_APPIUM_MAX_WORKERS to 1–8 and adjust the container limit after measuring the intended workload. Emulator limits remain separate. A dedicated 384 MiB executable tmpfs holds worker files and downloaded ChromeDriver binaries; the agent’s general temporary directory retains its existing mount protection. The worker directory is removed on release.

For an existing SDK-equipped agent installation, RDF_APPIUM_ENTRY may point to an absolute Appium index.js from a project containing both pinned dependencies. The worker process discovers its driver from that project.

## Client workflow

1. Request a device through the existing queue API and retain the request ID.
2. Wait for the device session to be running.
3. Use https://farm.example.com/api/sessions/SESSION_ID/appium as the WebDriver base URL. Send Authorization: Bearer TOKEN on every request.
4. Create one W3C session. The service pins its udid and UiAutomator2 system port to the assigned device.
5. Delete the W3C session, then release the device using the retained queue request ID. Confirm device cleanup through the queue API.

A native session request:

```json
{
  "capabilities": {
    "alwaysMatch": {
      "platformName": "Android",
      "appium:automationName": "UiAutomator2",
      "appium:appPackage": "com.android.settings",
      "appium:appActivity": ".Settings",
      "appium:noReset": true
    },
    "firstMatch": [{}]
  }
}
```

POST the object to the base URL followed by /session. Subsequent commands use the returned W3C driver ID, for example /session/DRIVER_ID/source. The device session ID and W3C driver ID are different identifiers.

Install APKs through the service's application API before creating the W3C session. Do not pass app download URLs, host paths or driver executable paths in capabilities.

## Access and lifecycle

All commands require an active device session accessible to its owner or an authorized administrator and sessions.control, sessions.files and sessions.console. Sharing a screen does not grant Appium access. Current account permissions and token revocation are checked for every HTTP request.

Supported commands cover native element lookup, clicks, text entry, W3C actions, source, screenshot, orientation, timeouts and selected gestures. The agent rejects unlisted routes, another driver's ID, JavaScript outside a confirmed web context, shell execution, host file operations and client-selected ADB servers. Only UiAutomator2's ChromeDriver download feature is enabled; other insecure features remain disabled.

Only one command may be in flight per device. A second session creation is rejected without replacing the active worker. Command and startup deadlines are finite. An uncertain upstream request stops the worker; automatic action retries are not performed. Stopping or expiring the device session terminates its worker and removes its temporary directory. Deleting only the W3C session does not release the device lease.

## Verification

Automated checks exercise real loopback child-process startup/termination, driver affinity, capability restrictions, response redaction, temporary-directory cleanup and production HTTP authorization. The pinned Appium package has also answered /status locally and stopped cleanly.

Full UiAutomator2 execution on Android, the optional Linux image/SDK deployment, WebDriver client compatibility and concurrent live device runs are **Not tested**. See [verification limits](../verification.md).
