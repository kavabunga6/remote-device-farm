import { Fragment, type ReactNode } from 'react';
import { t, type MessageKey } from './i18n';

/** Keep a sentence together while allowing translators to move its formatted values. */
export function TranslatedText({ message, values }: { message: MessageKey; values: Record<string, ReactNode> }) {
  return <>{t(message).split(/(\{\w+\})/g).map((part, index) =>
    <Fragment key={index}>{/^\{\w+\}$/.test(part) && Object.hasOwn(values, part.slice(1, -1)) ? values[part.slice(1, -1)] : part}</Fragment>)}</>;
}
