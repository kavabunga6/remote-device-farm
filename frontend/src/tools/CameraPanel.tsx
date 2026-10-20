import { useEffect, useId, useRef, useState } from 'react';
import { apiRequest, jsonBody } from '../api';
import { t } from '../i18n';
import { Icon } from '../icons';
import { useNotifications } from '../notifications';

type CameraState = { available: boolean; imageSet: boolean | null };
async function prepareImage(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error(t('camera.invalid'));
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context || !bitmap.width || !bitmap.height) throw new Error(t('camera.invalid'));
    for (const maximum of [1024, 768, 512, 384, 256]) {
      const ratio = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob && blob.size <= 256 * 1024) return blob;
    }
    throw new Error(t('camera.invalid'));
  } finally { bitmap.close(); }
}

export function CameraPanel({ sessionId, running, active }: { sessionId: string; running: boolean; active: boolean }) {
  const [state, setState] = useState<CameraState | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(sessionId);
  const operation = useRef(false);
  const id = useId();
  const { notify, notifyError } = useNotifications();
  useEffect(() => { current.current = sessionId; return () => { current.current = ''; }; }, [sessionId]);
  useEffect(() => {
    if (!running || !active || !open || busy) return;
    const abort = new AbortController();
    void apiRequest<CameraState>('/sessions/' + sessionId + '/camera', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setState(value); })
      .catch(() => { if (!abort.signal.aborted) setState({ available: false, imageSet: false }); });
    return () => abort.abort();
  }, [sessionId, running, active, open, busy]);
  async function change(op: 'image' | 'reset' | 'show', file?: File) {
    if (operation.current || !running || !state?.available) return;
    operation.current = true; setBusy(true);
    const owner = sessionId;
    try {
      let body: BodyInit;
      if (file) {
        const data = new FormData(); data.append('image', await prepareImage(file), 'camera.png'); body = data;
      } else body = jsonBody({});
      const value = await (op === 'image'
        ? apiRequest<CameraState>('/sessions/' + sessionId + '/camera/image', { method: 'POST', body })
        : op === 'reset' ? apiRequest<CameraState>('/sessions/' + sessionId + '/camera/reset', { method: 'POST', body })
          : apiRequest<CameraState>('/sessions/' + sessionId + '/camera/show', { method: 'POST', body }));
      if (current.current !== owner) return;
      setState(value); notify({ kind: 'success', title: t(op === 'reset' ? 'camera.resetDone' : op === 'show' ? 'camera.showDone' : 'camera.uploadDone') });
    } catch (error) { if (current.current === owner) notifyError(t('camera.failed'), error); }
    finally {
      if (current.current === owner) {
        operation.current = false; setBusy(false);
        if (input.current) input.current.value = '';
      }
    }
  }
  return <details className="env-card env-camera" open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-busy={busy}>
    <summary><span className="env-card-heading"><strong>{t('camera.title')}</strong><span>{t('camera.description')}</span></span>
      {busy && <span className="env-pending" role="status"><span className="mini-spinner" />{t('camera.working')}</span>}
      <Icon name="chevronDown" size={18} />
    </summary>
    <div className="env-card-body">
      <div className="env-camera-state" role="status" data-active={state?.imageSet === true}>
        <Icon name="camera" size={20} />
        <strong>{t(!running ? 'camera.stopped' : !state ? 'camera.checking' : !state.available ? 'camera.unavailable' : state.imageSet === null ? 'camera.unknown' : state.imageSet ? 'camera.imageSet' : 'camera.defaultScene')}</strong>
      </div>
      <p className="env-hint" id={id + '-hint'}>{t('camera.hint')}</p>
      <input ref={input} id={id} type="file" hidden accept="image/png,image/jpeg" aria-label={t('camera.file')} aria-describedby={id + '-hint'}
        disabled={!running || !state?.available || busy} onChange={event => { const file = event.target.files?.[0]; if (file) void change('image', file); }} />
      <div className="env-camera-actions">
        <button type="button" className="button primary small" disabled={!running || !state?.available || busy} onClick={() => input.current?.click()}>
          <Icon name="camera" size={16} />{t('camera.file')}
        </button>
        <button type="button" data-camera-action="show" className="button small" disabled={!running || !state?.available || !state.imageSet || busy} onClick={() => void change('show')}>
          <Icon name="camera" size={16} />{t('camera.show')}
        </button>
        <button type="button" data-camera-action="reset" className="button outline small" disabled={!running || !state?.available || state.imageSet === false || busy} onClick={() => void change('reset')}>
          <Icon name="refresh" size={16} />{t('camera.reset')}
        </button>
      </div>
    </div>
  </details>;
}
