import { expect, test, type Locator, type Page } from '@playwright/test';
import type { SessionLaunchOptions } from '../src/api';
import { openLaunchSection } from './launch-controls';

const profile = {
  id: 'resource-launch-qa', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30,
  abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis',
  image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',
  launchOverridesAllowed: true, cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2,
  diskGb: 8, diskMaxGb: 128, sdcardGb: 0, sdcardMaxGb: 32, enabled: true, emulatorParams: '-no-snapshot',
};
const resourceLabels = {
  cpu: 'Лимит CPU на узле', memoryMb: 'Лимит памяти на узле, МБ',
  guestCores: 'Ядра Android', guestMemoryMb: 'Память Android, МБ',
} as const;

async function fixture(page: Page, options: { role?: 'user'; busy?: boolean; theme?: 'light' | 'dark'; scale?: number } = {}) {
  const state = { requests: [] as Array<{ endpoint: string; body: { launchOptions: SessionLaunchOptions } }> };
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [profile] } }));
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  if (options.role) await page.route('**/api/me', async route => {
    const body = await (await route.fetch()).json(); body.user.role = options.role;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {
    theme: options.theme ?? 'light', fontFamily: 'system', fontScale: options.scale ?? 1, defaultAdbKeyId: null,
  } } }));
  await page.route('**/api/me/adb-public-keys', route => route.fulfill({ json: { keys: [] } }));
  await page.route('**/api/me/adb-key', route => route.fulfill({ json: { key: null } }));
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    for (const host of body.hosts) Object.assign(host, {
      name: 'Узел с длинным именем для проверки переноса подсказки', lastSeenAt: new Date().toISOString(),
      status: 'online', disabled: false, slotCpu: 8, slotMemoryMb: 16384, slots: 2, usedSlots: options.busy ? 2 : 0,
    });
    await route.fulfill({ json: body });
  });
  for (const endpoint of ['sessions', 'queue']) await page.route('**/api/' + endpoint, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: endpoint === 'sessions' ? { sessions: [] } : { entries: [], maxEntries: 3 } });
    state.requests.push({ endpoint, body: route.request().postDataJSON() });
    return route.fulfill({ status: 400, json: { error: { code: 'test_only', message: 'Тест: запрос перехвачен' } } });
  });
  await page.goto('/');
  const modal = await open(page, options.busy);
  return { modal, state };
}
async function open(page: Page, busy = false) {
  await page.getByRole('button', { name: busy ? 'Встать в очередь' : 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
  await openLaunchSection(modal, 'connection');
  await openLaunchSection(modal, 'storage');
  await expect(modal.getByRole('combobox', { name: 'Ключ ADB', exact: true })).toBeEnabled();
  return modal;
}
async function setResources(modal: Locator, values: Pick<SessionLaunchOptions, keyof typeof resourceLabels>) {
  for (const [field, label] of Object.entries(resourceLabels)) {
    const value = values[field as keyof typeof resourceLabels];
    if (value !== undefined) await modal.getByLabel(label, { exact: true }).fill(value === null ? '' : String(value));
  }
}

for (const busy of [false, true]) test(`chosen Android and node resources reach the ${busy ? 'queue' : 'session'} API`, async ({ page }) => {
  const { modal, state } = await fixture(page, { busy });
  const resources = { cpu: 6, memoryMb: 8192, guestCores: 4, guestMemoryMb: 4096 };
  await setResources(modal, resources);
  const launch = modal.getByRole('button', { name: busy ? 'Встать в очередь' : 'Запустить', exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0]).toMatchObject({ endpoint: busy ? 'queue' : 'sessions', body: { launchOptions: resources } });
  await modal.getByRole('button', { name: 'Сбросить', exact: true }).click();
  for (const [field, label] of Object.entries(resourceLabels)) await expect(modal.getByLabel(label, { exact: true })).toHaveValue(String(profile[field as keyof typeof resourceLabels]));
  await launch.click();
  await expect.poll(() => state.requests.length).toBe(2);
  for (const field of Object.keys(resourceLabels)) expect(state.requests[1].body.launchOptions).not.toHaveProperty(field);
});

test('guest resources above effective container limits block launch', async ({ page }) => {
  const { modal, state } = await fixture(page);
  const launch = modal.getByRole('button', { name: 'Запустить', exact: true });
  await setResources(modal, { guestCores: 5 });
  await expect(launch).toBeDisabled();
  await expect(modal.locator('.create-launch-status')).toContainText('Ядра Android не могут превышать CPU');
  await setResources(modal, { guestCores: 2, guestMemoryMb: 4096 });
  await expect(launch).toBeDisabled();
  await expect(modal.locator('.create-launch-status')).toContainText('минимум 1024 МБ');
  await setResources(modal, { guestMemoryMb: 3072 });
  await expect(launch).toBeEnabled();
  expect(state.requests).toHaveLength(0);
});

test('a regular user may lower resources but cannot raise the profile node limits', async ({ page }) => {
  const { modal, state } = await fixture(page, { role: 'user' });
  const launch = modal.getByRole('button', { name: 'Запустить', exact: true });
  await expect(modal.getByLabel(resourceLabels.cpu, { exact: true })).toHaveAttribute('max', '4');
  await expect(modal.getByLabel(resourceLabels.memoryMb, { exact: true })).toHaveAttribute('max', '4096');
  await expect(modal.getByRole('combobox', { name: 'Узел запуска', exact: true })).toHaveCount(0);
  await setResources(modal, { cpu: 5 });
  await expect(launch).toBeDisabled();
  await expect(modal.locator('.create-launch-status')).toContainText('не больше 4 по лимиту профиля');
  await setResources(modal, { cpu: 4, memoryMb: 5120 });
  await expect(launch).toBeDisabled();
  await expect(modal.locator('.create-launch-status')).toContainText('не больше 4096 МБ по лимиту профиля');
  await setResources(modal, { cpu: 3, memoryMb: 3072, guestCores: 1, guestMemoryMb: 1536 });
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0].body.launchOptions).toMatchObject({ cpu: 3, memoryMb: 3072, guestCores: 1, guestMemoryMb: 1536 });
});

async function fieldAlignment(modal: Locator) {
  return modal.evaluate(element => {
    const errors: number[] = [];
    for (const selector of ['.create-resource-fields', '.create-storage-fields', '.create-connection-fields']) {
      const grid = element.querySelector(selector)!;
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const fields = Array.from(grid.querySelectorAll(':scope > .create-field'));
      for (let index = 0; index < fields.length; index += columns) {
        const row = fields.slice(index, index + columns);
        for (const child of ['span:first-child', 'input,select', '.create-field-hint']) {
          const boxes = row.map(field => field.querySelector(child)?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
          if (boxes.length > 1) errors.push(Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top)));
        }
        const boxes = row.map(field => field.querySelector('input,select')!.getBoundingClientRect());
        if (boxes.length > 1) errors.push(Math.max(...boxes.map(box => box.width)) - Math.min(...boxes.map(box => box.width)));
      }
      // Every row in a column shares the same left edge.
      for (let index = columns; index < fields.length; index++) errors.push(Math.abs(fields[index].getBoundingClientRect().left - fields[index - columns].getBoundingClientRect().left));
    }
    return Math.max(0, ...errors);
  });
}

for (const [name, width, height, theme, scale] of [
  ['laptop-light', 1366, 768, 'light', 1], ['laptop-dark', 1366, 768, 'dark', 1],
  ['desktop-light', 1920, 1080, 'light', 1], ['desktop-dark', 1920, 1080, 'dark', 1],
  ['phone', 390, 844, 'light', 1], ['scale-125', 1366, 768, 'dark', 1.25], ['scale-150', 1366, 768, 'light', 1.5],
] as const) test(`launch settings preserve field hierarchy and alignment: ${name}`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  const { modal } = await fixture(page, { theme, scale });
  await page.evaluate(() => document.fonts.ready);
  const textarea = modal.getByLabel('Аргументы эмулятора', { exact: true });
  await expect(textarea).toBeHidden();
  await expect.poll(() => fieldAlignment(modal)).toBeLessThanOrEqual(1);
  const typography = await modal.evaluate(element => {
    const styles = (selector: string) => getComputedStyle(element.querySelector(selector)!);
    const heading = styles('#create-resources-title'), helper = styles('#create-resources-hint');
    const number = styles('input[type=number]'), select = styles('.create-connection-fields select');
    return { headingWeight: Number(heading.fontWeight), helperWeight: Number(helper.fontWeight), headingSize: parseFloat(heading.fontSize), helperSize: parseFloat(helper.fontSize),
      number: [number.paddingTop, number.paddingBottom, number.paddingLeft], select: [select.paddingTop, select.paddingBottom, select.paddingLeft],
      numberHeight: element.querySelector('input[type=number]')!.getBoundingClientRect().height,
      selectHeight: element.querySelector('.create-connection-fields select')!.getBoundingClientRect().height };
  });
  expect(typography.headingWeight).toBeGreaterThan(typography.helperWeight);
  expect(typography.headingSize).toBeGreaterThan(typography.helperSize);
  expect(typography.helperWeight).toBe(400);
  expect(typography.number).toEqual(typography.select); // Select's right padding also reserves its shared arrow.
  expect(Math.abs(typography.numberHeight - typography.selectHeight)).toBeLessThanOrEqual(1);
  const assertFit = async () => {
    const geometry = await modal.evaluate(element => {
      const box = element.getBoundingClientRect(), body = element.querySelector('.create-session-body')!, button = element.querySelector('.modal-actions .primary')!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, buttonBottom: button.bottom, overflow: Math.max(element.scrollWidth - element.clientWidth, body.scrollWidth - body.clientWidth, document.documentElement.scrollWidth - innerWidth) };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(height);
    expect(geometry.buttonBottom).toBeLessThan(height); expect(geometry.overflow).toBeLessThanOrEqual(1);
  };
  await assertFit();
  await modal.locator('#create-resources-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../.tmp-ui/launch-settings/${name}-resources.png` });
  await modal.locator('.create-advanced-settings > summary').click();
  await textarea.scrollIntoViewIfNeeded();
  await expect(textarea).toBeVisible();
  const surface = await textarea.evaluate(element => {
    const style = getComputedStyle(element), input = getComputedStyle(document.querySelector('.create-resource-fields input')!);
    return { background: style.backgroundColor, expectedBackground: input.backgroundColor, color: style.color, expectedColor: input.color, padding: parseFloat(style.paddingLeft), border: style.borderStyle };
  });
  expect(surface.background).toBe(surface.expectedBackground); expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(surface.color).toBe(surface.expectedColor); expect(surface.padding).toBeGreaterThanOrEqual(10); expect(surface.border).toBe('solid');
  await assertFit();
  await page.screenshot({ path: `../.tmp-ui/launch-settings/${name}-advanced.png` });
  await modal.locator('.create-advanced-settings > summary').click();
  await expect(textarea).toBeHidden();
});
