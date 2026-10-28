import { expect, test, type Page } from '@playwright/test';

const initialPreferences = { theme: 'light', fontFamily: 'system', fontScale: 0, defaultAdbKeyId: null };
const initialProfile = { id: 'u1', username: 'admin', displayName: 'admin', role: 'admin', provider: 'local', firstName: 'Алексей', lastName: 'Тестовый', company: 'Device Farm', jobTitle: 'QA-инженер', managedByProvider: false };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function mockAccount(page: Page) {
  await page.addInitScript(() => localStorage.setItem('rdf.language', 'ru'));
  await page.route('**/api/me/profile', route => route.fulfill({ json: { profile: initialProfile } }));
  await page.route('**/api/me/rentals?*', route => route.fulfill({ json: { rentals: [], nextCursor: null } }));
  await page.route('**/api/me/preferences*', route => route.fulfill({ json: { preferences: initialPreferences } }));
}
const appearance = (page: Page) => page.locator('#settings-appearance');
const theme = (page: Page, name: string) => appearance(page).getByRole('radio', { name, exact: true });

test('a rental-history failure preserves profile fields and appearance, then retries independently', async ({ page }) => {
  await mockAccount(page);
  let failHistory = true;
  let savedProfile: Record<string, unknown> | null = null;
  await page.route('**/api/me/rentals?*', route => failHistory
    ? route.fulfill({ status: 500, json: { error: 'Rental history unavailable' } })
    : route.fulfill({ json: { rentals: [], nextCursor: null } }));
  await page.route('**/api/me/profile', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { profile: initialProfile } });
    savedProfile = route.request().postDataJSON();
    return route.fulfill({ json: { profile: { ...initialProfile, ...savedProfile } } });
  });
  await page.goto('/#/account/profile');
  const form = page.locator('#settings-profile');
  await expect(form.getByRole('textbox', { name: 'Имя', exact: true })).toHaveValue(initialProfile.firstName);
  await expect(form.getByRole('textbox', { name: 'Фамилия' })).toHaveValue(initialProfile.lastName);
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Компания' }).fill('New company');
  await form.getByRole('button', { name: 'Сохранить данные' }).click();
  await expect.poll(() => savedProfile).toEqual({ firstName: initialProfile.firstName, lastName: initialProfile.lastName, company: 'New company', jobTitle: initialProfile.jobTitle });
  await page.locator('.settings-nav').getByRole('button', { name: 'Оформление', exact: true }).click();
  await expect(theme(page, 'Светлая')).toBeEnabled();
  await expect(theme(page, 'Светлая')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.settings-nav').getByRole('button', { name: 'История аренд' }).click();
  await expect(page.locator('#settings-history').getByRole('alert')).toBeVisible();
  failHistory = false;
  await page.locator('#settings-history').getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('#settings-history').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#settings-history .settings-history-empty')).toHaveText('Пока нет арендованных устройств.');
});

test('a failed profile cannot submit empty fields while other account sections still work', async ({ page }) => {
  await mockAccount(page);
  let failProfile = true, mutations = 0;
  await page.route('**/api/me/profile', route => {
    if (route.request().method() !== 'GET') { mutations++; return route.fulfill({ json: { profile: initialProfile } }); }
    return failProfile ? route.fulfill({ status: 403, json: { error: 'Access denied' } }) : route.fulfill({ json: { profile: initialProfile } });
  });
  await page.goto('/#/account/profile');
  const panel = page.locator('#settings-profile');
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Сохранить данные' })).toBeDisabled();
  for (const field of await panel.getByRole('textbox').all()) await expect(field).toBeDisabled();
  expect(mutations).toBe(0);
  await page.locator('.settings-nav').getByRole('button', { name: 'Оформление', exact: true }).click();
  await expect(theme(page, 'Тёмная')).toBeEnabled();
  await page.locator('.settings-nav').getByRole('button', { name: 'Профиль', exact: true }).click();
  failProfile = false;
  await panel.getByRole('button', { name: 'Повторить' }).click();
  await expect(panel.getByRole('textbox', { name: 'Имя', exact: true })).toHaveValue(initialProfile.firstName);
  await expect(panel.getByRole('button', { name: 'Сохранить данные' })).toBeEnabled();
});

test('a preference-loading failure leaves profile usable and retries without writing defaults', async ({ page }) => {
  await mockAccount(page);
  let failPreferences = true, writes = 0;
  await page.route('**/api/me/preferences*', route => {
    if (route.request().method() === 'PATCH') { writes++; return route.fulfill({ json: { preferences: initialPreferences } }); }
    return failPreferences ? route.fulfill({ status: 500, json: { error: 'Preferences unavailable' } }) : route.fulfill({ json: { preferences: { ...initialPreferences, theme: 'dark' } } });
  });
  await page.goto('/#/account/profile');
  await expect(page.locator('#settings-profile').getByRole('textbox', { name: 'Имя', exact: true })).toHaveValue(initialProfile.firstName);
  await page.locator('.settings-nav').getByRole('button', { name: 'Оформление', exact: true }).click();
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(theme(page, 'Тёмная')).toBeDisabled();
  expect(writes).toBe(0);
  failPreferences = false;
  await appearance(page).getByRole('button', { name: 'Повторить' }).click();
  await expect(theme(page, 'Тёмная')).toBeEnabled();
  await expect(theme(page, 'Тёмная')).toHaveAttribute('aria-checked', 'true');
});

for (const firstStatus of [200, 500]) {
  test(`appearance serializes requests and ignores an outdated ${firstStatus} response`, async ({ page }) => {
    await mockAccount(page);
    const first = deferred(), second = deferred();
    const requests: Array<Record<string, unknown>> = [];
    let stored = { ...initialPreferences }, active = 0, maximumActive = 0;
    await page.route('**/api/me/preferences*', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { preferences: stored } });
      const patch = route.request().postDataJSON(); requests.push(patch);
      active++; maximumActive = Math.max(maximumActive, active);
      const index = requests.length;
      await (index === 1 ? first.promise : second.promise);
      if (index === 1 && firstStatus === 500) await route.fulfill({ status: 500, json: { error: 'Earlier save failed' } });
      else { stored = { ...stored, ...patch }; await route.fulfill({ json: { preferences: stored } }); }
      active--;
    });
    try {
      await page.goto('/#/account/appearance');
      await theme(page, 'Тёмная').click();
      await expect.poll(() => requests.length).toBe(1);
      await theme(page, 'Светлая').click();
      await theme(page, '130%').click();
      await page.waitForTimeout(650);
      expect(requests).toHaveLength(1);
      await expect(theme(page, 'Светлая')).toHaveAttribute('aria-checked', 'true');
      await expect(theme(page, '130%')).toHaveAttribute('aria-checked', 'true');
      await expect(appearance(page).locator('.appearance-status')).toHaveText('Сохраняем…');
      first.resolve();
      await expect.poll(() => requests.length).toBe(2);
      await expect(appearance(page).getByRole('alert')).toHaveCount(0);
      await expect(appearance(page).locator('.appearance-status')).toHaveText('Сохраняем…');
      await expect(theme(page, 'Светлая')).toHaveAttribute('aria-checked', 'true');
      second.resolve();
      await expect(appearance(page).locator('.appearance-status')).toHaveText('Сохранено');
      expect(maximumActive).toBe(1);
      expect(stored).toMatchObject({ theme: 'light', fontScale: 1.3 });
      await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'light');
      await expect(page.locator('html')).toHaveCSS('font-size', '20.8px');
    } finally { first.resolve(); second.resolve(); }
  });
}

test('leaving before the debounce flushes the choice, and returning waits for that write', async ({ page }) => {
  await mockAccount(page);
  const reply = deferred();
  let writes = 0, stored = { ...initialPreferences };
  await page.route('**/api/me/preferences*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { preferences: stored } });
    writes++;
    const patch = route.request().postDataJSON();
    await reply.promise; stored = { ...stored, ...patch };
    await route.fulfill({ json: { preferences: stored } });
  });
  try {
    await page.goto('/#/account/appearance');
    await theme(page, 'Тёмная').click();
    await page.evaluate(() => { window.location.hash = '/overview'; });
    await expect(page.locator('.user-settings-page')).toHaveCount(0);
    await expect.poll(() => writes).toBe(1);
    await page.evaluate(() => { window.location.hash = '/account/appearance'; });
    await expect(theme(page, 'Тёмная')).toBeDisabled();
    reply.resolve();
    await expect(theme(page, 'Тёмная')).toBeEnabled();
    await expect(theme(page, 'Тёмная')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
    expect(writes).toBe(1);
  } finally { reply.resolve(); }
});

test('the latest failed preference remains selected and can be retried', async ({ page }) => {
  await mockAccount(page);
  let fail = true;
  await page.route('**/api/me/preferences*', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { preferences: initialPreferences } });
    return fail ? route.fulfill({ status: 500, json: { error: 'Save unavailable' } })
      : route.fulfill({ json: { preferences: { ...initialPreferences, ...route.request().postDataJSON() } } });
  });
  await page.goto('/#/account/appearance');
  await theme(page, 'Тёмная').click();
  await expect(appearance(page).getByRole('alert')).toBeVisible();
  await expect(theme(page, 'Тёмная')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
  fail = false;
  await appearance(page).getByRole('button', { name: 'Повторить' }).click();
  await expect(appearance(page).locator('.appearance-status')).toHaveText('Сохранено');
  await expect(appearance(page).getByRole('alert')).toHaveCount(0);
});

test('a queued account write never applies to a different signed-in user', async ({ page }) => {
  await mockAccount(page);
  const firstReply = deferred();
  let userId = 'u1', writes = 0, rejected = 0;
  await page.route('**/api/me', route => {
    return route.fulfill({ json: { user: { id: userId, username: userId, displayName: userId, role: 'admin' } } });
  });
  await page.route('**/api/me/preferences*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { preferences: initialPreferences } });
    const patch = route.request().postDataJSON();
    if (patch.expectedUserId !== userId) {
      rejected++;
      return route.fulfill({ status: 409, json: { error: { code: 'account_changed', message: 'The account has changed. Try the action again.' } } });
    }
    writes++;
    await firstReply.promise;
    await route.fulfill({ json: { preferences: { ...initialPreferences, ...patch } } });
  });
  try {
    await page.goto('/#/account/appearance');
    await theme(page, 'Тёмная').click();
    await expect.poll(() => writes).toBe(1);
    await theme(page, 'Светлая').click();
    await page.waitForTimeout(650);
    userId = 'u2'; firstReply.resolve();
    await expect.poll(() => rejected).toBe(1);
    await expect(appearance(page).getByRole('alert')).toContainText('Аккаунт изменился. Повторите действие.');
    await expect(appearance(page).locator('.appearance-status')).not.toHaveText('Сохраняем…');
    expect(writes).toBe(1);
    await expect(theme(page, 'Светлая')).toHaveAttribute('aria-checked', 'true');
  } finally { firstReply.resolve(); }
});
