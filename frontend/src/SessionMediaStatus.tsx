import { t } from './i18n';
import { useEffect, useRef } from 'react';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import type { ConnectionMode, SessionAudioState, StreamMetrics, StreamStatus, StreamTransport } from './useSessionStream';
import './SessionMediaStatus.css';

type Props = {
  status: StreamStatus;
  format: 'image' | 'video';
  transport?: StreamTransport;
  streamError?: string;
  mode?: ConnectionMode;
  onModeChange?: (mode: ConnectionMode) => void;
  metrics?: StreamMetrics;
  audioTransport?: ConnectionMode | null;
  audioEnabled: boolean;
  audioState: SessionAudioState;
  audioNotice?: string;
  audioBusy?: boolean;
  audioPending?: boolean;
  onUnlockAudio?: () => void;
  onToggleAudio?: () => void;
};
const audioLabels: Record<SessionAudioState, string> = {
  get disabled() { return t('ui.2a9dc2437cd8'); }, get connecting() { return t('ui.ba0c00b1a3f2'); }, get waiting() { return t('ui.7109ee75aab8'); },
  get unlock() { return t('ui.176288e012a0'); }, get receiving() { return t('ui.24c10d415fb7'); }, get unavailable() { return t('ui.0c30ab349215'); },
};
const audioDetails: Record<SessionAudioState, string> = {
  get disabled() { return t('ui.2c8e6c5b13db'); },
  get connecting() { return t('ui.197980b43eca'); },
  get waiting() { return t('ui.72ba84e06286'); },
  get unlock() { return t('ui.6e41e2d90e82'); },
  get receiving() { return t('ui.6c01357d0c95'); },
  get unavailable() { return t('ui.8b08da0887fc'); },
};

/** Transport and playback state are observed locally, independently of Android media volume. */
export function SessionMediaStatus({ status, format, transport, streamError, mode = 'websocket', onModeChange, metrics, audioTransport, audioEnabled, audioState, audioNotice, audioBusy = false, audioPending = false, onUnlockAudio, onToggleAudio }: Props) {
  const transportMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (transportMenu.current && !transportMenu.current.contains(event.target as Node)) transportMenu.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const actualTransport = transport ?? (status === 'live' ? format === 'video' ? 'scrcpy' : 'images' : null);
  const videoLabel = status === 'live' ? actualTransport === 'webrtc' ? 'WebRTC' : actualTransport === 'scrcpy' ? 'scrcpy' : actualTransport === 'mjpeg' ? 'MJPEG' : t('ui.57ea1e1aa7d9')
    : status === 'connecting' ? t('ui.2b0e3fa2e835') : status === 'unsupported' ? t('ui.3a6ec360f375') : t('ui.1cdbd38b277f');
  const videoDetail = status === 'live' ? actualTransport === 'webrtc' ? t('ui.6078d009cc30') : actualTransport === 'scrcpy' ? t('ui.d2ba013e5891') : actualTransport === 'mjpeg' ? t('ui.5dc4e9d9a2ae') : t('ui.766ed39cb87f')
    : streamError || (status === 'connecting' ? t('ui.3020ac4bc180') : status === 'unsupported' ? t('ui.a435e4c18cb1') : t('ui.ec863f600ac1'));
  const state = audioEnabled ? audioState === 'disabled' ? 'connecting' : audioState : 'disabled';
  const unlock = state === 'unlock' && onUnlockAudio;
  const action = unlock || onToggleAudio;
  const audioFallback = mode === 'webrtc' && audioTransport === 'websocket' && audioEnabled;
  const audioLabel = audioFallback && (state === 'receiving' || state === 'waiting') ? t('ui.e1be5d71d4c7') : audioLabels[state];
  const audioTitle = [audioDetails[state], audioFallback ? t('ui.2b65c50dff39') : '', audioNotice].filter(Boolean).join(' ');
  const audioContents = <>{state === 'connecting' || audioPending ? <ActivityIndicator /> : <Icon name={state === 'disabled' || state === 'unavailable' ? 'volumeOff' : 'volume'} size={15}/>}<span>{audioLabel}</span></>;
  return <div className="session-media-status" role="group" aria-label={t('ui.8c04e6b7ad8e')}>
    {onModeChange ? <details className="session-transport-menu" ref={transportMenu} onKeyDown={event => {
      if (event.key === 'Escape' && transportMenu.current) { transportMenu.current.open = false; transportMenu.current.querySelector('summary')?.focus(); }
    }}>
      <summary className="session-badge session-media-badge" data-media="video" data-state={status} title={videoDetail + t('ui.b04311ff82e1')} aria-label={t('ui.a9ce28442aea')}>{status === 'connecting' ? <ActivityIndicator /> : <Icon name="chevronDown" size={15}/>}<span>{videoLabel}</span></summary>
      <div className="session-transport-popover">
        <label htmlFor="session-transport">{t('ui.bfa2b3807818')}</label>
        <select id="session-transport" value={mode} onChange={event => onModeChange(event.target.value as ConnectionMode)}><option value="websocket">{t('ui.2adc1280d346')}</option><option value="webrtc">{t('ui.cffd062854c1')}</option></select>
        <p role="status">{videoDetail}</p>
        <dl>
          <div><dt>{t('ui.1bdef5526ac9')}</dt><dd>{metrics?.rttMs == null ? '—' : Math.round(metrics.rttMs) + t('ui.3d28ff50f586')}</dd></div>
          <div><dt>{t('ui.77986dd22b95')}</dt><dd>{metrics?.fps == null ? '—' : metrics.fps + t('ui.d0fe96463fac')}</dd></div>
          {mode === 'webrtc' && <><div><dt>{t('ui.c4003078c9fa')}</dt><dd>{metrics?.iceRttMs == null ? '—' : Math.round(metrics.iceRttMs) + t('ui.3d28ff50f586')}</dd></div><div><dt>{t('ui.bd6c2f1e576a')}</dt><dd>{metrics?.packetsLost ?? '—'}</dd></div></>}
        </dl>
        <small>{t('ui.f6621fd37f49')}</small>
      </div>
    </details> : <span className="session-badge session-media-badge" data-media="video" data-state={status} title={videoDetail} role="status">{status === 'connecting' ? <ActivityIndicator /> : <Icon name={status === 'live' ? 'play' : 'alert'} size={15}/>}<span>{videoLabel}</span></span>}
    {action ? <button type="button" className="session-badge session-media-badge session-media-audio" data-media="audio" data-state={state} title={audioTitle}
      aria-label={unlock ? t('ui.e94b876c3606') : audioEnabled ? t('ui.3a8735ac215d') : t('ui.249482ec7bb9')}
      aria-pressed={unlock ? undefined : audioEnabled} onClick={action} disabled={audioBusy}>{audioContents}</button>
      : <span className="session-badge session-media-badge session-media-audio" data-media="audio" data-state={state} title={audioTitle} role="status">{audioContents}</span>}
  </div>;
}
