import { expect, test, type Locator, type Page } from '@playwright/test';

const sessionId = 'cbd55091-aaaa-bbbb-cccc-000000000001';
const stoppedId = 'stopped-session';
const stoppedSession = {
  id: stoppedId, ownerId: 'u1', ownerName: 'admin', hostId: 'h1', hostName: 'worker-01',
  profileId: 'a13', profileName: 'Stopped device', state: 'stopped', orientation: 'portrait',
  audioEnabled: false, networkEnabled: true, createdAt: '2026-01-01T00:00:00Z', label: null,
};

// Exercise the enlarged hit area, away from the visible primary button.
async function whitespace(card: Locator) {
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  await card.click({ position: { x: box!.width - 12, y: 12 } });
}
async function closeDialog(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: /^Закрыть/ }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('node card whitespace opens the same settings as its native link', async ({ page }) => {
  await page.goto('/#/admin/nodes');
  const adminNode = page.locator('.node-overview').first();
  await whitespace(adminNode);
  await expect(page).toHaveURL(/#\/admin\/nodes\?host=h1$/);
  await expect(page.getByRole('dialog', { name: 'worker-01' })).toBeVisible();
  await closeDialog(page);
  const action = adminNode.locator('.card-primary-action');
  await expect(action).toHaveAttribute('href', /#\/admin\/nodes\?host=h1$/);
  await action.focus();
  await action.press('Enter');
  await expect(page.getByRole('dialog', { name: 'worker-01' })).toBeVisible();
  await closeDialog(page);
  await page.goto('/#/hosts');
  await whitespace(page.locator('.host-card').first());
  await expect(page.getByRole('dialog', { name: 'worker-01' })).toBeVisible();
});

test('profile and local user cards support whitespace and native keyboard buttons', async ({ page }) => {
  await page.goto('/#/admin/profiles');
  const profile = page.locator('.admin-profile-row').first();
  await whitespace(profile);
  await expect(page.getByRole('dialog', { name: 'Изменить профиль' })).toBeVisible();
  await closeDialog(page);
  for (const key of ['Enter', 'Space']) {
    await profile.locator('.card-primary-action').focus();
    await profile.locator('.card-primary-action').press(key);
    await expect(page.getByRole('dialog', { name: 'Изменить профиль' })).toBeVisible();
    await closeDialog(page);
  }
  const details = profile.getByRole('button', { name: /^Образ и параметры:/ });
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await profile.getByRole('button', { name: 'Отключить', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Отключить профиль?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.goto('/#/admin/users');
  const user = page.locator('.user-record').first();
  await whitespace(user);
  await expect(page.getByRole('dialog', { name: 'Данные пользователя' })).toBeVisible();
  await closeDialog(page);
  await user.locator('.card-primary-action').focus();
  await user.locator('.card-primary-action').press('Space');
  await expect(page.getByRole('dialog', { name: 'Данные пользователя' })).toBeVisible();
});

test('own and shared session cards and admin rows navigate while release stays separate', async ({ page }) => {
  await page.goto('/');
  const own = page.locator('.session-card').first();
  await own.getByRole('button', { name: 'Освободить слот', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Завершить сессию?');
  expect(new URL(page.url()).hash).not.toContain('/session/');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  await whitespace(own);
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
  await page.goto('/');
  await whitespace(page.locator('.shared-with-me-item').first());
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
  await page.goto('/#/admin/sessions');
  const row = page.locator('.admin-sessions-table tbody tr').first();
  await row.getByRole('button', { name: 'Освободить', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Принудительно остановить?');
  await expect(page).toHaveURL(/#\/admin\/sessions$/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  await row.click({ position: { x: 420, y: 12 } });
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
  await page.goto('/#/admin/sessions');
  await page.locator('.admin-sessions-table .card-primary-action').first().focus();
  await page.locator('.admin-sessions-table .card-primary-action').first().press('Enter');
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
});

test('stopped sessions stay passive and nodes are hidden without admin permissions', async ({ page }) => {
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [stoppedSession] } }));
  await page.goto('/');
  const stopped = page.locator('.session-card').first();
  await expect(stopped).not.toHaveClass(/interactive-card/);
  await expect(stopped.locator('.card-primary-action')).toHaveCount(0);
  await expect(stopped.getByRole('button', { name: 'Освободить слот', exact: true })).toBeDisabled();
  await whitespace(stopped);
  expect(new URL(page.url()).hash).not.toContain('/session/');
  await page.goto('/#/admin/sessions');
  const row = page.locator('.admin-sessions-table tbody tr').first();
  await expect(row).not.toHaveClass(/interactive-card/);
  await expect(row.locator('.card-primary-action')).toHaveCount(0);
  await row.click({ position: { x: 420, y: 12 } });
  await expect(page).toHaveURL(/#\/admin\/sessions$/);
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'u1', username: 'qa', displayName: 'QA', role: 'user' } } }));
  await page.goto('/#/hosts');
  await page.reload();
  // Regular users are sent back to the overview and never see node cards.
  await expect(page.locator('.host-card')).toHaveCount(0);
  await expect(page.locator('.hosts-page')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('node token revoke, node occupants and journal rows expose their existing primary action', async ({ page }) => {
  await page.route('**/api/admin/agents', route => route.fulfill({ json: { agents: [
    { hostId: 'h1', name: 'worker-01', source: 'registered', canRevoke: true, status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  ] } }));
  await page.goto('/#/admin/nodes?host=h1');
  const nodeDialog = page.getByRole('dialog', { name: 'worker-01' });
  await expect(nodeDialog).toBeVisible();
  await nodeDialog.locator('summary').filter({ hasText: 'Подключение агента' }).click();
  await nodeDialog.getByRole('button', { name: 'Отозвать токен', exact: true }).click();
  await expect(nodeDialog).toContainText('Отозвать токен?');
  await nodeDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(nodeDialog.getByRole('button', { name: 'Отозвать токен', exact: true })).toBeVisible();
  await closeDialog(page);
  await page.route('**/api/admin/hosts/h1/slots', route => route.fulfill({ json: { occupants: [{
    slotIndex: 0, sessionId, profileName: 'QA occupied device', ownerName: 'QA', state: 'running',
  }] } }));
  await page.goto('/#/admin/nodes?host=h1');
  await whitespace(page.locator('.node-occupancy li').first());
  await expect(page).toHaveURL(new RegExp('#/session/' + sessionId + '$'));
  await page.goto('/#/admin/journal');
  for (const name of ['Аренды', 'Действия', 'Логи сервиса']) {
    await page.getByRole('tablist', { name: 'Раздел журнала' }).getByRole('tab', { name, exact: true }).click();
    const row = page.locator('#adm-journal tbody tr').first();
    await expect(row.locator('.card-primary-action')).toBeVisible();
    await row.click({ position: { x: 430, y: 12 } });
    await expect(page.getByRole('dialog')).toBeVisible();
    await closeDialog(page);
  }
});

for (const occupied of [false, true]) {
  test(`empty session card ${occupied ? 'opens queue options without free slots' : 'opens launch by pointer and keyboard'}`, async ({ page }) => {
    await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [] } }));
    await page.route('**/api/hosts', async route => {
      const response = await route.fetch();
      const data = await response.json();
      for (const host of data.hosts) host.usedSlots = occupied ? host.slots : 0;
      await route.fulfill({ json: data });
    });
    await page.goto('/');
    const card = page.locator('.session-create-card');
    const launch = card.getByRole('button', { name: 'Создать новую сессию', exact: true });
    await expect(card).toBeVisible();
    if (occupied) {
      await expect(launch).toBeEnabled();
      await whitespace(card);
      const dialog = page.getByRole('dialog', { name: 'Новая сессия' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Встать в очередь', exact: true })).toBeEnabled();
    } else {
      await expect(launch).toBeEnabled();
      await whitespace(card);
      await expect(page.getByRole('dialog', { name: 'Новая сессия' })).toBeVisible();
      await closeDialog(page);
      await launch.focus();
      await launch.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Новая сессия' })).toBeVisible();
      await closeDialog(page);
      await page.getByRole('navigation', { name: 'Администрирование', exact: true }).getByRole('link', { name: 'Узлы', exact: true }).click();
      await expect(page).toHaveURL(/#\/admin\/nodes$/);
      await expect(page.getByRole('heading', { name: 'Узлы', level: 1, exact: true })).toBeVisible();
    }
  });
}
