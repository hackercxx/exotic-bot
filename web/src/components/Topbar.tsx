import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MagnifyingGlass, Bell, SignOut, Terminal, CaretRight } from '@phosphor-icons/react';
import { useAuth } from '../lib/auth';
import { useStore } from '../lib/store';
import { NAV } from './Sidebar';

interface Props {
  onOpenPalette: () => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
}

export function Topbar({ onOpenPalette, onToggleTerminal, terminalOpen }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { counters, events, toasts } = useStore();
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const crumb = useMemo(() => {
    const item = NAV.find((n) => (n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)));
    return item?.label || 'Dashboard';
  }, [location.pathname]);

  const notices = events.slice(0, 6);

  return (
    <header className="no-print fixed left-[76px] right-0 top-0 z-30 flex h-[76px] items-center gap-4 border-b border-white/[0.07] bg-[rgba(7,9,15,0.72)] px-8 backdrop-blur-xl max-[760px]:left-[64px] max-[760px]:px-4">
      {/* Breadcrumb */}
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="font-display font-semibold text-violet-300">EXOTIC BOT</span>
        <CaretRight size={12} className="text-slate-600" />
        <span className="truncate font-medium text-slate-300">{crumb}</span>
      </div>

      <div className="flex-1" />

      {/* Search trigger → command palette */}
      <button
        onClick={onOpenPalette}
        className="btn-ghost hidden h-9 min-w-[220px] items-center justify-between gap-2 px-3 text-sm text-slate-400 sm:flex"
      >
        <span className="flex items-center gap-2">
          <MagnifyingGlass size={15} />
          Search…
        </span>
        <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            ⌘K
          </kbd>
      </button>
      <button onClick={onOpenPalette} aria-label="Search" className="btn-ghost p-2 sm:hidden">
        <MagnifyingGlass size={16} />
      </button>

      {/* Terminal toggle */}
      <button
        onClick={onToggleTerminal}
        aria-label="Toggle activity terminal"
        aria-pressed={terminalOpen}
        className={`btn-ghost p-2 ${terminalOpen ? '!border-cyan-400/40 !bg-cyan-500/10 text-cyan-300' : ''}`}
      >
        <Terminal size={16} />
      </button>

      {/* Notifications */}
      <div className="relative">
        <button
          onClick={() => setBellOpen((v) => !v)}
          aria-label="Notifications"
          className="btn-ghost relative p-2"
        >
          <Bell size={16} />
          {counters.pending > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gradient-to-r from-violet to-cyan px-1 text-[10px] font-bold text-ink-950">
              {counters.pending}
            </span>
          )}
        </button>
        {bellOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setBellOpen(false)} />
            <div className="glass absolute right-0 top-11 z-50 w-[320px] p-3">
              <div className="label mb-2 px-1">Latest activity</div>
              {notices.length === 0 && <div className="px-1 py-3 text-xs text-slate-500">No activity yet.</div>}
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {notices.map((e) => (
                  <li key={e.id} className="rounded-lg px-2 py-1.5 text-xs leading-relaxed text-slate-300 hover:bg-white/5">
                    <span
                      className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                        e.level === 'error'
                          ? 'bg-red-400'
                          : e.level === 'warn'
                            ? 'bg-amber-400'
                            : e.level === 'success'
                              ? 'bg-emerald-400'
                              : 'bg-cyan-400'
                      }`}
                    />
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="btn-ghost flex h-9 items-center gap-2 px-2.5 text-sm"
          aria-label="User menu"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet to-cyan text-[11px] font-bold text-ink-950">
            {(user?.email || '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden max-w-[140px] truncate text-slate-300 md:inline">{user?.email}</span>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="glass absolute right-0 top-11 z-50 w-52 p-2">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  navigate('/settings');
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5"
              >
                <Bell size={15} /> Notifications & settings
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  logout();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
              >
                <SignOut size={15} /> Sign out
              </button>
            </div>
          </>
        )}
      </div>

      {/* Live toasts render in Toasts.tsx; silence unused binding */}
      <span className="hidden">{toasts.length}</span>
    </header>
  );
}
