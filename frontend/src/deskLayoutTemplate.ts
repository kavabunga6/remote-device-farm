import type { FloatingWindowName, WidgetBounds } from './useFloatingSessionWorkspace';

export type DeskLayoutTemplate = {
  windows: Record<FloatingWindowName, WidgetBounds>;
  front: FloatingWindowName;
  widgets: Record<string, WidgetBounds>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readBounds(value: unknown): WidgetBounds | null {
  if (!isRecord(value)) return null;
  const { left, top, width, height } = value;
  if (!isFiniteNumber(left) || !isFiniteNumber(top) || !isFiniteNumber(width) || !isFiniteNumber(height) ||
    width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function readTemplate(value: unknown): DeskLayoutTemplate | null {
  if (!isRecord(value) || !isRecord(value.windows) || !isRecord(value.widgets)) return null;
  const { front } = value;
  const device = readBounds(value.windows.device);
  const tools = readBounds(value.windows.tools);
  if (!device || !tools || (front !== 'device' && front !== 'tools')) return null;
  const widgets = Object.fromEntries(Object.entries(value.widgets).flatMap(([id, data]) => {
    const bounds = readBounds(data);
    return bounds ? [[id, bounds] as const] : [];
  }));
  return { windows: { device, tools }, front, widgets };
}

function decodeTemplate(raw: string | null): DeskLayoutTemplate | null {
  if (raw === null) return null;
  try { return readTemplate(JSON.parse(raw)); }
  catch { return null; }
}

function templateKey(userId: string): string {
  return 'rdf-desk-template-v1:' + encodeURIComponent(userId);
}

export function saveDeskLayoutTemplate(userId: string, template: DeskLayoutTemplate): boolean {
  const value = readTemplate(template);
  if (!value) return false;
  try {
    window.localStorage.setItem(templateKey(userId), JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function readDeskLayoutTemplateForSession(userId: string, sessionId: string): DeskLayoutTemplate | null {
  const key = templateKey(userId);
  const sessionKey = key + ':' + encodeURIComponent(sessionId);
  try {
    const saved = window.sessionStorage.getItem(sessionKey);
    if (saved !== null) return decodeTemplate(saved);
  } catch { /* The tab can still use the saved template if session storage is unavailable. */ }

  let template: DeskLayoutTemplate | null;
  try { template = decodeTemplate(window.localStorage.getItem(key)); }
  catch { return null; }
  // Pin the initial choice, including absence of a template, across reloads of this tab.
  try { window.sessionStorage.setItem(sessionKey, JSON.stringify(template)); }
  catch { /* Keep the current session usable if session storage is unavailable. */ }
  return template;
}
