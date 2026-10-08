import { getLanguage, setLanguage, subscribeLanguage, t, type Language } from './i18n';
import { useId, useSyncExternalStore } from 'react';

export function useInterfaceLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
export function LanguageControl() {
  const language = useInterfaceLanguage();
  const id = useId();
  return <div className="language-control">
    <label className="sr-only" htmlFor={id}>{t('language.label')}</label>
    <select id={id} aria-label={t('language.label')} value={language}
      onChange={event => setLanguage(event.target.value as Language)}>
      <option value="ru">{t('language.ru')}</option>
      <option value="en">{t('language.en')}</option>
    </select>
  </div>;
}
