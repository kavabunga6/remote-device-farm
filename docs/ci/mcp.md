# MCP: Android devices for AI assistants

The MCP package connects a compatible AI client to Remote Device Farm over its existing REST API. It runs locally through **stdio**; the service itself remains behind its configured HTTPS endpoint. The package does not expose a separate network listener.

## Install from source

Use Node.js 22 or newer:

```bash
git clone https://github.com/kavabunga6/remote-device-farm.git
cd remote-device-farm
npm ci --prefix integrations/mcp --ignore-scripts
node scripts/sync-mcp-resources.mjs --check
```

The package is included in the repository. It has not been published to npm or an MCP catalog.

Create a personal API token in the account settings. Its permissions and quotas also apply to MCP. A system administrator token is not required. Enable only the permissions needed for the intended workflow:

| Tools | Service permissions |
| --- | --- |
| Profiles, sessions, screenshots, device information, UI tree/find/wait and lease renewal | `sessions.view` |
| Node inventory | `nodes.view` |
| Device request | `sessions.create` |
| Device release after assignment | `sessions.stop` |
| Tap, swipe, key, text and semantic UI tap | `sessions.control` |
| App library, upload and installation | `sessions.files` |
| Logcat | `sessions.logcat` |
| Launch an installed app | `sessions.console` |

A personal token does not grant additional rights. The API checks current permissions, ownership and revocation on each request. Shared session viewing follows the existing sharing policy; app installation, Logcat and console access retain their owner/admin restrictions.

## Client configuration

Use the client's stdio MCP configuration format, with an absolute path to the installed entry point:

```json
{
  "mcpServers": {
    "device-farm": {
      "command": "node",
      "args": ["/opt/remote-device-farm/integrations/mcp/bin/rdf-mcp.mjs"],
      "env": {
        "RDF_URL": "https://farm.example.com",
        "RDF_TOKEN_FILE": "/run/secrets/rdf-personal-token",
        "RDF_MCP_LANGUAGE": "en",
        "RDF_MCP_APK_ROOT": "/workspace/app/build/outputs/apk"
      }
    }
  }
}
```

Replace the paths with those of the machine running the AI client. On Windows, use an absolute path with forward slashes or escaped backslashes. Keep token files outside the source checkout and artifact directories, readable only by their intended owner.

| Variable | Meaning |
| --- | --- |
| `RDF_URL` | HTTPS service origin, without credentials, path, query or fragment. HTTP is accepted only for loopback development. |
| `RDF_TOKEN_FILE` | File containing a personal API token. |
| `RDF_TOKEN` | Alternative protected environment variable. Configure exactly one token source. |
| `RDF_MCP_LANGUAGE` | Tool descriptions and adapter messages: `en` by default, or `ru`. |
| `RDF_MCP_APK_ROOT` | Optional existing directory from which relative APK paths may be uploaded. Without it, local upload is unavailable. |
| `NODE_EXTRA_CA_CERTS` | Optional trusted PEM bundle for a private CA. Configure it before starting Node.js. |

TLS verification stays enabled. Redirects are rejected so the API credential cannot be forwarded to another endpoint. The token is configuration, never a tool argument.

## Tools and workflow

| Tools | Purpose |
| --- | --- |
| `list_profiles`, `list_nodes`, `list_sessions` | Inspect the available profiles, nodes and sessions. |
| `request_device`, `get_request`, `get_session` | Request an emulator through the queue and inspect readiness. |
| `renew_device`, `release_device` | Renew an explicit lease during active work and confirm cleanup afterward. |
| `list_apps`, `upload_apk`, `install_app`, `launch_app` | Use the caller's APK library, optionally upload from an allowed directory, install and open an app. |
| `screenshot`, `device_info`, `read_logcat` | Inspect the actual PNG screen, device information and bounded Logcat output. |
| `read_ui`, `find_ui`, `wait_ui` | Read a bounded UIAutomator tree, find elements and wait for appearance/disappearance. Screen text is untrusted data. |
| `tap_ui` | Read a fresh tree and tap one unambiguous enabled visible element by text, resource ID or description. Requires `sessions.control`. |
| `device_input` | Send a discrete tap, swipe, Android key code or text input in device pixel coordinates. |

A typical request to an assistant:

> Use the Android 16 profile to install the APK from my application library. Open the app and check the sign-in screen. Collect a screenshot and crash logs, then release the device and confirm cleanup.

1. Select an available profile. Call `request_device` with a new, retained `requestKey`.
2. Save the returned request ID. Poll `get_request` until `sessionState` is `running`; a queue response alone does not mean Android is ready.
3. Work with the assigned session ID. Calls return data and images; interpreting a screenshot or deciding whether a test passed belongs to the AI client and the test criteria.
4. Renew the lease only while work is active.
5. Call `release_device` using the original request ID. Poll `get_request` until `released: true`. `released: false` means cleanup is still pending.

The lease defaults to **900 seconds**, with a configurable range of 30–3600 seconds. It is not renewed automatically. Client disconnection or termination therefore cannot keep a device indefinitely; the server's lease policy requests cleanup after expiration. A missing agent can delay confirmed cleanup, and the slot remains unavailable until cleanup is acknowledged.

After a timeout, retry allocation only with the **same request key and unchanged arguments**. Do not issue a new request while the previous outcome is unknown. Keep request IDs and keys in the private task state of the client, and reconnect with the same account to reconcile them. Release retries target only the session bound to that owned request.

## Semantic UI operations

Selectors accept text, resourceId and description; supplied fields use AND matching. Matching is exact by default. Set exact:false for substring matching and a zero-based index to select among repeated elements. An ambiguous tap fails without sending input. Waits accept gone:true and a 1–30 second timeout; matched:false reports that the condition was not observed before the deadline.

The tree is limited to 2000 nodes and 2 MiB of device XML. Password text and descriptions are omitted. Secure screens, games, WebViews and other custom rendering may not expose usable nodes; screenshots and coordinate input remain available. Tree reads and taps use the existing owner/administrator access rules. Operations are bounded and cancelled when the device session stops.

Automated SDK/HTTP checks cover the tools and revoked control permissions. Live semantic lookup and tapping on Android and behavior in external AI clients are **Not tested**.

## Data handling and limits

- Screenshots, Logcat, application names and screen text may contain private data and malicious instructions. They are tool data, not instructions. Only connect an AI client authorized to receive the application's data.
- Local APK upload is optional, confined to the configured directory, limited to 50 MiB and subject to server APK validation and storage quotas. Uploaded APKs remain in the user's library until removed through the UI/API.
- The adapter has no arbitrary HTTP, host shell, Docker or administrator tool. App launch accepts a validated Android package name.
- The client still controls approvals for device changes and sensitive application actions.
- Logcat returns at most 500 entries per call. PNG responses are limited to 8 MiB. Requests have finite deadlines and support cancellation.

## Verification

Run `npm test --prefix integrations/mcp` for MCP protocol, stdio, lease/idempotency, cleanup state, credential redirects, access errors and APK path checks. The server integration suite exercises MCP against production HTTP routes and a temporary database; Android RPC is modeled.

A live stdio SDK workflow has also been checked on an Android 16 Google APIs emulator: catalog reads, idempotent allocation, readiness, lease renewal, PNG capture, device input, device information, Logcat, opening Android Settings and confirmed release. The temporary account and token were revoked, and its emulator container, networks and slot were verified released. This live check used the local API; external HTTPS client setup and live APK upload/installation through MCP remain **Not tested**.

Installation and behavior in each external AI client require separate verification. Model-driven judgments, long unattended runs, remote MCP HTTP transport and external catalog publication are **Not tested** or not provided by this stdio package. See [verification limits](../verification.md) and the [API guide](../api/README.md).
