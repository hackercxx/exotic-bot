import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { WhatsappLogo, Copy, CheckCircle, WarningCircle, CaretRight, LinkSimple } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { pushToast, bumpRev } from '../lib/store';
import { analytics } from '../lib/analytics';
import { Button, Field, Input, Spinner } from './ui';

export interface PairSession {
  sessionId: string;
  phone: string;
  status: 'CONNECTING' | 'WAITING_FOR_CODE' | 'PAIRED' | 'EXPIRED' | 'ERROR';
  code: string | null;
  codeExpiresInSeconds: number | null;
  error: string | null;
  accountId: string | null;
}

type Phase = 'form' | 'waiting' | 'paired';

const POLL_MS = 1500;

/**
 * WhatsApp pairing-code connection: enter the number (with country code), get a
 * genuine 8-character WhatsApp pairing code, type it into
 * WhatsApp → Linked devices → Link with phone number. Same protocol as the
 * official app; messages then flow through this instance's inbox pipeline.
 */
export function WhatsAppPairing({ onDone, connected }: { onDone?: () => void; connected?: boolean }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [phone, setPhone] = useState('');
  const [session, setSession] = useState<PairSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairedTracked = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
  }, []);

  const applySession = useCallback((s: PairSession) => {
    setSession(s);
    if (s.status === 'PAIRED') {
      setPhase('paired');
      stopPolling();
      if (!pairedTracked.current) {
        pairedTracked.current = true;
        analytics.trackChannelConnected('whatsapp');
      }
      pushToast('success', 'WhatsApp linked', s.phone);
      bumpRev();
      return;
    }
    if (s.status === 'WAITING_FOR_CODE') setPhase('waiting');
  }, [stopPolling]);

  // poll the linking session while a code is outstanding
  useEffect(() => {
    if (phase !== 'waiting' || !session) return;
    pollRef.current = setInterval(async () => {
      try {
        const { session: s } = await api<{ session: PairSession }>(`/accounts/whatsapp/pair/${session.sessionId}`);
        applySession(s);
      } catch {
        /* transient poll failure — keep polling */
      }
    }, POLL_MS);
    tickRef.current = setInterval(() => {
      setSeconds((s) => (s === null || s <= 0 ? 0 : s - 1));
    }, 1000);
    return stopPolling;
  }, [phase, session, applySession, stopPolling]);

  useEffect(() => {
    if (session?.codeExpiresInSeconds != null) setSeconds(session.codeExpiresInSeconds);
  }, [session?.codeExpiresInSeconds, session?.code]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { session: s } = await api<{ session: PairSession }>('/accounts/whatsapp/pair', {
        method: 'POST',
        body: { phoneNumber: phone },
      });
      setSession(s);
      if (s.status === 'ERROR') {
        setError(s.error || 'Could not reach WhatsApp servers');
        setPhase('form');
      } else {
        analytics.trackChannelConnectStarted('whatsapp');
        setPhase('waiting');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start linking');
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { session: s } = await api<{ session: PairSession }>(
        `/accounts/whatsapp/pair/${session.sessionId}/code`,
        { method: 'POST' },
      );
      applySession(s);
      if (s.status === 'ERROR') setError(s.error || 'Could not get a code');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not get a code');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    stopPolling();
    if (session) {
      try {
        await api(`/accounts/whatsapp/pair/${session.sessionId}`, { method: 'DELETE' });
      } catch {
        /* best effort */
      }
    }
    setSession(null);
    setPhase('form');
    setError(null);
  };

  const copyCode = async () => {
    if (!session?.code) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (phase === 'paired' && session) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-[10px] border border-emerald-400/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
          <CheckCircle size={16} /> {session.phone} linked — messages flow into your Inbox
        </div>
        <Button
          onClick={() => {
            onDone?.();
            setPhase('form');
            setSession(null);
          }}
          className="w-full"
        >
          Done
        </Button>
      </div>
    );
  }

  if (phase === 'waiting' && session) {
    const expired = session.status === 'EXPIRED' || (seconds !== null && seconds <= 0 && session.status !== 'PAIRED');
    return (
      <div className="space-y-4">
        <div className="text-center">
          <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">
            {session.status === 'WAITING_FOR_CODE' ? 'Your pairing code' : 'Linking'}
          </div>
          {session.code && !expired ? (
            <>
              <div
                className="font-mono text-3xl font-bold tracking-[0.3em] text-white"
                style={{ textShadow: '0 0 24px rgba(37,211,102,0.55)' }}
              >
                {session.code}
              </div>
              <div className="mt-1.5 flex items-center justify-center gap-3 text-xs text-slate-500">
                <span>{seconds !== null ? `expires in ${seconds}s` : ''}</span>
                <button
                  onClick={copyCode}
                  className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                  type="button"
                >
                  {copied ? <CheckCircle size={12} className="text-emerald-300" /> : <Copy size={12} />}
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
            </>
          ) : expired ? (
            <div className="text-sm text-amber-300">Code expired before it was entered.</div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-slate-400">
              <Spinner size={16} /> Requesting a genuine code from WhatsApp…
            </div>
          )}
        </div>

        <div className="rounded-[10px] border border-white/10 bg-white/[0.03] px-3.5 py-3 text-xs leading-relaxed text-slate-400">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-emerald-300">
            <LinkSimple size={13} /> On your phone
          </div>
          <ol className="list-decimal space-y-1 pl-4">
            <li>Open WhatsApp → tap the ⋮ (or Settings) → Linked devices</li>
            <li>
              Tap <strong className="text-slate-200">Link a device</strong>
            </li>
            <li>
              Choose <strong className="text-slate-200">Link with phone number instead</strong>
            </li>
            <li>Confirm the number {session.phone} and type this code</li>
          </ol>
          <p className="mt-2 text-[11px] text-slate-500">
            The code is requested from WhatsApp's servers — it's the same code WhatsApp itself would show. Scanning a QR
            is not required.
          </p>
        </div>

        {(expired || session.status === 'ERROR') && (
          <div className="flex items-start gap-2 rounded-[10px] border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <WarningCircle size={14} className="mt-0.5 shrink-0" />
            {session.error || 'The code expired — request a new one.'}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <WarningCircle size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={requestCode} loading={busy} disabled={session.status === 'PAIRED'} className="flex-1">
            {expired || session.status === 'ERROR' ? 'Get a new code' : 'Re-issue code'}
          </Button>
          <Button variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="space-y-3">
      <Field
        label="WhatsApp number"
        hint="Full number with country code — the account you want as your business line."
      >
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
            +
          </span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d\s()-]/g, ''))}
            placeholder="1 555 010 7788"
            inputMode="tel"
            autoComplete="tel"
            className="pl-7"
            required
          />
        </div>
      </Field>
      {error && (
        <div className="flex items-start gap-2 rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <WarningCircle size={14} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}
      <Button type="submit" loading={busy} className="w-full">
        <WhatsappLogo size={16} /> Get pairing code <CaretRight size={13} />
      </Button>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {connected ? 'Another number can be linked the same way. ' : ''}
        Links this phone as a device — no QR scan needed. Inbound messages arrive through the same signature-checked
        pipeline as the Cloud API.
      </p>
    </form>
  );
}
