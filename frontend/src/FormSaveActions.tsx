import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { ActivityIndicator } from './ActivityIndicator';
import './FormSaveActions.css';

/** One dock stacks pending forms and reserves space below page notifications. */
export function FormSaveDock() {
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    const main = element.parentElement;
    const observer = new ResizeObserver(() => {
      if (main) element.style.setProperty('--form-save-available-width', main.getBoundingClientRect().width + 'px');
      const height = element.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--form-save-offset', (height ? height + 12 : 0) + 'px');
    });
    observer.observe(element);
    if (main) observer.observe(main);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--form-save-offset'); };
  }, []);
  return <div id="form-save-dock" ref={dock}/>;
}

/** Keeps native form validation and submission for both inline and floating actions. */
export function FormSaveActions({ formId, dirty, busy = false, disabled = false, context, label, className = '', buttonClassName = 'button primary' }: {
  formId: string; dirty: boolean; busy?: boolean; disabled?: boolean; context: string; label?: string;
  className?: string; buttonClassName?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const floatingFocus = useRef(false);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [visibility, setVisibility] = useState({ inline: true, form: false });
  useLayoutEffect(() => { setDock(document.getElementById('form-save-dock')); }, []);
  useEffect(() => {
    const action = button.current, form = action?.form;
    if (!dirty || !action || !form) return;
    const observer = new IntersectionObserver(entries => {
      setVisibility(previous => {
        const next = { ...previous };
        for (const entry of entries) {
          if (entry.target === action) next.inline = entry.isIntersecting && entry.intersectionRatio >= 0.999;
          if (entry.target === form) next.form = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
        }
        return previous.inline === next.inline && previous.form === next.form ? previous : next;
      });
    }, { threshold: [0, 1] });
    observer.observe(action); observer.observe(form);
    return () => observer.disconnect();
  }, [dirty, formId]);
  const floating = Boolean(dirty && dock && visibility.form && !visibility.inline);
  useLayoutEffect(() => {
    if (floating || !floatingFocus.current) return;
    floatingFocus.current = false;
    const target = dirty ? button.current : previousFocus.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    previousFocus.current = null;
  }, [floating, dirty]);
  const unavailable = busy || disabled || !dirty;
  const copy = busy ? t('ui.9c27c381dd8b') : label ?? t('ui.b4d30cae5289');
  return <>
    <div className={'form-save-actions ' + className}>
      <button ref={button} type="submit" form={formId} className={buttonClassName} disabled={unavailable} aria-hidden={floating || undefined} tabIndex={floating ? -1 : undefined}>{busy && <ActivityIndicator/>}{copy}</button>
    </div>
    {floating && dock && createPortal(<section className="floating-form-save" role="region" aria-label={context}>
      <div className="floating-form-save-copy"><strong title={context}>{context}</strong><span>{t('images.unsaved')}</span></div>
      <button type="submit" form={formId} className="button primary" disabled={unavailable} onFocus={event => {
        floatingFocus.current = true;
        previousFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
      }} onBlur={event => { if (event.relatedTarget) floatingFocus.current = false; }}>{busy && <ActivityIndicator/>}{copy}</button>
    </section>, dock)}
  </>;
}
