import { TranslatedText } from './TranslatedText';
import { localizeText, t } from './i18n';
import { useState } from 'react';
import { api, type DeviceSession } from './api';
import { DEVICE_KIND_LABEL, type RentableDevice } from './devices';
import { Icon } from './icons';

// Separate from CreateSessionModal on purpose: a physical phone has no profile, GPU mode or slot.
export function RentDeviceModal({ devices, onClose, onRented }: {
  devices: RentableDevice[]; onClose: () => void; onRented: (session: DeviceSession) => void;
}) {
  const [selected, setSelected] = useState(devices.length ? `${devices[0]!.host.id}|${devices[0]!.device.kind}|${devices[0]!.device.id}` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const [hostId, kind, deviceId] = selected.split('|') as [string, 'usb-android', string];
    if (busy || !deviceId) return;
    setBusy(true); setError('');
    try { onRented(await api.rentDevice(hostId, kind, deviceId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.4e84b16d0d9e')); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal rent-device-modal" role="dialog" aria-modal="true" aria-labelledby="rent-heading" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <div className="modal-top"><div><h2 id="rent-heading">{t('ui.2ae7dc61e871')}</h2><p className="modal-description">{t('ui.572fbe00f568')}</p></div><button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={onClose} disabled={busy}><Icon name="close" size={19} /></button></div>
      <form onSubmit={event => void submit(event)}>
        {devices.length ? <fieldset className="rent-device-list" disabled={busy}><legend className="sr-only">{t('ui.b336b96eb36f')}</legend>
          {devices.map(({ host, device }) => { const key = `${host.id}|${device.kind}|${device.id}`; return <label key={key} className={'rent-device' + (selected === key ? ' selected' : '')}>
            <input type="radio" name="device" value={key} checked={selected === key} onChange={() => setSelected(key)} />
            <span><strong>{device.model || device.id}</strong><small><TranslatedText message="copy.RentDeviceModal.a373164f" values={{ p0: DEVICE_KIND_LABEL[device.kind], p1: host.displayName || host.name }} /></small></span></label>; })}
        </fieldset> : <p className="empty-note" role="status">{t('ui.c4edbb38503a')}</p>}
        <div className="create-session-footer"><div className="create-launch-status" aria-live="polite">{error && <span className="create-error" role="alert">{localizeText(error)}</span>}</div>
          <button type="button" className="button" onClick={onClose} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button>
          <button type="submit" className="button primary" disabled={busy || !selected}>{busy ? t('ui.4f5ff3d9ae22') : t('ui.26426ec56c9a')}</button></div>
      </form>
    </div>
  </div>;
}
