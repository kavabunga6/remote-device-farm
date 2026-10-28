import { useId, useState } from 'react';
import { useAccess } from './permissions';
import { getLocale, t } from './i18n';
import type { Profile } from './api';
import { Icon } from './icons';
import { memoryLabel, profileEnvironment } from './profile-metadata';
import { profileStatus, PROFILE_STATUS_LABELS, PROFILE_STATUS_HELP, profileMetadataHelp } from './profile-status';

function ProfileDetails({ profile }: { profile: Profile }) {
  const environment = profileEnvironment(profile);
  const hasUnspecifiedMetadata = !profile.deviceModel?.trim() || !profile.resolution?.trim() ||
    environment.cores === t('ui.c5ae8cdbe7dd') || environment.memory === t('ui.c5ae8cdbe7dd');
  return <div className="admin-profile-detail-content">
    <p className="admin-profile-status-help">{PROFILE_STATUS_HELP[profileStatus(profile)]}</p>
    <dl className="admin-profile-facts">
      <div><dt>{t('ui.f3bdf7cce355')}</dt><dd>{environment.model}</dd></div>
      <div><dt>{t('ui.66e8aa762f6d')}</dt><dd>{environment.resolution}</dd></div>
      <div><dt>{t('ui.cd9bad6b5a92')}</dt><dd>{profile.diskGb == null ? t('ui.011e1ca54824') : t('copy.ProfileCard.9030bbc4', { p0: profile.diskGb.toLocaleString(getLocale()) })}</dd></div>
      <div><dt>{t('ui.45b14de1a664')}</dt><dd>{environment.abi}</dd></div>
    </dl>
    <dl className="admin-profile-source">
      <div><dt>{t('ui.c9907645803f')}</dt><dd><code>{profile.id}</code></dd></div>
      <div><dt>{t('ui.157705d4fc52')}</dt><dd><code>{profile.image || t('ui.0d836c1579f1')}</code></dd></div>
      <div><dt>{t('ui.6945fd170daa')}</dt><dd>{profile.emulatorParams?.trim() ? <code>{profile.emulatorParams}</code> : t('ui.465370e8594b')}</dd></div>
      <div><dt>{t('ui.a60003e96650')}</dt><dd>{Object.keys(profile.containerEnv ?? {}).length ? <code>{Object.keys(profile.containerEnv!).join(', ')}</code> : t('ui.465370e8594b')}</dd></div>
    </dl>
    <p className="admin-profile-detail-note">{t('ui.204db635ac91')}</p>
    {hasUnspecifiedMetadata && <p className="admin-profile-detail-note">{profileMetadataHelp()}</p>}
  </div>;
}

export function ProfileRow({ profile, onEdit, onToggle, onDelete }: {
  profile: Profile;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const can = useAccess();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const status = profileStatus(profile);
  const environment = profileEnvironment(profile);
  const toggleDetails = () => setExpanded(value => !value);
  const editLabel = t('ui.ba4daef19d1a') + profile.name + '»';
  const detailsLabel = t('ui.e26ae71cee24') + ': ' + profile.name;
  const toggleLabel = profile.enabled === false ? t('ui.a54eaf37858d') : t('ui.bb5bdd176cdf');
  return <>
    <tr className={'admin-profile-row' + (can('profiles.manage') ? ' interactive-card' : '')} data-profile-state={status}>
      <td className="admin-profile-identity">
        <div className="admin-profile-name">
          <Icon name="phone" size={18}/>
          <button type="button" className="card-primary-action" disabled={!can('profiles.manage')} onClick={onEdit} aria-label={editLabel}>{profile.name}</button>
          {profile.recommended && <span className="admin-profile-recommended" title={t('ui.859f8f01fde8')}><Icon name="star" size={14}/><span className="sr-only">{t('ui.859f8f01fde8')}</span></span>}
        </div>
        <p className="admin-profile-metadata">{environment.android} · {environment.api} · {environment.abi}</p>
      </td>
      <td><button type="button" className={'admin-profile-status card-secondary-action is-' + status} data-profile-status={status}
        aria-label={t('copy.ProfileCard.da6b75bd', { p0: PROFILE_STATUS_LABELS[status] })} aria-expanded={expanded} aria-controls={id}
        onClick={toggleDetails}><span aria-hidden="true"/>{PROFILE_STATUS_LABELS[status]}<Icon name="info" size={13}/></button></td>
      <td className="admin-profile-resources"><span>{t('ui.db9a4c7d4c19')}: {profile.cpu?.toLocaleString(getLocale()) ?? t('ui.011e1ca54824')}</span><strong>{memoryLabel(profile.memoryMb)}</strong></td>
      <td className="admin-profile-resources"><span>{t('ui.db9a4c7d4c19')}: {environment.cores}</span><strong>{environment.memory}</strong></td>
      <td><div className="admin-profile-actions">
        <button type="button" className="icon-button card-secondary-action" title={detailsLabel} aria-label={detailsLabel} aria-expanded={expanded} aria-controls={id} onClick={toggleDetails}><Icon name={expanded ? 'arrowUp' : 'chevronDown'} size={16}/></button>
        {can('profiles.manage') && <>
          <button type="button" className="icon-button card-secondary-action" title={toggleLabel} aria-label={toggleLabel} onClick={onToggle}><Icon name="power" size={16}/></button>
          <button type="button" className="icon-button danger-icon card-secondary-action" title={t('ui.be99b1361201')} aria-label={t('ui.be99b1361201')} onClick={onDelete}><Icon name="trash" size={16}/></button>
        </>}
      </div></td>
    </tr>
    <tr className="admin-profile-expanded" hidden={!expanded}><td colSpan={5}>
      <section id={id} aria-label={detailsLabel}>{expanded && <ProfileDetails profile={profile}/>}</section>
    </td></tr>
  </>;
}
