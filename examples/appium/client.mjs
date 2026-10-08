import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// The smoke test uses only these Appium WebDriver commands. Applications can keep
// their existing Appium client and capabilities instead of importing this helper.
export async function createSession({ port = 4723, capabilities, signal }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Appium port');
  const base = `http://127.0.0.1:${port}`;
  async function request(method, route, body, timeout = 30_000, requestSignal = signal) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    let response, payload;
    try {
      response = await fetch(base + route, {
        method, redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal,
      });
      payload = await response.json();
    } catch (error) {
      // Reading a response body may wrap the abort reason. Preserve the caller's
      // cancellation so the element deadline is distinct from a transport error.
      requestSignal?.throwIfAborted();
      throw error;
    }
    if (!response.ok || payload?.value?.error) {
      const error = new Error(payload?.value?.message || `Appium returned HTTP ${response.status}`);
      error.code = payload?.value?.error;
      throw error;
    }
    if (!payload || !Object.hasOwn(payload, 'value')) throw new Error('Invalid Appium response: missing value');
    return payload.value;
  }
  const created = await request('POST', '/session', {
    capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
  }, 90_000);
  if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error('Appium did not return a session ID');
  const route = `/session/${encodeURIComponent(created.sessionId)}`;
  return {
    async waitForDisplayed(selector, { timeout = 20_000 } = {}) {
      if (!Number.isInteger(timeout) || timeout < 1) throw new Error('Invalid element timeout');
      const deadline = AbortSignal.timeout(timeout);
      const waitSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        while (true) {
          waitSignal.throwIfAborted();
          try {
            const element = await request('POST', `${route}/element`, {
              using: '-android uiautomator', value: selector,
            }, 5000, waitSignal);
            const id = element?.['element-6066-11e4-a52e-4f735466cecf'];
            if (typeof id !== 'string' || !id) throw new Error('Appium did not return an element ID');
            const visible = await request('GET', `${route}/element/${encodeURIComponent(id)}/displayed`, undefined,
              5000, waitSignal);
            waitSignal.throwIfAborted();
            if (visible === true) return;
          } catch (error) {
            if (!['no such element', 'stale element reference'].includes(error.code)) throw error;
          }
          await delay(250, undefined, { signal: waitSignal });
        }
      } catch (error) {
        signal?.throwIfAborted();
        // fetch rejects with the signal reason; timers/promises wraps it in cause.
        if (deadline.aborted && (error === deadline.reason || error.cause === deadline.reason)) {
          throw new Error(`Element was not displayed within ${timeout} ms: ${selector}`, { cause: error });
        }
        throw error;
      }
    },
    async saveScreenshot(file) {
      const encoded = await request('GET', `${route}/screenshot`);
      if (typeof encoded !== 'string') throw new Error('Appium did not return a PNG screenshot');
      const png = Buffer.from(encoded, 'base64');
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Appium returned an invalid PNG screenshot');
      }
      await writeFile(file, png);
    },
    async deleteSession() {
      // The test timeout may have already aborted its signal; cleanup still runs.
      try { await request('DELETE', route, undefined, 15_000, null); }
      catch (error) { if (error.code !== 'invalid session id') throw error; }
    },
  };
}
