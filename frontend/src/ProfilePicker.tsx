import { getLocale, getLanguage, t } from './i18n';
import { useMemo } from 'react';
import { Icon } from './icons';
import type { CatalogProfile } from './profile-catalog';
import './ProfilePicker.css';

/** One device list replaces saved presets and cascading environment filters. */
export function ProfilePicker({ profiles, selectedId, onSelect, disabled = false }: {
  profiles: CatalogProfile[]; selectedId: string; onSelect: (id: string) => void; disabled?: boolean;
}) {
  const sorted = useMemo(() => [...profiles].sort((a, b) => Number(b.apiLevel ?? -1) - Number(a.apiLevel ?? -1) || a.name.localeCompare(b.name, getLocale(), { numeric: true }) || a.id.localeCompare(b.id)), [profiles, getLanguage()]);
  const label = (profile: CatalogProfile) => {
    const duplicate = profiles.filter(item => item.name === profile.name && item.abi === profile.abi).length > 1;
    return [profile.name, profile.abi, duplicate ? profile.id : ''].filter(Boolean).join(' · ');
  };
  return <section className="profile-picker" aria-label={t('ui.c1f4d70adc83')}>
    <label className="create-device-field"><span>{t('ui.dba20ab53801')}</span><select aria-label={t('ui.dba20ab53801')} value={selectedId} title={sorted.find(profile => profile.id === selectedId)?.name} disabled={disabled || !sorted.length} onChange={event => onSelect(event.target.value)}>
      {!sorted.some(profile => profile.id === selectedId) && <option value={selectedId} disabled>{sorted.length ? t('ui.8e6e447e0336') : t('ui.bf64faea0d9c')}</option>}
      {sorted.map(profile => <option key={profile.id} value={profile.id} disabled={profile.enabled === false}>{label(profile)}{profile.enabled === false ? t('ui.f29d2159ba06') : ''}</option>)}
    </select></label>
    {!sorted.length && <div className="profile-picker-empty"><Icon name="phone" size={22}/><strong>{t('ui.bf64faea0d9c')}</strong><p>{t('ui.6b300bd298b7')}</p></div>}
  </section>;
}
