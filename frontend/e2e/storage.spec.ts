import { expect, test } from '@playwright/test';

test('user picks data partition and SD card within profile limits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Новая сессия/ }).first().click();
  await page.getByRole('combobox', { name: 'Устройство', exact: true }).selectOption('a13');
  await page.locator('.create-settings > summary').click();
  // Switching profiles preserves GPU intent; this scenario uses software rendering.
  const gpu = page.getByRole('switch', { name: 'Ускорение GPU' });
  await gpu.uncheck();
  await expect(gpu).not.toBeChecked();
  const disk = page.getByLabel('Раздел данных, ГБ');
  const sd = page.getByLabel('SD-карта, ГБ');
  await expect(disk).toHaveValue('16');
  await expect(sd).toHaveValue('2');
  await disk.fill('99');
  await expect(page.getByRole('button', { name: /Запустить/ })).toBeDisabled();
  await disk.fill('32'); await sd.fill('0');
  await expect(page.getByRole('button', { name: /Запустить/ })).toBeEnabled();
});
