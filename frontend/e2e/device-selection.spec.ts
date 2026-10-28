import { openLaunchSection } from './launch-controls';
import { expect, test, type Page } from '@playwright/test';
import type { Profile } from '../src/api';
const image = 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2';
const profiles: Profile[] = [
  { id: 'device-qa', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30, abi: 'x86_64', imageFlavor: 'google_apis', deviceType: 'mobile', image, cpu: 4, memoryMb: 6144, guestCores: 2, guestMemoryMb: 4096, diskGb: 8, diskMaxGb: 32, sdcardGb: 2, sdcardMaxGb: 8, enabled: true, allowLaunchOverrides: null, launchOverridesAllowed: false },
  { id: 'tablet-qa', name: 'Планшет · Android 11 · Google APIs', androidVersion: '11', apiLevel: 30, abi: 'x86_64', imageFlavor: 'google_apis', deviceType: 'mobile', image, cpu: 4, memoryMb: 6144, guestCores: 2, guestMemoryMb: 4096, diskGb: 8, diskMaxGb: 32, enabled: true, allowLaunchOverrides: true, launchOverridesAllowed: true },
];
async function fixture(page: Page, role: 'user' | 'admin' = 'user', theme = 'light', scale = 1) {
  const requests: Record<string, unknown>[] = [], retiredRequests: string[] = [];
  page.on('request', request => { if (/profile-presets|profiles\/(recommended|frequent)/.test(request.url())) retiredRequests.push(request.url()); });
  await page.route('**/api/me', async route => { const body = await (await route.fetch()).json(); body.user.role = role; await route.fulfill({ json: body }); });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null } } }));
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles } }));
  await page.route('**/api/admin/profiles', route => route.fulfill({ json: { profiles } }));
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { hosts: body.hosts.map((host: Record<string, unknown>) => ({ ...host, lastSeenAt: new Date().toISOString(), slots: 3, usedSlots: 0, slotCpu: 8, slotMemoryMb: 16384, metrics: { ...(host.metrics as object), gpuCapabilities: ['cuda'] } })) } });
  });
  await page.route('**/api/sessions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessions: [] } });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: { code: 'test_only', message: 'Запуск перехвачен тестом' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
  return { modal, requests, retiredRequests };
}

test('one dropdown replaces all presets, with locked parameters and independent GPU selection', async ({ page }) => {
  const { modal, requests, retiredRequests } = await fixture(page);
  await expect(modal.getByRole('combobox', { name: 'Устройство', exact: true })).toHaveValue('device-qa');
  await expect(modal.getByText('Пресеты профилей')).toHaveCount(0);
  await expect(modal.getByRole('tab')).toHaveCount(2);
  await expect(modal.getByRole('button', { name: 'Сохранить пресет' })).toHaveCount(0);
  await expect(modal.getByText('Параметры устройства заданы администратором.', { exact: false })).toBeVisible();
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await expect(modal.getByLabel('Ядра Android', { exact: true })).toHaveCount(0);
  await expect(modal.getByRole('combobox', { name: 'Ключ ADB', exact: true })).toBeEnabled();
  await modal.locator('#create-tab-device').click();
  await modal.getByRole('switch', { name: 'Ускорение GPU' }).check();
  await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ profileId: 'device-qa', gpuMode: 'nvidia', launchOptions: {} });
  expect(retiredRequests).toEqual([]);
});

test('per-profile permission unlocks resources and changing devices discards overrides', async ({ page }) => {
  const { modal, requests } = await fixture(page);
  const device = modal.getByRole('combobox', { name: 'Устройство', exact: true });
  await device.selectOption('tablet-qa');
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await modal.getByLabel('Ядра Android', { exact: true }).fill('1');
  await modal.locator('#create-tab-device').click();
  await modal.getByRole('switch', { name: 'Ускорение GPU' }).check();
  await device.selectOption('device-qa');
  await expect(modal.getByLabel('Ядра Android', { exact: true })).toHaveCount(0);
  await expect(modal.getByRole('switch', { name: 'Ускорение GPU' })).toBeChecked();
  await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ profileId: 'device-qa', gpuMode: 'nvidia', launchOptions: {} });
  await device.selectOption('tablet-qa');
  await modal.locator('#create-tab-settings').click();
  await expect(modal.getByLabel('Ядра Android', { exact: true })).toHaveValue('2');
});

test('administrators can edit launches even when ordinary-user overrides are denied', async ({ page }) => {
  const { modal } = await fixture(page, 'admin');
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await expect(modal.getByLabel('Лимит CPU на узле', { exact: true })).toBeEnabled();
  await expect(modal.getByLabel('Лимит CPU на узле', { exact: true })).toHaveAttribute('max', '16');
  await expect(modal.getByRole('combobox', { name: 'Узел запуска', exact: true })).toBeEnabled();
});

test('administrator changes the farm default and the profile can explicitly override it', async ({ page }) => {
  await fixture(page, 'admin');
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  let allowed = false;
  const saved: boolean[] = [];
  await page.route('**/api/admin/launch-settings', route => {
    if (route.request().method() === 'PATCH') { allowed = route.request().postDataJSON().allowLaunchOverrides; saved.push(allowed); }
    return route.fulfill({ json: { allowLaunchOverrides: allowed } });
  });
  await page.goto('/#/admin/profiles');
  await page.locator('.admin-launch-settings > summary').click();
  const toggle = page.getByRole('switch', { name: 'Разрешить изменение параметров при запуске', exact: true });
  await expect(toggle).not.toBeChecked(); await toggle.check();
  await expect(page.locator('.launch-settings-status')).toHaveText('Разрешение сохранено');
  await expect(toggle).toBeChecked(); expect(saved).toEqual([true]);
  await page.getByRole('button', { name: 'Изменить профиль «Android 11 · Google APIs»', exact: true }).click();
  const editor = page.getByRole('dialog');
  const permission = editor.getByRole('combobox', { name: 'Изменение параметров пользователями', exact: true });
  await expect(permission).toHaveValue('inherit'); await permission.selectOption('deny');
  let patch: Record<string, unknown> | undefined;
  await page.route('**/api/admin/profiles/device-qa', route => { patch = route.request().postDataJSON(); return route.fulfill({ json: { profile: { ...profiles[0], ...patch } } }); });
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => patch?.allowLaunchOverrides).toBe(false);
});

for (const [width, height, theme, scale] of [
  [1440, 1000, 'light', 1], [1440, 1000, 'dark', 1], [390, 844, 'light', 1], [390, 844, 'dark', 1], [1280, 1000, 'dark', 1.5],
] as const) test(`device dialog geometry ${width} ${theme} ${scale}`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  const { modal } = await fixture(page, 'admin', theme, scale);
  await modal.locator('#create-tab-settings').click();
  await openLaunchSection(modal, 'connection');
  await page.evaluate(() => document.fonts.ready);
  const result = await modal.evaluate(element => {
    const box = element.getBoundingClientRect();
    const selector = element.querySelector('select[aria-label="Устройство"]')!;
    const style = getComputedStyle(selector);
    const mismatches: number[] = [];
    for (const group of element.querySelectorAll('.create-resource-fields,.create-storage-fields,.create-connection-fields')) {
      const fields = [...group.querySelectorAll('input,select')];
      for (let i=0; i<fields.length; i+=2) if (fields[i+1] && getComputedStyle(group).gridTemplateColumns.split(' ').length === 2) {
        const a=fields[i].getBoundingClientRect(), b=fields[i+1].getBoundingClientRect();
        mismatches.push(Math.abs(a.top-b.top), Math.abs(a.bottom-b.bottom));
      }
    }
    const launch = element.querySelector('.create-session-footer')!.getBoundingClientRect();
    return { left: box.left, right: box.right, scroll: element.scrollWidth - element.clientWidth, arrow: style.backgroundImage, reserve: parseFloat(style.paddingRight), mismatches, footer: launch.bottom };
  });
  expect(result.left).toBeGreaterThanOrEqual(0); expect(result.right).toBeLessThanOrEqual(width); expect(result.scroll).toBeLessThanOrEqual(1);
  expect(result.reserve).toBeGreaterThanOrEqual(36); expect(result.arrow).not.toBe('none');
  for (const delta of result.mismatches) expect(delta).toBeLessThanOrEqual(1);
  expect(result.footer).toBeLessThanOrEqual(height);
  await page.screenshot({ path: `../.tmp-ui/device-selection/${width}-${theme}-${scale}.png`, fullPage: true });
});

test('failed farm permission save rolls the switch back and reports the error', async ({ page }) => {
  await fixture(page, 'admin'); await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  let rejectSave: (() => void) | undefined;
  await page.route('**/api/admin/launch-settings', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { allowLaunchOverrides: false } });
    await new Promise<void>(resolve => { rejectSave = resolve; });
    await route.fulfill({ status: 503, json: { error: { code: 'test_only', message: 'Не удалось сохранить разрешение' } } });
  });
  await page.goto('/#/admin/profiles'); await page.locator('.admin-launch-settings > summary').click();
  const toggle = page.getByRole('switch', { name: 'Разрешить изменение параметров при запуске', exact: true });
  await toggle.check(); await expect(toggle).toBeDisabled(); await expect(toggle).toBeChecked();
  await expect.poll(() => Boolean(rejectSave)).toBe(true); rejectSave!();
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  await expect(page.locator('.launch-settings-error')).toContainText('Не удалось сохранить разрешение');
});

for (const [width, height, theme, scale] of [[1440,1000,'light',1],[1440,1000,'dark',1],[390,844,'dark',1],[1280,1000,'light',1.5]] as const) test(`permission controls geometry ${width} ${theme} ${scale}`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await fixture(page, 'admin', theme, scale);
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.goto('/#/admin/profiles'); await page.locator('.admin-launch-settings > summary').click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `../.tmp-ui/device-selection/policy-${width}-${theme}-${scale}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Изменить профиль «Android 11 · Google APIs»', exact: true }).click();
  const editor=page.getByRole('dialog'); const permission=editor.getByRole('combobox', { name: 'Изменение параметров пользователями', exact: true });
  await permission.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
  const box=await permission.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(width);
  const dimensions=await permission.evaluate(element=>({ reserve: parseFloat(getComputedStyle(element).paddingRight), arrow: getComputedStyle(element).backgroundImage, height: element.getBoundingClientRect().height }));
  expect(dimensions.reserve).toBeGreaterThanOrEqual(36); expect(dimensions.arrow).not.toBe('none'); expect(dimensions.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `../.tmp-ui/device-selection/profile-${width}-${theme}-${scale}.png`, fullPage: true });
});
