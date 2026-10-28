import type { Locator } from '@playwright/test';

export async function openLaunchSection(dialog: Locator, section: 'connection' | 'storage') {
  const options = dialog.locator('.create-settings');
  if (!await options.evaluate(element => (element as HTMLDetailsElement).open)) await options.locator(':scope > summary').click();
  const group = dialog.locator('.create-' + section + '-section');
  if (!await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(':scope > summary').click();
}
