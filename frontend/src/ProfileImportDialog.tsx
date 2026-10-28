import examples from '../../shared/interface-examples.json';
import { TranslatedText } from './TranslatedText';
import { localizeText, t } from './i18n';
import { useState } from 'react';
import { api, type ProfileImportResult } from './api';
import { Icon } from './icons';
import { useAdminDialog } from './useAdminDialog';
import './ProfileImportDialog.css';

const ACTION: Record<ProfileImportResult['results'][number]['action'], string> = { get create() { return t('ui.dbc7c7dab0e3'); }, get update() { return t('ui.1d71cc4eeb9c'); }, get skip() { return t('ui.6662621fbab6'); }, get invalid() { return t('ui.bf22dfeeba8b'); } };

/** Import profiles from a JSON manifest: check first, then apply. New profiles always start disabled. */
export function ProfileImportDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [text, setText] = useState('');
  const [update, setUpdate] = useState(false);
  const [result, setResult] = useState<ProfileImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useAdminDialog(true, busy, onClose);

  const parse = (): unknown | null => {
    try { return JSON.parse(text); } catch { setError(t('ui.672e511ddcda')); return null; }
  };
  const run = async (apply: boolean) => {
    setError('');
    const manifest = parse();
    if (manifest === null) return;
    setBusy(true);
    try {
      const outcome = await api.importProfiles(manifest, { apply, update });
      setResult(outcome);
      if (outcome.applied) onApplied();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.2e1adf80d27c')); setResult(null); }
    finally { setBusy(false); }
  };
  const hasIssues = Boolean(result && (result.issues.length || result.results.some(item => item.issues.length)));
  const nothingToDo = Boolean(result && !result.results.some(item => item.action === 'create' || item.action === 'update'));

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal profile-import-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="profile-import-heading">
      <div className="modal-top"><h2 id="profile-import-heading">{t('ui.218d77705244')}</h2><button type="button" className="icon-button" aria-label={t('ui.a7a4033657e8')} onClick={onClose} disabled={busy}><Icon name="close" size={19} /></button></div>
      <p className="profile-import-note"><TranslatedText message="copy.ProfileImportDialog.c44a903d" values={{ p0: <strong>{t('ui.3108ace8d87e')}</strong>, p1: <code>{t('ui.74234e98afe7')}</code> }} /></p>
      <label className="profile-import-file"><span>{t('ui.c35718c46580')}</span><input type="file" accept="application/json,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(content => { setText(content); setResult(null); setError(''); }); }} /></label>
      <label className="profile-import-text"><span>{t('ui.93a87a98d673')}</span><textarea value={text} onChange={event => { setText(event.target.value); setResult(null); }} rows={9} spellCheck={false} placeholder={examples.profileManifest} disabled={busy} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={update} onChange={event => { setUpdate(event.target.checked); setResult(null); }} disabled={busy} />{t('ui.6bbfcf3f6e22')}</label>
      {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
      {result && <div className="profile-import-result" role="status">
        {result.issues.map(issue => <p className="profile-import-issue" key={issue.path}><code>{issue.path}</code> {localizeText(issue.message)}</p>)}
        <ul>{result.results.map(item => <li key={item.id || item.name} data-action={item.action}>
          <strong>{item.name || item.id || t('ui.0106f3ae2502')}</strong> <span className="profile-import-action">{ACTION[item.action]}</span>
          {item.issues.map(issue => <p className="profile-import-issue" key={issue.path + issue.message}><code>{issue.path}</code> {localizeText(issue.message)}</p>)}
          {item.warnings.map(warning => <p className="profile-import-warning" key={warning}>{localizeText(warning)}</p>)}
        </li>)}</ul>
        {result.applied && <p className="profile-import-done">{t('ui.41842447c717')}</p>}
      </div>}
      <div className="modal-actions">
        <button type="button" className="button outline" onClick={onClose} disabled={busy}>{result?.applied ? t('ui.a7a4033657e8') : t('ui.8fbe9b75cbdf')}</button>
        <button type="button" className="button outline" onClick={() => void run(false)} disabled={busy || !text.trim()}>{t('ui.e4424a6df6f6')}</button>
        <button type="button" className="button primary" onClick={() => void run(true)} disabled={busy || !result || result.applied || hasIssues || nothingToDo}>{busy ? t('ui.7e4f3baf839f') : t('ui.e15f960d93eb')}</button>
      </div>
    </div>
  </div>;
}
