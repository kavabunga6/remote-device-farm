# Device debugging

## Traffic inspector

Open a running emulator session and select **Traffic**. Start capture, reproduce the request in the Android app, then stop capture. The inspector retains the last 200 HTTP requests and HTTPS CONNECT connections.

- **Sequence** lists requests by time, with method, path, host, status, duration and transferred bytes. Click a column heading to sort.
- **Structure** groups requests by host and path directories. Expand a host or directory to inspect individual requests.
- Select an entry to view **Overview**, **Request** or **Response**. Request and response headers are displayed separately. HTTPS entries describe encrypted tunnels with an explicit open/closed state and live directional byte counts. HTTP status, transport outcome and failure phase are separate fields.
- Search by URL, method or status. Combine space-separated terms, or filter HTTP requests, TLS tunnels and errors.
- **Freeze list updates** holds the visible records while capture continues. Resuming displays the latest records. Updates preserve selection and scroll position. The eviction counter reports records removed from the buffer; the selected record remains as its last available snapshot.
- Drag the divider between the list and details to resize them. Arrow keys adjust a focused divider; double-click resets it. Wide panels place details beside the list; compact panels stack them.
- **Record packets (PCAP)** enables packet capture before starting. **Settings** contains the optional HTTP body preview and limits. The toolbar HAR export contains exactly the displayed, filtered or frozen records. The selected request has a separate HAR download; stop capture before downloading PCAP.

The inspector temporarily sets Android's HTTP proxy. Disable an existing custom proxy first. Stopping restores the disabled-proxy setting only when the inspector still owns it; a subsequent manual proxy change is preserved. Existing app connections may require restarting the app.

- A fixed allowlist retains content, cache and standard negotiation headers. Cookies and authorization headers are excluded. Query parameter values are redacted; URL paths can still contain sensitive data.
- HTTP text body previews are off by default. Enabling them retains up to 4 KiB per direction and can expose credentials and application data in the UI and HAR. Previews are truncated explicitly; binary or compressed content is not decoded. HTTPS content is never decrypted.
- HTTPS remains encrypted. CONNECT records describe connections, not individual encrypted HTTP requests.
- Apps that ignore Android's proxy are absent from the request table.
- Optional raw PCAP captures packets at the emulator network layer, including traffic that ignores the proxy. It is not redacted and can contain application data and credentials. Stop capture before downloading it.
- Capture stops after ten minutes or approximately 30 MiB of PCAP. The UI reports the reason, PCAP finalization and failed stop confirmation. Existing traffic continues after recording stops; captured entries are frozen with an incomplete-capture outcome. The capture directory has a separate 40 MiB tmpfs ceiling inside the session's memory limit.
- The proxy supports up to 64 simultaneous connections. Further connections receive HTTP 503 and increment a visible refusal counter. Established CONNECT tunnels have no idle cutoff; individual network operations retain bounded timeouts. An idle proxy can remain until the session is destroyed and is not exposed on the host.
- HTTP timings measure connection establishment (including DNS), request sending, response wait and response receipt. HTTP byte counters exclude headers; CONNECT counters describe encrypted bytes in both directions. HAR preserves partial outcomes, unknown timing availability and tunnel metadata through extension fields; encrypted tunnel lifetime is not represented as HTTP response time.
- Files and capture state are removed with the emulator container. Agent recovery stops capture and restores the inspector's proxy setting.

Detailed diagnostics require an updated agent and a new emulator session. The standard emulator image requires rebuilding to include Python 3. Older or third-party images can report that inspection is unavailable. USB devices do not offer this inspector.

The proxy runs inside the emulator's container network namespace and uses its existing egress policy. It does not route application requests through the server or the agent host network.

### API

All endpoints require session ownership or authorized administration. Shared screen access does not grant debug access.

| Endpoint | Purpose |
| --- | --- |
| GET /api/sessions/{id}/network-inspector | Capture state and bounded request log |
| POST /api/sessions/{id}/network-inspector | start, stop, clear or pcap |
| GET /api/sessions/{id}/network-inspector/har | Download the current server buffer as HAR |

Start with `{ "op": "start", "pcap": false, "captureBodies": false }`. Both recording options are explicit; `captureBodies` defaults to false. PCAP download accepts an optional `captureId` from the current state to reject downloads after a capture restart. See the [OpenAPI specification](../api/openapi.yaml) for outcome, progress, buffer and PCAP fields.

PCAP export uses `{"op":"pcap","offset":0,"captureId":"<capture-id>"}`; each result contains `contentBase64`, `offset` and `size`. Append decoded chunks and advance the offset until `size` bytes have been received.

Inspection requires sessions.console and sessions.env. HAR and PCAP export additionally require sessions.files. Audit records contain action names, without request URLs or capture contents.

## WebView and Chrome

Open **WebView** to list debuggable pages on the session's Android device. Select a page to read its HTML or evaluate a JavaScript expression. Output is displayed as text. JavaScript executes in that page and can change its application data.

The Android app must enable WebView debugging, normally in a debug build. Pages rendered without a debugging endpoint cannot be inspected by this tool. Chrome must have an open page.

The agent discovers sockets on the leased device, opens a temporary loopback ADB forward and removes it after each request. Clients cannot supply a DevTools host, port or WebSocket URL. Responses, concurrency and execution time are bounded.

| Endpoint | Purpose |
| --- | --- |
| GET /api/sessions/{id}/webviews | List page targets, titles and URLs |
| POST /api/sessions/{id}/webviews | document or evaluate for a returned target |

Both endpoints require sessions.console and session ownership or authorized administration. Page contents and JavaScript results may contain private application data.

Hybrid WebDriver automation is available through the optional [managed Appium endpoint](../ci/managed-appium.md).
