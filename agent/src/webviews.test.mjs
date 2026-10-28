import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { WebViews } from './webviews.mjs';
test('WebView targets stay bound to the device; CDP forwards are removed on success and failure', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', id: 'owned-page', title: 'Test', url: 'https://example.test/',
      webSocketDebuggerUrl: 'ws://untrusted.invalid/devtools/page/owned-page' }]));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', raw => { const request = JSON.parse(String(raw)); socket.send(JSON.stringify({ id: request.id, result: { result: { value: '<html>test</html>' } } })); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const calls = [], port = server.address().port;
  const adb = { run: async (serial, args) => {
    calls.push([serial, args]);
    return { exitCode: 0, stdout: args[0] === 'shell' ? '000: @webview_devtools_remote_42\n' : args[1] === 'tcp:0' ? String(port) : '' };
  } };
  const views = new WebViews(adb);
  try {
    const result = await views.command('owned-device', { op: 'list' });
    assert.equal(result.pages[0].target, 'webview_devtools_remote_42/owned-page');
    assert.equal((await views.command('owned-device', { op: 'document', target: result.pages[0].target })).result.result.value, '<html>test</html>');
    await assert.rejects(views.command('owned-device', { op: 'evaluate', target: 'other/page', expression: '1' }));
    await assert.rejects(views.command('owned-device', { op: 'evaluate', target: result.pages[0].target, expression: 'x'.repeat(16385) }));
    assert.equal(calls.filter(([, args]) => args[1] === '--remove').length, 3);
    assert.ok(calls.every(([serial]) => serial === 'owned-device'));
    assert.equal(views.busy.size, 0);
  } finally { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise(resolve => server.close(resolve)); }
});
