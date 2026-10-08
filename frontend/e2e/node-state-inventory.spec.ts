import { expect, test, type Locator, type Page } from '@playwright/test';

const states = [
  { id: 'node-online', name: 'worker-online', displayName: 'Лаборатория USB', status: 'online', disabled: false, state: 'online', label: 'В сети' },
  { id: 'node-disabled', name: 'worker-disabled · Сервер интеграционных проверок Android и автоматизации', displayName: null, status: 'offline', disabled: true, state: 'disabled', label: 'Отключён' },
  { id: 'node-offline', name: 'worker-offline', displayName: null, status: 'offline', disabled: false, state: 'offline', label: 'Не в сети' },
] as const;

async function mockNodes(page: Page, includePhone = true, count = states.length, missingMetrics = false) {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const source = body.hosts[0];
    await route.fulfill({ json: { hosts: states.slice(0, count).map((state, index) => ({
      ...source, ...state, agentName: state.name, usedSlots: 1, slots: 3,
      lastSeenAt: new Date(Date.now() - (index ? 300_000 : 10_000)).toISOString(),
      metrics: missingMetrics ? {} : {
        ...source.metrics, hostIp: `192.0.2.${10 + index}`,
        cpuCores: 16, cpuPhysicalCores: 16, cpuThreads: 32, cpuAllocatableCores: 8,
        cpuModel: 'Example CPU', gpuModel: 'NVIDIA Example GPU',
        memoryTotalMb: 65536, memoryAvailableMb: index === 2 ? undefined : 32768,
        memoryFreeMb: index === 2 ? 32768 : 16384,
        diskFreeGb: 256, diskTotalGb: 512,
        gpuPresent: true, gpuCapabilities: ['cuda'],
        gpuTelemetry: [{ index: 0, utilizationPercent: 0, memoryUsedMb: 33, memoryTotalMb: 16384 }],
      },
      devices: index ? [] : [
        { id: 'slots', slots: 2 },
        { id: 'internal-counter', kind: 'emulator', model: 'Служебный счётчик', state: 'free' },
        ...(includePhone ? [{ id: 'USB-TEST-123456', kind: 'usb-android', platform: 'android', model: 'Pixel 9', state: 'free', reason: null }] : []),
      ],
    })) } });
  });
}

async function openDiagnostics(page: Page, card: Locator) {
  await card.getByRole('link', { name: /^Настройки узла:/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.node-diagnostics summary').click();
  await expect(dialog.locator('.node-diagnostics > details')).toHaveAttribute('open', '');
  return dialog;
}

async function closeNode(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: /^Закрыть/ }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const [scenario, theme, width, scale] of [['light', 'light', 1280, 1], ['dark', 'dark', 1280, 1], ['narrow', 'light', 390, 1], ['zoom', 'light', 1280, 1.25]] as const) {
  test(`admin node states and USB inventory stay clear in ${scenario}`, async ({ page }) => {
    await mockNodes(page);
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme, fontFamily: 'system', fontScale: scale, defaultAdbKeyId: null } } }));
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/#/admin/nodes');
    const cards = page.locator('.node-overview');
    await expect(cards).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    await expect(cards.locator('.node-state, .host-badge')).toHaveCount(0);
    const colors: string[] = [];
    const neutralColors: string[] = [];
    for (const state of states) {
      const card = cards.filter({ has: page.getByRole('link', { name: 'Настройки узла: ' + state.name, exact: true }) });
      await expect(card).toHaveAttribute('data-state', state.state);
      const cpu = card.locator('[data-resource="cpu"]');
      await expect(cpu.locator('strong')).toHaveText('Example CPU');
      await expect(cpu.locator('small')).toContainText('16 ядер · 32 потоков');
      await expect(cpu).not.toContainText('%');
      const memory = card.locator('[data-resource="memory"]');
      await expect(memory.locator('strong')).toHaveText('64 ГБ');
      await expect(memory.locator('small')).toHaveText('32 ГБ доступно');
      await expect(memory.locator('b')).toHaveText('50%');
      await expect(memory.locator('b')).toHaveAttribute('aria-label', /Занято.*50%/);
      const disk = card.locator('[data-resource="disk"]');
      await expect(disk.locator('strong')).toHaveText('512 ГБ');
      await expect(disk.locator('small')).toHaveText('256 ГБ свободно');
      await expect(disk.locator('b')).toHaveText('50%');
      await expect(disk.locator('b')).toHaveAttribute('aria-label', /Занято.*50%/);
      await expect(card.locator('.host-capacity strong')).toHaveText('2');
      await expect(card.locator('.host-capacity')).toContainText('свободно из 3 слотов');
      await expect(card.locator('.host-slot')).toHaveCount(3);
      await expect(card.locator('.host-slot[data-busy]')).toHaveCount(1);
      await expect(card.locator('.host-gpu-status')).toHaveText(state.state === 'online' ? 'Режимы запуска: cuda' : state.state === 'disabled' ? 'Узел отключён' : 'Узел не в сети');
      await expect(card.locator('[data-resource="gpu"] strong')).toHaveText('NVIDIA Example GPU');
      await expect(card).toHaveAttribute('aria-label', state.name + ' · ' + state.label);
      const indicator = card.locator('.host-status-indicator');
      const background = await indicator.evaluate(element => getComputedStyle(element).backgroundColor);
      neutralColors.push(await card.evaluate(element => getComputedStyle(element).backgroundColor));
      colors.push(background);
      await card.hover();
      await expect.poll(() => indicator.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(background);
    }
    expect(new Set(colors).size).toBe(3);
    expect(new Set(neutralColors).size).toBe(1);
    expect(colors).not.toContain(neutralColors[0]);
    const layout = await cards.evaluateAll(elements => elements.map(element => {
      const card = element.getBoundingClientRect();
      const header = element.querySelector('.host-status-indicator')!.getBoundingClientRect();
      return {
        top: card.top, left: card.left, width: card.width, headerBottom: header.bottom,
        rows: ['h3', '.host-address', '.node-freshness'].map(selector => element.querySelector('.host-card-heading ' + selector)!.getBoundingClientRect().top),
        resources: Array.from(element.querySelectorAll('.host-spec')).map(tile => ({
          left: tile.getBoundingClientRect().left,
          rows: [':scope > span', 'strong', 'small'].map(selector => tile.querySelector(selector)!.getBoundingClientRect().top),
        })),
      };
    }));
    if (width === 1280 && scale === 1) {
      expect(new Set(layout.map(card => Math.round(card.left))).size).toBe(2);
      expect(new Set(layout.map(card => Math.round(card.top))).size).toBe(2);
      expect(Math.abs(layout[0]!.top - layout[1]!.top)).toBeLessThanOrEqual(1);
      expect(layout[2]!.top).toBeGreaterThan(layout[0]!.top);
    }
    for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) {
      if (Math.abs(layout[i]!.top - layout[j]!.top) <= 1) {
        expect(Math.abs(layout[i]!.headerBottom - layout[j]!.headerBottom), 'Adjacent header/body boundaries align despite a long name').toBeLessThanOrEqual(1);
        layout[i]!.resources.forEach((tile, resource) => tile.rows.forEach((top, row) => expect(Math.abs(top - layout[j]!.resources[resource]!.rows[row]!), 'Resource labels, values and help align between adjacent cards').toBeLessThanOrEqual(1)));
        layout[i]!.rows.forEach((top, row) => expect(Math.abs(top - layout[j]!.rows[row]!), 'Title, IP and heartbeat share aligned rows despite a long name').toBeLessThanOrEqual(1));
      }
    }
    for (const card of layout) {
      expect(card.resources[0]!.left).toBeLessThan(card.resources[1]!.left);
      expect(card.resources[2]!.left).toBeLessThan(card.resources[3]!.left);
      for (const [left, right] of [[0, 1], [2, 3]]) {
        card.resources[left!]!.rows.forEach((top, row) => expect(Math.abs(top - card.resources[right!]!.rows[row]!), 'Paired resource labels, values and help share rows').toBeLessThanOrEqual(1));
      }
    }
    const inventory = page.getByRole('region', { name: 'Физические устройства', exact: true });
    await expect(inventory).toBeVisible();
    await expect(inventory.getByRole('columnheader', { name: 'Подключено к узлу', exact: true })).toBeVisible();
    await expect(inventory.locator('tbody tr')).toHaveCount(1);
    const phone = inventory.locator('tbody tr').first();
    for (const value of ['Pixel 9', 'USB-TEST-123456', 'Android по USB', 'Лаборатория USB', 'Свободно']) await expect(phone).toContainText(value);
    if (theme === 'dark') {
      const contrast = await phone.locator('.device-state-free').evaluate(element => {
        const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
        const luminance = (channels: number[]) => channels.slice(0, 3).map(value => {
          const linear = value / 255;
          return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
        const foreground = luminance(rgb(getComputedStyle(element).color));
        for (let node: Element | null = element; node; node = node.parentElement) {
          const channels = rgb(getComputedStyle(node).backgroundColor);
          if ((channels[3] ?? 1) < 1) continue;
          const background = luminance(channels);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        }
        throw new Error('Opaque inventory background was not found');
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    await expect(inventory).not.toContainText('slots');
    await expect(inventory).not.toContainText('internal-counter');
    await expect(inventory).not.toContainText('Служебный счётчик');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.mouse.move(width - 1, 0);
    if (scenario === 'narrow') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `../.tmp-ui/admin-node-states-${scenario}.png`, fullPage: true });
    }
    else await page.locator('.admin-section-panel').screenshot({ path: `../.tmp-ui/admin-node-states-${scenario}.png` });

    if (scenario === 'light') {
      for (const state of states) {
        const card = cards.filter({ has: page.getByRole('link', { name: 'Настройки узла: ' + state.name, exact: true }) });
        const dialog = await openDiagnostics(page, card);
        await expect(dialog.locator('.node-diagnostics')).toContainText(/32\s+потоков · 8\s+доступно для сессий/);
        const gpu = dialog.locator('.node-gpu-summary');
        await expect(gpu.locator('.node-gpu-status')).toHaveText(state.state === 'online' ? 'Доступен · CUDA' : state.state === 'disabled' ? 'Узел отключён' : 'Узел не в сети');
        const stats = gpu.locator('.node-gpu-stats');
        await expect(stats).toContainText('Загрузка GPU');
        await expect(stats).toContainText('Занято видеопамяти');
        if (state.state === 'online') {
          await expect(stats).toContainText('0%');
          await expect(stats).toContainText(/33 из 16\s384 МБ/);
        } else {
          await expect(stats).toContainText('Нет данных');
          await expect(stats).not.toContainText('%');
          await expect(stats).not.toContainText('МБ');
        }
        await closeNode(page);
      }
      const disabled = cards.filter({ has: page.getByRole('link', { name: 'Настройки узла: ' + states[1].name, exact: true }) });
      const box = (await disabled.boundingBox())!;
      await disabled.click({ position: { x: box.width - 12, y: 12 } });
      await expect(page.getByRole('dialog', { name: 'worker-disabled · Сервер интеграционных проверок Android и автоматизации', exact: true })).toBeVisible();
      await expect(page).toHaveURL(/#\/admin\/nodes\?host=node-disabled$/);
    }
  });
}

test('a single node remains compact and a legacy slot report never creates a physical inventory', async ({ page }) => {
  await mockNodes(page, false, 1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/admin/nodes');
  await expect(page.locator('.node-overview')).toHaveCount(1);
  const card = (await page.locator('.node-overview').boundingBox())!;
  const grid = (await page.locator('.node-overview-grid').boundingBox())!;
  expect(card.width).toBeLessThanOrEqual(grid.width * 0.6);
  await expect(page.getByRole('region', { name: 'Физические устройства', exact: true })).toHaveCount(0);
});


test('missing node metrics are unknown rather than zero resources', async ({ page }) => {
  await mockNodes(page, false, 1, true);
  await page.goto('/#/admin/nodes');
  const card = page.locator('.node-overview');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.host-gpu-status')).toHaveText('Нет данных');
  await expect(card.locator('[data-resource="memory"] strong')).toHaveText('—');
  await expect(card.locator('[data-resource="disk"] strong')).toHaveText('Нет данных');
  await expect(card.locator('.host-spec b, .host-meter')).toHaveCount(0);
  for (const resource of ['cpu', 'memory', 'disk']) {
    await expect(card.locator(`[data-resource="${resource}"]`)).not.toContainText(/\b0\b/);
  }
  await expect(card.locator('.host-capacity strong')).toHaveText('2');
  await expect(card.locator('.host-capacity')).toContainText('свободно из 3 слотов');
  const dialog = await openDiagnostics(page, card);
  await expect(dialog.locator('.node-gpu-status')).toHaveText('Нет данных');
  await expect(dialog.locator('.node-gpu-stats')).toContainText('Нет данных');
  await expect(dialog.locator('.node-gpu-stats')).not.toContainText('0');
});


test('compact GPU state distinguishes unsupported hardware, missing telemetry and stale measurements', async ({ page }) => {
  const telemetry = [{ index: 0, utilizationPercent: 67, memoryUsedMb: 33, memoryTotalMb: 16384 }];
  const cases = [
    { id: 'gpu-without-readings', label: 'Доступен · CUDA', stale: false, metrics: { gpuPresent: true, gpuCapabilities: ['cuda'], nvidiaGpuAvailable: true, gpuTelemetry: undefined } },
    { id: 'gpu-absent', label: 'Не обнаружен', stale: false, metrics: { gpuPresent: false, gpuCapabilities: [], nvidiaGpuAvailable: false, gpuTelemetry: undefined } },
    // The explicit empty capability list must override a legacy true flag.
    { id: 'gpu-unsupported', label: 'Недоступен для запуска', stale: false, metrics: { gpuPresent: true, gpuCapabilities: [], nvidiaGpuAvailable: true, gpuTelemetry: undefined } },
    { id: 'gpu-stale', label: 'Данные устарели', stale: true, metrics: { gpuPresent: true, gpuCapabilities: ['cuda'], nvidiaGpuAvailable: true, gpuTelemetry: telemetry } },
  ];
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const response = await route.fetch();
    const source = (await response.json()).hosts[0];
    await route.fulfill({ json: { hosts: cases.map(item => ({
      ...source, id: item.id, name: item.id, displayName: null, agentName: item.id,
      status: 'online', disabled: false, devices: [],
      lastSeenAt: new Date(Date.now() - (item.stale ? 300_000 : 1_000)).toISOString(),
      metrics: { ...source.metrics, gpuModel: undefined, gpuVendor: undefined, driGpuAvailable: undefined, ...item.metrics },
    })) } });
  });
  await page.goto('/#/admin/nodes');
  for (const item of cases) {
    const card = page.locator('.node-overview').filter({ has: page.getByRole('link', { name: 'Настройки узла: ' + item.id, exact: true }) });
    await expect(card.locator('.host-gpu-status')).toHaveText(item.id === 'gpu-without-readings' ? 'Режимы запуска: cuda' : item.label);
    const dialog = await openDiagnostics(page, card);
    const gpu = dialog.locator('.node-gpu-summary');
    await expect(gpu.locator('.node-gpu-status')).toHaveText(item.label);
    await expect(gpu.locator('.node-gpu-stats')).toContainText('Нет данных');
    await expect(gpu.locator('.node-gpu-stats')).not.toContainText('%');
    await expect(gpu.locator('.node-gpu-stats')).not.toContainText('МБ');
    await closeNode(page);
  }
});


test('compact GPU measurements keep separate devices and preserve zero values', async ({ page }) => {
  await page.route('**/api/me/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/hosts', async route => {
    const response = await route.fetch();
    const source = (await response.json()).hosts[0];
    await route.fulfill({ json: { hosts: [{
      ...source, status: 'online', disabled: false, lastSeenAt: new Date().toISOString(),
      metrics: { ...source.metrics, gpuPresent: true, gpuCapabilities: ['cuda', 'gpu'], gpuTelemetry: [
        { index: 0, utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 16384 },
        { index: 1, utilizationPercent: 67, memoryUsedMb: 33, memoryTotalMb: 16384 },
      ] },
    }] } });
  });
  await page.goto('/#/admin/nodes');
  const card = page.locator('.node-overview');
  await expect(card.locator('.host-gpu-status')).toHaveText('Режимы запуска: cuda · gpu');
  const dialog = await openDiagnostics(page, card);
  const gpu = dialog.locator('.node-gpu-summary');
  await expect(gpu.locator('.node-gpu-status')).toHaveText('Доступен · CUDA / GPU');
  const devices = gpu.locator('.node-gpu-device');
  await expect(devices).toHaveCount(2);
  for (const [index, load, memory] of [[0, '0%', /0 из 16\s384 МБ/], [1, '67%', /33 из 16\s384 МБ/]] as const) {
    const device = devices.nth(index);
    await expect(device.locator('dt')).toHaveText(['Загрузка GPU #' + index, 'Видеопамять GPU #' + index]);
    await expect(device.locator('dd').nth(0)).toHaveText(load);
    await expect(device.locator('dd').nth(1)).toHaveText(memory);
  }
});
