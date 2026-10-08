import { expect, test, type Page } from '@playwright/test';

const profiles = [
  { id: 'deep-link-first', name: 'Android 10 · AOSP', enabled: false, androidVersion: '10', apiLevel: 29 },
  { id: 'deep-link-second', name: 'Android 11 · Google APIs', enabled: true, androidVersion: '11', apiLevel: 30 },
].map(profile => ({ ...profile, abi: 'x86_64', image: 'us-docker.pkg.dev/android-emulator-268719/images/29-aosp-x64-no-metrics:latest', cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 16, gpuMode: 'software', gpuImage: '', gpuMemoryMb: 4096, emulatorParams: '' }));

async function setup(page: Page, ready = Promise.resolve()) {
  const state = { profiles: profiles.map(profile => ({ ...profile })), writes: [] as Array<{ id: string; body: Record<string, unknown> }> };
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/admin/profiles', async route => { await ready; return route.fulfill({ json: { profiles: state.profiles } }); });
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: state.profiles.filter(profile => profile.enabled) } }));
  await page.route(/\/api\/admin\/profiles\/[^/]+$/, route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const body = route.request().postDataJSON();
    state.writes.push({ id, body });
    state.profiles = state.profiles.map(profile => profile.id === id ? { ...profile, ...body } : profile);
    return route.fulfill({ json: { profile: state.profiles.find(profile => profile.id === id) } });
  });
  return state;
}
const editor = (page: Page) => page.getByRole('dialog', { name: 'Изменить профиль', exact: true });
const profileLink = (id: string) => '/#/admin/profiles?profile=' + encodeURIComponent(id);

test('legacy profile settings link waits for inventory and closing clears only editor parameters', async ({ page }, testInfo) => {
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  let resolveInventory!: () => void;
  const ready = new Promise<void>(resolve => { resolveInventory = resolve; });
  await setup(page, ready);
  await page.goto(profileLink(profiles[0]!.id) + '&section=gpu&from=launch');
  await expect(editor(page)).toHaveCount(0);
  resolveInventory();
  const modal = editor(page);
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('ID профиля', { exact: true })).toHaveValue(profiles[0]!.id);
  await expect(modal.getByLabel('Поддержка GPU', { exact: true })).toHaveCount(0);
  await expect(modal.getByRole('heading', { name: 'Графика', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('gpu-admin-dark.png') });
  await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page).toHaveURL(/#\/admin\/profiles\?from=launch$/);
  await expect(modal).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Администрирование' }).getByRole('link', { name: 'Профили устройств' }).click();
  await expect(page.locator('.device-profile-card')).toHaveCount(2);
  await expect(page.locator('.device-profile-card').getByText('Ускорение GPU', { exact: true })).toHaveCount(0);
  await expect(modal).toHaveCount(0);
});

test('hash navigation opens the exact profile and resets the previous draft', async ({ page }) => {
  await setup(page);
  await page.goto('/#/admin/profiles');
  await expect(page.locator('.device-profile-card')).toHaveCount(2);
  await expect(page.locator('.device-profile-card').getByText('Ускорение GPU', { exact: true })).toHaveCount(0);
  await page.evaluate(hash => { window.location.hash = hash; }, profileLink(profiles[0]!.id).slice(1));
  const modal = editor(page);
  await expect(modal.getByLabel('Название', { exact: true })).toHaveValue(profiles[0]!.name);
  await modal.getByLabel('Название', { exact: true }).fill('Несохранённый черновик');
  await page.evaluate(hash => { window.location.hash = hash; }, profileLink(profiles[1]!.id).slice(1));
  await expect(modal.getByLabel('ID профиля', { exact: true })).toHaveValue(profiles[1]!.id);
  await expect(modal.getByLabel('Название', { exact: true })).toHaveValue(profiles[1]!.name);
  await page.evaluate(() => { window.location.hash = '#/admin/profiles?profile=does-not-exist'; });
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: `Изменить профиль «${profiles[0]!.name}»`, exact: true }).click();
  await expect(modal.getByLabel('ID профиля', { exact: true })).toHaveValue(profiles[0]!.id);
  await expect(page).toHaveURL(/#\/admin\/profiles$/);
  await modal.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(modal).toHaveCount(0);
});

test('saving a linked profile updates that profile and prevents the editor reopening on refresh', async ({ page }) => {
  const state = await setup(page);
  await page.goto(profileLink(profiles[1]!.id) + '&section=gpu');
  const modal = editor(page);
  await expect(modal.getByLabel('Поддержка GPU', { exact: true })).toHaveCount(0);
  await modal.getByLabel('Название', { exact: true }).fill('Обновлённый профиль');
  await expect(modal.getByLabel('Образ эмулятора для запуска с GPU', { exact: true })).toHaveCount(0);
  await expect(modal.getByLabel('Лимит памяти при включённом GPU, МБ', { exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ id: profiles[1]!.id, body: { name: 'Обновлённый профиль', image: profiles[1]!.image, memoryMb: 4096 } });
  expect(state.writes[0]!.body).not.toHaveProperty('gpuSupport');
  expect(state.writes[0]!.body).not.toHaveProperty('gpuImage');
  expect(state.writes[0]!.body).not.toHaveProperty('gpuMemoryMb');
  expect(state.writes[0]!.body).not.toHaveProperty('gpuMode');
  await expect(page).toHaveURL(/#\/admin\/profiles$/);
  await expect(modal).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Администрирование' }).getByRole('link', { name: 'Профили устройств' }).click();
  await expect(page.locator('.device-profile-card')).toHaveCount(2);
  await expect(page.locator('.device-profile-card').getByText('Ускорение GPU', { exact: true })).toHaveCount(0);
  await expect(modal).toHaveCount(0);
});
