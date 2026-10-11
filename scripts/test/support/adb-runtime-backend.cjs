const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
if (args[0] === 'pubkey') {
  if (process.env.RDF_TOKEN) process.exit(88);
  console.log('fixture-public-key');
} else if (args[0] === '-L') {
  const listener = /^tcp:localhost:([0-9]+)$/.exec(args[1]);
  const client = /^tcp:127\.0\.0\.1:([0-9]+)$/.exec(process.env.ADB_SERVER_SOCKET || '');
  if (!listener || !client || listener[1] !== client[1] || client[1] === '5037' || process.env.RDF_TOKEN) process.exit(89);
  fs.appendFileSync(process.env.TRACE, JSON.stringify({ privateAdb: true, port: Number(listener[1]) }) + '\n');
  const server = net.createServer(socket => socket.on('error', () => {}));
  server.listen(Number(listener[1]), '127.0.0.1');
  server.on('error', () => process.exit(90));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else if (args[0] === 'kill-server') {
  process.exit(91);
} else {
  process.env.FAKE_TOOL = 'adb';
  require('./ci-backend.cjs');
}
