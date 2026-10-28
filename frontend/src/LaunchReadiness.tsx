import { t } from './i18n';
import { Icon } from './icons';
import { useAccess } from './permissions';
import type { LaunchReadiness as Readiness } from './launch-readiness';

export function LaunchReadiness({ readiness, admin, alternative, onAutoHost }: {
  readiness: Readiness; admin: boolean; alternative: boolean; onAutoHost: () => void;
}) {
  const can = useAccess();
  const canOpen = (href: string) => can(href.startsWith('#/admin/nodes') ? 'nodes.manage' : 'profiles.manage');
  if (readiness.state === 'ready') return null;
  const actions = [...new Map(readiness.issues.filter(issue => issue.href && canOpen(issue.href)).map(issue => [issue.href, issue])).values()];
  return <section className="launch-readiness" data-state={readiness.state} aria-label={t('ui.4288155a592c')} aria-live="polite">
    <div className="launch-readiness-heading"><Icon name="info" size={16}/><strong>{readiness.state === 'busy' ? t('ui.9052544a2279') : t('ui.9613e0f712c0')}</strong></div>
    <ul>{readiness.issues.map(issue => <li key={issue.code}>
      <strong>{issue.message}</strong><p>{issue.remedy}</p>
    </li>)}</ul>
    {actions.length > 0 && <div className="launch-readiness-actions">{actions.map(issue => <a key={issue.href} href={issue.href} target="_blank" rel="noopener noreferrer">{issue.action}<span aria-hidden="true">↗</span><span className="sr-only"> {t('ui.3b2b9762d54d')}</span></a>)}</div>}
    {!admin && readiness.state === 'blocked' && <p className="create-field-hint">{t('ui.1af52c86f53f')}</p>}
    {alternative && <button type="button" className="text-button" onClick={onAutoHost}>{t('ui.2aa7f97fa588')}</button>}
    {readiness.nodes.length > 1 && <details className="launch-node-checks"><summary>{t('ui.37b24b49418e')}<span>{readiness.nodes.length}</span><Icon name="arrowDown" size={14}/></summary><ul>{readiness.nodes.map(({ host, issues }) => <li key={host.id}><strong>{host.name}</strong><p>{issues.length ? issues.map(issue => issue.message.startsWith(host.name + ': ') ? issue.message.slice(host.name.length + 2) : issue.message).join(' ') : host.activeSessions >= host.maxSessions ? t('ui.8d8484b6ae2a') : t('ui.567ba8786865')}</p>{can('nodes.manage') && issues.length > 0 && <a href={'#/admin/nodes?host=' + encodeURIComponent(host.id)} target="_blank" rel="noopener noreferrer">{t('ui.ca4096adda5e')}<span className="sr-only"> {t('ui.3b2b9762d54d')}</span></a>}</li>)}</ul></details>}
    {actions.length > 0 && <p className="create-field-hint">{t('ui.50cdc195457d')}</p>}
  </section>;
}
