import { t } from './i18n';
import type { DeviceSession } from './api';
import { ActivityIndicator } from './ActivityIndicator';

const LABELS: Record<DeviceSession['status'], string> = {
  get starting() { return t('ui.a207dbeaf97a'); }, get running() { return t('ui.0232a305412b'); }, get stopping() { return t('ui.546ea337315e'); }, get stopped() { return t('ui.39e74d43c11a'); }, get error() { return t('ui.bf22dfeeba8b'); },
};
export function SessionStatusBadge({ status }: { status: DeviceSession['status'] }) {
  const active = status === 'starting' || status === 'stopping';
  return <span className={`session-badge status-badge status-${status}`} role="status">
    <span className="session-status-icon" aria-hidden="true">{active ? <ActivityIndicator /> : <span className="status-dot" />}</span>
    {LABELS[status]}
  </span>;
}
