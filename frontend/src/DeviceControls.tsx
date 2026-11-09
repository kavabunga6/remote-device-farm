import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ActivityIndicator } from './ActivityIndicator';
import { Icon, type IconName } from './icons';
import { t } from './i18n';
import type { useSessionCapture } from './useSessionCapture';

type ControlProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  pending?: boolean;
};

function Control({ icon, label, pending, children, title = label, ...props }: ControlProps) {
  return <button type="button" className="device-control" aria-label={label} title={title} {...props}>
    {pending ? <ActivityIndicator /> : <Icon name={icon} />}{children}
  </button>;
}

const androidNavigation = [
  ['back', 'ui.1a9fb1f3cf8e', 4],
  ['home', 'ui.f6e01d413ff6', 3],
  ['recent', 'ui.2d7ce9a5379c', 187],
] as const;

const androidHardware = [
  ['volumeOff', 'ui.187b90793015', 164],
  ['plus', 'ui.d32a29ef600e', 24],
  ['minus', 'ui.e199c10f2526', 25],
  ['power', 'ui.ffe25dd2be73', 26],
] as const;

type Props = {
  onKey: (code: number) => void;
  canControl: boolean;
  textInput: ReactNode;
  audio: ReactNode;
  rotate?: { landscape: boolean; busy: boolean; onClick: () => void };
  network?: { enabled: boolean; busy: boolean; onClick: () => void };
  upload?: { pending: boolean; disabled: boolean; onClick: () => void };
  capture: ReturnType<typeof useSessionCapture>;
  captureReady: boolean;
};

export function DeviceControls({ onKey, canControl, textInput, audio, rotate, network, upload, capture, captureReady }: Props) {
  const seconds = capture.elapsedSeconds;
  const recordingTime = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const androidButton = ([icon, message, code]: (typeof androidNavigation | typeof androidHardware)[number]) =>
    <Control key={code} icon={icon} label={t(message)} onClick={() => onKey(code)} disabled={!canControl} />;

  return <div className="device-controls" role="group" aria-label={t('device.controls')}>
    <div className="control-group">
      {androidNavigation.map(androidButton)}
      {rotate && <Control icon="rotate" label={t('ui.4bfe24c8f020')} aria-pressed={rotate.landscape} data-state={rotate.landscape ? 'enabled' : undefined}
        disabled={rotate.busy} onClick={rotate.onClick} />}
      {textInput}
    </div>
    <div className="control-group">
      {audio}
      <Control icon={capture.recording ? 'stop' : 'recordScreen'} pending={capture.saving}
        title={t(capture.saving ? 'ui.8d839c3234cd' : capture.recording ? 'ui.ea0f675f3aab' : 'ui.c085454ef117')}
        label={t(capture.saving ? 'ui.8d839c3234cd' : capture.recording ? 'ui.29efbde7481a' : 'ui.4e087745e0a4')}
        aria-pressed={capture.recording} data-state={capture.recording ? 'recording' : undefined}
        onClick={capture.recording ? capture.stopRecording : capture.startRecording}
        disabled={capture.saving || (!capture.recording && (!captureReady || !capture.recordingSupported))}>
        {capture.recording && <span className="device-recording-time" dir="ltr" aria-hidden="true">{recordingTime}</span>}
      </Control>
      <Control icon="camera" label={t('ui.02ea85d55701')} onClick={() => void capture.takeScreenshot()}
        disabled={!captureReady || !capture.screenshotSupported} />
      {upload && <Control icon="upload" pending={upload.pending} label={t('ui.f48012de6546')}
        title={t('ui.b59947f1458d')} onClick={upload.onClick} disabled={upload.disabled} />}
    </div>
    <div className="control-group">
      {network && <Control icon={network.enabled ? 'wifi' : 'wifiOff'} aria-pressed={network.enabled} data-state={network.enabled ? 'enabled' : undefined}
        label={t(network.enabled ? 'ui.1866e096f838' : 'ui.fcfc99f6b5e8')} onClick={network.onClick} disabled={network.busy} />}
      {androidHardware.map(androidButton)}
    </div>
  </div>;
}
