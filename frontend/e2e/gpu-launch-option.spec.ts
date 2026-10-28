import { openLaunchSection } from './launch-controls';
import { expect, test, type Page } from '@playwright/test';

const profile = {
  id: 'gpu-option-qa', name: 'Android 11 · Google APIs', androidVersion: '11', apiLevel: 30,
  abi: 'x86_64', deviceType: 'mobile', imageFlavor: 'google_apis',
  image: 'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',
  cpu: 4, memoryMb: 4096,
  guestMemoryMb: 2048, guestCores: 2, diskGb: 8, enabled: true,
};

type ProfileOverride = Partial<typeof profile> & { gpuSupport?: string };
type HostOverride = { id: string; name: string; gpuHost: boolean; gpuCapabilities?: Array<'cuda' | 'gpu'>; slots?: number; usedSlots?: number; status?: 'online' | 'offline'; disabled?: boolean; lastSeenAt?: string };
async function fixture(page: Page, options: { gpuHost?: boolean; slotMemoryMb?: number; profile?: ProfileOverride; extraProfiles?: ProfileOverride[]; role?: 'user'; hosts?: HostOverride[]; initialBusy?: boolean; theme?: 'light' | 'dark' } = {}) {
  const requests: Record<string, unknown>[] = [];
  const queued: Record<string, unknown>[] = [];
  const extraProfiles = (options.extraProfiles ?? []).map(extra => ({ ...profile, ...extra }));
  const state = { profile: { ...profile, ...options.profile }, gpuHost: options.gpuHost !== false, slotMemoryMb: options.slotMemoryMb ?? 6144 };
  if (options.role) await page.route('**/api/me', async route => { const body = await (await route.fetch()).json(); body.user.role = options.role; await route.fulfill({ json: body }); });
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: { theme: options.theme ?? 'light', fontFamily: 'system', fontScale: 1, defaultAdbKeyId: null } } }));
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [state.profile, ...extraProfiles] } }));
  await page.route('**/api/hosts', async route => {
    const body = await (await route.fetch()).json();
    const source = body.hosts[0];
    const hosts = options.hosts ?? [{ id: source.id, name: source.name, gpuHost: state.gpuHost }];
    await route.fulfill({ json: { hosts: hosts.map(host => ({ ...source, id: host.id, name: host.name, agentName: host.name, status: host.status ?? 'online', disabled: host.disabled ?? false, lastSeenAt: host.lastSeenAt ?? new Date().toISOString(), slots: host.slots ?? 2, usedSlots: host.usedSlots ?? 0, slotMemoryMb: state.slotMemoryMb, metrics: { ...source.metrics, nvidiaGpuAvailable: host.gpuHost, gpuCapabilities: host.gpuCapabilities } })) } });
  });
  await page.route('**/api/sessions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessions: [] } });
    requests.push(route.request().postDataJSON());
    // Keep the modal open to compare both modes without creating a device.
    return route.fulfill({ status: 400, json: { error: { code: 'test_only', message: 'Тест: запуск перехвачен' } } });
  });
  await page.route('**/api/queue', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { entries: [], maxEntries: 3 } });
    queued.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: { code: 'test_only', message: 'Тест: очередь перехвачена' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: 'Новая сессия' });
  await expect(modal.getByRole('button', { name: options.initialBusy ? 'Встать в очередь' : 'Запустить', exact: true })).toBeEnabled();
  return { modal, requests, queued, state };
}

test('GPU toggle keeps one image and resource limit and sends the chosen mode', async ({ page }, testInfo) => {
  const { modal, requests } = await fixture(page, { theme: 'dark' });
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  const launch = modal.getByRole('button', { name: 'Запустить', exact: true });
  await expect(gpu).toBeEnabled();
  await expect(gpu).not.toBeChecked();
  await modal.locator('.create-container-details summary').click();
  await modal.locator('.create-settings > summary').click();
  await openLaunchSection(modal, 'connection');
  for (const [checked, mode] of [[true, 'nvidia'], [false, 'software']] as const) {
    await gpu.setChecked(checked);
    await expect(modal.locator('.create-container-details')).toContainText(profile.image);
    await expect(modal.getByRole('spinbutton', { name: 'Лимит памяти на узле, МБ', exact: true })).toHaveValue('4096');
    await expect(launch).toBeEnabled();
    await launch.click();
    await expect.poll(() => requests.length).toBe(checked ? 1 : 2);
    expect(requests.at(-1)).toMatchObject({ profileId: profile.id, gpuMode: mode });
  }
  await gpu.check();
  await expect(gpu).toHaveCSS('background-color', 'rgb(52, 211, 153)');
  await page.screenshot({ path: testInfo.outputPath('gpu-capability-dark.png') });
});

test('legacy profile GPU restrictions do not prevent launch on a capable node', async ({ page }) => {
  const { modal, requests } = await fixture(page, { profile: { gpuSupport: 'none' } });
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  await expect(gpu).toBeEnabled();
  await gpu.check();
  await expect(modal.getByRole('combobox', { name: 'Устройство', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ gpuMode: 'nvidia' });
});

test('missing host capability disables GPU with the specific reason and recovers on refresh', async ({ page }) => {
  await page.clock.install();
  const { modal, state } = await fixture(page, { gpuHost: false });
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  await expect(gpu).toBeDisabled();
  await expect(modal.locator('#create-gpu-help')).toContainText('На узле недоступно ускорение GPU');
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
  state.gpuHost = true;
  await page.clock.fastForward(10_000);
  await expect(gpu).toBeEnabled();
  await expect(gpu).not.toBeChecked();
  await gpu.check();
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
});

test('GPU remains switchable off if a selected host loses the capability', async ({ page }) => {
  await page.clock.install();
  const { modal, state } = await fixture(page);
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  await gpu.check();
  state.gpuHost = false;
  await page.clock.fastForward(10_000);
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await expect(gpu).toBeEnabled();
  await expect(gpu).toBeChecked();
  await gpu.uncheck();
  await expect(gpu).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
});

for (const support of ['cuda', 'gpu'] as const) {
  test(`a node reporting ${support} can accelerate any profile`, async ({ page }) => {
    const { modal, requests } = await fixture(page, { hosts: [
      { id: 'cpu-host', name: 'Узел без GPU', gpuHost: false, gpuCapabilities: [] },
      { id: support + '-host', name: 'Узел с GPU', gpuHost: false, gpuCapabilities: [support] },
    ] });
    await modal.getByRole('switch', { name: 'Ускорение GPU' }).check();
    await expect(modal.locator('#create-gpu-help')).toContainText(support === 'cuda' ? 'NVIDIA / CUDA' : 'GPU готов');
    await modal.getByRole('button', { name: 'Запустить', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ hostId: support + '-host', gpuMode: 'nvidia' });
  });
}

test('reported empty capabilities override a stale NVIDIA availability flag', async ({ page }) => {
  const { modal } = await fixture(page, { hosts: [{ id: 'none', name: 'Без GPU', gpuHost: true, gpuCapabilities: [] }] });
  await expect(modal.getByRole('switch', { name: 'Ускорение GPU' })).toBeDisabled();
  await expect(modal.locator('#create-gpu-help')).toContainText('На узле недоступно ускорение GPU');
});

test('changing the profile preserves acceleration when the node supports GPU', async ({ page }) => {
  const other = { id: 'software-profile', name: 'Android 12', gpuSupport: 'none' };
  const { modal } = await fixture(page, { extraProfiles: [other] });
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  await gpu.check();
  const device = modal.getByRole('combobox', { name: 'Устройство', exact: true });
  await device.selectOption(other.id);
  await expect(device).toHaveValue(other.id);
  await expect(gpu).toBeChecked();
  await expect(gpu).toBeEnabled();
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
});

test('remembered launch GPU survives legacy profile metadata', async ({ page }) => {
  await page.addInitScript(id => localStorage.setItem('rdf.lastLaunch', JSON.stringify({ profileId: id, gpuMode: 'nvidia' })), profile.id);
  const { modal } = await fixture(page, { profile: { gpuSupport: 'none' } });
  await expect(modal.getByRole('switch', { name: 'Ускорение GPU' })).toBeChecked();
  await expect(modal.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
});



test('a busy compatible GPU node offers a GPU queue instead of using a free incompatible node', async ({ page }) => {
  const { modal, queued } = await fixture(page, { hosts: [
    { id: 'cpu-free', name: 'Свободный узел без GPU', gpuHost: false, gpuCapabilities: [] },
    { id: 'gpu-busy', name: 'Занятый CUDA узел', gpuHost: true, gpuCapabilities: ['cuda'], slots: 1, usedSlots: 1 },
  ] });
  const gpu = modal.getByRole('switch', { name: 'Ускорение GPU' });
  await gpu.check();
  const queue = modal.getByRole('button', { name: 'Встать в очередь', exact: true });
  await expect(queue).toBeEnabled();
  await queue.click();
  await expect.poll(() => queued.length).toBe(1);
  expect(queued[0]).toMatchObject({ hostId: null, profileId: profile.id, gpuMode: 'nvidia' });
});

for (const [kind, hostState, hint] of [
  ['offline', { status: 'offline' as const }, 'Узел не в сети'],
  ['disabled', { disabled: true }, 'Узел отключён'],
] as const) {
  test(`${kind} GPU nodes show availability rather than absent GPU`, async ({ page }) => {
    const { modal } = await fixture(page, { hosts: [
      { id: 'cpu-free', name: 'Узел CPU', gpuHost: false, gpuCapabilities: [] },
      { id: 'gpu-unavailable', name: 'Узел GPU', gpuHost: true, gpuCapabilities: ['cuda'], ...hostState },
    ] });
    await expect(modal.getByRole('switch', { name: 'Ускорение GPU' })).toBeDisabled();
    await expect(modal.locator('#create-gpu-help')).toContainText(hint);
    await expect(modal.locator('#create-gpu-help')).not.toContainText('недоступно ускорение GPU');
  });
}
