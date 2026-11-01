import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleAlert,
  Info,
  LoaderCircle,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ApiProblem } from '../api';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`button button--${variant} button--${size} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle size={14} className="spin" aria-hidden /> : Icon ? <Icon size={14} aria-hidden /> : null}
      <span>{children}</span>
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  children,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={`button button--${variant} button--${size}`}>
      {Icon ? <Icon size={14} aria-hidden /> : null}
      <span>{children}</span>
    </Link>
  );
}

const statusToneMap: Record<string, string> = {
  active: 'positive',
  published: 'positive',
  validated: 'positive',
  completed: 'positive',
  approved: 'positive',
  promoted: 'positive',
  succeeded: 'positive',
  running: 'info',
  queued: 'info',
  submitted: 'info',
  pending: 'info',
  draft: 'neutral',
  not_submitted: 'neutral',
  not_requested: 'neutral',
  requested: 'info',
  superseded: 'neutral',
  retired: 'neutral',
  changes_requested: 'warning',
  warning: 'warning',
  failed: 'negative',
  rejected: 'negative',
  cancelled: 'negative',
  archived: 'neutral',
};

export function StatusPill({
  value,
  label,
  tone,
}: {
  value: string;
  label?: string;
  tone?: string;
}) {
  const resolvedTone = tone ?? statusToneMap[value] ?? 'neutral';
  return (
    <span className={`status status--${resolvedTone}`}>
      <span className="status__dot" aria-hidden />
      {label ?? value.replace(/_/g, ' ')}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="page-header">
      <div className="page-header__main">
        {back ? (
          <Link to={back.to} className="back-link">
            <ArrowLeft size={13} aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || action ? (
        <div className="panel__header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action ? <div className="panel__action">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="field__error">{error}</p> : hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input select ${props.className ?? ''}`} />;
}

export function ProblemBanner({
  error,
  onRetry,
  compact = false,
}: {
  error: ApiProblem | Error | null | undefined;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (!error) return null;
  const problem = 'status' in error ? (error as ApiProblem) : null;
  const title = problem?.title ?? 'Something went wrong';
  const detail = problem?.detail ?? error.message;
  return (
    <div className={`problem ${compact ? 'problem--compact' : ''}`} role="alert">
      <CircleAlert size={16} aria-hidden />
      <div>
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
        {problem?.issues?.length ? (
          <ul>
            {problem.issues.slice(0, 8).map((issue) => (
              <li key={`${issue.path}-${issue.code}-${issue.message}`}>
                <code>{issue.path || '/'}</code> {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {problem?.correlationId ? <p className="problem__meta">Correlation {problem.correlationId}</p> : null}
        {onRetry ? (
          <button type="button" className="text-button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon = Info,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={20} aria-hidden />
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        {action ? <div className="empty__action">{action}</div> : null}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-table" aria-label="Loading" role="status">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div className="skeleton-row" key={rowIndex}>
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <span
              key={columnIndex}
              className="skeleton-block"
              style={{ width: `${45 + ((rowIndex + columnIndex) % 4) * 12}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      {detail ? <span className="metric__detail">{detail}</span> : null}
    </div>
  );
}

export function MetricStrip({ children }: { children: ReactNode }) {
  return <div className="metric-strip">{children}</div>;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog__header">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="dialog__body">{children}</div>
      {footer ? <div className="dialog__footer">{footer}</div> : null}
    </dialog>
  );
}

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  tone: ToastTone;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  push: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const item = { ...toast, id: crypto.randomUUID() };
    setItems((current) => [...current, item]);
    window.setTimeout(() => {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    }, 4500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((item) => (
          <div className={`toast toast--${item.tone}`} key={item.id}>
            {item.tone === 'success' ? <Check size={15} /> : item.tone === 'error' ? <AlertTriangle size={15} /> : <Info size={15} />}
            <div>
              <strong>{item.title}</strong>
              {item.detail ? <p>{item.detail}</p> : null}
            </div>
            <button
              type="button"
              className="icon-button icon-button--quiet"
              aria-label="Dismiss"
              onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}
