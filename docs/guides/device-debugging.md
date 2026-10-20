# Device debugging

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
