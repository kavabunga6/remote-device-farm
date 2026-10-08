import { expect, test } from '@playwright/test';

for (const [kind, endpoint, label] of [
  ['personal', '/api/tokens', 'Создать личный токен'],
  ['system', '/api/admin/tokens', 'Создать системный токен'],
] as const) test(`empty ${kind} token card opens and submits its own form`, async ({ page }) => {
  await page.route('**/api/tokens', route => route.fulfill({ json: { tokens: [] } }));
  await page.route('**/api/admin/tokens', route => route.fulfill({ json: { tokens: [] } }));
  await page.goto('/#/tokens');
  const action = page.getByRole('button', { name: label, exact: true });
  const section = page.locator('.token-section').filter({ has: page.locator(`#token-create-${kind}`) });
  const form = section.locator('form');
  const name = form.getByLabel('Название', { exact: true });
  const otherForm = page.locator('.token-section').filter({ hasNot: action }).locator('form');
  await expect(action).toBeVisible();
  await expect(form).toBeHidden();
  const card = section.locator('.token-list');
  const box = await card.boundingBox();
  await card.click({ position: { x: box!.width - 12, y: 12 } });
  await expect(form).toBeVisible();
  await expect(name).toBeFocused();
  await expect(otherForm).toBeHidden();
  await section.getByRole('button', { name: 'Отмена', exact: true }).click();
  for (const key of ['Enter', 'Space']) {
    await action.focus();
    await action.press(key);
    await expect(name).toBeFocused();
    await section.getByRole('button', { name: 'Отмена', exact: true }).click();
  }
  await section.getByRole('button', { name: 'Новый токен', exact: true }).click();
  await name.fill('Integration test');
  await form.getByLabel('Срок действия').selectOption('90');
  await page.route(`**${endpoint}`, route => route.fulfill({ json: {
    token: 'one-time-test-token', item: { id: 'test-token', name: 'Integration test', kind,
      createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null },
  } }));
  const request = page.waitForRequest(item => item.method() === 'POST' && item.url().endsWith(endpoint));
  await form.getByRole('button', { name: 'Создать токен', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ name: 'Integration test', expiresInDays: 90 });
  await expect(form.getByRole('status')).toContainText('Сохраните токен сейчас');
  const createdSection = page.locator('.token-section').filter({ has: page.locator(`#token-create-${kind}`) });
  await expect(createdSection.locator('.token-row')).toContainText('Integration test');
  await expect(createdSection.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Я сохранил токен', exact: true }).click();
  await expect(form).toBeHidden();
});
