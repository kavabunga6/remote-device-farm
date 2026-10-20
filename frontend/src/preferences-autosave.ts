import { settingsApi, type UserPreferences } from './settings-api';
import { api } from './api';
import { t } from './i18n';

// Writes outlive an account-page mount. Waiting for the same user's outstanding
// writes before loading prevents a quick return from restoring an older value.
const writes = new Map<string, Promise<void>>();

export function saveUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const previous = writes.get(userId) ?? Promise.resolve();
  const result = previous.then(async () => {
    // A queued /me write must not use the cookie of a newly signed-in user.
    const current = await api.me();
    if (current?.id !== userId) throw new Error(t('error.unauthorized'));
    return settingsApi.updatePreferences(patch);
  });
  const settled = result.then(() => undefined, () => undefined);
  writes.set(userId, settled);
  void settled.then(() => { if (writes.get(userId) === settled) writes.delete(userId); });
  return result;
}

export async function loadUserPreferences(userId: string): Promise<UserPreferences> {
  await writes.get(userId);
  return settingsApi.preferences();
}
