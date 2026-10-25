import { NavLink, useLocation } from 'react-router-dom';
import {
  House,
  UserCircle,
  CalendarBlank,
  ChatCircleDots,
  MusicNotes,
  ChartLineUp,
  Gear,
} from '@phosphor-icons/react';
import { useStore } from '../lib/store';
import type { IconC } from './ui';

export const NAV: { to: string; label: string; icon: IconC }[] = [
  { to: '/', label: 'Dashboard', icon: House },
  { to: '/accounts', label: 'Accounts', icon: UserCircle },
  { to: '/content', label: 'Content', icon: CalendarBlank },
  { to: '/inbox', label: 'Inbox', icon: ChatCircleDots },
  { to: '/music', label: 'Music', icon: MusicNotes },
  { to: '/analytics', label: 'Analytics', icon: ChartLineUp },
  { to: '/settings', label: 'Settings', icon: Gear },
];

/**
 * Fixed left rail: 76px collapsed → 224px on hover (§5).
 * Expands as an overlay so content never shifts.
 */
export function Sidebar() {
  const { counters } = useStore();
  const location = useLocation();

  return (
    <aside className="no-print group fixed inset-y-0 left-0 z-40 flex w-[76px] flex-col border-r border-white/[0.07] bg-[rgba(11,14,22,0.85)] backdrop-blur-xl transition-[width] duration-300 ease-out hover:w-[224px] max-[760px]:w-[64px] max-[760px]:hover:w-[64px]">
      <div className="flex h-[76px] items-center gap-3 overflow-hidden px-[22px]">
        <img src="/icon.svg" alt="EXOTIC BOT" className="h-8 w-8 shrink-0 rounded-lg shadow-glow-violet" />
        <span className="whitespace-nowrap font-display text-sm font-semibold tracking-wide text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 max-[760px]:hidden">
          EXOTIC BOT
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-hidden px-[14px]">
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
          const badge = to === '/inbox' && counters.pending > 0 ? counters.pending : 0;
          return (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              className={`relative flex h-11 items-center gap-3 overflow-hidden rounded-[10px] px-[14px] transition-all duration-200 hover:scale-[1.02] ${
                active
                  ? 'border border-violet-400/40 bg-violet-500/15 text-white shadow-glow-violet'
                  : 'border border-transparent text-slate-400 hover:border-white/10 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              <Icon size={22} weight="duotone" className="shrink-0" />
              <span className="whitespace-nowrap text-sm font-medium opacity-0 transition-opacity duration-200 group-hover:opacity-100 max-[760px]:hidden">
                {label}
              </span>
              {badge > 0 && (
                <span className="absolute right-2 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gradient-to-r from-violet to-cyan px-1 text-[10px] font-bold text-ink-950">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="overflow-hidden px-[22px] pb-5">
        <div className="flex items-center gap-2 whitespace-nowrap text-[10px] uppercase tracking-widest text-slate-500">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulseDot" />
          <span className="opacity-0 transition-opacity duration-200 group-hover:opacity-100 max-[760px]:hidden">
            self-hosted
          </span>
        </div>
      </div>
    </aside>
  );
}
