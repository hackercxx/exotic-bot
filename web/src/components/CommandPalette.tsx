import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MagnifyingGlass, ArrowRight, Command } from '@phosphor-icons/react';
import { NAV } from './Sidebar';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Command palette: fuzzy search over pages + actions, ↑↓ navigation, Enter executes (§5). */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const navCmds: Cmd[] = NAV.map((n) => ({
      id: `nav-${n.to}`,
      label: `Go to ${n.label}`,
      hint: 'page',
      run: () => {
        navigate(n.to);
        onClose();
      },
    }));
    const actionCmds: Cmd[] = [
      {
        id: 'act-compose',
        label: 'Create a new post',
        hint: 'action',
        run: () => {
          navigate('/content?compose=1');
          onClose();
        },
      },
      {
        id: 'act-connect',
        label: 'Connect an account',
        hint: 'action',
        run: () => {
          navigate('/accounts');
          onClose();
        },
      },
      {
        id: 'act-ai',
        label: 'Configure AI reply engine',
        hint: 'action',
        run: () => {
          navigate('/settings');
          onClose();
        },
      },
      {
        id: 'act-report',
        label: 'Open printable daily report',
        hint: 'action',
        run: () => {
          navigate('/analytics/report');
          onClose();
        },
      },
    ];
    return [...navCmds, ...actionCmds];
  }, [navigate, onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint || ''}`.toLowerCase();
      // subsequence fuzzy match
      let i = 0;
      for (const ch of hay) {
        if (ch === q[i]) i++;
        if (i === q.length) return true;
      }
      return false;
    });
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[index]?.run();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 px-4 pt-[14vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          onKeyDown={onKeyDown}
        >
          <motion.div
            className="glass w-full max-w-xl overflow-hidden"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
              <MagnifyingGlass size={17} className="text-violet-300" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pages and actions…"
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              />
              <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                esc
              </kbd>
            </div>
            <ul className="max-h-72 overflow-y-auto p-2">
              {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No matches</li>}
              {results.map((cmd, i) => (
                <li key={cmd.id}>
                  <button
                    onMouseEnter={() => setIndex(i)}
                    onClick={cmd.run}
                    className={`flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left text-sm transition-colors ${
                      i === index ? 'bg-violet-500/20 text-white' : 'text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      {i === index ? <ArrowRight size={14} className="text-cyan-300" /> : <span className="w-3.5" />}
                      {cmd.label}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{cmd.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 border-t border-white/[0.07] px-4 py-2 font-mono text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <Command size={11} /> K
              </span>
              <span>↑↓ navigate</span>
              <span>↵ execute</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
