import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { getToken } from './api';
import { pushToast, setCounters, pushEvent, bumpRev, setEvents, type Counters } from './store';
import { api } from './api';
import type { EventItem } from './types';

interface WsState {
  connected: boolean;
}

const Ctx = createContext<WsState>({ connected: false });

/**
 * Live event stream (§4.8): WebSocket /ws with JWT, reconnect with backoff.
 * Feeds toasts, the terminal panel, badges and refetch signals.
 */
export function WsProvider({ children }: { children: ReactNode }) {
  const connectedRef = useRef(false);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retry = 1000;
    let retryTimer: number | undefined;

    const connect = () => {
      const token = getToken();
      if (!token || closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        connectedRef.current = true;
        retry = 1000;
        api<{ counters: Counters }>('/messages/counts')
          .then((c) => setCounters(c.counters))
          .catch(() => undefined);
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handle(msg);
        } catch {
          /* ignore malformed frame */
        }
      };

      socket.onclose = () => {
        connectedRef.current = false;
        if (closed) return;
        retryTimer = window.setTimeout(connect, Math.min(retry, 15000));
        retry *= 1.8;
      };
      socket.onerror = () => socket?.close();
    };

    const handle = (msg: { type: string; data: any }) => {
      switch (msg.type) {
        case 'counters':
          setCounters(msg.data || {});
          break;
        case 'event:new': {
          const e: EventItem = msg.data;
          pushEvent(e);
          if (e.level === 'error') pushToast('error', 'Action failed', e.message);
          else if (e.message.includes('token') && e.level === 'warn') pushToast('warn', 'Token expiring', e.message);
          break;
        }
        case 'message:new': {
          bumpRev();
          const status = msg.data?.status;
          if (status === 'RECEIVED' || status === 'AWAITING_APPROVAL') {
            pushToast('info', 'New message awaiting approval', msg.data?.sender ? `from ${msg.data.sender}` : undefined);
          }
          break;
        }
        case 'message:updated':
          bumpRev();
          if (msg.data?.status === 'SENT' || msg.data?.status === 'AUTO_SENT') {
            pushToast('success', 'Reply sent');
          }
          break;
        case 'post:updated': {
          bumpRev();
          if (msg.data?.status === 'PUBLISHED') pushToast('success', 'Post published');
          if (msg.data?.status === 'FAILED') pushToast('error', 'Publish failed', 'Check the Content page for the error');
          break;
        }
        case 'account:updated': {
          bumpRev();
          if (msg.data?.status === 'TOKEN_EXPIRING') pushToast('warn', 'Token expiring', 'Rotate the token soon to avoid disconnects');
          break;
        }
        default:
          break;
      }
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return <Ctx.Provider value={{ connected: connectedRef.current }}>{children}</Ctx.Provider>;
}

export function useWs() {
  return useContext(Ctx);
}

/** Re-fetch analytics/counts when live events change server data. */
export function refreshAll() {
  void api<{ events: EventItem[] }>('/events?limit=120')
    .then((r) => setEvents(r.events))
    .catch(() => undefined);
}
