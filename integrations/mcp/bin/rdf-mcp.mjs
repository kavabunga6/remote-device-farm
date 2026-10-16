#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { t } from '../src/messages.mjs';

let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Explicit leases expire at the broker; disconnect never renews them.
  try { await server?.close(); } finally { process.exitCode = 0; }
}
try {
  const config = loadConfig();
  server = createMcpServer(config);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  await server.connect(new StdioServerTransport());
} catch {
  console.error(t('startupError'));
  process.exitCode = 1;
}
