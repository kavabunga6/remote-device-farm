import { t } from './i18n';
import type { DeviceSession } from './api';
import type { AuditRecord, RentalRecord, ServiceLogRecord } from './settings-api';

type Field = [label: string, value: string | null | undefined];
type Badge = { label: string; tone: 'neutral' | 'success' | 'warning' | 'error' };
export interface JournalDate { label: string; value: string | null; emptyLabel?: string }
export interface JournalDetail {
  title: string;
  category: string;
  badge: Badge;
  summary: Field[];
  dates: JournalDate[];
  technical: Field[];
  hostId?: string | null;
  sessionId?: string | null;
  sessionEnded?: boolean;
}

const liveStates: Record<string, string> = {
  get starting() { return t('ui.a207dbeaf97a'); }, get running() { return t('ui.0232a305412b'); }, get stopping() { return t('ui.75adfadd9b91'); }, get stopped() { return t('ui.d0dd0cfdf601'); }, get error() { return t('ui.bf22dfeeba8b'); }, get failed() { return t('ui.bf22dfeeba8b'); },
};

export function rentalDetail(item: RentalRecord, liveSession?: DeviceSession): JournalDetail {
  const failed = item.finalState === 'failed' || item.finalState === 'error';
  // The rental closes when the session is deleted; its last state can still be "stopping".
  const badge: Badge = item.endedAt
    ? { label: failed ? t('ui.2cca5c739679') : t('ui.d0dd0cfdf601'), tone: failed ? 'error' : 'neutral' }
    : { label: liveSession ? liveStates[liveSession.status] || t('ui.983ec1306814') : t('ui.983ec1306814'), tone: liveSession?.status === 'error' ? 'error' : 'success' };
  return {
    title: item.profileName, category: t('ui.c73549b31ecd'), badge,
    hostId: item.hostId, sessionId: item.sessionId, sessionEnded: Boolean(item.endedAt),
    summary: [[t('ui.2a5c42af7c00'), item.ownerUsername], [t('ui.e77a383ee52d'), item.hostName]],
    dates: [
      { label: t('ui.0a39fbc65169'), value: item.createdAt },
      { label: t('ui.9e62692be036'), value: item.startedAt, emptyLabel: t('ui.febfb1f3734e') },
      { label: t('ui.d0dd0cfdf601'), value: item.endedAt, emptyLabel: t('ui.a03dd23bf072') },
    ],
    technical: [[t('ui.a1d21ea2bf16'), item.id], [t('ui.fe128693433a'), item.sessionId], [t('ui.32aaa6817ab1'), item.ownerUserId], [t('ui.6145a142f4d3'), item.hostId], [t('ui.c9907645803f'), item.profileId], [t('ui.9e8b5b2cf2ed'), item.finalState]],
  };
}

const outcomeLabels: Record<string, string> = { get success() { return t('ui.4ad64e13c9a3'); }, get denied() { return t('ui.c65141292bf1'); }, get failed() { return t('ui.bf22dfeeba8b'); } };
const targetLabels: Record<string, string> = {
  get session() { return t('ui.f7aa03484689'); }, get host() { return t('ui.e77a383ee52d'); }, get user() { return t('ui.2a5c42af7c00'); }, get device() { return t('ui.dba20ab53801'); }, get profile() { return t('ui.599412c70ba3'); },
  get profile_preset() { return t('ui.b89254b3cbac'); }, get team() { return t('ui.8b372c12c268'); }, get token() { return t('ui.4a2ec492d412'); }, get app() { return t('ui.26b855cc1660'); }, get queue() { return t('ui.cb297d129add'); }, get webhook() { return t('ui.a296b7e333ad'); },
};

export function actionDetail(item: AuditRecord, title: string): JournalDetail {
  const systemEvent = !item.actorUserId && !item.actorUsername;
  // Lifecycle events use outcome=success for recording the event, even session.failed.
  const badge: Badge = item.action === 'session.failed'
    ? { label: t('ui.bf22dfeeba8b'), tone: 'error' }
    : systemEvent && item.outcome === 'success'
      ? { label: t('ui.a36681d8f85a'), tone: 'neutral' }
      : { label: outcomeLabels[item.outcome] || item.outcome, tone: item.outcome === 'success' ? 'success' : item.outcome === 'denied' ? 'warning' : 'error' };
  return {
    title, category: systemEvent ? item.targetType === 'session' ? t('ui.4f684d574475') : t('ui.91a9af0f4e99') : t('ui.edf28bee3064'),
    badge,
    hostId: item.targetType === 'host' ? item.targetId : null,
    sessionId: item.targetType === 'session' ? item.targetId : null,
    summary: [[t('ui.6665414a26a7'), item.actorUsername || t('ui.6da215b1bdac')], [t('ui.cedecb919c3a'), item.targetType ? targetLabels[item.targetType] || item.targetType : null]],
    dates: [{ label: t('ui.04edebc624ec'), value: item.occurredAt }],
    technical: [[t('ui.f184eb160a96'), item.id], [t('ui.d89424627679'), item.action], [t('ui.4997a5143d9f'), item.outcome], [t('ui.32aaa6817ab1'), item.actorUserId], [t('ui.cd0bb8dea285'), item.subjectUserId], [t('ui.802e782254c8'), item.targetType], [t('ui.11b5be4a6b5c'), item.targetId]],
  };
}

const serviceLabels: Record<string, string> = { get server() { return t('ui.5a03382f1926'); }, get agent() { return t('ui.d5fd08be28ee'); }, get emulator() { return t('ui.e6033cd72f50'); } };
const severityLabels: Record<string, string> = { get info() { return t('ui.0bf0fcb2ff78'); }, get warning() { return t('ui.233a8e993aeb'); }, get error() { return t('ui.bf22dfeeba8b'); } };

export function logDetail(item: ServiceLogRecord, title: string, hostName: string): JournalDetail {
  return {
    title, category: t('ui.876e372971fa'),
    badge: { label: severityLabels[item.severity] || item.severity, tone: item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'neutral' },
    hostId: item.hostId, sessionId: item.sessionId,
    summary: [[t('ui.095f8a67b557'), serviceLabels[item.service] || item.service], [t('ui.e77a383ee52d'), item.hostId ? hostName : null], [t('ui.3e0ccd92fa15'), item.message || null]],
    dates: [{ label: t('ui.04edebc624ec'), value: item.occurredAt }],
    technical: [[t('ui.f184eb160a96'), item.id], [t('ui.0dc7319ef460'), item.code], [t('ui.095f8a67b557'), item.service], [t('ui.7f67af3d6cd9'), item.severity], [t('ui.6145a142f4d3'), item.hostId], [t('ui.fe128693433a'), item.sessionId]],
  };
}

export function technicalFields(detail: JournalDetail): Field[] {
  return [...detail.technical, ...detail.dates.map(({ label, value }): Field => [label + ' (UTC)', value])]
    .filter(([, value]) => value != null && value !== '');
}

export function journalCopyText(detail: JournalDetail): string {
  return [detail.title, detail.category + ' · ' + detail.badge.label,
    ...detail.summary.filter(([, value]) => value != null && value !== '').map(([label, value]) => label + ': ' + value),
    ...technicalFields(detail).map(([label, value]) => label + ': ' + value),
  ].join('\n');
}
