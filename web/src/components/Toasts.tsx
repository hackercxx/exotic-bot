import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, WarningCircle, XCircle, Info } from '@phosphor-icons/react';
import { useStore, dismissToast, type Toast } from '../lib/store';

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  warn: WarningCircle,
  info: Info,
} as const;

const COLORS = {
  success: 'border-emerald-400/40 text-emerald-300',
  error: 'border-red-400/40 text-red-300',
  warn: 'border-amber-400/40 text-amber-300',
  info: 'border-violet-400/40 text-violet-200',
} as const;

/** Toasts: slide in from the right, auto-dismiss 3.2s with a draining bar (§5). */
export function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="no-print pointer-events-none fixed right-5 top-24 z-[60] flex w-[330px] max-w-[calc(100vw-40px)] flex-col gap-2.5">
      <AnimatePresence>
        {toasts.map((t: Toast) => {
          const Icon = ICONS[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 60, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="glass pointer-events-auto relative overflow-hidden p-3.5 pr-9 shadow-lg"
              onClick={() => dismissToast(t.id)}
            >
              <div className="flex items-start gap-2.5">
                <Icon size={17} weight="fill" className={`mt-0.5 shrink-0 ${COLORS[t.kind]}`} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">{t.title}</div>
                  {t.body && <div className="mt-0.5 text-xs leading-relaxed text-slate-400">{t.body}</div>}
                </div>
              </div>
              <span className="absolute inset-x-0 bottom-0 h-[3px] origin-left animate-drain bg-gradient-to-r from-violet to-cyan" />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
