import { expect, test, type Locator, type Page } from '@playwright/test';

// Relative luminance and contrast ratio of the rendered text colour against the first opaque ancestor background.
async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const parse = (value: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return [0, 0, 0, 0];
      const parts = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    let background: [number, number, number, number] = [255, 255, 255, 1];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] > 0.95) { background = color; break; }
    }
    const text = parse(getComputedStyle(element).color);
    const a = lum(text), b = lum(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

async function openSession(page: Page) {
  await page.goto('/');
  await expect(page.locator('.session-card').first()).toBeVisible();
  await page.locator('.session-card').first().getByRole('link', { name: /Открыть сессию:/ }).click();
  await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toBeVisible();
}

test('login page renders when signed out', async ({ page }) => {
  await page.route('**/api/me', route => route.fulfill({ json: { user: null } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Войти/ })).toBeVisible();
  await expect(page.locator('.login-form input').first()).toBeVisible();
});

test('Sessions replaces Home and keeps launch and session navigation available', async ({ page }) => {
  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Сессии', level: 1, exact: true })).toBeVisible();
  const sessionsLink = page.getByRole('navigation', { name: 'Главная навигация', exact: true }).getByRole('link', { name: 'Сессии', exact: true });
  await expect(sessionsLink).toHaveAttribute('href', '#/overview');
  await expect(sessionsLink).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Device Farm — Сессии', exact: true })).toHaveAttribute('href', '#/overview');
  await expect(page.locator('.overview-hosts, .overview-stats, .host-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Узлы', exact: true })).toHaveCount(0);
  await expect(page.getByText('Свободных слотов', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Узлов в сети', { exact: true })).toHaveCount(0);
  const card = page.locator('.overview-sessions .session-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Android 11');
  await page.getByRole('button', { name: 'Новая сессия', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая сессия', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await card.getByRole('link', { name: /Открыть сессию:/ }).click();
  await expect(page).toHaveURL(/#\/session\//);
  await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toBeVisible();
});

test('a session opens with the screen and the console, log and info tabs', async ({ page }) => {
  await openSession(page);
  await expect(page.getByAltText('Экран Android устройства')).toBeAttached();
  await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Инструменты устройства' });
  for (const name of ['Консоль', 'Логкат', 'Сведения']) await expect(tabs.getByRole('tab', { name })).toBeVisible();

  await tabs.getByRole('tab', { name: 'Логкат' }).click();
  await expect(page.getByRole('heading', { name: 'Логкат устройства' })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Сведения' }).click();
  await expect(tabs.getByRole('tab', { name: 'Сведения' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Консоль' }).click();
  await expect(page.getByRole('heading', { name: 'Консоль устройства' })).toBeVisible();
});

test('log search with a regular expression filters rows', async ({ page }) => {
  await openSession(page);
  await page.getByRole('tab', { name: 'Логкат' }).click();
  const rows = page.locator('.log-row');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  expect(before).toBeGreaterThan(20);

  await page.getByRole('button', { name: 'Регулярное выражение', exact: true }).click();
  await page.getByLabel('Поиск по журналу').fill('FATAL|dns timeout');
  await expect(async () => {
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(before);
  }).toPass();
  for (const text of await rows.allInnerTexts()) expect(text).toMatch(/FATAL|dns timeout/);

  await page.getByLabel('Поиск по журналу').fill('(');
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
});

test('dark theme keeps text readable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-effective-theme', 'dark');
  const card = page.locator('.session-card').first();
  await expect(card).toBeVisible();
  const probes: Locator[] = [
    page.getByRole('heading', { name: 'Сессии', level: 1 }),
    card.getByRole('link', { name: /Открыть сессию:/ }),
    page.locator('.overview-sessions').getByRole('heading', { name: /^Мои сессии/ }),
    card.locator('.status-badge'),
  ];
  for (const probe of probes) {
    const ratio = await contrastOf(probe);
    expect.soft(ratio, await probe.innerText()).toBeGreaterThanOrEqual(4.5);
  }
});

test('the admin load chart is readable in dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/admin/ops');
  const section = page.locator('#adm-ops');
  await expect(section.getByRole('heading', { name: 'Занятые слоты' })).toBeVisible();
  await expect(section.locator('.ops-chart svg').first()).toBeVisible();
  await section.getByText('Данные графика таблицей').click();
  await expect(section.getByRole('table', { name: /Занятые слоты по узлам/ })).toBeVisible();
  const ratio = await contrastOf(section.locator('.ops-card strong').first());
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('admin sidebar links retain native keyboard navigation and addressable routes', async ({ page }) => {
  await page.goto('/#/admin/sessions');
  const nav = page.getByRole('navigation', { name: 'Администрирование', exact: true });
  const sections = [
    ['sessions', 'Все сессии'], ['nodes', 'Узлы'], ['profiles', 'Профили устройств'],
    ['images', 'Образы'], ['roles', 'Роли и права'], ['users', 'Пользователи'], ['ops', 'Нагрузка'], ['journal', 'Журнал'],
  ] as const;
  await expect(nav.getByRole('link')).toHaveCount(sections.length);
  for (const [id, label] of sections) {
    await expect(nav.getByRole('link', { name: new RegExp('^' + label + '(?:\\s|$)') })).toHaveAttribute('href', '#/admin/' + id);
  }
  await expect(nav.getByRole('link', { name: /^Все сессии(?:\s|$)/ })).toHaveAttribute('aria-current', 'page');
  const journal = nav.getByRole('link', { name: 'Журнал', exact: true });
  await journal.focus();
  await journal.press('Enter');
  await expect(page).toHaveURL(/#\/admin\/journal$/);
  await expect(journal).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Журнал', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Разделы администрирования' })).toHaveCount(0);
  await page.goBack();
  await expect(nav.getByRole('link', { name: /^Все сессии(?:\s|$)/ })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(journal).toHaveAttribute('aria-current', 'page');
  await page.goto('/#/admin/nodes?host=h1');
  await expect(nav.getByRole('link', { name: 'Узлы', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog', { name: 'worker-01', exact: true })).toBeVisible();
});

test('regular users cannot see admin navigation or open admin sections through a direct route', async ({ page }) => {
  const adminRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/admin/')) adminRequests.push(request.url()); });
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'u1', username: 'qa', displayName: 'QA', role: 'user' } } }));
  await page.goto('/#/admin/profiles');
  await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Администрирование', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar a[href^="#/admin/"]')).toHaveCount(0);
  await expect(page.locator('.admin-workspace')).toHaveCount(0);
  await expect(page.locator('.host-card')).toHaveCount(0);
  await page.goto('/#/admin/users');
  await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeVisible();
  await expect(page.locator('.admin-workspace')).toHaveCount(0);
  expect(adminRequests).toEqual([]);
});

test('retired team route shows existing administration without a team editor', async ({ page }) => {
  await page.goto('/#/admin/teams');
  await expect(page.getByRole('heading', { name: 'Все сессии', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Команды' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Новая команда' })).toHaveCount(0);
});
test.describe('phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('admin navigation closes the mobile menu after selecting a section', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    const sidebar = page.locator('.sidebar');
    const nav = page.getByRole('navigation', { name: 'Администрирование', exact: true });
    await expect(sidebar).toHaveClass(/mobile-open/);
    const journal = nav.getByRole('link', { name: 'Журнал', exact: true });
    await journal.scrollIntoViewIfNeeded();
    await expect(journal).toBeInViewport();
    await journal.click();
    await expect(page).toHaveURL(/#\/admin\/journal$/);
    await expect(sidebar).not.toHaveClass(/mobile-open/);
    await expect(page.getByRole('heading', { name: 'Журнал', level: 1, exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    await expect(journal).toHaveAttribute('aria-current', 'page');
    // Choosing the already active entry must also dismiss the drawer.
    await journal.click();
    await expect(sidebar).not.toHaveClass(/mobile-open/);
  });

  test('overview has no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.session-card').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('session view has no horizontal overflow', async ({ page }) => {
    await openSession(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test('Sessions keeps personal sessions, the queue and shared access without node cards', async ({ page }) => {
  await page.route('**/api/queue', route => route.fulfill({ json: { entries: [{
    id: 'sessions-page-queue', profileId: 'a13', profileName: 'Android 13 · Software',
    hostId: null, hostName: null, label: null, position: 2,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }], maxEntries: 3 } }));
  await page.goto('/#/overview');
  const sessions = page.locator('.overview-sessions');
  await expect(sessions.getByRole('heading', { name: /^Мои сессии/ })).toBeVisible();
  await expect(sessions.locator('.session-card').first()).toBeVisible();
  const queue = page.getByRole('region', { name: 'Очередь на устройство', exact: true });
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('Android 13 · Software');
  await expect(queue.getByRole('button', { name: 'Отменить', exact: true })).toBeEnabled();
  await expect(page.locator('.overview-stats, .overview-hosts, .host-card')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Сессии команды' })).toHaveCount(0);
  const shared = page.getByRole('region', { name: 'Доступные мне' });
  await expect(shared.getByRole('link', { name: /Открыть/ })).toHaveAttribute('href', /#\/session\//);
});
test.describe('responsive workspace', () => {
  for (const [label, width, height] of [
    ['phone', 390, 844],
    ['notebook', 1366, 768],
    ['desktop', 1920, 1080],
    ['large desktop', 2560, 1440],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${label} ${width} × ${height} in ${theme} theme keeps essential controls reachable`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Сессии', level: 1 })).toBeInViewport();
        await expect(page.getByRole('button', { name: 'Новая сессия' })).toBeInViewport();
        await expect(page.locator('.session-card').first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

        await openSession(page);
        await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toBeVisible();
        for (const name of ['Домой', 'Передать файлы на устройство']) {
          const control = page.getByRole('button', { name, exact: true });
          await expect(control).toBeVisible();
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport();
        }
        // Compact layouts show the screen and the tools one at a time.
        if (width < 1201) await page.getByRole('group', { name: 'Компоновка сессии' }).getByRole('button', { name: 'Инструменты', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'Консоль' })).toBeVisible();
        if (width >= 1366) await expect(page.getByRole('heading', { name: 'Консоль устройства' })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      });
    }
  }
});

test('HD session keeps every control and input visible with a saved tall console', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => localStorage.setItem('rdf-console-height', '1000'));
  await openSession(page);
  await expect(page.locator('.banner-warning')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const selectors = ['.device-screen', '.device-controls', '.text-send', '.terminal-input'];
    return Math.ceil(Math.max(...selectors.map(selector => document.querySelector(selector)!.getBoundingClientRect().bottom)));
  })).toBeLessThanOrEqual(760);
  await expect(page.getByRole('button', { name: 'Скачать PNG-снимок экрана устройства' })).toBeInViewport();
  expect(await page.evaluate(() => localStorage.getItem('rdf-console-height'))).toBe('1000');
});

test('account key deep link follows browser back and forward', async ({ page }) => {
  await page.goto('/#/account/profile');
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
  await expect(nav.getByRole('button', { name: 'Профиль' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: 'Ключи ADB' }).click();
  await expect(page).toHaveURL(/#\/account\/keys$/);
  await expect(page.locator('#settings-keys')).toBeVisible();
  await page.goBack();
  await expect(nav.getByRole('button', { name: 'Профиль' })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(nav.getByRole('button', { name: 'Ключи ADB' })).toHaveAttribute('aria-current', 'page');
});
test.describe('profile appearance', () => {
  for (const [setting, systemTheme] of [['dark', 'light'], ['light', 'dark']] as const) {
    test(`saved ${setting} theme overrides ${systemTheme} system theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: systemTheme });
      await page.route('**/api/me/preferences', async route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        const preferences = route.request().postDataJSON();
        await route.fulfill({ json: { preferences } });
      });
      await page.goto('/#/account/appearance');
      const appearance = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Оформление' }) });
      await expect(appearance).toBeVisible();
      const saved = page.waitForRequest(item => item.method() === 'PATCH' && item.url().endsWith('/api/me/preferences'));
      await appearance.getByRole('radio', { name: setting === 'dark' ? 'Тёмная' : 'Светлая' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-effective-theme', setting);
      expect((await saved).postDataJSON().theme).toBe(setting);
      await expect(appearance).toBeVisible();
    });
  }
  test('a fixed scale sets one predictable root size and Auto returns to the responsive one', async ({ page }) => {
    await page.route('**/api/me/preferences', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({ json: { preferences: route.request().postDataJSON() } });
    });
    await page.goto('/#/account/appearance');
    const html = page.locator('html');
    await page.getByRole('radio', { name: '130%' }).click();
    await expect(html).toHaveCSS('font-size', '20.8px');
    await page.getByRole('radio', { name: 'Авто' }).click();
    await expect(html).not.toHaveAttribute('style', /font-size/);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('root')!).zoom)).toBe('1');
  });
});
test.describe('launch profile compatibility', () => {
  for (const [label, width, height, theme] of [
    ['HD dark', 1366, 768, 'dark'],
    ['phone light', 390, 844, 'light'],
  ] as const) {
    test(`selects the first profile that fits a 4 GB slot on ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.route('**/api/hosts', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.hosts[0].slotMemoryMb = 4096;
        await route.fulfill({ json: data });
      });
      await page.route(/\/api\/(admin\/)?profiles$/, async route => {
        const response = await route.fetch();
        const data = await response.json();
        const fittingProfile = data.profiles.find((profile: { id: string }) => profile.id === 'a13');
        fittingProfile.memoryMb = 4096;
        // Android must leave the required 1 GB for the emulator inside the 4 GB container.
        fittingProfile.guestMemoryMb = 3072;
        fittingProfile.name = 'Android 13 · Software · Pixel 6 Pro · Google APIs · x86_64';
        await route.fulfill({ json: data });
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Новая сессия' }).click();
      const dialog = page.getByRole('dialog', { name: 'Новая сессия' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.create-selected-profile h3')).toContainText('Android 13 · Software');
      const launch = dialog.getByRole('button', { name: 'Запустить' });
      await expect(launch).toBeEnabled();
      await expect(launch).toBeInViewport();
      const longName = dialog.locator('.create-selected-profile h3');
      const widthOverflow = await longName.evaluate(node => node.scrollWidth - node.clientWidth);
      expect(widthOverflow).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await expect(page.locator('html')).toHaveAttribute('data-effective-theme', theme);
    });
  }
});
test('share link disappears after closing the dialog', async ({ page }) => {
  await openSession(page);
  await page.getByRole('button', { name: /Поделиться/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Доступ к сессии' });
  await dialog.getByRole('button', { name: 'Создать ссылку' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка на сессию' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: /Поделиться/ }).click();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка на сессию' })).toHaveCount(0);
});

test('shared view hides owner tools', async ({ page }) => {
  await page.goto('/#/shared/rdfs_view_aaaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Инструменты устройства' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Освободить', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Завершить', exact: true })).toHaveCount(0);
  await expect(page.getByRole('application', { name: 'Сенсорный экран устройства' })).toHaveAttribute('tabindex', '-1');
  await page.request.post('/api/shares/redeem', { data: { token: 'rdfs_owner_aaaaaaaaaaaaaaaaaaaaaaaaaa' } });
});
test('share link supports several recipients with an explicit limit', async ({ page }) => {
  await openSession(page);
  await page.getByRole('button', { name: /Поделиться/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Доступ к сессии' });
  await expect(dialog.getByRole('radio', { name: /Один человек/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /Несколько человек/ }).check();
  await dialog.getByRole('spinbutton', { name: /Максимум получателей/ }).fill('3');
  const request = page.waitForRequest(item => item.method() === 'POST' && /\/api\/sessions\/[^/]+\/shares$/.test(item.url()));
  await dialog.getByRole('button', { name: 'Создать ссылку' }).click();
  expect((await request).postDataJSON().maxRecipients).toBe(3);
  await expect(dialog).toContainText('Использовано мест: 0 из 3');
});
test('admin can create and edit company details on a local user', async ({ page }) => {
  await page.goto('/#/admin/users');
  await page.getByRole('button', { name: 'Новый пользователь' }).click();
  const create = page.getByRole('dialog', { name: 'Новый пользователь' });
  await create.getByLabel('Логин').fill('qa.company.e2e');
  await create.getByLabel('Отображаемое имя').fill('QA Company');
  await create.getByLabel('Компания').fill('Example Mobile');
  await create.getByLabel('Должность').fill('Тестировщик');
  await create.getByLabel('Пароль', { exact: true }).fill('temporary12345');
  await create.getByRole('button', { name: 'Создать пользователя' }).click();
  await expect(create).toHaveCount(0);
  const row = page.locator('.user-record').filter({ hasText: 'qa.company.e2e' });
  await expect(row).toContainText('Example Mobile · Тестировщик');
  await row.getByRole('button', { name: 'Изменить' }).click();
  const edit = page.getByRole('dialog', { name: 'Данные пользователя' });
  await expect(edit.getByLabel('Компания')).toHaveValue('Example Mobile');
  await edit.getByLabel('Компания').fill('Example QA');
  await edit.getByLabel('Должность').fill('Android QA');
  await edit.getByRole('button', { name: 'Сохранить' }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText('Example QA · Android QA');
});

test('profile company and job title persist after saving', async ({ page }) => {
  await page.goto('/#/account/profile');
  const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Личные данные' }) });
  await expect(card.getByLabel('Компания')).toHaveValue('Device Farm');
  await card.getByLabel('Компания').fill('Mobile Lab');
  await card.getByLabel('Должность').fill('Старший тестировщик');
  await card.getByRole('button', { name: 'Сохранить данные' }).click();
  await page.reload();
  await expect(card.getByLabel('Компания')).toHaveValue('Mobile Lab');
  await expect(card.getByLabel('Должность')).toHaveValue('Старший тестировщик');
});
test('pausing node sends only availability while its name edit is unsaved', async ({ page }) => {
  const source = (await (await page.request.get('/api/hosts')).json()).hosts[0];
  await page.route('**/api/admin/hosts/h1/settings', route => route.fulfill({ json: { host: { ...source, disabled: true }, policyError: null } }));
  await page.goto('/#/admin/nodes');
  await page.getByRole('link', { name: 'Настройки узла: worker-01', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'worker-01' });
  await dialog.getByLabel('Имя узла').fill('Несохранённое имя');
  const request = page.waitForRequest(item => item.method() === 'PATCH' && /\/api\/admin\/hosts\/h1\/settings$/.test(item.url()));
  await dialog.getByRole('button', { name: 'Отключить узел' }).click();
  expect((await request).postDataJSON()).toEqual({ disabled: true });
  await expect(dialog.getByLabel('Имя узла')).toHaveValue('Несохранённое имя');
});
test('a node connected through server configuration has no token to revoke', async ({ page }) => {
  await page.route('**/api/admin/agents', route => route.fulfill({ json: { agents: [
    { hostId: 'h1', name: 'worker-01', source: 'environment', canRevoke: false, status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  ] } }));
  await page.goto('/#/admin/nodes?host=h1');
  const dialog = page.getByRole('dialog', { name: 'worker-01' });
  await expect(dialog).toContainText('Агент подключён через конфигурацию сервера.');
  await expect(dialog.getByRole('button', { name: 'Отозвать токен' })).toHaveCount(0);
});
