import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, acceptedCount: number, delayInventory = false) {
  let sessions: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let inventoryReads = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions', async route => {
    if (!sessions.length) {
      const body = await (await route.fetch()).json();
      sessions = Array.from({ length: 3 }, (_, index) => ({ ...body.sessions[0], id: 'cbd55091-aaaa-bbbb-cccc-00000000000' + (index + 1), profileName: 'Android ' + (11 + index) }));
    }
    if (requests.length) { inventoryReads++; if (delayInventory) await gate; }
    await route.fulfill({ json: { sessions } });
  });
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    requests.push(id);
    const index = sessions.findIndex(session => session.id === id);
    if (index < acceptedCount) {
      sessions[index] = { ...sessions[index], state: 'stopping' };
      await route.fulfill({ status: 202, json: { ok: true, released: false } });
    } else await route.fulfill({ status: 503, json: { error: { code: 'stop_unavailable', message: 'Service unavailable' } } });
  });
  await page.goto('/');
  await page.locator('.bulk-actions button').first().click();
  return { requests, finish, inventoryReads: () => inventoryReads };
}

test('failed bulk release remains actionable and identifies every rejected session', async ({ page }) => {
  const state = await fixture(page, 0);
  await page.locator('.bulk-actions button').first().click();
  const toast = page.locator('.notification-toast');
  await expect(toast.locator('.notification-title')).toHaveText('Не все сессии удалось остановить');
  await expect(toast).toContainText('Принято: 0. Не удалось: 3.');
  await expect(page.locator('.bulk-actions button').first()).toHaveText('Да, завершить все');
  await toast.locator('.notification-details-toggle').click();
  for (const version of [11, 12, 13]) await expect(toast).toContainText('Android ' + version);
  expect(state.requests).toHaveLength(3);
});

test('partial release marks accepted sessions as stopping before a slow inventory refresh', async ({ page }) => {
  const state = await fixture(page, 2, true);
  try {
    await page.locator('.bulk-actions button').first().click();
    const toast = page.locator('.notification-toast');
    await expect(toast.locator('.notification-title')).toHaveText('Не все сессии удалось остановить');
    await expect(toast).toContainText('Принято: 2. Не удалось: 1.');
    await expect(page.locator('.session-card .status-stopping')).toHaveCount(2);
    await expect.poll(state.inventoryReads).toBeGreaterThan(0);
    expect(state.requests).toHaveLength(3);
    await expect(page.locator('.session-card').filter({ hasText: 'Android 13' }).locator('.session-card-release')).toBeEnabled();
  } finally { state.finish(); }
});

test('accepted bulk release replaces pending feedback before inventory returns', async ({ page }) => {
  const state = await fixture(page, 3, true);
  try {
    await page.locator('.bulk-actions button').first().click();
    await expect(page.locator('.notification-title')).toHaveText('Запросы остановки приняты');
    await expect(page.locator('.notification-toast')).toContainText('Остановка и очистка выполняются в фоне.');
    await expect(page.locator('.bulk-actions')).toHaveCount(0);
    await expect.poll(state.inventoryReads).toBeGreaterThan(0);
    expect(state.requests).toHaveLength(3);
  } finally { state.finish(); }
});
