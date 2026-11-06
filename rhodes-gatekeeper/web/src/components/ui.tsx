import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

// ------------------------------------------------------------ buttons
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
export function Button({ variant = 'secondary', size, busy, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'lg' | 'sm'; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined} className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}>
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------ form fields
export function Field({ label, error, hint, required, children, htmlFor }: { label: string; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req" aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

export function TextInput({ label, value, onChange, error, required, hint, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string; required?: boolean; hint?: ReactNode } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const id = useId();
  return (
    <Field label={label} error={error} required={required} hint={hint} htmlFor={id}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} required={required} {...rest} />
    </Field>
  );
}

export function TextArea({ label, value, onChange, error, required, hint, rows = 3, ...rest }: { label: string; value: string; onChange: (v: string) => void; error?: string; required?: boolean; hint?: ReactNode; rows?: number } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'>) {
  const id = useId();
  return (
    <Field label={label} error={error} required={required} hint={hint} htmlFor={id}>
      <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} {...rest} />
    </Field>
  );
}

export function Select({ label, value, onChange, options, error, required, hint, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; error?: string; required?: boolean; hint?: ReactNode; placeholder?: string }) {
  const id = useId();
  return (
    <Field label={label} error={error} required={required} hint={hint} htmlFor={id}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="toggle-row">
      <label htmlFor={id} className="toggle">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-track" aria-hidden><span className="toggle-thumb" /></span>
        <span>{label}</span>
      </label>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------ feedback
export function Alert({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'error' | 'success'; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'red' | 'teal' | 'green' | 'amber'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden /> {label}…</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ------------------------------------------------------------ modal
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not(.modal-close)');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ toasts
type Toast = { id: number; tone: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------ data hook
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}
