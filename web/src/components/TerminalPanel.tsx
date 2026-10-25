import { AnimatePresence, motion } from 'framer-motion';
import { X, Terminal } from '@phosphor-icons/react';
import { useStore } from '../lib/store';

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-cyan-300',
  success: 'text-emerald-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

function stamp(iso: string) {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

/**
 * Terminal panel (§4.8): streams the last 120 events in JetBrains Mono.
 * Live events prepend via the WebSocket provider.
 */
export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { events } = useStore();
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 400, opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="no-print fixed bottom-0 right-0 top-[76px] z-40 flex w-[380px] max-w-[92vw] flex-col border-l border-white/[0.07] bg-[rgba(7,9,15,0.92)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
            <div className="flex items-center gap-2">
              <Terminal size={15} className="text-cyan-300" />
              <span className="font-display text-sm font-semibold text-white">Activity log</span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">live</span>
            </div>
            <button onClick={onClose} aria-label="Close terminal" className="btn-ghost p-1.5">
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 font-mono text-[11.5px] leading-relaxed">
            {events.length === 0 && <div className="text-slate-600">waiting for events…</div>}
            {events.map((e) => (
              <div key={e.id} className="flex gap-2 border-b border-white/[0.04] py-1.5">
                <span className="shrink-0 text-slate-600">{stamp(e.createdAt)}</span>
                <span className={`shrink-0 ${LEVEL_COLOR[e.level] || 'text-slate-400'}`}>
                  {e.level.toUpperCase().padEnd(7, ' ')}
                </span>
                <span className="min-w-0 break-words text-slate-300">{e.message}</span>
              </div>
            ))}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
