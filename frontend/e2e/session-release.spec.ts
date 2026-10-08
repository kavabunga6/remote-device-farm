import { expect, test, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const session = {
  id: sessionId, ownerId: 'u1', ownerName: 'admin', hostId: 'h1', hostName: 'worker-01',
  profileId: 'a11-gpu', profileName: 'Android 11 · NVIDIA GPU', state: 'running', orientation: 'portrait',
  audioEnabled: false, networkEnabled: true, createdAt: '2026-01-01T00:00:00Z', label: null,
  idleExpiresAt: '2099-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
};

type SessionIdentity = { label?: string | null; profileName?: string; profileId?: string };

async function fixture(page: Page, options: {
  failFirst?: boolean; identity?: SessionIdentity; inventoryIdentity?: SessionIdentity;
  emptyInventory?: boolean; released?: boolean;
} = {}) {
  const device = { ...session, ...options.identity };
  const inventoryDevice = { ...device, ...options.inventoryIdentity };
  let accepted = false, requests = 0, blockedInventoryReads = 0;
  let finishInventory!: () => void;
  const inventoryGate = new Promise<void>(resolve => { finishInventory = resolve; });
  const release = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    requests++;
    if (options.failFirst && requests === 1) {
      await route.fulfill({ status: 503, json: { error: { code: 'stop_unavailable', message: 'Не удалось принять запрос остановки. Повторите попытку.' } } });
      return;
    }
    accepted = true;
    await route.fulfill({ status: 202, json: { ok: true, released: options.released ?? false } });
  };
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/sessions/' + sessionId, async route => {
    if (route.request().method() === 'DELETE') return release(route);
    await route.fulfill({ json: { session: { ...device, state: accepted ? 'stopping' : 'running' } } });
  });
  await page.route('**/api/sessions/' + sessionId + '/kill', release);
  await page.route('**/api/sessions', async route => {
    if (accepted) { blockedInventoryReads++; await inventoryGate; }
    await route.fulfill({ json: { sessions: options.emptyInventory ? [] : [{ ...inventoryDevice, state: accepted ? 'stopping' : 'running' }] } });
  });
  await page.goto('/#/session/' + sessionId);
  await expect(page.getByRole('button', { name: 'Завершить сессию', exact: true })).toBeEnabled();
  return { requests: () => requests, blockedInventoryReads: () => blockedInventoryReads, finishInventory };
}

async function confirmStop(page: Page, force = false) {
  if (force) {
    await page.locator('.session-more-actions > summary').click();
    await page.getByRole('button', { name: 'Освободить слот принудительно', exact: true }).click();
  } else await page.getByRole('button', { name: 'Завершить сессию', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: force ? 'Принудительно остановить?' : 'Завершить сессию?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: force ? 'Освободить принудительно' : 'Завершить сессию', exact: true }).click();
  return dialog;
}

async function expectReleaseToast(page: Page, identity: string, released = false) {
  const toast = page.locator('.notification-toast');
  await expect(toast).toHaveCount(1);
  await expect(toast.locator('.notification-title')).toHaveText(released ? 'Слот освобождён' : 'Сессия завершается');
  await expect(toast.locator('.notification-message')).toHaveText(
    `${identity} · #${sessionId.slice(0, 8)}. ${released ? 'Данные сеанса удалены.' : 'Остановка и очистка выполняются в фоне.'}`,
  );
}

for (const force of [false, true]) {
  test(`${force ? 'force release' : 'release'} returns to a usable overview before a delayed inventory refresh and background stop complete`, async ({ page }) => {
    if (!force) {
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
        theme: 'dark', fontFamily: 'system', fontScale: 1.5, defaultAdbKeyId: null,
      } } }));
    }
    const label = 'Проверка оплаты';
    // The session view has the latest rename while the dashboard inventory is still stale.
    const state = await fixture(page, { identity: { label }, inventoryIdentity: { label: 'Старое имя' } });
    try {
      await confirmStop(page, force);
      await expect(page).toHaveURL(/#\/overview$/);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.locator('.session-layout')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Сессии', exact: true })).toBeVisible();
      await expect.poll(state.blockedInventoryReads).toBeGreaterThan(0);
      expect(state.requests()).toBe(1);
      await expectReleaseToast(page, label);
      if (!force) {
        await page.locator('.notification-toast').hover();
        await page.screenshot({ path: '../.tmp-ui/session-release/release-toast-dark-150.png' });
      }
      const card = page.locator('.overview-sessions .session-card').first();
      await expect(card).toContainText('Останавливается');
      await expect(card.locator('.card-primary-action')).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Освободить слот', exact: true })).toBeDisabled();
      // The refresh is still unresolved here. Other work must be possible immediately.
      await page.getByRole('button', { name: 'Новая сессия', exact: true }).click();
      const newSession = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
      await expect(newSession).toBeVisible();
      await newSession.getByRole('button', { name: 'Закрыть', exact: true }).click();
      state.finishInventory();
      await expect(card).toContainText('Останавливается');
      await expect(page).toHaveURL(/#\/overview$/);
      expect(state.requests()).toBe(1);
    } finally { state.finishInventory(); }
  });
}

test('a rejected stop keeps the current session and confirmation available for retry', async ({ page }) => {
  const state = await fixture(page, { failFirst: true });
  try {
    const dialog = await confirmStop(page);
    await expect(dialog.getByRole('alert')).toHaveText('Не удалось принять запрос остановки. Повторите попытку.');
    await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
    await expect(page.locator('.session-layout')).toBeVisible();
    await expect(page.locator('.session-heading .status-badge')).toHaveText('Работает');
    const retry = dialog.getByRole('button', { name: 'Завершить сессию', exact: true });
    await expect(retry).toBeEnabled();
    expect(state.requests()).toBe(1);
    expect(state.blockedInventoryReads()).toBe(0);
    await retry.click();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.overview-sessions .session-card').first()).toContainText('Останавливается');
    expect(state.requests()).toBe(2);
  } finally { state.finishInventory(); }
});

for (const scenario of [
  { name: 'uses the device profile name without inventory', identity: { label: null }, expected: session.profileName, released: false },
  { name: 'falls back to session ID when no name is available', identity: { label: null, profileName: '', profileId: 'unlisted-profile' }, expected: 'Сессия', released: true },
]) {
  test(`release toast ${scenario.name}`, async ({ page }) => {
    const state = await fixture(page, { identity: scenario.identity, emptyInventory: true, released: scenario.released });
    try {
      await confirmStop(page);
      await expect(page).toHaveURL(/#\/overview$/);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect.poll(state.blockedInventoryReads).toBeGreaterThan(0);
      await expectReleaseToast(page, scenario.expected, scenario.released);
      expect(state.requests()).toBe(1);
    } finally { state.finishInventory(); }
  });
}
