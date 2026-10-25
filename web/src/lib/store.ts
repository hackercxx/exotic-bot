import { useSyncExternalStore } from 'react';
import type { EventItem } from './types';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info' | 'warn';
  title: string;
  body?: string;
  at: number;
}

export interface Counters {
  pending: number;
  connected: number;
  scheduled: number;
}

interface AppState {
  toasts: Toast[];
  counters: Counters;
  events: EventItem[];
  /** bumped on live mutations so pages know to refetch */
  rev: number;
}

let state: AppState = {
  toasts: [],
  counters: { pending: 0, connected: 0, scheduled: 0 },
  events: [],
  rev: 0,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getState(): AppState {
  return state;
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ── actions ────────────────────────────────────────────────────────────

export function pushToast(kind: Toast['kind'], title: string, body?: string) {
  const toast: Toast = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, title, body, at: Date.now() };
  setState({ toasts: [...state.toasts.slice(-4), toast] });
  setTimeout(() => dismissToast(toast.id), 3200);
}

export function dismissToast(id: string) {
  setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

export function setCounters(counters: Partial<Counters>) {
  setState({ counters: { ...state.counters, ...counters } });
}

export function pushEvent(event: EventItem) {
  setState({ events: [event, ...state.events].slice(0, 200) });
}

export function setEvents(events: EventItem[]) {
  setState({ events: events.slice(0, 200) });
}

export function bumpRev() {
  setState({ rev: state.rev + 1 });
}
