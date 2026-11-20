import { expect, test } from '@playwright/test';
import path from 'node:path';

for (const [theme, language] of [['light', 'ru'], ['dark', 'en']] as const) {
  test(`provider failure and recovery remain visible in ${theme}/${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript(lang => localStorage.setItem('rdf.language', lang), language);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: 1 } } }));
    await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
    let ready = false;
    let hostId = '';
    await page.route('**/api/hosts', async route => {
      const body = await (await route.fetch()).json();
      const host = body.hosts[0]; hostId = host.id;
      await route.fulfill({ json: { hosts: [{ ...host, status: 'online', lastSeenAt: new Date().toISOString(), devices: [],
        providers: [{ kind: 'emulator', platform: 'android', status: 'ready', code: null },
          { kind: 'usb-android', platform: 'android', status: ready ? 'ready' : 'unavailable', code: ready ? null : 'inventory-unavailable' }],
      }] } });
    });
    await page.goto('/#/admin/nodes');
    const warning = page.locator('.node-overview .node-provider-row[data-state=unavailable]');
    await expect(warning).toContainText('USB Android');
    await page.evaluate(id => { window.location.hash = '/admin/nodes?host=' + encodeURIComponent(id); }, hostId);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const status = dialog.locator('.node-provider-status');
    await expect(status.locator('[data-state=unavailable]')).toContainText(language === 'ru' ? 'Не удалось получить список устройств' : 'Could not list devices');
    const alignment = await status.locator('.node-provider-row>div').evaluateAll(rows => rows.map(row => {
      const [name, state] = row.children;
      const nameBox = name.getBoundingClientRect(), stateBox = state.getBoundingClientRect();
      return { delta: Math.abs(nameBox.y - stateBox.y), overlap: nameBox.right > stateBox.left };
    }));
    expect(alignment.every(row => row.delta < 2 && !row.overlap)).toBe(true);
    if (process.env.UI_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.UI_CAPTURE_DIR, 'providers-' + theme + '.png') });
    ready = true;
    await page.reload();
    await expect(page.getByRole('dialog').locator('.node-provider-row[data-state=ready]')).toHaveCount(2);
    await expect(page.getByRole('dialog').locator('.node-provider-row[data-state=unavailable]')).toHaveCount(0);
  });
}

for (const theme of ['light', 'dark'] as const) test(`emulator outage removes runnable slots and recovery restores them: ${theme}`, async ({ page }) => {
  let ready = false;
  await page.emulateMedia({ colorScheme: theme });
  await page.route('**/api/me/notifications', r => r.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const host = (await (await route.fetch()).json()).hosts[0];
    await route.fulfill({ json: { hosts: [{ ...host, status: 'online', disabled: false, lastSeenAt: new Date().toISOString(), slots: 2, usedSlots: 0,
      providers: [{ kind: 'emulator', platform: 'android', status: ready ? 'ready' : 'unavailable', code: ready ? null : 'maintenance-unavailable' }] }] } });
  });
  await page.goto('/#/admin/nodes');
  await expect(page.locator('.node-pool-summary')).toContainText('0 / 0');
  await expect(page.locator('.host-slot')).toHaveCount(0);
  await expect(page.locator('.host-card-footer')).toContainText('Нет доступных слотов');
  ready = true; await page.reload();
  await expect(page.locator('.node-pool-summary')).toContainText('2 / 2');
  await expect(page.locator('.host-slot')).toHaveCount(2);
});

for (const theme of ['light', 'dark'] as const) test(`stale USB inventory is unavailable without erasing busy or quarantined devices: ${theme}`, async ({ page }) => {
  let fresh = false; await page.emulateMedia({ colorScheme: theme });
  await page.route('**/api/me/notifications', r => r.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const host = (await (await route.fetch()).json()).hosts[0];
    await route.fulfill({ json: { hosts: [{ ...host, status: 'online', disabled: false, lastSeenAt: new Date(Date.now() - (fresh ? 0 : 960_000)).toISOString(),
      devices: ['free', 'busy', 'quarantined'].map(state => ({ kind: 'usb-android', id: 'phone-' + state, state, model: state, reason: null })) }] } });
  });
  await page.goto('/#/admin/nodes');
  const inventory = page.locator('.device-inventory');
  await expect(inventory.locator('.device-state-offline')).toHaveCount(1);
  await expect(inventory.locator('.device-state-busy')).toHaveCount(1);
  await expect(inventory.locator('.device-state-quarantined')).toHaveCount(1);
  fresh = true; await page.reload();
  await expect(inventory.locator('.device-state-free')).toHaveCount(1);
});

test('paused nodes permit administrator cleanup while a lost heartbeat disables it', async ({ page }) => {
  let fresh = true;
  await page.route('**/api/me/notifications', r => r.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const host = (await (await route.fetch()).json()).hosts[0];
    await route.fulfill({ json: { hosts: [{ ...host, status: 'online', disabled: true, lastSeenAt: new Date(Date.now() - (fresh ? 0 : 960_000)).toISOString(),
      devices: [{ kind: 'usb-android', id: 'quarantined-phone', model: 'Phone', state: 'quarantined', reason: null }] }] } });
  });
  await page.goto('/#/admin/nodes');
  const retry = page.locator('.device-inventory').getByRole('button');
  await expect(retry).toBeEnabled();
  fresh = false; await page.reload();
  await expect(retry).toBeDisabled();
  await expect(page.locator('.device-state-quarantined')).toHaveCount(1);
});
