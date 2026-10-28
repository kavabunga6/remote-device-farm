import examples from '../../shared/interface-examples.json';
import { localizeText, t } from './i18n';
import { useRef, useState } from 'react';
import { containerEnvToText, parseContainerEnvText } from './profile-env';
import { api, type Profile, type ProfileInput } from './api';
import { Icon } from './icons';
import { useAdminDialog } from './useAdminDialog';
import './ProfileModal.css';

const blankProfile: ProfileInput = {
  id: '', name: '', androidVersion: '', image: '', cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2, diskGb: 16, diskMaxGb: null, sdcardGb: null, sdcardMaxGb: null, emulatorParams: '', apiLevel: null, abi: null, deviceModel: null, resolution: null, imageFlavor: null, deviceType: null, imageTag: null, recommended: false, allowLaunchOverrides: null,
};

export function ProfileModal({ current, onClose, onSaved }: { current: Profile | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ProfileInput>(() => current ? {
    id: current.id, name: current.name, androidVersion: current.androidVersion || '', image: current.image || '', cpu: current.cpu || 4, memoryMb: current.memoryMb || 4096, guestMemoryMb: current.guestMemoryMb ?? null, guestCores: current.guestCores ?? null, diskGb: current.diskGb || 16, diskMaxGb: current.diskMaxGb ?? null, sdcardGb: current.sdcardGb ?? null, sdcardMaxGb: current.sdcardMaxGb ?? null, emulatorParams: current.emulatorParams || '', apiLevel: current.apiLevel ?? null, abi: current.abi ?? null, deviceModel: current.deviceModel ?? null, resolution: current.resolution ?? null, imageFlavor: current.imageFlavor ?? null, deviceType: current.deviceType ?? null, imageTag: current.imageTag ?? null, recommended: current.recommended ?? false, allowLaunchOverrides: current.allowLaunchOverrides ?? null,
  } : blankProfile);
  const [enabled, setEnabled] = useState(current?.enabled !== false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const dialogRef = useAdminDialog(true, busy, onClose);
  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => setForm(previous => ({ ...previous, [key]: value }));

  const [envText, setEnvText] = useState(() => containerEnvToText(current?.containerEnv));
  const [optionsText, setOptionsText] = useState(() => {
    const options = Object.fromEntries(Object.entries(current?.dockerOptions ?? {}).filter(([key]) => key !== 'gpu'));
    return Object.keys(options).length ? JSON.stringify(options, null, 2) : '';
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    setError('');
    const parsed = parseContainerEnvText(envText);
    if (parsed.error) { setError(parsed.error); return; }
    let dockerOptions: Record<string, unknown> = {};
    if (optionsText.trim()) {
      try {
        const value = JSON.parse(optionsText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        dockerOptions = value;
      } catch { setError(t('ui.8057bc0272b7')); return; }
    }
    if ('gpu' in dockerOptions) { setError(t('ui.d463d8c447c2')); return; }
    pending.current = true; setBusy(true);
    try {
      const payload = { ...form, containerEnv: parsed.env, dockerOptions };
      if (current) {
        const { id: _id, ...fields } = payload;
        void _id;
        await api.updateProfile(current.id, { ...fields, enabled });
      } else await api.createProfile(payload);
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.8f9c4884b8f9')); }
    finally { pending.current = false; setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div className="modal profile-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="profile-heading" aria-describedby="profile-description">
      <header className="modal-top profile-editor-header">
        <div><h2 id="profile-heading">{current ? t('ui.4bc581e8d7c9') : t('ui.aaed1e96af70')}</h2><p id="profile-description">{t('ui.f18bf64f883e')}</p></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={t('ui.a7a4033657e8')}><Icon name="close" size={19} /></button>
      </header>
      <form className="profile-form" onSubmit={submit} aria-busy={busy}>
        <fieldset className="profile-editor-body" disabled={busy}>
          <section className="profile-editor-section profile-editor-wide" aria-labelledby="profile-general-heading">
            <h3 id="profile-general-heading">{t('ui.799ccfdf4b03')}</h3>
            <div className="profile-editor-fields">
              <label><span>{t('ui.c9907645803f')}</span><input value={form.id} onChange={event => set('id', event.target.value)} disabled={Boolean(current)} pattern="[a-z][a-z0-9-]{1,79}" title={t('ui.7d66e31f17f6')} placeholder={t('ui.ff8e9e47329b')} required maxLength={80} /></label>
              <label><span>{t('ui.0918b4ba9268')}</span><input value={form.name} onChange={event => set('name', event.target.value)} placeholder={t('ui.b8f7df2d7dc6')} maxLength={120} required /></label>
              <label><span>{t('ui.7b1487ed07ac')}</span><input value={form.androidVersion} onChange={event => set('androidVersion', event.target.value)} placeholder={t('ui.e629fa6598d7')} maxLength={80} required /></label>
              <label><span>{t('ui.157705d4fc52')}</span><input value={form.image} onChange={event => set('image', event.target.value)} placeholder={t('ui.ded7b85fb193')} maxLength={255} required /></label>
            </div>
          </section>
          <section className="profile-editor-section profile-editor-wide" aria-labelledby="profile-metadata-heading">
            <h3 id="profile-metadata-heading">{t('ui.3917a8f58dc9')}</h3>
            <p className="profile-field-note">{t('ui.9e8de64b0a17')}</p>
            <div className="profile-editor-fields">
              <label><span>{t('ui.47ea712ddb7d')}</span><select value={form.deviceType ?? ''} onChange={event => set('deviceType', (event.target.value || null) as ProfileInput['deviceType'])}><option value="">{t('ui.0d836c1579f1')}</option><option value="mobile">{t('ui.497d356b21d3')}</option><option value="tv">{t('ui.ca62d5e073f5')}</option><option value="wear">{t('ui.59b4ce924fd2')}</option><option value="automotive">{t('ui.08b53c0255f3')}</option><option value="desktop">{t('ui.9bd88f2485ac')}</option></select></label>
              <label><span>{t('ui.f935769780ae')}</span><select value={form.imageFlavor ?? ''} onChange={event => set('imageFlavor', (event.target.value || null) as ProfileInput['imageFlavor'])}><option value="">{t('ui.0d836c1579f1')}</option><option value="aosp">{t('ui.a77d75100dda')}</option><option value="google_apis">{t('ui.2eb1e7ab1759')}</option><option value="google_play">{t('ui.fa644f7728fe')}</option></select></label>
              <label><span>{t('ui.8a42267a77ab')}</span><input type="number" min={1} max={999} value={form.apiLevel ?? ''} onChange={event => set('apiLevel', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.0d836c1579f1')} /></label>
              <label><span>{t('ui.58ca61f26eeb')}</span><input value={form.abi ?? ''} onChange={event => set('abi', event.target.value || null)} placeholder={t('ui.5adc2b317fc3')} maxLength={120} /></label>
              <label><span>{t('ui.805268e3ed0d')}</span><input value={form.deviceModel ?? ''} onChange={event => set('deviceModel', event.target.value || null)} placeholder={t('ui.e895fb5ecd06')} maxLength={120} /></label>
              <label><span>{t('ui.acaeee85a7ad')}</span><input value={form.resolution ?? ''} onChange={event => set('resolution', event.target.value || null)} placeholder={t('ui.149bfb4575f3')} maxLength={20} pattern={/[1-9][0-9]{1,4}\s*[xх×]\s*[1-9][0-9]{1,4}/.source} /></label>
            </div>
          </section>
          <section className="profile-editor-section" aria-labelledby="profile-resources-heading">
            <h3 id="profile-resources-heading">{t('ui.8c11295d2221')}</h3>
            <div className="profile-editor-fields">
              <label><span>{t('ui.8ae6d0b53b58')}</span><input type="number" min={1} max={16} value={form.cpu} onChange={event => set('cpu', Number(event.target.value))} required /></label>
              <label><span>{t('ui.01e4c4609286')}</span><input type="number" min={1024} max={65536} step={256} value={form.memoryMb} onChange={event => set('memoryMb', Number(event.target.value))} required /></label>
              <label><span>{t('ui.849635da03ef')}</span><input type="number" min={1} max={form.cpu} value={form.guestCores ?? ''} onChange={event => set('guestCores', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.c5ae8cdbe7dd')} aria-describedby="profile-guest-help" /></label>
              <label><span>{t('ui.43ec81e4a9a8')}</span><input type="number" min={1024} max={Math.max(1024, form.memoryMb - 1024)} step={256} value={form.guestMemoryMb ?? ''} onChange={event => set('guestMemoryMb', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.c5ae8cdbe7dd')} aria-describedby="profile-memory-help profile-guest-help" /></label>
            </div>
            <p className="profile-field-note" id="profile-memory-help">{t('ui.518763865297')}</p>
            <p className="profile-field-note" id="profile-guest-help">{t('ui.d86e072a540c')}</p>
          </section>
          <section className="profile-editor-section" aria-labelledby="profile-storage-heading">
            <h3 id="profile-storage-heading">{t('ui.f7a4aaf1ce76')}</h3>
            <div className="profile-editor-fields">
              <label><span>{t('ui.5e8ae340a38a')}</span><input type="number" min={2} max={128} value={form.diskGb} onChange={event => set('diskGb', Number(event.target.value))} required /></label>
              <label><span>{t('ui.ab7ef3761363')}</span><input type="number" min={form.diskGb} max={128} value={form.diskMaxGb ?? ''} onChange={event => set('diskMaxGb', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.f83b6f5721e6')}/></label>
              <label><span>{t('ui.11624932af64')}</span><input type="number" min={1} max={32} value={form.sdcardGb ?? ''} onChange={event => set('sdcardGb', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.b8a2f3bf38bf')}/></label>
              <label><span>{t('ui.ac2150efbdb9')}</span><input type="number" min={1} max={32} value={form.sdcardMaxGb ?? ''} onChange={event => set('sdcardMaxGb', event.target.value === '' ? null : Number(event.target.value))} placeholder={t('ui.f83b6f5721e6')}/></label>
            </div>
            <p className="profile-field-note">{t('ui.e86b529dd160')}</p>
          </section>
          <section className="profile-editor-section profile-editor-wide" aria-labelledby="profile-launch-heading">
            <h3 id="profile-launch-heading">{t('ui.f7ffa59af6d1')}</h3>
            <label><span>{t('ui.713dd518ab73')}</span><select aria-label={t('ui.713dd518ab73')} value={form.allowLaunchOverrides == null ? 'inherit' : form.allowLaunchOverrides ? 'allow' : 'deny'} disabled={busy} onChange={event => set('allowLaunchOverrides', event.target.value === 'inherit' ? null : event.target.value === 'allow')}><option value="inherit">{t('ui.1e85e5403a99')}</option><option value="allow">{t('ui.95cac9297773')}</option><option value="deny">{t('ui.966bbe76afb6')}</option></select></label>
            <p className="profile-field-note">{t('ui.7248a2222405')}</p>
            <label className="profile-launch-field"><span>{t('ui.6945fd170daa')}</span><textarea value={form.emulatorParams} onChange={event => set('emulatorParams', event.target.value)} placeholder={t('ui.9ff835086160')} maxLength={500} rows={2} aria-describedby="profile-params-help" /></label>
            <p className="profile-field-note" id="profile-params-help">{t('ui.4171c94201ad')}</p>
            <label className="profile-launch-field"><span>{t('ui.a60003e96650')}</span><textarea value={envText} onChange={event => setEnvText(event.target.value)} placeholder={t('ui.040ff82edb88')} rows={3} spellCheck={false} aria-describedby="profile-env-help" /></label>
            <p className="profile-field-note" id="profile-env-help">{t('ui.32e9a9b3573f')}</p>
            <label className="profile-launch-field"><span>{t('ui.99c5cabe9e0b')}</span><textarea value={optionsText} onChange={event => setOptionsText(event.target.value)} placeholder={examples.dockerOptions} rows={5} spellCheck={false} aria-describedby="profile-docker-help" /></label>
            <p className="profile-field-note" id="profile-docker-help">{t('ui.2ec092b8c14b')}</p>
          </section>
        </fieldset>
        <footer className="profile-editor-footer">
          {error && <div className="inline-error" role="alert">{localizeText(error)}</div>}
          <div className="profile-editor-actions">
            {current && <label className="checkbox-label"><input type="checkbox" disabled={busy} checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('ui.117858d60be7')}</label>}
            <div className="modal-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>{t('ui.8fbe9b75cbdf')}</button><button className="button primary" type="submit" disabled={busy}>{busy ? t('ui.9c27c381dd8b') : current ? t('ui.b4d30cae5289') : t('ui.355ba97a0f2b')}</button></div>
          </div>
        </footer>
      </form>
    </div>
  </div>;
}
