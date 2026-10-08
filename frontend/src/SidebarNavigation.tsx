import { can } from './permissions';
import type { User } from './api';
import { sectionPermission } from './admin-navigation';
import { getLocale, t } from './i18n';
import { adminSections, type AdminSection } from './admin-navigation';
import type { NavigationCounts } from './api';
import { Icon } from './icons';

type Props = {
  page: string;
  section?: AdminSection;
  user: User;
  counts: NavigationCounts | null;
  onNavigate: () => void;
};

const compactCount = { format: (value: number) => new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value) };

function NavigationCount({ value, description }: { value?: number; description: string }) {
  const label = value === undefined ? t('ui.72b8d93dedac', { p0: description }) : `${description}: ${value.toLocaleString(getLocale())}`;
  return <small className="side-nav-count" title={label} aria-label={label}>{value === undefined ? '—' : value >= 10000 ? compactCount.format(value) : value.toLocaleString(getLocale())}</small>;
}

export function SidebarNavigation({ page, section, user, counts, onNavigate }: Props) {
  const adminCounts = {
    sessions: { value: counts?.allSessions, description: t('ui.4f64520b34bf') },
    nodes: { value: counts?.nodes, description: t('ui.a6942642be3f') },
    profiles: { value: counts?.profiles, description: t('ui.d0acee5d717b') },
    users: { value: counts?.users, description: t('ui.b3d19f2fed0f') },
  };
  return <div className="sidebar-navigation">
    <nav className="side-nav" aria-label={t('ui.5135f064dea4')}>
      {can(user, 'sessions.view') && <a href="#/overview" aria-label={t('ui.6b8377e0a6fa')} data-counted aria-current={page === 'overview' ? 'page' : undefined} onClick={onNavigate}>
        <Icon name="phone" size={20} /><span>{t('ui.6b8377e0a6fa')}</span>
        <NavigationCount value={counts?.sessions} description={t('ui.d24bff1da366')} />
      </a>}
      {can(user, 'tokens.personal') && <a href="#/tokens" data-counted aria-current={page === 'tokens' ? 'page' : undefined} onClick={onNavigate} aria-label={t('ui.daaf8ccbab69')} title={t('ui.daaf8ccbab69')}>
        <Icon name="key" size={20} /><span>{t('ui.98b7dc41479f')}</span>
        <NavigationCount value={counts?.tokens} description={can(user, 'tokens.system') ? t('ui.a09357a0b710') : t('ui.0c7bff3f03de')} />
      </a>}
    </nav>
    {adminSections.some(item => can(user, sectionPermission[item.id])) && <nav className="side-nav side-nav-admin" aria-labelledby="admin-navigation-heading">
      <h2 id="admin-navigation-heading" className="side-nav-heading">{t('ui.eff775aa4e8c')}</h2>
      {adminSections.filter(item => can(user, sectionPermission[item.id])).map(item => {
        const count = item.id in adminCounts ? adminCounts[item.id as keyof typeof adminCounts] : undefined;
        return <a key={item.id} href={'#/admin/' + item.id} aria-label={item.label} data-counted={count ? true : undefined}
          aria-current={(page === 'admin' && section === item.id) || (page === 'hosts' && item.id === 'nodes') ? 'page' : undefined}
          onClick={onNavigate}>
          <Icon name={item.icon} size={20} /><span>{item.label}</span>
          {count && <NavigationCount {...count} />}
        </a>;
      })}
    </nav>}
  </div>;
}
