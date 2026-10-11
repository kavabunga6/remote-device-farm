const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const session = '11111111-1111-4111-8111-111111111111';
const queue = '22222222-2222-4222-8222-222222222222';
const trace = row => fs.appendFileSync(process.env.TRACE, JSON.stringify(row) + '\n');
if (process.env.FAKE_TOOL === 'adb') {
  trace({ adb: args });
  if (args[0] === 'connect') console.log('connected');
  else if (args.includes('get-state')) console.log('device');
  else {
    if (process.env.RDF_TOKEN || process.env.TEST_CI_TOKEN) process.exit(88);
    if (args.includes('logcat')) console.log('fixture-logcat');
    if (args.includes('screencap')) process.stdout.write('fixture-png');
  }
  process.exit(0);
}
const flag = name => args[args.indexOf(name) + 1];
const url = new URL(args.find(value => /^https?:\/\//.test(value)));
if (url.hostname === 'raw.githubusercontent.com') {
  const file = url.pathname.endsWith('/scripts/rdf.sh') ? 'scripts/rdf.sh' : 'integrations/common/run-tests.sh';
  const data = fs.readFileSync(path.join(process.env.RDF_SOURCE_ROOT, file));
  fs.writeFileSync(flag('-o'), process.env.CORRUPT_DOWNLOAD ? Buffer.concat([data, Buffer.from('\n# corrupted\n')]) : data);
  process.exit(0);
}
const method = flag('-X');
const headers = fs.readFileSync(0, 'utf8');
if (headers.trim() !== 'Authorization: Bearer fixture-token') process.exit(89);
if (args.some(value => value.includes('fixture-token'))) process.exit(90);
trace({ method, path: url.pathname, body: args.includes('--data') ? JSON.parse(flag('--data')) : null });
let body = {}, code = 200;
if (method === 'POST' && url.pathname === '/api/queue') body = { id: queue };
else if (url.pathname === '/api/queue/' + queue) {
  body = { id: queue, state: 'assigned', sessionId: session };
  if (method === 'DELETE') code = 409;
} else if (url.pathname.endsWith('/adb-port-access')) body = { host: 'fixture', port: 15555 };
else if (url.pathname.endsWith('/keepalive')) body = {};
else if (url.pathname === '/api/sessions/' + session) {
  if (method === 'DELETE') {
    if (!process.env.CLEANUP_PENDING) fs.writeFileSync(process.env.STOPPED_FILE, 'stopped');
  }
  if (method === 'GET' && fs.existsSync(process.env.STOPPED_FILE)) code = 404;
  else body = { session: { id: session, state: 'running' } };
} else process.exit(91);
fs.writeFileSync(flag('-o'), JSON.stringify(body));
process.stdout.write(String(code));
