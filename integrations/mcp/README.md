# Remote Device Farm MCP

Local stdio MCP adapter for the Remote Device Farm REST API. Request leased Android emulators, install APKs, inspect PNG screenshots and Logcat, send device input and release the device through the existing access controls.

See [installation, configuration and verification](https://github.com/kavabunga6/remote-device-farm/blob/main/docs/ci/mcp.md).

```bash
npm ci --ignore-scripts
npm test
node bin/rdf-mcp.mjs
```

Configure a protected personal token through RDF_TOKEN_FILE or RDF_TOKEN, the HTTPS RDF_URL and optionally RDF_MCP_APK_ROOT. Tool descriptions support English, Russian, Simplified Chinese, Hindi, Spanish, Arabic, French, Bengali, Brazilian Portuguese, Urdu, Indonesian and German; select one with RDF_MCP_LANGUAGE. There is no public network listener or automatic lease renewal.

License: Apache-2.0. Includes the official MCP TypeScript SDK and Zod under their respective licenses.
