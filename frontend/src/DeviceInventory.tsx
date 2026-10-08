import { useAccess } from './permissions';
import { t } from './i18n';
import { useState } from 'react';
import { api, type Host, type HostDevice } from './api';
import { DEVICE_KIND_LABEL, deviceStateLabel, physicalDevices } from './devices';

// Admin view of physical devices per node. A quarantined device failed its wipe and is out of rotation; the
// button asks the agent to wipe it again and releases it only if the agent verifies it clean.
export function DeviceInventory({ hosts, onRefresh }: { hosts: Host[]; onRefresh: () => void }) {
  const can = useAccess();
  const [busyKey, setBusyKey] = useState('');
  const [message, setMessage] = useState('');
  const rows = hosts.flatMap(host => physicalDevices(host.devices).map(device => ({ host, device })));
  if (!rows.length) return null;
  const retry = async (host: Host, device: HostDevice) => {
    const key = `${host.id}|${device.id}`;
    setBusyKey(key); setMessage('');
    try {
      const { clean } = await api.sanitizeDevice(host.id, device.kind, device.id);
      setMessage(clean ? t('ui.c402808f1ab4', { p0: device.model || device.id }) : t('ui.6499109e1a89', { p0: device.model || device.id }));
      onRefresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('ui.54c4abbfb464')); }
    finally { setBusyKey(''); }
  };
  return <section className="content-section device-inventory" aria-labelledby="device-inventory-heading">
    <div className="section-heading"><div><h2 id="device-inventory-heading">{t('ui.38510c4724bc')}</h2><p>{t('ui.803583c1ae1d')}</p></div></div>
    {message && <div className="inline-warning" role="status">{message}</div>}
    <div className="table-wrap"><table className="device-table"><thead><tr><th>{t('ui.dba20ab53801')}</th><th>{t('ui.d4a6795c199f')}</th><th>{t('ui.962955cf3184')}</th><th>{t('ui.ca285db3dd75')}</th><th aria-label={t('ui.cad123465b9e')} /></tr></thead><tbody>
      {rows.map(({ host, device }) => { const key = `${host.id}|${device.id}`; const stuck = device.state === 'quarantined' || device.state === 'cleaning' || device.state === 'unverified'; return <tr key={key} data-state={device.state}>
        <td>{device.model || device.id}<small>{device.id}</small></td><td>{DEVICE_KIND_LABEL[device.kind]}</td><td>{host.displayName || host.name}</td>
        <td><span className={'device-state device-state-' + device.state}>{deviceStateLabel(device.state)}</span>{device.reason && <small className="device-reason">{device.reason}</small>}</td>
        <td>{can('nodes.manage') && stuck && <button type="button" className="button" disabled={busyKey === key || host.status !== 'online'} onClick={() => void retry(host, device)}>{busyKey === key ? t('ui.4ad7ee0809e3') : t('ui.79f5e8bee339')}</button>}</td></tr>; })}
    </tbody></table></div>
  </section>;
}
