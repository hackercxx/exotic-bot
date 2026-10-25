import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { WsProvider } from './lib/ws';
import { api } from './lib/api';
import { setEvents, setCounters } from './lib/store';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import type { EventItem } from './lib/types';

import { Login } from './pages/Login';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Accounts } from './pages/Accounts';
import { Content } from './pages/Content';
import { Inbox } from './pages/Inbox';
import { Music } from './pages/Music';
import { Analytics } from './pages/Analytics';
import { Report } from './pages/Report';
import { Settings } from './pages/Settings';

function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet to-cyan font-display text-lg font-bold text-ink-950 shadow-glow-violet">
        E
      </div>
      <Spinner size={16} />
    </div>
  );
}

/** Authenticated shell: guards routes, seeds live counters + event log. */
function ProtectedLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    api<{ events: EventItem[] }>('/events?limit=120')
      .then((r) => setEvents(r.events))
      .catch(() => undefined);
    api<{ received: number; pending: number; sentToday: number; awaitingApproval: number }>('/messages/counts')
      .then((c) => setCounters({ pending: c.pending }))
      .catch(() => undefined);
  }, [user]);

  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const onboarded = localStorage.getItem('exotic.onboarded') === '1';
  if (!onboarded && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

/** Public pages: login (first-run or returning) + onboarding wizard. */
function PublicOnly({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function OnboardingGuard({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <WsProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={
                <PublicOnly>
                  <Login />
                </PublicOnly>
              }
            />
            <Route
              path="/onboarding"
              element={
                <OnboardingGuard>
                  <Onboarding />
                </OnboardingGuard>
              }
            />
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/content" element={<Content />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/music" element={<Music />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/analytics/report" element={<Report />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </WsProvider>
    </AuthProvider>
  );
}
