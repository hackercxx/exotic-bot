import { motion, AnimatePresence } from 'framer-motion';
import type { ReactNode, ComponentType, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react';
import { X } from '@phosphor-icons/react';
import { sparklinePath } from '../lib/format';

// Phosphor icon components (ForwardRefExoticComponent) — kept loose on purpose:
// any duotone icon with {size, weight, className} must fit this slot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IconC = ComponentType<any>;

/** Page transition: fade up 14px over 450ms (§5 motion). */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Staggered children: 60ms per card (§5 motion). */
export function Stagger({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function GlassCard({
  children,
  className = '',
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return <div className={`glass ${hover ? 'glass-hover' : ''} ${className}`}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
}

export function Button({ variant = 'primary', loading, children, className = '', disabled, ...rest }: ButtonProps) {
  const base = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-ghost !border-red-500/40 !text-red-300 hover:!bg-red-500/10' : 'btn-ghost';
  return (
    <button
      className={`${base} inline-flex items-center justify-center gap-2 px-4 py-2 text-sm ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

/** Pill toggle: 40×22, violet when on, 220ms ease (§5). */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex shrink-0 items-center rounded-full transition-colors duration-[220ms] ease-out disabled:opacity-40"
      style={{
        width: 40,
        height: 22,
        background: checked ? '#E5192D' : 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <span
        className="absolute rounded-full bg-white shadow transition-transform duration-[220ms] ease-out"
        style={{ width: 16, height: 16, left: 3, transform: `translateX(${checked ? 18 : 0}px)` }}
      />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className || ''}`} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`field min-h-[90px] resize-y ${props.className || ''}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`field appearance-none ${props.className || ''}`} />;
}

const TONES = {
  violet: 'bg-violet-100/10 text-violet-300 border-violet-400/30',
  cyan: 'bg-cyan-100/10 text-cyan-300 border-cyan-400/30',
  green: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  amber: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  red: 'bg-red-400/10 text-red-300 border-red-400/30',
  gray: 'bg-white/5 text-slate-300 border-white/10',
} as const;

export function Badge({ tone = 'gray', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const POST_STATUS_TONE: Record<string, keyof typeof TONES> = {
  DRAFT: 'gray',
  SCHEDULED: 'violet',
  PUBLISHING: 'cyan',
  PUBLISHED: 'green',
  FAILED: 'red',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = POST_STATUS_TONE[status] || (/SENT|REPLIED/.test(status) ? 'green' : status === 'AWAITING_APPROVAL' || status === 'RECEIVED' ? 'amber' : 'gray');
  return <Badge tone={tone}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon?: IconC;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {Icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
          <Icon size={26} weight="duotone" className="text-violet-300" />
        </div>
      )}
      <div className="font-display text-base font-medium text-white">{title}</div>
      {body && <p className="max-w-sm text-sm leading-relaxed text-slate-400">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-violet-400/70 border-t-transparent align-middle"
      style={{ width: size, height: size }}
    />
  );
}

export function Sparkline({
  values,
  stroke = '#FF4D5A',
  width = 130,
  height = 36,
}: {
  values: number[];
  stroke?: string;
  width?: number;
  height?: number;
}) {
  const points = values.length >= 2 ? values : [0, ...(values.length === 1 ? [values[0]] : [0])];
  const d = sparklinePath(points, width, height);
  if (!d) return <div style={{ width, height }} />;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`spark-${stroke.replace('#', '')}`} x1="0" x2="1">
          <stop offset="0%" stopColor="#E5192D" />
          <stop offset="100%" stopColor={stroke} />
        </linearGradient>
      </defs>
      <path d={d} fill="none" stroke={`url(#spark-${stroke.replace('#', '')})`} strokeWidth="2" strokeLinecap="round" />
      <circle
        cx={width}
        cy={Number(d.split('L').pop()?.split(',')[1] || 0)}
        r="3"
        fill={stroke}
      />
    </svg>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            className={`glass w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-6`}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="font-display text-lg font-semibold text-white">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="btn-ghost p-1.5">
                <X size={16} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
