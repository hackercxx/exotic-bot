import { useEffect, useState, type FormEvent } from 'react';
import {
  InstagramLogo,
  ArrowSquareOut,
  LockKey,
  User,
  ShieldCheck,
  CaretDown,
  Timer,
} from '@phosphor-icons/react';
import { api, ApiError } from '../lib/api';
import { analytics } from '../lib/analytics';
import { Button, Field, Input } from './ui';

/**
 * Connect Instagram two ways:
 *  1. Private API (username + password) — works with NO Meta app configured,
 *     the instagrapi-style path. This is the default and the one that actually
 *     connects when META_APP_ID/SECRET are absent.
 *  2. Official OAuth (redirect to facebook.com) — only offered when the server
 *     reports a Meta app is configured.
 */
export function InstagramConnect({
  connected,
  onDone,
  compact,
  metaConfigured,
}: {
  connected?: boolean;
  onDone?: () => void;
  compact?: boolean;
  metaConfigured?: boolean;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // set when Instagram demands a second factor (409 needsTwoFactor)
  const [twoFactor, setTwoFactor] = useState<{ method: 'totp' | 'sms' } | null>(null);
  const [code, setCode] = useState('');
  // set when Instagram challenges the login (409 needsChallenge) — a security
  // code it just emailed/texted, verified right here in the form
  const [challenge, setChallenge] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [challengeCode, setChallengeCode] = useState('');
  // Advanced settings: an optional per-attempt residential proxy
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [proxy, setProxy] = useState('');
  // Cooldown driven by the backend's 429 (code RATE_LIMITED + retryAfterSec)
  // — the submit button stays disabled until it reaches zero.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownKind, setCooldownKind] = useState<'rate' | 'attempts'>('rate');
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (!cooldownUntil) return;
    const id = window.setInterval(() => setTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const remaining = Math.max(0, Math.ceil((cooldownUntil - tick) / 1000));
  const cooling = remaining > 0;
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');

  const startCooldown = (retryAfterSec: number, kind: 'rate' | 'attempts') => {
    if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return;
    setCooldownKind(kind);
    setTick(Date.now());
    setCooldownUntil(Date.now() + retryAfterSec * 1000);
  };

  // Default to private-API login; OAuth is only used when Meta is configured.
  const useOAuth = false;

  const submitPrivate = async (e: FormEvent) => {
    e.preventDefault();
    if (cooling) return; // countdown running — the button is disabled anyway
    const clean = username.trim().replace(/^@/, '');
    if (!clean || !password) return;
    setBusy(true);
    setError(null);
    try {
      analytics.trackChannelConnectStarted('instagram');
      await api('/accounts/instagram/private', {
        method: 'POST',
        body: {
          username: clean,
          password,
          ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
          ...(twoFactor && code.trim() ? { verificationCode: code.trim() } : {}),
          ...(challenge && challengeCode.trim()
            ? { challengeId: challenge.challengeId, challengeCode: challengeCode.trim() }
            : {}),
        },
      });
      setPassword(''); // don't keep the password in memory after success
      setCode('');
      setChallengeCode('');
      setChallenge(null);
      setCooldownUntil(0); // a success clears any pending countdown
      analytics.trackChannelConnected('instagram');
      onDone?.();
      window.location.href = '/accounts?connected=instagram';
      return;
    } catch (err) {
      const payload = err instanceof ApiError ? err.payload : null;
      if (payload?.needsTwoFactor) {
        setTwoFactor({ method: payload.method === 'totp' ? 'totp' : 'sms' });
        setError(null);
        setBusy(false);
        return;
      }
      if (payload?.needsChallenge && typeof payload.challengeId === 'string') {
        setChallenge({
          challengeId: payload.challengeId,
          sentTo: typeof payload.sentTo === 'string' ? payload.sentTo : 'your email or phone',
        });
        setError(null);
        setBusy(false);
        return;
      }
      // 429 (RATE_LIMITED) or a failed attempt carrying retryAfterSec → lock
      // the card and count down, exactly like the backend asked us to.
      const retryAfterSec = typeof payload?.retryAfterSec === 'number' ? payload.retryAfterSec : 0;
      startCooldown(retryAfterSec, payload?.code === 'RATE_LIMITED' ? 'rate' : 'attempts');
      setError(err instanceof Error ? err.message : 'Could not connect Instagram');
      setBusy(false);
    }
  };

  const submitOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const clean = username.trim().replace(/^@/, '');
      const { url } = await api<{ url: string }>('/accounts/instagram/connect', {
        method: 'POST',
        body: { username: clean },
      });
      analytics.trackChannelConnectStarted('instagram');
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start OAuth');
      setBusy(false);
    }
  };

  if (connected && !username) {
    return (
      <div className="rounded-[10px] border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
        Instagram connected ✓
      </div>
    );
  }

  return (
    <form onSubmit={submitPrivate} className="space-y-3">
      {twoFactor && (
        <div className="rounded-[10px] border border-amber-400/30 bg-amber-500/10 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-200">
            <ShieldCheck size={14} /> Two-factor code required
          </div>
          <p className="mb-2.5 text-[11px] leading-relaxed text-amber-200/80">
            {twoFactor.method === 'totp'
              ? 'Open your authenticator app and enter the 6-digit code for Instagram.'
              : 'Instagram sent (or will send) an SMS code to your phone — enter it below.'}
          </p>
          <Field label="Verification code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center font-mono text-lg tracking-[0.4em]"
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </Field>
          <button
            type="button"
            onClick={() => {
              setTwoFactor(null);
              setCode('');
              setError(null);
            }}
            className="mt-1 text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            Use different credentials
          </button>
        </div>
      )}
      {challenge && (
        <div className="rounded-[10px] border border-amber-400/30 bg-amber-500/10 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-200">
            <ShieldCheck size={14} /> Security code sent
          </div>
          <p className="mb-2.5 text-[11px] leading-relaxed text-amber-200/80">
            Instagram is verifying this login and sent a 6-digit code to{' '}
            <span className="font-mono text-amber-100">{challenge.sentTo}</span>. Enter it below to
            finish connecting — no need to open the Instagram app.
          </p>
          <Field label="Security code">
            <Input
              value={challengeCode}
              onChange={(e) => setChallengeCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center font-mono text-lg tracking-[0.4em]"
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </Field>
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setChallengeCode('');
              setError(null);
            }}
            className="mt-1 text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            Use different credentials
          </button>
        </div>
      )}
      <Field label="Instagram username" hint="Sign in directly with your Instagram handle and password (private API).">
        <div className="relative">
          <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
            placeholder="your.brand"
            autoComplete="username"
            spellCheck={false}
            className="!pl-9"
            required
          />
        </div>
      </Field>
      <Field label="Instagram password" hint="Stored AES-256-GCM encrypted at rest; used only to open the session.">
        <div className="relative">
          <LockKey size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            className="!pl-9"
            required
          />
        </div>
      </Field>
      {/* Advanced settings — per-attempt residential proxy (overrides .env) */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="flex items-center gap-1.5 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
        >
          <CaretDown size={11} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          Advanced settings
          {proxy.trim() && <span className="text-emerald-400">· proxy set</span>}
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <Field
              label="Residential proxy"
              hint="IP:Port:User:Pass — leave empty to use INSTAGRAM_PROXY_URL from the server's .env file."
            >
              <Input
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="203.0.113.7:8080:user:pass"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}

      {(error || cooling) && (
        <div className="space-y-1.5 rounded-[10px] border border-amber-400/30 bg-amber-500/10 p-3">
          {cooling && (
            <div className="flex items-center gap-2 font-mono text-xs font-semibold text-amber-100">
              <Timer size={14} className="text-amber-300" />
              {cooldownKind === 'rate' ? 'Rate limited.' : 'Too many attempts.'} Try again in {mm}:{ss}
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-amber-200/80">
            Connection failed. Instagram blocks cloud servers. Please ensure a residential proxy is
            configured, then wait 15 minutes before trying again.
          </p>
        </div>
      )}

      <Button type="submit" loading={busy} disabled={cooling} className="w-full">
        <InstagramLogo size={16} />
        {twoFactor || challenge ? 'Verify & connect' : compact ? 'Connect' : 'Connect Instagram'}
      </Button>

      {metaConfigured && (
        <button
          type="button"
          onClick={submitOAuth}
          disabled={busy}
          className="w-full text-center text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline disabled:opacity-50"
        >
          Or continue with official Meta OAuth <ArrowSquareOut size={11} className="inline" />
        </button>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        Direct sign-in uses the private API (like <span className="font-mono">instagrapi</span>) — no Facebook Page or
        Meta app required. Enter your username and password and you're connected: if Instagram asks for a
        two-factor or security code it appears right here, verified in place. Instagram may ask you to confirm
        the login from your phone the first time.
      </p>
    </form>
  );
}
