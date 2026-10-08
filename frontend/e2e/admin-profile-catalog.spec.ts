import { expect, test, type Page } from '@playwright/test';

const profiles = Array.from({ length: 50 }, (_, index) => ({
  id: `qa-profile-${index}`, name: `QA environment ${String(index).padStart(2, '0')}`,
  androidVersion: ['11', '13', '15', '17'][index % 4], apiLevel: [30, 33, 35, 37][index % 4],
  deviceType: ['mobile', 'tv', 'wear'][index % 3], imageFlavor: ['aosp', 'google_apis'][index % 2],
  abi: ['x86_64', 'arm64-v8a'][index % 2], image: `registry.example/android/profile-${index}:verified`,
  enabled: index % 7 !== 0,
  cpu: 4, memoryMb: 4096, guestCores: null, guestMemoryMb: null, diskGb: 8,
  gpuMode: 'software', gpuModes: ['software'], gpuImage: null, gpuMemoryMb: null,
  deviceModel: null, resolution: null, emulatorParams: '-no-snapshot -memory 2048', recommended: false,
}));
Object.assign(profiles[0], { emulatorParams: '-no-snapshot -memory 2048 -cores 3', name: 'Unique Pixel regression', image: 'registry.example/qa/long/source/reference:needle-image-tag', enabled: true, androidVersion: '15', apiLevel: 35, deviceType: 'mobile', imageFlavor: 'google_apis', abi: 'x86_64' });
Object.assign(profiles[1], { name: 'Pending TV', enabled: true });
Object.assign(profiles[2], { name: 'Disabled legacy device', enabled: false });

async function setup(page: Page) {
  const state = { reads: 0 };
  await page.route('**/api/admin/profiles', route => { state.reads++; return route.fulfill({ json: { profiles } }); });
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: profiles.filter(profile => profile.enabled) } }));
  await page.goto('/#/admin/profiles');
  await expect(page.getByRole('searchbox', { name: 'Найти профиль' })).toBeVisible();
  return state;
}
const search = (page: Page) => page.getByRole('searchbox', { name: 'Найти профиль' });
const cards = (page: Page) => page.locator('.device-profile-card');
const select = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });

test('catalogue search finds names and image references, reports empty results and resets', async ({ page }) => {
  await setup(page);
  await expect(cards(page)).toHaveCount(18);
  await search(page).fill('Unique Pixel regression');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Unique Pixel regression');
  await search(page).fill('needle-image-tag');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Unique Pixel regression');
  await search(page).fill('-cores 3');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Unique Pixel regression');
  await search(page).fill('no-such-environment-in-catalogue');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Профили не найдены', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).first().click();
  await expect(search(page)).toHaveValue('');
  await expect(cards(page)).toHaveCount(18);
});

test('five filters combine and keep their values when inventory refreshes', async ({ page }) => {
  await setup(page);
  const filters = [['Версия Android', '15'], ['Тип устройства', 'mobile'], ['Тип образа', 'google_apis'], ['Архитектура / ABI', 'x86_64'], ['Готовность', 'ready']];
  for (const [name, value] of filters) await select(page, name).selectOption(value);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Unique Pixel regression');
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).first().click();
  for (const [name] of filters) await expect(select(page, name)).toHaveValue('');
  await expect(cards(page)).toHaveCount(18);
});

test('pagination keeps a bounded card list and a changed query starts on the first page', async ({ page }) => {
  await setup(page);
  const next = page.getByRole('button', { name: 'Следующая страница профилей', exact: true }).first();
  const previous = page.getByRole('button', { name: 'Предыдущая страница профилей', exact: true }).first();
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(cards(page)).toHaveCount(18);
  await expect(previous).toBeEnabled();
  await next.click();
  await expect(cards(page)).toHaveCount(14);
  await expect(next).toBeDisabled();
  await search(page).fill('Unique Pixel');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Unique Pixel regression');
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).first().click();
  await expect(cards(page)).toHaveCount(18);
  await expect(previous).toBeDisabled();
});

test('status explanations and source details stay separate from editing and unknown metadata is explicit', async ({ page }) => {
  await setup(page);
  for (const [name, state] of [['Unique Pixel regression', 'ready'], ['Disabled legacy device', 'disabled']]) {
    await search(page).fill(name);
    const card = cards(page);
    await expect(card).toHaveCount(1);
    const status = card.locator(`[data-profile-status="${state}"]`);
    await status.click();
    await expect(status).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.device-profile-status-explanation')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await status.click();
    await expect(status).toHaveAttribute('aria-expanded', 'false');
  }
  await search(page).fill('Unique Pixel regression');
  const card = cards(page);
  await expect(card).toContainText('Не указана в профиле');
  await expect(card).toContainText('Не задано в профиле');
  await card.getByText('Образ и параметры', { exact: true }).click();
  await expect(card.getByText(profiles[0].image, { exact: true })).toBeVisible();
  await expect(card.getByText(profiles[0].emulatorParams, { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const box = await card.boundingBox();
  await card.click({ position: { x: 12, y: box!.height / 2 } });
  await expect(page.getByRole('dialog', { name: 'Изменить профиль' })).toBeVisible();
});
