import type { UserPreferences } from './settings-api';
import './user-preferences.css';

const storagePrefix = 'rdf-user-preferences:';
const defaultPreferences: UserPreferences = {
  theme: 'system', fontFamily: 'system', fontScale: 0, defaultAdbKeyId: null,
};
let activeTheme: UserPreferences['theme'] = 'system';
let listening = false;

function updateEffectiveTheme(): void {
  const dark = activeTheme === 'dark' ||
    (activeTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.effectiveTheme = dark ? 'dark' : 'light';
}

export function applyUserPreferences(preferences: UserPreferences, userId?: string): void {
  const root = document.documentElement;
  activeTheme = preferences.theme;
  root.dataset.theme = preferences.theme;
  // One predictable model: 0 is "automatic" (the stylesheet grows type with the window); any other value is a fixed
  // multiple of 16 px. It sets the root size only, so there is no CSS zoom and pointer coordinates stay exact.
  root.style.setProperty('--user-font-scale', '1');
  if (preferences.fontScale > 0) root.style.fontSize = 16 * preferences.fontScale + 'px';
  else root.style.removeProperty('font-size');
  updateEffectiveTheme();
  if (!listening) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateEffectiveTheme);
    listening = true;
  }
  if (userId) {
    try { localStorage.setItem(storagePrefix + userId, JSON.stringify(preferences)); }
    catch { /* Storage is optional. */ }
  }
}

export function restoreUserPreferences(userId?: string): void {
  applyUserPreferences(defaultPreferences);
  if (!userId) return;
  try {
    const value = JSON.parse(localStorage.getItem(storagePrefix + userId) || 'null') as Partial<UserPreferences> | null;
    if (!value) return;
    if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') return;
    if (typeof value.fontScale !== 'number' || (value.fontScale !== 0 && (value.fontScale < 0.8 || value.fontScale > 1.5))) return;
    applyUserPreferences({
      theme: value.theme, fontFamily: 'system', fontScale: value.fontScale,
      defaultAdbKeyId: null,
    });
  } catch { /* Ignore unavailable or stale local preferences. */ }
}
