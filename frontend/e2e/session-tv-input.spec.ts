import { expect, test } from '@playwright/test';
const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
for (const [deviceType, shared, expected] of [['tv', false, 23], ['tv', true, 23], ['tv', 'view', null], ['mobile', false, 66], [undefined, false, 66]] as const) {
  test(`screen keyboard respects ${deviceType ?? 'legacy'} semantics, shared=${shared}`, async ({ page }) => {
    if (shared) await page.emulateMedia({ colorScheme: 'dark' });
    const inputs: Record<string, unknown>[] = [];
    await page.exposeFunction('recordSessionInput', (data: Record<string, unknown>) => inputs.push(data));
    await page.addInitScript(() => {
      let Socket = window.WebSocket;
      Object.defineProperty(window, 'WebSocket', {
        configurable: true, get: () => Socket,
        set: (Next: typeof WebSocket) => {
          const Wrapped = function(url: string | URL, protocols?: string | string[]) {
            const socket = new Next(url, protocols);
            const send = socket.send.bind(socket);
            socket.send = data => {
              if (typeof data === 'string') {
                const message = JSON.parse(data);
                if (message.type === 'input') void (window as unknown as { recordSessionInput: (value: unknown) => Promise<void> }).recordSessionInput(message);
              }
              send(data);
            };
            return socket;
          };
          Object.setPrototypeOf(Wrapped, Next);
          Socket = Wrapped as unknown as typeof WebSocket;
        },
      });
    });
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    await page.route('**/api/sessions/' + sessionId, async route => {
      const response = await route.fetch(); const data = await response.json();
      data.session.deviceType = deviceType;
      data.session.idleExpiresAt = new Date(Date.now() + 3600000).toISOString();
      if (shared) { data.session.access = shared === 'view' ? 'view' : 'control'; data.session.profileId = ''; }
      await route.fulfill({ response, json: data });
    });
    await page.goto('/#/session/' + sessionId);
    await expect(page.locator('.session-media-badge[data-media=video]')).toHaveAttribute('data-state', 'live');
    const screen = page.locator('.touch-layer'); await screen.focus();
    for (const key of ['Enter', 'NumpadEnter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Backspace']) await screen.press(key);
    await expect.poll(() => inputs.filter(x => x.kind === 'key').map(x => x.keyCode)).toEqual(expected === null ? [] : [expected, expected, 19, 20, 21, 22, 4, 4]);
  });
}
