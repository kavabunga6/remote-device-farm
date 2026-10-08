import { t } from './i18n';
import type { StartupProgress } from './api';
import { Icon } from './icons';
import { ActivityIndicator } from './ActivityIndicator';
import { STARTUP_STAGE_LABELS, startupPercent, startupStage, startupSummary, startupTransfer } from './startup-progress';
import './SessionStartupProgress.css';

const STEPS = [
  { get label() { return t('ui.111213e773d5'); }, get detail() { return t('ui.1c529862daab'); }, get done() { return t('ui.f377ed5d23fb'); } },
  { get label() { return t('ui.4ae260ce132f'); }, get detail() { return t('ui.a41cc690ca19'); }, get done() { return t('ui.1f9204c45402'); } },
  { get label() { return t('ui.f7ffa59af6d1'); }, get detail() { return t('ui.88bf88c0d22a'); }, get done() { return t('ui.c79c11c5619a'); } },
];
const stageStep = (stage: StartupProgress['stage'] | null): number =>
  stage === 'booting' || stage === 'ready' ? 2 : stage === 'creating' ? 1 : 0;

export function SessionStartupProgress({ progress, compact = false }: { progress?: StartupProgress | null; compact?: boolean }) {
  const stage = startupStage(progress);
  const percent = startupPercent(progress);
  const transfer = startupTransfer(progress);
  if (compact) return <div className="session-startup-compact" role="status" aria-live="polite"><Icon name="download" size={15}/><span>{startupSummary(progress)}{transfer && <small>{transfer}</small>}</span></div>;
  const currentStep = stageStep(stage);
  const title = stage ? STARTUP_STAGE_LABELS[stage] : t('ui.0a95ee764951');
  return <div className="session-startup-center"><section className="session-startup-progress" data-stage={stage || 'starting'} aria-labelledby="startup-heading">
    <header className="session-startup-header"><h2 id="startup-heading">{t('ui.996f22b45715')}</h2><p>{t('ui.3a3fdb81fefb')}</p></header>
    <ol className="session-startup-steps" aria-label={t('ui.1db6983396ad')}>{STEPS.map((step, index) => {
      // Android readiness still requires the browser stream to connect.
      const complete = index < currentStep;
      const active = index === currentStep && !complete;
      return <li key={step.label} className={complete ? 'is-complete' : active ? 'is-current' : 'is-pending'} aria-current={active ? 'step' : undefined}>
        <span className="session-startup-step-number" aria-hidden="true">{complete ? <Icon name="check" size={16}/> : active ? <ActivityIndicator /> : index + 1}</span>
        <div className="session-startup-step-content">
          <h3>{step.label}</h3>
          <p>{complete ? step.done : step.detail}</p>
          <div className="session-startup-step-status" role={active ? 'status' : undefined} aria-live={active ? 'polite' : undefined}>{complete ? t('ui.c045c25ac488') : active ? title : t('ui.89c9e3a11aee')}</div>
          {active && <div className="session-startup-current">
            {percent == null ? <div className="session-startup-indeterminate" role="progressbar" aria-label={title} aria-valuetext={t('ui.4c670f2619f1')}><span aria-hidden="true"/></div> : <progress max={100} value={percent} aria-label={title} aria-valuetext={Math.round(percent) + '%'}/>}
            {(transfer || percent != null) && <div className="session-startup-progress-meta"><span>{transfer}</span>{percent != null && <span className="session-startup-percent">{Math.round(percent)}%</span>}</div>}
          </div>}
        </div>
      </li>;
    })}</ol>
    <footer className="session-startup-footer"><Icon name="info" size={15}/><p>{t('ui.5b301fef989c')}</p></footer>
  </section></div>;
}
