#!/usr/bin/env node
import net from 'node:net';
import WebSocket from 'ws';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const server = option('server', process.env.RDF_SERVER_URL);
const sessionId = option('session', process.env.RDF_SESSION_ID);
const token = process.env.RDF_TOKEN;
const port = Number(option('port', process.env.RDF_LOCAL_PORT || 15555));
if (!server || !sessionId || !token || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage: RDF_TOKEN=<token> node bin/adb-relay.mjs --server https://farm.example --session <id> [--port 15555]');
  process.exit(2);
}

const endpoint = new URL(server);
if (!['https:', 'http:', 'wss:', 'ws:'].includes(endpoint.protocol)) throw new Error('Server must use HTTP(S) or WS(S)');
if (['http:', 'ws:'].includes(endpoint.protocol) && !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)) {
  throw new Error('Remote broker URL must use TLS');
}
endpoint.protocol = endpoint.protocol === 'https:' || endpoint.protocol === 'wss:' ? 'wss:' : 'ws:';
endpoint.pathname = `/api/sessions/${encodeURIComponent(sessionId)}/adb-tunnel`;
endpoint.search = '';

const listener = net.createServer((local) => {
  local.pause();
  const remote = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024, handshakeTimeout: 15000, perMessageDeflate: false });
  let ended = false;
  function close() {
    if (ended) return;
    ended = true;
    local.destroy();
    remote.close();
  }
  remote.on('open', () => local.resume());
  remote.on('message', (chunk, binary) => {
    if (!binary) return close();
    if (!local.write(chunk)) remote.pause();
  });
  local.on('drain', () => remote.resume());
  local.on('data', (chunk) => {
    if (remote.readyState !== WebSocket.OPEN || remote.bufferedAmount > 4 * 1024 * 1024) return close();
    remote.send(chunk, { binary: true });
  });
  remote.on('unexpected-response', (_, response) => {
    console.error(`ADB relay rejected: HTTP ${response.statusCode}`);
    close();
  });
  remote.on('error', (error) => { console.error(`ADB relay error: ${error.message}`); close(); });
  remote.on('close', close);
  local.on('error', close);
  local.on('close', close);
});

listener.listen(port, '127.0.0.1', () => {
  console.log(`Session ${sessionId} is available via adb -H 127.0.0.1 -P ${port} devices`);
});
