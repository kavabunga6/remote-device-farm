import { apiRequest } from './api';

export interface ProxySettings { enabled: boolean; url: string; username: string; passwordSet: boolean; noProxy: string }
export const outboundProxyApi = {
  read: (signal?: AbortSignal) => apiRequest<{ proxy: ProxySettings }>('/admin/outbound-proxy', { signal }),
  save: (proxy: Omit<ProxySettings, 'passwordSet'> & { password?: string }) => apiRequest<{ proxy: ProxySettings }>('/admin/outbound-proxy', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proxy),
  }),
};
