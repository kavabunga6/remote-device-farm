import { openLaunchSection } from './launch-controls';
import { test, expect, type Page } from '@playwright/test';
const profile = { id: 'launch-qa', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30,
  abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis', image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',
  cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 8, diskMaxGb: 128, sdcardGb: 0, sdcardMaxGb: 32, gpuMode: 'software', enabled: true, emulatorParams: '-no-snapshot' };
async function fixture(page: Page, occupied = false) {
  const state = { requests: [] as Record<string, unknown>[] };
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [profile] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: 'dark', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/me/adb-public-keys', route => route.fulfill({ json: { keys: [{ id: 'selected-key', name: 'Мой ноутбук', fingerprint: 'fingerprint', createdAt: new Date().toISOString() }] } }));
  await page.route('**/api/me/adb-key', route => route.fulfill({ json: { key: null } }));
  await page.route('**/api/hosts', async route => { const response = await route.fetch(); const body = await response.json(); for (const host of body.hosts) host.usedSlots = occupied ? host.slots : 0; await route.fulfill({ json: body }); });
  for (const path of ['sessions', 'queue']) await page.route('**/api/' + path, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: path === 'sessions' ? { sessions: [] } : { entries: [], maxEntries: 3 } });
    state.requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: { code: 'invalid_launch_options', message: 'Invalid launch options in test' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: occupied ? 'Встать в очередь' : 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog');
  const settings = modal.locator('.create-settings');
  if (!await settings.evaluate(element => (element as HTMLDetailsElement).open)) await settings.locator(':scope > summary').click();
  await openLaunchSection(modal, 'connection');
  await openLaunchSection(modal, 'storage');
  await expect(modal.getByRole('combobox', { name: 'Ключ ADB', exact: true })).toBeEnabled();
  return state;
}
for (const occupied of [false, true]) test(`launch options and chosen ADB key reach ${occupied ? 'queue' : 'direct session'} API`, async ({ page }) => {
  const state = await fixture(page, occupied), modal = page.getByRole('dialog');
  await modal.getByLabel('Раздел данных, ГБ', { exact: true }).fill('24');
  await modal.getByLabel('SD-карта, ГБ', { exact: true }).fill('4');
  await modal.getByRole('combobox', { name: 'Ключ ADB', exact: true }).selectOption('selected-key');
  await modal.locator('.create-advanced-settings > summary').click();
  await modal.getByLabel('Аргументы эмулятора', { exact: true }).fill('-no-boot-anim');
  await modal.getByRole('button', { name: occupied ? 'Встать в очередь' : 'Запустить', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0]).toMatchObject({ profileId: profile.id, adbKeyId: 'selected-key', gpuMode: 'software', launchOptions: { diskGb: 24, sdCardMb: 4096, emulatorParams: '-no-boot-anim' } });
  await expect(modal.locator('.create-error')).toContainText('Проверьте размеры хранилища');
});
test('desktop dialog aligns fields and keeps launch action in view', async ({ page }, testInfo) => {
  await fixture(page); const modal = page.getByRole('dialog');
  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    const box = await modal.boundingBox(), button = await modal.getByRole('button', { name: 'Запустить', exact: true }).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1180); expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThan(size.height);
    expect(await modal.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const disk = await modal.getByLabel('Раздел данных, ГБ', { exact: true }).boundingBox(), sd = await modal.getByLabel('SD-карта, ГБ', { exact: true }).boundingBox();
    expect(Math.abs(disk!.y - sd!.y)).toBeLessThan(1); expect(Math.abs(disk!.width - sd!.width)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath(`launch-${size.width}.png`), fullPage: true });
  }
});


test('reset is a button enabled only for changed resources, storage or arguments', async ({ page }) => {
  await fixture(page);
  const modal = page.getByRole('dialog');
  const reset = modal.getByRole('button', { name: 'Сбросить', exact: true });
  const cpu = modal.getByLabel('Лимит CPU на узле', { exact: true });
  const disk = modal.getByLabel('Раздел данных, ГБ', { exact: true });
  await expect(reset).toHaveClass(/button outline/);
  await expect(reset).toBeDisabled();
  await cpu.fill('2');
  await expect(reset).toBeEnabled();
  await cpu.fill(String(profile.cpu));
  await expect(reset).toBeDisabled();
  await disk.fill('24');
  await expect(reset).toBeEnabled();
  await disk.fill(String(profile.diskGb));
  await expect(reset).toBeDisabled();
  await modal.locator('.create-advanced-settings > summary').click();
  const args = modal.getByLabel('Аргументы эмулятора', { exact: true });
  await args.fill('  -no-snapshot  ');
  await expect(reset).toBeDisabled();
  await args.fill('-no-boot-anim');
  await expect(reset).toBeEnabled();
  await cpu.fill('2');
  await disk.fill('24');
  await reset.click();
  await expect(cpu).toHaveValue(String(profile.cpu));
  await expect(disk).toHaveValue(String(profile.diskGb));
  await expect(args).toHaveValue(profile.emulatorParams);
  await expect(reset).toBeDisabled();
});
