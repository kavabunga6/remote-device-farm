import { useState, type ReactNode } from 'react';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon, type IconName } from '../icons';

type Props = {
  title: string;
  description: string;
  icon: IconName;
  tone?: 'app' | 'connection';
  badge?: string;
  pending?: string;
  className?: string;
  initialOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

export function EnvironmentSection({ title, description, icon, tone, badge, pending, className, initialOpen = false, onOpenChange, children }: Props) {
  const [open, setOpen] = useState(initialOpen);
  return <details className={className ? `env-card ${className}` : 'env-card'} open={open} aria-busy={Boolean(pending)}
    onToggle={event => { setOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open); }}>
    <summary>
      <span className="env-card-icon" data-tone={tone}><Icon name={icon} /></span>
      <span className="env-card-heading">
        <span className="env-card-title"><strong>{title}</strong>{badge && <span className="env-card-badge">{badge}</span>}</span>
        <span className="env-card-description">{description}</span>
        {pending && <span className="env-pending" role="status"><ActivityIndicator />{pending}</span>}
      </span>
      <Icon name="chevronDown" className="env-card-chevron" size={18} />
    </summary>
    <div className="env-card-body">{children}</div>
  </details>;
}
