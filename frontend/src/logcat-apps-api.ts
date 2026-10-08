import { t } from './i18n';
import { apiRequest, type LogcatPage, type LogcatQuery } from './api';

export interface LogcatApp { packageName: string; uid: number }
export interface LogcatAppState extends LogcatApp { pids: number[] | null; sharedPackages: string[] }
export interface AppLogcatPage extends LogcatPage { app: LogcatAppState | null }

export const logcatAppsApi = {
  list: (sessionId: string) => apiRequest<{ apps: LogcatApp[] }>(
    '/sessions/' + encodeURIComponent(sessionId) + '/logcat/apps'),
  page: async (sessionId: string, query: LogcatQuery, packageName: string): Promise<AppLogcatPage> => {
    const params = new URLSearchParams();
    if (query.level) params.set('level', query.level);
    if (query.buffers?.length) params.set('buffers', query.buffers.join(','));
    if (query.lines !== undefined) params.set('lines', String(query.lines));
    if (query.since) params.set('since', query.since);
    if (query.skip !== undefined) params.set('skip', String(query.skip));
    if (packageName) params.set('packageName', packageName);
    const page = await apiRequest<AppLogcatPage>('/sessions/' + encodeURIComponent(sessionId) + '/logcat?' + params);
    // Older servers must not silently show the whole device as the selected app.
    if (packageName && page.app?.packageName !== packageName) throw new Error(t('ui.bc5b107532b8'));
    return page;
  },
};
