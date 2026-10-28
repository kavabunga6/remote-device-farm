import { errorMessage, getLocale, t } from './i18n';
import { ApiError, KNOWN_ERRORS, apiRequest, jsonBody } from './api';

export interface StoredApp {
  id: string; name: string; size: number; sha256: string;
  packageName: string | null; versionName: string | null; note: string | null; uploadedAt: string;
}
export interface AppUsage { count: number; usedBytes: number; maxBytes: number; maxApps: number; maxFileBytes: number }
export interface AppLibrary { apps: StoredApp[]; usage: AppUsage }

export const appsApi = {
  list: () => apiRequest<AppLibrary>('/apps'),
  remove: (id: string) => apiRequest<{ usage: AppUsage }>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  install: (sessionId: string, appId: string) =>
    apiRequest<{ ok: boolean; output?: string }>(`/sessions/${encodeURIComponent(sessionId)}/apps/install`, { method: 'POST', body: jsonBody({ appId }) }),
  installUrl: (sessionId: string, url: string) =>
    apiRequest<{ ok: boolean; output?: string }>(`/sessions/${encodeURIComponent(sessionId)}/apps/install-url`, { method: 'POST', body: jsonBody({ url }) }),
};

// fetch has no upload progress, so uploads use XMLHttpRequest.
export function uploadApp(file: File, onProgress: (fraction: number) => void): Promise<{ app: StoredApp; usage: AppUsage }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/apps');
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new ApiError(t('ui.c2b41e580091'), 0));
    xhr.onload = () => {
      const body = xhr.response as { error?: { code?: string; message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300) { resolve(body as unknown as { app: StoredApp; usage: AppUsage }); return; }
      if (xhr.status === 401) window.dispatchEvent(new Event('rdf:unauthorized'));
      const code = body?.error?.code ?? '';
      reject(new ApiError(KNOWN_ERRORS[code] ?? errorMessage(xhr.status, body?.error?.message), xhr.status, body?.error?.message));
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export function formatMb(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 10 || Number.isInteger(mb) ? String(Math.round(mb)) : mb.toLocaleString(getLocale(), { useGrouping: false, maximumFractionDigits: 1 });
}

export function formatAppSize(bytes: number): string {
  if (bytes >= 1048576) return t('ui.fb360df45f73', { p0: formatMb(bytes) });
  return t('ui.a949d23a8402', { p0: Math.max(1, Math.round(bytes / 1024)) });
}

// Quick client-side checks before a file is sent; the server repeats them.
export function checkUploadFile(file: { name: string; size: number }, usage: AppUsage | null): string | null {
  if (!/\.(apk|apks|zip)$/i.test(file.name)) return t('apps.invalidSet');
  if (file.size === 0) return t('ui.f4d7c310e609');
  if (usage) {
    if (file.size > usage.maxFileBytes) return t('ui.3b766b022e94', { p0: formatMb(usage.maxFileBytes) });
    if (usage.usedBytes + file.size > usage.maxBytes) return t('ui.4bd59d976bea');
    if (usage.count >= usage.maxApps) return t('ui.e1b0aa418732');
  }
  return null;
}
