import { useRef, useState } from 'react';
import { localizeText, t } from './i18n';
import { useAdminDialog } from './useAdminDialog';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';

export function LogoutDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const ref = useAdminDialog(true, busy, onClose);
  const confirm = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await onConfirm(); }
    catch (cause) { setError(localizeText(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9'))); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={ref} tabIndex={-1} className="modal confirm-modal logout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="logout-heading" aria-describedby="logout-detail" aria-busy={busy}>
      <header className="logout-dialog-heading"><span className="confirm-icon"><Icon name="logout" size={22} /></span><h2 id="logout-heading">{t('auth.logoutTitle')}</h2></header>
      <p id="logout-detail">{t('auth.logoutDetail')}</p>
      {error && <div className="inline-error" role="alert"><Icon name="alert" size={17} />{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button outline" onClick={onClose} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button>
        <button type="button" className="button primary" onClick={() => void confirm()} disabled={busy}>{busy && <ActivityIndicator />}{busy ? t('auth.loggingOut') : t('ui.5690c2e63b9d')}</button>
      </div>
    </div>
  </div>;
}
