import type { Host } from './api';
import { t } from './i18n';
import { normalizeProviderStatuses } from './generated/device-contract';
import { heartbeatAge } from './node-capacity';
import './NodeProviderStatus.css';

const stateKeys = { ready: 'providers.ready', unavailable: 'providers.unavailable', unknown: 'providers.unknown' } as const;
const codeKeys = { 'inventory-unavailable': 'providers.inventory-unavailable', 'maintenance-unavailable': 'providers.maintenance-unavailable', 'reconcile-unavailable': 'providers.reconcile-unavailable' } as const;

export function NodeProviderStatus({ host, failuresOnly = false }: { host: Host; failuresOnly?: boolean }) {
  const providers = normalizeProviderStatuses(host.providers).filter(provider => !failuresOnly || provider.status === 'unavailable');
  if (failuresOnly && !providers.length) return null;
  const stale = host.status !== 'online' || heartbeatAge(host.lastSeenAt).stale;
  return <section className="node-provider-status" aria-label={t('providers.title')}>
    {!failuresOnly && <h3>{t('providers.title')}</h3>}
    {!providers.length && <p>{t('providers.unknown')}</p>}
    {providers.map(provider => <div className="node-provider-row" key={provider.kind} data-state={stale ? 'unknown' : provider.status}>
      <div><strong>{provider.kind === 'emulator' ? t('providers.emulator') : t('providers.usb')}</strong>
        <span>{stale ? t('providers.stale') : t(stateKeys[provider.status])}</span></div>
      {provider.status === 'unavailable' && <p>{provider.code ? t(codeKeys[provider.code]) : t('providers.unavailableHint')}</p>}
    </div>)}
  </section>;
}
