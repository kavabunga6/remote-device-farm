import { localizeText, t } from './i18n';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';
import './LaunchSettings.css';

export function LaunchSettings({ onChanged }: { onChanged: () => void }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    setError(''); setAllowed(null);
    void api.launchSettings().then(result => { if (active) setAllowed(result.allowLaunchOverrides); })
      .catch(() => { if (active) setError(t('ui.698ab6f3feee')); });
    return () => { active = false; };
  }, [attempt]);
  const update = async (value: boolean) => {
    const previous = allowed;
    setAllowed(value); setBusy(true); setError(''); setSaved(false);
    try { const result = await api.updateLaunchSettings(value); setAllowed(result.allowLaunchOverrides); setSaved(true); onChanged(); }
    catch (cause) { setAllowed(previous); setError(cause instanceof Error ? cause.message : t('ui.84a76ba76fa0')); }
    finally { setBusy(false); }
  };
  return <details className="admin-launch-settings">
    <summary><span>{t('ui.fe5beb09b88b')}</span><span className="launch-settings-summary">{allowed === null ? t('ui.7b49f9e430c9') : allowed ? t('ui.3807696d1aa8') : t('ui.e546fd175157')}</span><Icon name="arrowDown" size={16}/></summary>
    <div className="launch-settings-body">
      <label className="launch-policy-control"><span><strong>{t('ui.7072208c7e04')}</strong><small id="launch-settings-help">{t('ui.418d0b4928e3')}</small></span><input type="checkbox" role="switch" aria-label={t('ui.7072208c7e04')} aria-describedby="launch-settings-help" checked={allowed === true} disabled={allowed === null || busy} onChange={event => void update(event.target.checked)}/></label>
      {error && <div className="launch-settings-error" role="alert"><span>{localizeText(error)}</span>{allowed === null && <button type="button" className="button outline small" onClick={() => setAttempt(current => current + 1)}>{t('ui.5189135a6110')}</button>}</div>}
      <p className="launch-settings-status" role="status">{busy ? t('ui.9c27c381dd8b') : saved ? t('ui.aa1bf7596834') : allowed === null && !error ? t('ui.ca8fab0f65ab') : ''}</p>
    </div>
  </details>;
}
