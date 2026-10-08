import { useAccess } from './permissions';
import { getLocale, t } from './i18n';
import { useId, useState } from 'react';
import type { Profile } from './api';
import { Icon } from './icons';
import './ProfileCard.css';
import { memoryLabel, profileEnvironment } from './profile-metadata';
import { profileStatus, PROFILE_STATUS_LABELS, PROFILE_STATUS_HELP, profileMetadataHelp } from './profile-status';

export function ProfileCard({ profile, onEdit, onToggle, onDelete }: {
  profile: Profile;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const can = useAccess();
  const titleId = useId();
  const statusHelpId = useId();
  const [showStatusHelp, setShowStatusHelp] = useState(false);
  const status = profileStatus(profile);
  const environment = profileEnvironment(profile);
  const hasUnspecifiedMetadata = !profile.deviceModel?.trim() || !profile.resolution?.trim() ||
    environment.cores === t('ui.c5ae8cdbe7dd') || environment.memory === t('ui.c5ae8cdbe7dd');
  const disabled = profile.enabled === false;

  return <article className="profile-card device-profile-card interactive-card" data-profile-state={status} aria-labelledby={titleId}>
    <header className="device-profile-heading">
      <h3 id={titleId}><button className="card-primary-action" type="button" disabled={!can('profiles.manage')} onClick={onEdit} aria-label={t('ui.ba4daef19d1a') + profile.name + "»"}>{profile.name}</button></h3>
      <p>{environment.android} · {environment.api}</p>
      <div className="device-profile-chips">
        <button type="button" className={'device-profile-status card-secondary-action is-' + status} data-profile-status={status}
          aria-label={PROFILE_STATUS_LABELS[status] + t('ui.77571251d900')} aria-expanded={showStatusHelp} aria-controls={statusHelpId}
          onClick={() => setShowStatusHelp(open => !open)}>
          <span aria-hidden="true" />{PROFILE_STATUS_LABELS[status]}<Icon name="info" size={13} />
        </button>
        {profile.recommended && <span className="device-profile-recommended"><Icon name="star" size={12}/>{t('ui.859f8f01fde8')}</span>}
      </div>
    </header>
    <div className="device-profile-body">
    <div id={statusHelpId} hidden={!showStatusHelp} className="device-profile-status-explanation card-secondary-action">{PROFILE_STATUS_HELP[status]}</div>

    <div className="device-profile-resources" role="group" aria-label={t('ui.297b02bc1b4a')}>
      <section className="device-profile-resource" aria-labelledby={titleId + '-cpu'}>
        <h4 id={titleId + '-cpu'}>{t('ui.db9a4c7d4c19')}</h4>
        <dl className="device-profile-resource-values">
          <div><dt>{t('ui.04fba521d85b')}</dt><dd>{profile.cpu?.toLocaleString(getLocale()) ?? t('ui.011e1ca54824')}</dd></div>
          <div><dt>{t('ui.6ee4b2429634')}</dt><dd className={environment.cores === t('ui.c5ae8cdbe7dd') ? 'is-unset' : undefined}>{environment.cores}</dd></div>
        </dl>
      </section>
      <section className="device-profile-resource" aria-labelledby={titleId + '-memory'}>
        <h4 id={titleId + '-memory'}>{t('ui.397211640533')}</h4>
        <dl className="device-profile-resource-values">
          <div><dt>{t('ui.04fba521d85b')}</dt><dd>{memoryLabel(profile.memoryMb)}</dd></div>
          <div><dt>{t('ui.6ee4b2429634')}</dt><dd className={environment.memory === t('ui.c5ae8cdbe7dd') ? 'is-unset' : undefined}>{environment.memory}</dd></div>
        </dl>
      </section>
    </div>
    <p className="device-profile-note">{t('ui.204db635ac91')}</p>

    <dl className="device-profile-features">
      <div><dt>{t('ui.45b14de1a664')}</dt><dd>{environment.abi}</dd></div>
      <div><dt>{t('ui.cd9bad6b5a92')}</dt><dd>{profile.diskGb == null ? t('ui.011e1ca54824') : profile.diskGb.toLocaleString(getLocale()) + t('ui.9fd219660ff0')}</dd></div>
      <div className={profile.deviceModel?.trim() ? undefined : 'is-unset'}><dt>{t('ui.f3bdf7cce355')}</dt><dd>{environment.model}</dd></div>
      <div className={profile.resolution?.trim() ? undefined : 'is-unset'}><dt>{t('ui.66e8aa762f6d')}</dt><dd>{environment.resolution}</dd></div>
    </dl>

    <details className="device-profile-details card-secondary-action">
      <summary>{t('ui.e26ae71cee24')}<Icon name="arrowDown" size={15} /></summary>
      <dl>
        <div><dt>{t('ui.c9907645803f')}</dt><dd><code>{profile.id}</code></dd></div>
        <div><dt>{t('ui.157705d4fc52')}</dt><dd><code>{profile.image || t('ui.0d836c1579f1')}</code></dd></div>
        <div><dt>{t('ui.6945fd170daa')}</dt><dd>{profile.emulatorParams?.trim() ? <code>{profile.emulatorParams}</code> : t('ui.465370e8594b')}</dd></div>
        <div><dt>{t('ui.a60003e96650')}</dt><dd>{Object.keys(profile.containerEnv ?? {}).length ? <code>{Object.keys(profile.containerEnv!).join(', ')}</code> : t('ui.465370e8594b')}</dd></div>
      </dl>
      {hasUnspecifiedMetadata && <p className="device-profile-source-note">{profileMetadataHelp()}</p>}
    </details>
    </div>

    {can('profiles.manage') && <footer className="profile-actions">
      <button className="text-button card-secondary-action" type="button" onClick={onToggle}>{disabled ? t('ui.a54eaf37858d') : t('ui.bb5bdd176cdf')}</button>
      <button className="icon-button danger-icon card-secondary-action" type="button" aria-label={t('ui.be99b1361201')} title={t('ui.be99b1361201')} onClick={onDelete}><Icon name="trash" size={17}/></button>
    </footer>}
  </article>;
}
