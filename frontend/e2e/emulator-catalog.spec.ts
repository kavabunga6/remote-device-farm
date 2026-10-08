import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const capturePath = (name: string) => fileURLToPath(new URL('../../.tmp-ui/' + name, import.meta.url));

const images = [
  { systemTag: 'default', flavor: 'aosp', minor: null },
  { systemTag: 'aosp_atd', flavor: 'aosp', minor: null },
  { systemTag: 'google_atd', flavor: 'google_apis', minor: null },
  { systemTag: 'google_apis_ps16k', flavor: 'google_apis', minor: 1 },
].map(({ systemTag, flavor, minor }) => ({
  package: `system-images;android-36${minor ? '.' + minor : ''};${systemTag};x86_64`,
  tag: `36-${systemTag}-x86_64`, api: 36, minor, androidVersion: '16', device: 'phone', flavor, abi: 'x86_64',
  built: false, digest: null, builtAt: null, sizeMb: null, profiles: [], updateAvailable: false,
}));
const catalog = {
  builder: { id: 'h1', name: 'worker-01' }, images, jobs: [],
  registry: { mode: 'builtin', builtinAddress: 'farm.internal.test', externalAddress: null, externalUsername: null, externalPasswordSet: false },
};
const catalogRoute = /\/api\/admin\/emulator-images(?:\?.*)?$/;
async function setup(page: Page, theme = 'light', fontScale = 1, initialCatalog: object = catalog) {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale, defaultAdbKeyId: null } } }));
  await page.route('**/api/admin/emulator-images/prewarm', route => route.fulfill({ json: { items: [] } }));
  await page.route(catalogRoute, route => route.fulfill({ json: initialCatalog }));
  await page.goto('/#/admin/profiles');
  await page.getByRole('button', { name: 'Каталог образов', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Каталог образов Google', exact: true });
  await expect(dialog.getByRole('checkbox')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  return dialog;
}

for (const theme of ['light', 'dark']) for (const [width, fontScale] of [[1366, 1], [390, 1], [900, 1.5]]) {
  test(`catalog controls stay aligned and usable: ${theme} ${width} ${fontScale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const dialog = await setup(page, theme, fontScale);
    const headingActions = await page.locator('.page-heading .heading-actions').boundingBox();
    expect(headingActions!.x).toBeGreaterThanOrEqual(0);
    expect(headingActions!.x + headingActions!.width).toBeLessThanOrEqual(width);
    expect(await page.locator('.page-heading .heading-actions button').evaluateAll(buttons => buttons.every(button => {
      const rect = button.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth;
    }))).toBe(true);
    const profileControls = await page.locator('.admin-profiles-filters select').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { y: rect.y, bottom: rect.bottom };
    }));
    const profileColumns = width > 1150 ? 5 : width > 700 ? 3 : 2;
    for (let index = 0; index < profileControls.length; index += profileColumns) {
      const row = profileControls.slice(index, index + profileColumns);
      expect(Math.max(...row.map(control => control.y)) - Math.min(...row.map(control => control.y))).toBeLessThanOrEqual(1);
      expect(Math.max(...row.map(control => control.bottom)) - Math.min(...row.map(control => control.bottom))).toBeLessThanOrEqual(1);
    }
    await dialog.locator('.emulator-catalog-settings > summary').click();
    const builtin = dialog.getByRole('radio', { name: 'Встроенный registry' });
    const external = dialog.getByRole('radio', { name: 'Внешний registry' });
    await expect(builtin).toBeChecked();
    await expect(dialog.getByRole('textbox', { name: 'Адрес сервера' })).toHaveValue('farm.internal.test');
    await expect(dialog.getByRole('textbox', { name: 'Адрес сервера' })).toHaveAttribute('placeholder', 'farm.example.com');
    await expect(dialog.locator('#catalog-builtin-hint')).not.toContainText(/localhost|127\.0\.0\.1|5191|5173/);
    const choices = await dialog.locator('.emulator-catalog-choice').evaluateAll(labels => labels.map(label => {
      const radio = label.querySelector('input')!.getBoundingClientRect(), text = label.querySelector('span')!.getBoundingClientRect();
      return { radio: { x: radio.x, y: radio.y, width: radio.width, height: radio.height }, text: { x: text.x, y: text.y, height: text.height }, height: label.getBoundingClientRect().height };
    }));
    for (const choice of choices) {
      expect(choice.radio.width).toBe(16);
      expect(choice.radio.x + choice.radio.width).toBeLessThan(choice.text.x);
      expect(Math.abs(choice.radio.y + choice.radio.height / 2 - choice.text.y - choice.text.height / 2)).toBeLessThanOrEqual(1);
      expect(choice.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: capturePath(`catalog-builtin-${theme}-${width}-${fontScale}.png`) });
    await builtin.focus();
    await page.keyboard.press('ArrowRight');
    await expect(external).toBeChecked();
    const username = dialog.getByRole('textbox', { name: 'Логин', exact: true });
    await expect(dialog.getByLabel('Пароль или токен', { exact: true })).toBeVisible();
    const password = dialog.locator('input[type=password]');
    await username.fill('image-builder');
    await password.fill('test-token');
    // Unequal label lengths must not stagger the adjacent credential controls.
    if (width > 480) {
      await dialog.locator('.emulator-catalog-credentials label > span').last().evaluate(element => { element.textContent = 'Пароль или персональный токен доступа к хранилищу'; });
      const [left, right] = await Promise.all([username.boundingBox(), password.boundingBox()]);
      expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(left!.height - right!.height)).toBeLessThanOrEqual(1);
      await dialog.locator('.emulator-catalog-credentials label > span').last().evaluate(element => { element.textContent = 'Пароль или токен'; });
    }
    const controls = await dialog.locator('.emulator-catalog-filters select').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { y: rect.y, bottom: rect.bottom, paddingEnd: parseFloat(style.paddingInlineEnd), arrow: style.backgroundImage };
    }));
    for (const control of controls) { expect(control.paddingEnd).toBeGreaterThanOrEqual(40); expect(control.arrow).not.toBe('none'); }
    for (let index = 0; index < controls.length; index += width > 1000 ? 4 : 2) {
      const row = controls.slice(index, index + (width > 1000 ? 4 : 2));
      expect(Math.max(...row.map(control => control.y)) - Math.min(...row.map(control => control.y))).toBeLessThanOrEqual(1);
      expect(Math.max(...row.map(control => control.bottom)) - Math.min(...row.map(control => control.bottom))).toBeLessThanOrEqual(1);
    }
    const overflow = await dialog.evaluate(element => Math.max(element.scrollWidth - element.clientWidth, element.querySelector('.emulator-catalog-body')!.scrollWidth - element.querySelector('.emulator-catalog-body')!.clientWidth, document.documentElement.scrollWidth - innerWidth));
    expect(overflow).toBeLessThanOrEqual(1);
    await dialog.locator('.emulator-catalog-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: capturePath(`catalog-external-${theme}-${width}-${fontScale}.png`) });
  });
}

test('catalog distinguishes ATD, standard and other SDK variants and copies the precise package', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const dialog = await setup(page);
  const rows = dialog.locator('.emulator-catalog-item');
  await expect(rows.nth(0).locator('strong')).toHaveText('Android 16 · AOSP');
  await expect(rows.nth(0)).toContainText('Стандартный образ');
  await expect(rows.nth(1).locator('strong')).toHaveText('Android 16 · AOSP ATD');
  await expect(rows.nth(2).locator('strong')).toHaveText('Android 16 · Google APIs ATD');
  await expect(rows.nth(1)).toContainText('Для автотестов');
  await expect(rows.nth(1)).toContainText('аппаратный рендеринг отключён');
  await expect(rows.nth(3).locator('strong')).toContainText('google_apis_ps16k');
  await expect(rows.nth(3)).toContainText('API 36.1');
  for (const [index, image] of images.entries()) await expect(rows.nth(index).locator('code')).toHaveText(image.package);
  await rows.nth(1).getByRole('button', { name: 'Копировать пакет ' + images[1].package, exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(images[1].package);
  await page.screenshot({ path: capturePath('catalog-variants.png') });
});

test('build shows immediate feedback during a pending POST and accepted jobs before catalog refresh', async ({ page }) => {
  let accept!: () => void, releaseCatalog!: () => void;
  const pendingPost = new Promise<void>(resolve => { accept = resolve; });
  const pendingCatalog = new Promise<void>(resolve => { releaseCatalog = resolve; });
  let requests = 0, accepted = false;
  const dialog = await setup(page);
  await page.route(catalogRoute, async route => { await pendingCatalog; await route.fulfill({ json: catalog }); });
  await page.route('**/api/admin/emulator-images/builds', async route => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ packages: [images[1].package] });
    await pendingPost;
    accepted = true;
    await route.fulfill({ status: 202, json: { jobs: [{ id: 'accepted-build', package: images[1].package, image: 'registry/image', state: 'queued' }] } });
  });
  try {
    await dialog.getByRole('checkbox', { name: 'Выбрать Android 16 · AOSP ATD', exact: true }).check();
    await dialog.getByRole('button', { name: 'Собрать (1)', exact: true }).click();
    const sending = dialog.getByRole('button', { name: 'Отправка…', exact: true });
    await expect(sending).toBeDisabled();
    await expect(sending).toHaveAttribute('aria-busy', 'true');
    await expect(sending.locator('.mini-spinner')).toBeVisible();
    await expect(dialog.locator('.emulator-catalog-footer [role=status]')).toHaveText('Отправляем запрос на сборку…');
    // A request held indefinitely stays explicit; no real 20-second sleep is needed.
    await sending.evaluate((button: HTMLButtonElement) => button.click());
    expect(requests).toBe(1);
    expect(accepted).toBe(false);
    accept();
    await expect(dialog.locator('.emulator-catalog-item').nth(1).locator('.emulator-catalog-state')).toHaveText('В очереди');
    await expect(dialog.getByRole('button', { name: 'Закрыть', exact: true }).last()).toBeEnabled();
    await expect(dialog.locator('.emulator-catalog-footer [role=status]')).toContainText('Окно можно закрыть');
    expect(requests).toBe(1);
    await page.screenshot({ path: capturePath('catalog-build-accepted.png') });
  } finally { accept(); releaseCatalog(); }
});


test('slow polls are coalesced and a stale catalog cannot erase an accepted build', async ({ page }) => {
  await page.clock.install();
  const backgroundJob = { id: 'older-job', package: images[0].package, image: 'registry/older', state: 'building' };
  const acceptedJob = { id: 'new-job', package: images[1].package, image: 'registry/new', state: 'queued' };
  const dialog = await setup(page, 'light', 1, { ...catalog, jobs: [backgroundJob] });
  let releaseStale!: () => void, releaseFresh!: () => void, reads = 0;
  const stale = new Promise<void>(resolve => { releaseStale = resolve; });
  const fresh = new Promise<void>(resolve => { releaseFresh = resolve; });
  await page.route(catalogRoute, async route => {
    const index = ++reads;
    await (index === 1 ? stale : fresh);
    await route.fulfill({ json: { ...catalog, jobs: index === 1 ? [backgroundJob] : [acceptedJob, backgroundJob] } });
  });
  await page.route('**/api/admin/emulator-images/builds', route => route.fulfill({ status: 202, json: { jobs: [acceptedJob] } }));
  try {
    await page.clock.runFor(4100);
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(12_000);
    expect(reads).toBe(1);
    await dialog.getByRole('checkbox', { name: 'Выбрать Android 16 · AOSP ATD', exact: true }).check();
    await dialog.getByRole('button', { name: 'Собрать (1)', exact: true }).click();
    const state = dialog.locator('.emulator-catalog-item').nth(1).locator('.emulator-catalog-state');
    await expect(state).toHaveText('В очереди');
    expect(reads).toBe(1);
    releaseStale();
    await expect.poll(() => reads).toBe(2);
    await expect(state).toHaveText('В очереди');
    await page.clock.runFor(8000);
    expect(reads).toBe(2);
    await expect(state).toHaveText('В очереди');
    releaseFresh();
    await expect(state).toHaveText('В очереди');
  } finally { releaseStale(); releaseFresh(); }
});


const buildJob = (index: number, state: string) => ({ id: `build-${index}`, package: images[index].package, image: `registry/image-${index}`, state });

test('queued cancellation is immediate, sends the original builder and survives a stale poll', async ({ page }) => {
  await page.clock.install();
  const queued = buildJob(0, 'queued'), cancelled = { ...queued, state: 'cancelled' };
  const dialog = await setup(page, 'light', 1, { ...catalog, jobs: [queued] });
  let accept!: () => void, releaseStale!: () => void, releaseFresh!: () => void;
  const post = new Promise<void>(resolve => { accept = resolve; });
  const stale = new Promise<void>(resolve => { releaseStale = resolve; });
  const fresh = new Promise<void>(resolve => { releaseFresh = resolve; });
  let requests = 0, reads = 0;
  await page.route(catalogRoute, async route => {
    const index = ++reads;
    await (index === 1 ? stale : fresh);
    await route.fulfill({ json: { ...catalog, jobs: [index === 1 ? queued : cancelled] } });
  });
  await page.route('**/api/admin/emulator-images/builds/build-0/cancel', async route => {
    requests++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ builderHostId: 'h1' });
    await post;
    await route.fulfill({ json: { jobs: [cancelled] } });
  });
  try {
    await page.clock.runFor(4100);
    await expect.poll(() => reads).toBe(1);
    const row = dialog.locator('.emulator-catalog-item').first();
    const cancel = row.getByRole('button', { name: 'Отменить сборку Android 16 · AOSP', exact: true });
    await cancel.click();
    await expect(cancel).toBeDisabled();
    await expect(cancel).toHaveAttribute('aria-busy', 'true');
    await expect(cancel.locator('.mini-spinner')).toBeVisible();
    await expect(row.locator('[role=status]')).toHaveText('Отменяем…');
    await cancel.evaluate((button: HTMLButtonElement) => button.click());
    expect(requests).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Закрыть', exact: true }).last()).toBeEnabled();
    accept();
    await expect(row.locator('[role=status]')).toHaveText('Сборка отменена');
    await expect(row.locator('.emulator-catalog-cancel')).toHaveCount(0);
    await expect(row.getByRole('checkbox')).toBeEnabled();
    releaseStale();
    await expect.poll(() => reads).toBe(2);
    await expect(row.locator('[role=status]')).toHaveText('Сборка отменена');
    releaseFresh();
    await expect(row.locator('[role=status]')).toHaveText('Сборка отменена');
  } finally { accept(); releaseStale(); releaseFresh(); }
});

test('running cancellation can retry errors and keeps polling until stopped', async ({ page }) => {
  await page.clock.install();
  let job = buildJob(0, 'pushing'), attempts = 0;
  const dialog = await setup(page, 'light', 1, { ...catalog, jobs: [job] });
  await page.route(catalogRoute, route => route.fulfill({ json: { ...catalog, jobs: [job] } }));
  await page.route('**/api/admin/emulator-images/builds/build-0/cancel', route => {
    if (++attempts === 1) return route.fulfill({ status: 502, json: { error: { code: 'image_build_cancel_failed', message: 'Node returned an invalid cancellation result' } } });
    job = { ...job, state: 'cancelling' };
    return route.fulfill({ json: { jobs: [job] } });
  });
  const row = dialog.locator('.emulator-catalog-item').first();
  const stop = row.getByRole('button', { name: 'Остановить сборку Android 16 · AOSP', exact: true });
  await expect(row.locator('[role=status]')).toHaveText('Отправка в registry');
  await stop.click();
  await expect(page.getByText('Узел не подтвердил отмену сборки. Обновите состояние и повторите попытку.', { exact: true })).toBeVisible();
  await expect(stop).toBeEnabled();
  await expect(row.locator('[role=status]')).toHaveText('Отправка в registry');
  await stop.click();
  await expect(row.locator('[role=status]')).toHaveText('Останавливается');
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveText('Остановка…');
  await expect(row.getByRole('checkbox')).toBeDisabled();
  job = { ...job, state: 'cancelled' };
  await page.clock.runFor(4100);
  await expect(row.locator('[role=status]')).toHaveText('Сборка отменена');
  await expect(row.locator('.emulator-catalog-cancel')).toHaveCount(0);
});

test('parallel cancel responses do not revert another job or misreport a completed build', async ({ page }) => {
  await page.clock.install();
  const jobs = [buildJob(0, 'queued'), buildJob(1, 'building')];
  const dialog = await setup(page, 'light', 1, { ...catalog, jobs });
  let releaseFirst!: () => void, releaseCatalog!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const heldCatalog = new Promise<void>(resolve => { releaseCatalog = resolve; });
  const results = [{ ...jobs[0], state: 'cancelled' }, { ...jobs[1], state: 'done' }];
  await page.route(catalogRoute, async route => { await heldCatalog; await route.fulfill({ json: { ...catalog, jobs: results } }); });
  await page.route('**/api/admin/emulator-images/builds/*/cancel', async route => {
    const index = route.request().url().includes('build-0/') ? 0 : 1;
    if (index === 0) await first;
    await route.fulfill({ json: { jobs: [results[index]] } });
  });
  try {
    const rows = dialog.locator('.emulator-catalog-item');
    await rows.nth(0).locator('.emulator-catalog-cancel').click();
    await rows.nth(1).locator('.emulator-catalog-cancel').click();
    await expect(rows.nth(1).locator('[role=status]')).toHaveText('Собран');
    await expect(rows.nth(0).locator('[role=status]')).toHaveText('Отменяем…');
    releaseFirst();
    await expect(rows.nth(0).locator('[role=status]')).toHaveText('Сборка отменена');
    await expect(rows.nth(1).locator('[role=status]')).toHaveText('Собран');
  } finally { releaseFirst(); releaseCatalog(); }
});

test('state filter groups active builds and separates errors and cancelled attempts', async ({ page }) => {
  await page.clock.install();
  const jobs = ['queued', 'building', 'pushing', 'cancelling'].map((state, index) => buildJob(index, state));
  const dialog = await setup(page, 'light', 1, { ...catalog, jobs });
  const filter = dialog.getByRole('combobox', { name: 'Состояние', exact: true });
  await filter.selectOption({ label: 'В работе' });
  await expect(dialog.locator('.emulator-catalog-item')).toHaveCount(4);
  const completed = [buildJob(0, 'failed'), buildJob(1, 'cancelled'), buildJob(2, 'done'), buildJob(3, 'queued')];
  const next = { ...catalog, images: images.map((image, index) => ({ ...image, built: index < 3 })), jobs: [...completed, ...jobs] };
  await page.route(catalogRoute, route => route.fulfill({ json: next }));
  await dialog.getByRole('button', { name: 'Обновить список', exact: true }).click();
  await expect(dialog.locator('.emulator-catalog-item')).toHaveCount(1);
  await filter.selectOption({ label: 'Ошибки' });
  await expect(dialog.locator('.emulator-catalog-item strong')).toHaveText('Android 16 · AOSP');
  await expect(dialog.locator('.emulator-catalog-state')).toHaveText('Ошибка сборки');
  await expect(dialog.getByText('Предыдущая сборка доступна', { exact: true })).toBeVisible();
  await filter.selectOption({ label: 'Отменённые' });
  await expect(dialog.locator('.emulator-catalog-item strong')).toHaveText('Android 16 · AOSP ATD');
  await expect(dialog.locator('.emulator-catalog-state')).toHaveText('Сборка отменена');
  await filter.selectOption({ label: 'Собраны' });
  await expect(dialog.locator('.emulator-catalog-item')).toHaveCount(3);
  await filter.selectOption({ label: 'Не собраны' });
  await expect(dialog.locator('.emulator-catalog-item strong')).toContainText('google_apis_ps16k');
});

for (const theme of ['light', 'dark']) for (const width of [1366, 390]) {
  test(`build cancellation controls stay aligned: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install();
    const jobs = ['queued', 'building', 'cancelling', 'cancelled'].map((state, index) => buildJob(index, state));
    const dialog = await setup(page, theme, 1, { ...catalog, jobs });
    const rows = dialog.locator('.emulator-catalog-item');
    await expect(rows.nth(0).locator('.emulator-catalog-cancel')).toHaveText('Отменить');
    await expect(rows.nth(1).locator('.emulator-catalog-cancel')).toHaveText('Остановить');
    await expect(rows.nth(2).locator('.emulator-catalog-cancel')).toBeDisabled();
    await expect(rows.nth(3).locator('.emulator-catalog-cancel')).toHaveCount(0);
    const controls = await rows.evaluateAll(elements => elements.map(row => {
      const button = row.querySelector('button.emulator-catalog-cancel')?.getBoundingClientRect();
      const main = row.querySelector('.emulator-catalog-main')!.getBoundingClientRect();
      const status = row.querySelector('.emulator-catalog-status')!.getBoundingClientRect();
      return { button: button && { x: button.x, right: button.right, height: button.height }, mainX: main.x, statusRight: status.right };
    }));
    for (const control of controls.filter(control => control.button)) {
      expect(control.button!.height).toBeGreaterThanOrEqual(width < 760 ? 44 : 40);
      expect(control.button!.x).toBeGreaterThanOrEqual(0);
      expect(control.button!.right).toBeLessThanOrEqual(width);
      expect(Math.abs(width < 760 ? control.button!.x - control.mainX : control.button!.right - control.statusRight)).toBeLessThanOrEqual(1);
    }
    expect(await dialog.evaluate(element => Math.max(element.scrollWidth - element.clientWidth, element.querySelector('.emulator-catalog-body')!.scrollWidth - element.querySelector('.emulator-catalog-body')!.clientWidth, document.documentElement.scrollWidth - innerWidth))).toBeLessThanOrEqual(1);
    await rows.first().scrollIntoViewIfNeeded();
    await rows.first().locator('.emulator-catalog-cancel').focus();
    await page.screenshot({ path: capturePath(`catalog-cancellation-${theme}-${width}.png`) });
  });
}
