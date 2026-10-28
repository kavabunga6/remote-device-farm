import { expect, test, type Page } from '@playwright/test';

const fixtures = [
  { id: 'delete-enabled', name: 'Android 13 · Google APIs · Pixel 6 Pro', androidVersion: '13', apiLevel: 33, enabled: true },
  { id: 'delete-disabled', name: 'Android 10 · AOSP · Архивный профиль для автоматизации', androidVersion: '10', apiLevel: 29, enabled: false },
].map(profile => ({ ...profile, abi: 'x86_64', image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64:latest', cpu: 4, memoryMb: 4096, guestCores: 2, guestMemoryMb: 2048, diskGb: 16, gpuMode: 'software', deviceModel: 'Pixel 6', resolution: '1080x1920' }));

async function mockProfiles(page: Page, inUse = false) {
  let profiles = fixtures.map(profile => ({ ...profile }));
  const mutations: string[] = [];
  let inventoryReads = 0;
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route(/\/api\/(admin\/)?profiles$/, route => {
    inventoryReads++;
    return route.fulfill({ json: { profiles: route.request().url().includes('/admin/') ? profiles : profiles.filter(profile => profile.enabled) } });
  });
  await page.route(/\/api\/admin\/profiles\/[^/]+(?:\/permanent)?$/, route => {
    const request = route.request();
    if (request.method() !== 'DELETE') return route.continue();
    const pathname = new URL(request.url()).pathname;
    mutations.push(pathname);
    const id = decodeURIComponent(pathname.split('/')[4]!);
    if (pathname.endsWith('/permanent')) {
      if (inUse) return route.fulfill({ status: 409, json: { error: { code: 'profile_in_use', message: 'Profile is used by active sessions or queued requests' } } });
      profiles = profiles.filter(profile => profile.id !== id);
    } else profiles = profiles.map(profile => profile.id === id ? { ...profile, enabled: false } : profile);
    return route.fulfill({ json: { ok: true } });
  });
  return { mutations, reads: () => inventoryReads };
}
const cardFor = (page: Page, name: string) => page.locator('.admin-profile-row').filter({ has: page.getByRole('button', { name: `Изменить профиль «${name}»`, exact: true }) });
const deleteDialog = (page: Page) => page.getByRole('alertdialog', { name: 'Удалить профиль?', exact: true });

for (const profile of fixtures) {
  test(`permanent deletion removes an ${profile.enabled ? 'enabled' : 'disabled'} profile after inventory refresh`, async ({ page }) => {
    const state = await mockProfiles(page);
    await page.goto('/#/admin/profiles');
    const card = cardFor(page, profile.name);
    await expect(card.getByRole('button', { name: profile.enabled ? 'Отключить' : 'Включить', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Удалить', exact: true }).click();
    const dialog = deleteDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.admin-action-target')).toContainText(profile.name);
    await expect(dialog.locator('.admin-action-target')).toContainText(profile.id);
    const reads = state.reads();
    await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect.poll(state.reads).toBeGreaterThan(reads);
    expect(state.mutations).toEqual([`/api/admin/profiles/${profile.id}/permanent`]);
    await expect(page.locator('.admin-profile-row')).toHaveCount(fixtures.length - 1);
  });
}

test('disable keeps the profile in the catalog and uses the existing endpoint', async ({ page }) => {
  const state = await mockProfiles(page);
  await page.goto('/#/admin/profiles');
  const card = cardFor(page, fixtures[0]!.name);
  await card.getByRole('button', { name: 'Отключить', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Отключить профиль?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отключить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Включить', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Удалить', exact: true })).toBeVisible();
  expect(state.mutations).toEqual([`/api/admin/profiles/${fixtures[0]!.id}`]);
});

test('in-use deletion shows a localized explanation and leaves confirmation open', async ({ page }) => {
  const state = await mockProfiles(page, true);
  await page.goto('/#/admin/profiles');
  const card = cardFor(page, fixtures[0]!.name);
  await card.getByRole('button', { name: 'Удалить', exact: true }).click();
  const dialog = deleteDialog(page);
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(/сесси/);
  await expect(dialog.getByRole('alert')).toContainText(/очеред/);
  await expect(dialog.getByRole('alert')).not.toContainText('Profile is used');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Удалить', exact: true })).toBeEnabled();
  await expect(card).toHaveCount(1);
  expect(state.mutations).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Удалить', exact: true })).toBeFocused();
});

for (const [scenario, theme, width, fontScale] of [
  ['light', 'light', 1280, 1], ['dark', 'dark', 1280, 1], ['narrow', 'light', 390, 1], ['zoom', 'light', 1280, 1.25],
] as const) {
  test(`delete confirmation and row actions are aligned in ${scenario}`, async ({ page }) => {
    const state = await mockProfiles(page);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale, defaultAdbKeyId: null } } }));
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/#/admin/profiles');
    await expect(page.locator('.admin-profile-row')).toHaveCount(fixtures.length);
    await page.evaluate(() => document.fonts.ready);
    for (const profile of fixtures) {
      const card = cardFor(page, profile.name);
      const bounds = await card.locator('.admin-profile-actions button').evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        return { y: box.y, bottom: box.bottom, right: box.right, left: box.left };
      }));
      expect(bounds).toHaveLength(3);
      expect(Math.abs(bounds[0]!.y - bounds[1]!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds[0]!.bottom - bounds[1]!.bottom)).toBeLessThanOrEqual(1);
      expect(bounds[0]!.right).toBeLessThanOrEqual(bounds[1]!.left);
    }
    const opener = cardFor(page, fixtures[1]!.name).getByRole('button', { name: 'Удалить', exact: true });
    await opener.click();
    const dialog = deleteDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
    const geometry = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const bounds = (selector: string) => {
        const box = element.querySelector(selector)!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, center: box.top + box.height / 2 };
      };
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overflow: element.scrollWidth - element.clientWidth, title: bounds('h2'), icon: bounds('.confirm-icon'), actions: [...element.querySelectorAll('.modal-actions button')].map(button => { const box = button.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; }) };
    });
    await page.screenshot({ path: `../.tmp-ui/profile-delete-${scenario}.png` });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width + 1);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(801);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.icon.right).toBeLessThanOrEqual(geometry.title.left);
    expect(Math.abs(geometry.icon.center - geometry.title.center)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.actions[0]!.top - geometry.actions[1]!.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.actions[0]!.bottom - geometry.actions[1]!.bottom)).toBeLessThanOrEqual(1);
    expect(geometry.actions[0]!.right).toBeLessThanOrEqual(geometry.actions[1]!.left);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(state.mutations).toEqual([]);
    await expect(page.locator('.admin-profile-row')).toHaveCount(fixtures.length);
  });
}
