import type { Locator } from '@playwright/test';

export async function openLaunchSection(dialog: Locator, section: 'connection' | 'storage') {
  await dialog.locator('#create-tab-settings').click();
  const group = dialog.locator('.create-' + section + '-section');
  if (!await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(':scope > summary').click();
}
