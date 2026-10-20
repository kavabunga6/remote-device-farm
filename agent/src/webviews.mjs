import WebSocket from 'ws';
import { agentMessage } from './messages.mjs';
const fail = () => { throw new Error(agentMessage('webviews.failed')); };
const allowed = /^[A-Za-z0-9_.-]{1,160}$/;
const MAX_BYTES = 1024 * 1024;
export class WebViews {
  constructor(adb, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    this.adb = adb; this.fetch = fetchImpl; this.WebSocket = WebSocketImpl; this.busy = new Set();
  }
  async withForward(serial, socket, signal, work) {
    const result = await this.adb.run(serial, ['forward', 'tcp:0', 'localabstract:' + socket], { timeoutMs: 5000, maxOutputBytes: 4096 });
    const port = Number(String(result.stdout).trim());
    if (result.exitCode || !Number.isInteger(port) || port < 1024 || port > 65535) fail();
    try { signal?.throwIfAborted(); return await work(port); }
    finally { await this.adb.run(serial, ['forward', '--remove', 'tcp:' + port], { timeoutMs: 5000, maxOutputBytes: 4096 }).catch(() => {}); }
  }
  async pages(port, signal) {
    const response = await this.fetch('http://127.0.0.1:' + port + '/json/list', { signal, redirect: 'error' });
    const parts = []; let size = 0;
    for await (const chunk of response.body ?? []) { if ((size += chunk.length) > MAX_BYTES) fail(); parts.push(chunk); }
    const pages = JSON.parse(Buffer.concat(parts).toString());
    if (!Array.isArray(pages) || pages.length > 100) fail();
    return pages.filter(page => page.type === 'page' && allowed.test(page.id) &&
      typeof page.webSocketDebuggerUrl === 'string' && new URL(page.webSocketDebuggerUrl).pathname === '/devtools/page/' + page.id);
  }
  async command(serial, params = {}, { signal } = {}) {
    if (!['list', 'document', 'evaluate'].includes(params.op) || Object.keys(params).some(k => !['op', 'target', 'expression'].includes(k)) ||
        (params.op === 'evaluate' && (typeof params.expression !== 'string' || !params.expression.trim() || params.expression.length > 16384))) fail();
    if (this.busy.has(serial) || this.busy.size >= 4) throw new Error(agentMessage('webviews.busy'));
    this.busy.add(serial);
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
    try {
      const result = await this.adb.run(serial, ['shell', 'cat', '/proc/net/unix'], { timeoutMs: 5000, maxOutputBytes: 256 * 1024, signal: deadline });
      if (result.exitCode) fail();
      const sockets = [...new Set([...String(result.stdout).matchAll(/@(webview_devtools_remote(?:_\d+)?|chrome_devtools_remote)\s*$/gm)].map(item => item[1]))].slice(0, 16);
      const list = [];
      for (const socket of sockets) {
        await this.withForward(serial, socket, deadline, async port => {
          for (const page of await this.pages(port, deadline)) {
            const target = socket + '/' + page.id;
            if (params.op === 'list') list.push({ target, title: String(page.title ?? '').slice(0, 300), url: String(page.url ?? '').slice(0, 2048) });
            else if (params.target === target) {
              list.push(await this.cdp(port, page.id, 'Runtime.evaluate',
                { expression: params.op === 'document' ? 'document.documentElement.outerHTML.slice(0, 200000)' : params.expression,
                  returnByValue: true, awaitPromise: false, timeout: 5000, userGesture: false }, deadline));
            }
          }
        });
      }
      if (params.op === 'list') return { pages: list };
      if (list.length !== 1) fail();
      return { result: list[0] };
    } catch (error) { if (error.message === agentMessage('webviews.busy')) throw error; fail(); }
    finally { this.busy.delete(serial); }
  }
  cdp(port, id, method, params, signal) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocket('ws://127.0.0.1:' + port + '/devtools/page/' + id, { maxPayload: MAX_BYTES, handshakeTimeout: 5000 });
      const finish = (error, value) => { signal.removeEventListener('abort', abort); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); error ? reject(error) : resolve(value); };
      const abort = () => finish(new Error('aborted'));
      signal.addEventListener('abort', abort, { once: true });
      ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
      ws.on('message', bytes => { try { const data = JSON.parse(String(bytes)); if (data.id === 1) finish(data.error ? new Error('cdp_error') : null, data.result); } catch { finish(new Error('cdp_error')); } });
      ws.once('error', error => finish(error)); ws.once('close', () => finish(new Error('closed')));
      if (signal.aborted) abort();
    });
  }
}
