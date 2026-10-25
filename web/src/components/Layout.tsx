import { useEffect, useState, type ReactNode } from 'react';
import { AmbientBackground } from './AmbientBackground';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { TerminalPanel } from './TerminalPanel';
import { CommandPalette } from './CommandPalette';
import { Toasts } from './Toasts';

/** App shell: ambient bg + sidebar + topbar + terminal + palette + toasts. */
export function Layout({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => localStorage.getItem('exotic.terminal') === '1');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleTerminal = () => {
    setTerminalOpen((v) => {
      localStorage.setItem('exotic.terminal', v ? '0' : '1');
      return !v;
    });
  };

  return (
    <div className="min-h-screen">
      <AmbientBackground />
      <Sidebar />
      <div className="relative z-10 ml-[76px] min-h-screen max-[760px]:ml-[64px]">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleTerminal={toggleTerminal}
          terminalOpen={terminalOpen}
        />
        <main
          className={`px-8 pb-12 pt-[100px] transition-[padding] duration-300 max-[760px]:px-4 ${
            terminalOpen ? '2xl:pr-[400px]' : ''
          }`}
        >
          {children}
        </main>
      </div>
      <TerminalPanel open={terminalOpen} onClose={toggleTerminal} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toasts />
    </div>
  );
}
