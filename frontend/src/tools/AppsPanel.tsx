import { TranslatedText } from '../TranslatedText';
import { localizeText, getLocale, t } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { appsApi, checkUploadFile, formatAppSize, formatMb, uploadApp, type AppUsage, type StoredApp } from '../apps-api';
import { Icon } from '../icons';
import '../Apps.css';

type UploadItem = { key: number; name: string; progress: number; error?: string; done?: boolean };
type Message = { kind: 'ok' | 'error'; text: string };

const message = (error: unknown): string => error instanceof Error ? error.message : t('ui.c4f2454fb582');
const day = (value: string): string => new Date(value).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

// Apps: upload an APK once, install it into any of your sessions, or install from a URL.
export function AppsPanel({ sessionId, active, running, panelId }: { sessionId: string; active: boolean; running: boolean; panelId?: string }) {
  const [apps, setApps] = useState<StoredApp[]>([]);
  const [usage, setUsage] = useState<AppUsage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [result, setResult] = useState<Message | null>(null);
  const [url, setUrl] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const usageRef = useRef<AppUsage | null>(null);
  usageRef.current = usage;

  const refresh = useCallback(async () => {
    try {
      const library = await appsApi.list();
      setApps(library.apps); setUsage(library.usage); setLoadError('');
    } catch (error) { setLoadError(message(error)); }
    setLoaded(true);
  }, []);

  useEffect(() => { if (active && !loaded) void refresh(); }, [active, loaded, refresh]);

  const patch = (key: number, change: Partial<UploadItem>) =>
    setUploads(items => items.map(item => item.key === key ? { ...item, ...change } : item));

  // Files go one after another so the server and the network are never flooded.
  const addFiles = async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    const base = Date.now();
    setUploads(files.map((file, i) => ({ key: base + i, name: file.name, progress: 0 })));
    for (const [i, file] of files.entries()) {
      const key = base + i;
      const problem = checkUploadFile(file, usageRef.current);
      if (problem) { patch(key, { error: problem }); continue; }
      try {
        const created = await uploadApp(file, fraction => patch(key, { progress: fraction }));
        patch(key, { progress: 1, done: true });
        setApps(list => [created.app, ...list]); setUsage(created.usage); usageRef.current = created.usage;
      } catch (error) { patch(key, { error: message(error) }); }
    }
    busy.current = false;
    setTimeout(() => setUploads(items => items.filter(item => item.error)), 4000);
  };

  const install = async (app: StoredApp) => {
    setInstalling(app.id); setResult(null);
    try {
      await appsApi.install(sessionId, app.id);
      setResult({ kind: 'ok', text: t('ui.31da691960ac', { p0: app.name }) });
    } catch (error) { setResult({ kind: 'error', text: message(error) }); }
    setInstalling(null);
  };

  const installFromUrl = async () => {
    const link = url.trim();
    if (!link) return;
    setInstalling('url'); setResult(null);
    try {
      await appsApi.installUrl(sessionId, link);
      setResult({ kind: 'ok', text: t('ui.b07cf42267df') });
      setUrl('');
    } catch (error) { setResult({ kind: 'error', text: message(error) }); }
    setInstalling(null);
  };

  const remove = async (app: StoredApp) => {
    if (!window.confirm(t('ui.4de9c8fbea22', { p0: app.name }))) return;
    try {
      const response = await appsApi.remove(app.id);
      setApps(list => list.filter(item => item.id !== app.id)); setUsage(response.usage);
    } catch (error) { setResult({ kind: 'error', text: message(error) }); }
  };

  const ratio = usage ? Math.min(1, usage.usedBytes / usage.maxBytes) : 0;
  const canInstall = running && installing === null;

  return (
    <div className="apps-panel" id={panelId} role={panelId ? 'tabpanel' : undefined} aria-labelledby={panelId ? 'tool-tab-apps' : undefined} hidden={!active}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
      <div className="apps-head">
        <div>
          <h2>{t('ui.39c4b42c8d11')}</h2>
          <p>{t('apps.setHint')}</p>
        </div>
        <button type="button" className="button primary" onClick={() => picker.current?.click()}>
          <Icon name="upload" size={16} /> {t('ui.b5d0b38f9faf')}</button>
        <input ref={picker} type="file" accept=".apk,.apks,.zip" multiple hidden
          onChange={event => { void addFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
      </div>

      {dragging && <div className="apps-drop" role="presentation">{t('ui.07365513d144')}</div>}

      {usage && (
        <div className="apps-usage" aria-label={t('ui.661b75349fb7')}>
          <div className="apps-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
            <span className={ratio > 0.9 ? 'warn' : ''} style={{ width: `${ratio * 100}%` }} />
          </div>
          <span><TranslatedText message="copy.AppsPanel.c1f6cca8" values={{ p0: formatMb(usage.usedBytes), p1: formatMb(usage.maxBytes) }} /></span>
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="apps-uploads">
          {uploads.map(item => (
            <li key={item.key} className={item.error ? 'is-error' : item.done ? 'is-done' : ''}>
              <span className="apps-upload-name">{item.name}</span>
              {item.error ? <span className="apps-upload-note">{item.error}</span>
                : item.done ? <span className="apps-upload-note">{t('ui.5297a4436a6b')}</span>
                : <progress value={item.progress} max={1} aria-label={t('ui.b7333620254b', { p0: item.name })} />}
            </li>
          ))}
        </ul>
      )}

      {result && <div className={result.kind === 'ok' ? 'apps-result' : 'banner-error apps-error'} role={result.kind === 'ok' ? 'status' : 'alert'}>{result.text}</div>}
      {loadError && <div className="banner-error apps-error" role="alert">{localizeText(loadError)} <button type="button" onClick={() => void refresh()}>{t('ui.5189135a6110')}</button></div>}
      {!running && <p className="apps-hint">{t('ui.49609be8c6bd')}</p>}

      {loaded && !loadError && apps.length === 0 && uploads.length === 0 && (
        <div className="apps-empty">{t('ui.f8587ba80e89')}</div>
      )}

      {apps.length > 0 && (
        <ul className="apps-list">
          {apps.map(app => (
            <li key={app.id} className="apps-item">
              <div className="apps-info">
                <strong title={app.name}>{app.name}</strong>
                <span className="apps-meta">
                  {app.packageName && <span className="mono">{app.packageName}</span>}
                  {app.versionName && <span><TranslatedText message="copy.AppsPanel.1cdae72f" values={{ p0: app.versionName }} /></span>}
                  <span>{formatAppSize(app.size)}</span>
                  <span>{day(app.uploadedAt)}</span>
                </span>
                {app.note && <span className="apps-note">{app.note}</span>}
              </div>
              <div className="apps-actions">
                <button type="button" className="button primary" disabled={!canInstall} onClick={() => void install(app)}>
                  {installing === app.id ? t('ui.06fc7117859c') : t('ui.b7cd6fae08d9')}
                </button>
                <button type="button" className="button danger-outline" disabled={installing === app.id} onClick={() => void remove(app)}>{t('ui.be99b1361201')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form className="apps-url" onSubmit={event => { event.preventDefault(); void installFromUrl(); }}>
        <label htmlFor="apps-url-input">{t('ui.562a4c0083ea')}</label>
        <div className="apps-url-row">
          <input id="apps-url-input" type="url" inputMode="url" placeholder={t('ui.ffe9c908bc8f')}
            value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} disabled={installing !== null} />
          <button type="submit" className="button" disabled={!canInstall || !url.trim()}>
            {installing === 'url' ? t('ui.06fc7117859c') : t('ui.b7cd6fae08d9')}
          </button>
        </div>
        <small>{t('ui.0ea1cbc73f2c')}</small>
      </form>
    </div>
  );
}
